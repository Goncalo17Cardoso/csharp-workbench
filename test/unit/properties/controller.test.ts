import { describe, expect, it } from 'vitest';
import { PropertiesController, labelKeys } from '../../../src/properties/controller';
import type { PropsToWebview } from '../../../src/properties/protocol';

const P = '/p/a.csproj';
const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';

function mk(opts: { evalFails?: boolean; diskChangesBeforeWrite?: boolean } = {}) {
  const s = { text: CSPROJ, tmp: '', writes: 0, posts: [] as PropsToWebview[], secrets: 0, opened: [] as string[] };
  const c = new PropertiesController(P, {
    readText: async () => s.text,
    getProperties: async (_p, names) => {
      if (opts.evalFails) throw new Error('boom');
      const m = /<(Version)>([^<]*)</.exec(s.tmp || s.text);
      return Object.fromEntries(names.map((n) => [n, n === 'Version' && m ? m[2] : n === 'TargetFramework' ? 'net8.0' : '']));
    },
    writer: {
      readFile: async () => (opts.diskChangesBeforeWrite ? s.text + '<!-- other -->' : s.text),
      writeFile: async (p, t) => { s.writes++; if (p.endsWith('.cw-tmp')) s.tmp = t; else if (!p.endsWith('.cw-bak')) s.text = t; },
      rename: async () => { s.text = s.tmp; s.tmp = ''; },
      unlink: async () => {},
      realpath: async (p) => p,
      mode: async () => 0o644,
      chmod: async () => {},
      canWrite: async () => true,
    },
    post: (m) => s.posts.push(m),
    onSecrets: () => { s.secrets++; },
    openAt: (p) => s.opened.push(p),
    t: (k) => `T:${k}`,
  });
  return { s, c };
}
const types = (s: { posts: PropsToWebview[] }) => s.posts.map((p) => p.type);
const flush = () => new Promise((r) => setTimeout(r, 0));
const setVersion = [{ kind: 'set' as const, name: 'Version', value: '1.2.3' }];

describe('PropertiesController', () => {
  it('ready posts loading then model with translated labels', async () => {
    const { s, c } = mk();
    await c.handle({ type: 'ready' });
    expect(types(s)).toEqual(['loading', 'model']);
    const m = s.posts[1] as Extract<PropsToWebview, { type: 'model' }>;
    for (const k of labelKeys()) expect(m.labels[k]).toBe(`T:${k}`);
    expect(m.labels['Output type']).toBe('T:Output type');
  });

  it('save posts saved and a reloaded model', async () => {
    const { s, c } = mk();
    await c.handle({ type: 'ready' });
    s.posts.length = 0;
    await c.handle({ type: 'dirty', dirty: true, edits: setVersion });
    await c.handle({ type: 'save', edits: setVersion });
    expect(types(s)).toEqual(['saved', 'model']);
    expect(s.text).toContain('<Version>1.2.3</Version>');
    expect(c.dirty).toBe(false);
  });

  it('save with ChangedOnDiskError posts changedOnDisk and does not write', async () => {
    const { s, c } = mk({ diskChangesBeforeWrite: true });
    await c.handle({ type: 'ready' });
    s.posts.length = 0;
    await c.handle({ type: 'save', edits: setVersion });
    expect(types(s)).toEqual(['changedOnDisk']);
    expect(s.writes).toBe(0);
    expect(s.text).toBe(CSPROJ);
  });

  it('onFileChanged while dirty posts changedOnDisk, while clean reloads', async () => {
    const { s, c } = mk();
    await c.handle({ type: 'ready' });
    s.posts.length = 0;
    s.text = s.text + '<!-- external -->';
    c.onFileChanged();
    await flush();
    expect(types(s)).toEqual(['model']);
    s.posts.length = 0;
    await c.handle({ type: 'dirty', dirty: true, edits: [] });
    s.text = s.text + '<!-- external 2 -->';
    c.onFileChanged();
    await flush();
    expect(types(s)).toEqual(['changedOnDisk']);
  });

  it('readOnly model rejects save', async () => {
    const { s, c } = mk({ evalFails: true });
    await c.handle({ type: 'ready' });
    s.posts.length = 0;
    await c.handle({ type: 'save', edits: setVersion });
    expect(types(s)).toEqual(['error']);
    expect(s.writes).toBe(0);
  });

  it('routes secrets and openCsproj to deps', async () => {
    const { s, c } = mk();
    await c.handle({ type: 'manageSecrets' });
    await c.handle({ type: 'openCsproj', property: 'Version' });
    expect(s.secrets).toBe(1);
    expect(s.opened).toEqual(['Version']);
  });

  it('dirty stores the edits and saveCurrent saves them', async () => {
    const { s, c } = mk();
    await c.handle({ type: 'ready' });
    await c.handle({ type: 'dirty', dirty: true, edits: setVersion });
    expect(c.pendingEdits).toEqual(setVersion);
    expect(await c.saveCurrent()).toBe(true);
    expect(s.text).toContain('<Version>1.2.3</Version>');
    expect(c.pendingEdits).toEqual([]);
  });

  it('saveCurrent on a ChangedOnDisk failure writes nothing and returns false', async () => {
    const { s, c } = mk({ diskChangesBeforeWrite: true });
    await c.handle({ type: 'ready' });
    await c.handle({ type: 'dirty', dirty: true, edits: setVersion });
    expect(await c.saveCurrent()).toBe(false);
    expect(s.writes).toBe(0);
  });

  it('the watcher event from our own save does not post changedOnDisk', async () => {
    const { s, c } = mk();
    await c.handle({ type: 'ready' });
    await c.handle({ type: 'dirty', dirty: true, edits: setVersion });
    await c.handle({ type: 'save', edits: setVersion });
    s.posts.length = 0;
    await c.handle({ type: 'dirty', dirty: true, edits: [] });
    c.onFileChanged(); // disk text equals what we wrote
    await flush();
    expect(s.posts).toEqual([]);
  });
});
