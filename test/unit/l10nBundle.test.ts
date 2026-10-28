import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** String literals passed to the controller's `t(...)` / `vscode.l10n.t(...)` in a source file. */
function messages(src: string): string[] {
  return [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'"));
}

describe('l10n bundle', () => {
  it('has an entry for every host message', () => {
    const bundle = JSON.parse(read('l10n/bundle.l10n.json')) as Record<string, string>;
    const files = ['src/extension.ts', 'src/panel/PanelManager.ts', 'src/panel/controller.ts', 'src/ops/operations.ts'];
    const missing = files.flatMap((f) => messages(read(f))).filter((m) => !(m in bundle));
    expect(missing).toEqual([]);
  });
});

describe('l10n bundle covers src', () => {
  it('has every vscode.l10n.t literal in src', () => {
    const bundle = JSON.parse(read('l10n/bundle.l10n.json')) as Record<string, string>;
    const walk = (d: string): string[] => readdirSync(join(root, d), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
    const found = walk('src').flatMap((f) =>
      [...read(f).matchAll(/l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, (_x, c: string) => (c === 'n' ? '\n' : c))));
    const bad = walk('src').flatMap((f) => [...read(f).matchAll(/l10n\.t\(\s*(?!'|message\b)/g)].map(() => f));
    expect(bad, 'l10n.t must be called with a single-quoted literal').toEqual([]);
    expect(found.length).toBeGreaterThan(20);
    expect(found.filter((m) => !(m in bundle))).toEqual([]);
  });
});
