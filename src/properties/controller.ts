// Host-side logic of the Project Properties panel. Pure: no vscode import.
import { parse, type ParseError } from 'jsonc-parser';
import { ChangedOnDiskError, writeTextAtomically } from '../core/atomicWrite';
import { resolveActiveProfile } from '../launch/activeProfile';
import { applyProfileAction, launchSettingsPath, parseProfiles, ProfileError, type ProfileAction } from '../launch/launchSettings';
import { loadProperties, saveProperties, type PropertiesDeps, type PropertiesModel } from './model';
import type { PropertyEdit } from './csprojEdit';
import type { LaunchProfilesView, PropsToHost, PropsToWebview } from './protocol';
import { FIELDS, validateIdentifierPath, validateTfm, validateVersion } from './schema';

/** Access to launchSettings.json and the per-project active profile. */
export interface LaunchDeps {
  /** The file text, or undefined when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Creates the file (and `Properties/`) exclusively; used for the first write only. */
  create(path: string, text: string): Promise<void>;
  confirmDelete(name: string): Promise<boolean>;
  getActive(): string | undefined;
  setActive(name: string | undefined): Promise<void>;
}

export interface ControllerDeps extends PropertiesDeps {
  launch: LaunchDeps;
  post(m: PropsToWebview): void;
  onSecrets(): void;
  openAt(property: string): void;
  t(key: string, ...a: string[]): string;
}

const SECTIONS = ['Application', 'Build', 'Package', 'Assembly', 'Debug', 'Secrets'];
const UI = [
  'Save', 'Add', 'Reload', 'Reset', 'inherited', 'duplicate', 'set per configuration', 'Open in .csproj',
  'multi-line', 'Evaluated: {0}', 'from .csproj, not evaluated',
  'The project could not be evaluated, so it is read-only.', 'The project changed on disk.',
  'Manage user secrets',
  'Launch profiles', 'New profile', 'Duplicate', 'Rename', 'Delete', 'Project', 'Executable', 'Name', 'Value',
  'Command line arguments', 'Working directory', 'Application URL', 'Launch browser', 'Launch URL', 'Executable path',
  'Environment variables', 'Add variable', 'Remove', 'Active profile', 'Set as active', 'Command',
  'Not supported on this system', 'launchSettings.json is created when you add the first profile.', 'Profile name',
];

/** English keys of every label the webview shows (field labels, sections, validator messages). */
export function labelKeys(): string[] {
  const messages = [validateTfm('x'), validateVersion('x'), validateIdentifierPath('')];
  return [...new Set([...FIELDS.map((f) => f.label), ...SECTIONS, ...UI, ...messages.filter((m): m is string => !!m)])];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The first edit the schema validators reject, as [field label, message] l10n keys; undefined when all pass. */
export function invalidEdit(edits: PropertyEdit[]): [label: string, message: string] | undefined {
  for (const e of edits) {
    if (e.kind === 'remove') continue;
    if (e.kind === 'targetFrameworks') {
      const label = FIELDS.find((f) => f.kind === 'tfms')!.label;
      const bad = e.tfms.length === 0 ? validateTfm('') : e.tfms.map(validateTfm).find((m) => m !== undefined);
      if (bad) return [label, bad];
      continue;
    }
    const def = FIELDS.find((f) => f.property === e.name);
    const bad = def?.validate?.(e.value);
    if (def && bad) return [def.label, bad];
  }
  return undefined;
}

export class PropertiesController {
  private model: PropertiesModel | undefined;
  private isDirty = false;
  private saving = false;
  private edits: PropertyEdit[] = [];
  private launchText: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly projectPath: string, private readonly deps: ControllerDeps) {}

  get dirty(): boolean { return this.isDirty; }
  get pendingEdits(): PropertyEdit[] { return this.edits; }

  /** Saves the edits the webview last reported; false when there was nothing to save or it failed. */
  saveCurrent(): Promise<boolean> {
    return this.save(this.edits);
  }

  async handle(m: PropsToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.deps.post({ type: 'loading' });
        await this.load();
        return;
      case 'reload':
        this.isDirty = false;
        this.edits = [];
        await this.load();
        return;
      case 'dirty':
        this.isDirty = m.dirty;
        this.edits = m.dirty ? m.edits : [];
        return;
      case 'openCsproj':
        this.deps.openAt(m.property);
        return;
      case 'manageSecrets':
        this.deps.onSecrets();
        return;
      case 'save':
        await this.save(m.edits);
        return;
      case 'profiles':
        await this.enqueue(() => this.profileAction(m.action));
        return;
      case 'setActiveProfile':
        await this.enqueue(async () => { await this.deps.launch.setActive(m.name); this.postProfiles(); });
        return;
    }
  }

  onFileChanged(): void {
    if (this.saving) return; // the event comes from our own save, which posts the new model itself
    void this.deps.readText(this.projectPath).then(async (text) => {
      if (this.saving || text === this.model?.text) return; // our own write, or nothing changed
      if (this.isDirty) this.deps.post({ type: 'changedOnDisk' });
      else await this.load();
    }, () => { if (this.isDirty) this.deps.post({ type: 'changedOnDisk' }); });
  }

  private async load(): Promise<void> {
    try {
      this.model = await loadProperties(this.projectPath, this.deps);
      const labels = Object.fromEntries(labelKeys().map((k) => [k, this.deps.t(k)]));
      this.deps.post({ type: 'model', model: this.model, labels });
    } catch (e) {
      this.deps.post({ type: 'error', message: msg(e) });
      return;
    }
    await this.loadProfiles();
  }

  /** Profile actions run one at a time, so each applies to the text written by the previous one. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get launchPath(): string { return launchSettingsPath(this.projectPath); }

  private async loadProfiles(): Promise<void> {
    try {
      this.launchText = await this.deps.launch.read(this.launchPath);
      this.postProfiles();
    } catch (e) {
      this.deps.post({ type: 'error', message: msg(e) });
    }
  }

  private postProfiles(): void {
    const profiles = parseProfiles(this.launchText);
    const active = resolveActiveProfile(profiles, this.deps.launch.getActive())?.name;
    const errors: ParseError[] = [];
    const root: unknown = this.launchText?.trim() ? parse(this.launchText, errors, { allowTrailingComma: true }) : {};
    const invalid = errors.length > 0 || typeof root !== 'object' || root === null || Array.isArray(root);
    const model: LaunchProfilesView = {
      profiles, path: this.launchPath, exists: this.launchText !== undefined,
      ...(active ? { active } : {}),
      ...(invalid ? { invalid: this.deps.t('launchSettings.json is not valid JSON; fix it and reload.') } : {}),
    };
    this.deps.post({ type: 'profilesModel', model });
  }

  private async profileAction(action: ProfileAction): Promise<void> {
    const { launch, t } = this.deps;
    const fail = (message: string) => this.deps.post({ type: 'error', message });
    try {
      if (action.kind === 'delete' && !(await launch.confirmDelete(action.name))) { this.postProfiles(); return; }
      const original = this.launchText;
      let newText: string;
      try {
        newText = applyProfileAction(original, action);
      } catch (e) {
        if (!(e instanceof ProfileError)) throw e;
        fail(t(e.code === 'exists' ? 'A profile with that name already exists.'
          : e.code === 'missing' ? 'Profile not found.'
          : e.code === 'emptyName' ? 'The profile name is empty.'
          : 'launchSettings.json is not valid JSON; fix it and reload.'));
        this.postProfiles();
        return;
      }
      const verify = async (): Promise<void> => {
        const text = await launch.read(this.launchPath);
        const problem = checkApplied(parseProfiles(text), action);
        if (problem) throw new Error(problem);
      };
      if (original === undefined) {
        await launch.create(this.launchPath, newText);
        await verify();
      } else {
        await writeTextAtomically(this.launchPath, newText, { ...this.deps.writer, validate: verify }, original);
      }
      if (action.kind === 'rename' && launch.getActive() === action.from) await launch.setActive(action.name);
      if (action.kind === 'delete' && launch.getActive() === action.name) await launch.setActive(undefined);
    } catch (e) {
      fail(e instanceof ChangedOnDiskError ? t('launchSettings.json changed on disk; it was reloaded.') : msg(e));
    }
    await this.loadProfiles();
  }

  private async save(edits: PropertyEdit[]): Promise<boolean> {
    if (edits.length === 0) return false; // nothing to save: no write, no evaluation
    if (!this.model) { this.deps.post({ type: 'error', message: this.deps.t('Project not loaded') }); return false; }
    if (this.model.readOnly) {
      this.deps.post({ type: 'error', message: this.deps.t('The project could not be evaluated, so it is read-only.') });
      return false;
    }
    const invalid = invalidEdit(edits);
    if (invalid) {
      const { t } = this.deps;
      this.deps.post({ type: 'error', message: t('{0}: {1}', t(invalid[0]), t(invalid[1])) });
      return false;
    }
    this.saving = true;
    try {
      this.model = await saveProperties(this.model, edits, this.deps);
      this.isDirty = false;
      this.edits = [];
      this.deps.post({ type: 'saved' });
      const labels = Object.fromEntries(labelKeys().map((k) => [k, this.deps.t(k)]));
      this.deps.post({ type: 'model', model: this.model, labels });
      return true;
    } catch (e) {
      this.deps.post(e instanceof ChangedOnDiskError ? { type: 'changedOnDisk' } : { type: 'error', message: msg(e) });
      return false;
    } finally {
      this.saving = false;
    }
  }
}

/** Describes what is wrong when `profiles` (read back from disk) do not reflect `action`; undefined when fine. */
export function checkApplied(profiles: ReturnType<typeof parseProfiles>, action: ProfileAction): string | undefined {
  const find = (n: string) => profiles.find((p) => p.name === n);
  const bad = (what: string) => `launchSettings.json does not contain the expected change (${what}).`;
  switch (action.kind) {
    case 'new': return find(action.name) ? undefined : bad(action.name);
    case 'duplicate': return find(action.name) ? undefined : bad(action.name);
    case 'rename': return find(action.name) && (action.name === action.from || !find(action.from)) ? undefined : bad(action.name);
    case 'delete': return find(action.name) ? bad(action.name) : undefined;
    case 'set': return find(action.name)?.[action.field] === action.value || (action.value === undefined && find(action.name) && find(action.name)![action.field] === undefined) ? undefined : bad(action.field);
    case 'env': {
      const got = find(action.name)?.environmentVariables;
      return got && JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(action.env).sort()) ? undefined : bad('env');
    }
  }
}
