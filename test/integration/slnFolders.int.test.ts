import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DotnetCli } from '../../src/dotnet/cli';
import { nodeExec } from '../../src/dotnet/exec';
import { findDotnet } from '../../src/dotnet/locate';
import { createOutput } from '../../src/output';
import { addFolder, removeEmptyFolder, renameFolder } from '../../src/solution/slnFolders';
import { loadSolution } from '../../src/solution/slnParse';
import { nodeSolutionFs, writeSolutionAtomically } from '../../src/solution/slnWriter';

const home = os.homedir();
const dotnet = await findDotnet({
  pathEnv: process.env.PATH ?? '',
  home,
  exists: (p) => fs.access(p).then(() => true, () => false),
});

const T = 120_000;

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(dotnet!, args, { cwd }, (err, stdout, stderr) =>
      err ? reject(new Error(`dotnet ${args.join(' ')} failed: ${stderr || stdout || err.message}`)) : resolve(stdout),
    );
  });
}

describe.skipIf(!dotnet)('solution-folder edits validated by the dotnet CLI', () => {
  let root: string;
  let project: string;
  const cli = () => new DotnetCli(nodeExec, dotnet!, createOutput({ appendLine: () => {} }));

  beforeAll(async () => {
    process.env.DOTNET_ROOT ??= path.join(home, '.dotnet');
    root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-')), 'My App #1');
    await fs.mkdir(root);
    await run(['new', 'classlib', '-n', 'Lib', '-o', 'src/Lib', '-f', 'net8.0'], root);
    project = path.join(root, 'src', 'Lib', 'Lib.csproj');
  }, T);
  afterAll(async () => {
    if (root) await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  for (const kind of ['sln', 'slnx'] as const) {
    it(`${kind}: add, rename and remove folders; dotnet sln list and add --solution-folder agree`, async () => {
      await run(['new', 'sln', '--format', kind, '-n', `App-${kind}`], root);
      const sln = path.join(root, `App-${kind}.${kind}`);
      const read = () => nodeSolutionFs.readFile(sln);
      const model = () => loadSolution(sln, read);
      const newGuid = () => randomUUID();
      const edit = async (change: (text: string) => string) => {
        await writeSolutionAtomically(sln, change(await read()), {
          ...nodeSolutionFs,
          validate: async () => { await cli().slnList(sln); },
        });
        await cli().slnList(sln); // still valid after the edit
      };

      const bom = (await fs.readFile(sln)).subarray(0, 3);

      await edit((t) => addFolder(t, kind, 'src', undefined, newGuid));
      const src = (await model()).folders.find((f) => f.name === 'src')!;
      await edit((t) => addFolder(t, kind, 'Old Name', src.id, newGuid));
      await edit((t) => addFolder(t, kind, 'scratch', undefined, newGuid));
      const old = (await model()).folders.find((f) => f.name === 'Old Name')!;
      expect(old.parentId).toBe(src.id);

      await edit((t) => renameFolder(t, kind, old.id, 'Web #1'));
      let m = await model();
      const renamed = m.folders.find((f) => f.name === 'Web #1')!;
      expect(renamed.parentId).toBe(src.id);
      expect(m.folders.some((f) => f.name === 'Old Name')).toBe(false);

      const scratch = m.folders.find((f) => f.name === 'scratch')!;
      await edit((t) => removeEmptyFolder(t, kind, scratch.id));
      m = await model();
      expect(m.folders.map((f) => f.name).sort()).toEqual(['Web #1', 'src']);

      await cli().slnAdd(sln, project, 'src/Web #1');
      m = await model();
      expect(m.folders.filter((f) => f.name === 'Web #1')).toHaveLength(1);
      expect(m.projects.find((p) => p.name === 'Lib')!.folderId).toBe(renamed.id);
      expect((await cli().slnList(sln)).map((p) => p.path)).toEqual([project]);

      // Our edits never dropped the BOM that `dotnet new sln` wrote (if any).
      expect((await fs.readFile(sln)).subarray(0, 3)).toEqual(bom);

      // A result that dotnet rejects is rolled back byte for byte.
      const before = await fs.readFile(sln);
      const broken = kind === 'sln' ? 'not a solution\r\n' : '<Solution>\n  <Folder Name="/x/">\n</Solution>\n';
      await expect(writeSolutionAtomically(sln, broken, {
        ...nodeSolutionFs,
        validate: async () => { await cli().slnList(sln); },
      })).rejects.toThrow(/dotnet sln failed/);
      expect(await fs.readFile(sln)).toEqual(before);
      expect((await fs.readdir(root)).filter((f) => f.endsWith('.cw-tmp'))).toEqual([]);
    }, T);
  }
});
