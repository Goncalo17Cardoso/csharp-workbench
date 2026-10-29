import { describe, expect, it } from 'vitest';
import { PropertiesController, labelKeys } from '../../../src/properties/controller';
import type { PropsToWebview } from '../../../src/properties/protocol';

const P = '/p/a.csproj';
const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';

function mk(opts: { evalFails?: boolean; diskChangesBeforeWrite?: boolean; launch?: string; confirm?: boolean; viaWriter?: boolean } = {}) {
  const s = { launch: opts.launch as string | undefined, created: [] as string[], confirms: [] as string[], active: undefined as string | undefined, text: CSPROJ, tmp: '', writes: 0, posts: [] as PropsToWebview[], secrets: 0, opened: [] as string[] };
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
    launch: {
      read: async () => (opts.viaWriter ? s.text : s.launch),
      create: async (p, t) => { s.created.push(p); s.launch = t; },
      confirmDelete: async (n) => { s.confirms.push(n); return opts.confirm ?? true; },
      getActive: () => s.active,
      setActive: async (n) => { s.active = n; },
    },
    post: (m) => s.posts.push(m),
    onSecrets: () => { s.secrets++; },
    openAt: (p) => s.opened.push(p),
    t: (k) => `T:${k}`,
  });
  return { s, c };
}
const types = (s: { posts: PropsToWebview[] }) => s.posts.map((p) => p.type).filter((t) => t !== 'profilesModel');
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

  describe('launch profiles', () => {
    const PM = (s: { posts: PropsToWebview[] }) =>
      [...s.posts].reverse().find((p) => p.type === 'profilesModel') as Extract<PropsToWebview, { type: 'profilesModel' }>;

    it('ready posts profilesModel with exists=false when the file is absent', async () => {
      const { s, c } = mk();
      await c.handle({ type: 'ready' });
      expect(PM(s).model).toEqual({ profiles: [], path: '/p/Properties/launchSettings.json', exists: false });
    });

    it('profiles new on missing file creates Properties/launchSettings.json', async () => {
      const { s, c } = mk();
      await c.handle({ type: 'ready' });
      await c.handle({ type: 'profiles', action: { kind: 'new', name: 'web', commandName: 'Project' } });
      expect(s.created).toEqual(['/p/Properties/launchSettings.json']);
      expect(PM(s).model.exists).toBe(true);
      expect(PM(s).model.profiles.map((p) => p.name)).toEqual(['web']);
    });

    it('profiles set on an existing file writes atomically', async () => {
      const { s, c } = mk({ viaWriter: true });
      // the fake atomic writer stores into s.text, so it doubles as the launch file here
      s.text = '{"profiles":{"web":{"commandName":"Project"}}}';
      await c.handle({ type: 'ready' });
      await c.handle({ type: 'profiles', action: { kind: 'set', name: 'web', field: 'launchUrl', value: 'x' } });
      expect(s.posts.some((p) => p.type === 'error')).toBe(false);
      expect(s.text).toContain('"launchUrl": "x"');
    });

    it('delete asks confirmation and does nothing when declined', async () => {
      const { s, c } = mk({ launch: '{"profiles":{"web":{"commandName":"Project"}}}', confirm: false });
      await c.handle({ type: 'ready' });
      await c.handle({ type: 'profiles', action: { kind: 'delete', name: 'web' } });
      expect(s.confirms).toEqual(['web']);
      expect(s.launch).toContain('web');
      expect(PM(s).model.profiles).toHaveLength(1);
    });

    it('malformed launchSettings.json shows an error and is never written', async () => {
      const { s, c } = mk({ launch: '{ nope' });
      await c.handle({ type: 'ready' });
      s.posts.length = 0;
      await c.handle({ type: 'profiles', action: { kind: 'new', name: 'a', commandName: 'Project' } });
      expect(types(s)).toContain('error');
      expect(s.launch).toBe('{ nope');
      expect(s.writes).toBe(0);
    });

    it('duplicate name posts an error', async () => {
      const { s, c } = mk({ launch: '{"profiles":{"web":{"commandName":"Project"}}}' });
      await c.handle({ type: 'ready' });
      await c.handle({ type: 'profiles', action: { kind: 'new', name: 'web', commandName: 'Project' } });
      expect(s.posts.some((p) => p.type === 'error')).toBe(true);
    });

    it('setActiveProfile stores the name and posts the model with it as active', async () => {
      const { s, c } = mk({ launch: '{"profiles":{"a":{"commandName":"Project"},"b":{"commandName":"Project"}}}' });
      await c.handle({ type: 'ready' });
      expect(PM(s).model.active).toBe('a');
      await c.handle({ type: 'setActiveProfile', name: 'b' });
      expect(s.active).toBe('b');
      expect(PM(s).model.active).toBe('b');
    });

    it('two profile actions fired without awaiting both end up in the file', async () => {
      const { s, c } = mk({ viaWriter: true });
      s.text = '{"profiles":{"web":{"commandName":"Project"}}}';
      await c.handle({ type: 'ready' });
      const a = c.handle({ type: 'profiles', action: { kind: 'set', name: 'web', field: 'launchUrl', value: 'u' } });
      const b = c.handle({ type: 'profiles', action: { kind: 'set', name: 'web', field: 'applicationUrl', value: 'http://x' } });
      await Promise.all([a, b]);
      expect(s.text).toContain('"launchUrl": "u"');
      expect(s.text).toContain('"applicationUrl": "http://x"');
    });

    it('an external change to launchSettings.json is refused as changed on disk', async () => {
      const { s, c } = mk({ viaWriter: true, diskChangesBeforeWrite: true });
      s.text = '{"profiles":{"web":{"commandName":"Project"}}}';
      await c.handle({ type: 'ready' });
      s.posts.length = 0;
      await c.handle({ type: 'profiles', action: { kind: 'set', name: 'web', field: 'launchUrl', value: 'u' } });
      const err = s.posts.find((p) => p.type === 'error') as Extract<PropsToWebview, { type: 'error' }>;
      expect(err.message).toContain('changed on disk');
      expect(s.text).not.toContain('launchUrl');
    });

    it('a malformed file is flagged invalid in the model', async () => {
      const { s, c } = mk({ launch: '{ nope' });
      await c.handle({ type: 'ready' });
      expect(PM(s).model.invalid).toBeTruthy();
    });
  });
});
