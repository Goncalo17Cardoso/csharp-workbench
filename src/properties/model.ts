// Loads the evaluated project properties and saves edits through the validated atomic writer.
import { writeTextAtomically, type TextWriterDeps } from '../core/atomicWrite';
import { applyPropertyEdits, type PropertyEdit } from './csprojEdit';
import { originOf, scanCsproj, type PropertyOrigin } from './csprojScan';
import { ALL_PROPERTIES, FIELDS } from './schema';

export interface FieldState {
  property: string;
  evaluated: string;
  /** The decoded text of the last unconditional element in the .csproj (`$(Foo)` stays literal). */
  raw?: string;
  origin: PropertyOrigin;
  duplicates: boolean;
}

export interface PropertiesModel {
  projectPath: string;
  text: string;
  fields: FieldState[];
  readOnly: boolean;
  error?: string;
}

export interface PropertiesDeps {
  readText(p: string): Promise<string>;
  getProperties(p: string, names: string[]): Promise<Record<string, string>>;
  writer: Omit<TextWriterDeps, 'validate'>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function loadProperties(projectPath: string, deps: PropertiesDeps): Promise<PropertiesModel> {
  const text = await deps.readText(projectPath);
  const scan = scanCsproj(text);
  let values: Record<string, string> = {};
  let error: string | undefined;
  try {
    values = await deps.getProperties(projectPath, ALL_PROPERTIES);
  } catch (e) {
    error = msg(e);
  }
  const fields: FieldState[] = FIELDS.map((f) => {
    // The TargetFramework(s) field reads TargetFrameworks when that is set.
    const source = f.kind === 'tfms' && (values.TargetFrameworks ?? '') !== '' ? 'TargetFrameworks' : f.property;
    const o = originOf(scan, source);
    return {
      property: f.property,
      evaluated: values[source] ?? '',
      raw: o.origin === 'project' ? o.last?.value : undefined,
      origin: o.origin,
      duplicates: o.duplicates,
    };
  });
  return { projectPath, text, fields, readOnly: error !== undefined, ...(error !== undefined ? { error } : {}) };
}

export async function saveProperties(
  model: PropertiesModel,
  edits: PropertyEdit[],
  deps: PropertiesDeps,
): Promise<PropertiesModel> {
  if (edits.length === 0) return model; // nothing to save: no write, no evaluation
  const newText = applyPropertyEdits(model.text, edits);
  if (newText === model.text) return model;
  const names = [...new Set(edits.flatMap((e) => (e.kind === 'targetFrameworks' ? ['TargetFramework', 'TargetFrameworks'] : [e.name])))];
  const validate = async (): Promise<void> => {
    const got = await deps.getProperties(model.projectPath, names);
    const scan = scanCsproj(newText);
    for (const e of edits) {
      if (e.kind === 'set') {
        if (got[e.name] !== e.value) throw new Error(`${e.name} evaluates to "${got[e.name]}", expected "${e.value}".`);
      } else if (e.kind === 'remove') {
        if (originOf(scan, e.name).origin === 'project') throw new Error(`${e.name} is still set in the project.`);
      } else {
        const key = e.tfms.length === 1 ? 'TargetFramework' : 'TargetFrameworks';
        const want = e.tfms.join(';');
        if (got[key] !== want) throw new Error(`${key} evaluates to "${got[key]}", expected "${want}".`);
      }
    }
  };
  await writeTextAtomically(model.projectPath, newText, { ...deps.writer, validate }, model.text);
  return loadProperties(model.projectPath, deps);
}
