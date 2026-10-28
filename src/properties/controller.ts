// Host-side logic of the Project Properties panel. Pure: no vscode import.
import { ChangedOnDiskError } from '../core/atomicWrite';
import { loadProperties, saveProperties, type PropertiesDeps, type PropertiesModel } from './model';
import type { PropsToHost, PropsToWebview } from './protocol';
import { FIELDS, validateIdentifierPath, validateTfm, validateVersion } from './schema';

export interface ControllerDeps extends PropertiesDeps {
  post(m: PropsToWebview): void;
  onSecrets(): void;
  openAt(property: string): void;
  t(key: string, ...a: string[]): string;
}

const SECTIONS = ['Application', 'Build', 'Package', 'Assembly', 'Debug', 'Secrets'];

/** English keys of every label the webview shows (field labels, sections, validator messages). */
export function labelKeys(): string[] {
  const messages = [validateTfm('x'), validateVersion('x'), validateIdentifierPath('')];
  return [...new Set([...FIELDS.map((f) => f.label), ...SECTIONS, ...messages.filter((m): m is string => !!m)])];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class PropertiesController {
  private model: PropertiesModel | undefined;
  private isDirty = false;

  constructor(private readonly projectPath: string, private readonly deps: ControllerDeps) {}

  get dirty(): boolean { return this.isDirty; }

  async handle(m: PropsToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.deps.post({ type: 'loading' });
        await this.load();
        return;
      case 'reload':
        this.isDirty = false;
        await this.load();
        return;
      case 'dirty':
        this.isDirty = m.dirty;
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
    }
  }

  onFileChanged(): void {
    if (this.isDirty) this.deps.post({ type: 'changedOnDisk' });
    else void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.model = await loadProperties(this.projectPath, this.deps);
      const labels = Object.fromEntries(labelKeys().map((k) => [k, this.deps.t(k)]));
      this.deps.post({ type: 'model', model: this.model, labels });
    } catch (e) {
      this.deps.post({ type: 'error', message: msg(e) });
    }
  }

  private async save(edits: Extract<PropsToHost, { type: 'save' }>['edits']): Promise<void> {
    if (!this.model) { this.deps.post({ type: 'error', message: this.deps.t('Project not loaded') }); return; }
    if (this.model.readOnly) {
      this.deps.post({ type: 'error', message: this.deps.t('The project could not be evaluated, so it is read-only.') });
      return;
    }
    try {
      this.model = await saveProperties(this.model, edits, this.deps);
      this.isDirty = false;
      this.deps.post({ type: 'saved' });
      const labels = Object.fromEntries(labelKeys().map((k) => [k, this.deps.t(k)]));
      this.deps.post({ type: 'model', model: this.model, labels });
    } catch (e) {
      this.deps.post(e instanceof ChangedOnDiskError ? { type: 'changedOnDisk' } : { type: 'error', message: msg(e) });
    }
  }
}
