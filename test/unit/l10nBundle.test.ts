import { readFileSync } from 'node:fs';
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
