import { describe, expect, it } from 'vitest';
import { planSync, type SyncInputFile, type TextEdit } from '../../../src/sync/plan';

const P = '/w/App';
const f = (rel: string, text: string, inScope = true): SyncInputFile => ({ path: `${P}/${rel}`, text, projectDir: P, rootNamespace: 'MyApp', inScope });
function apply(text: string, edits: TextEdit[] = []): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}
const run = (files: SyncInputFile[]) => {
  const plan = planSync(files);
  return { plan, out: (i: number) => apply(files[i].text, plan.edits.get(files[i].path)) };
};

describe('planSync', () => {
  it('moved file gets new file-scoped namespace', () => {
    const { plan, out } = run([f('Domain/Customer.cs', 'namespace MyApp.Models;\npublic class Customer {}\n')]);
    expect(out(0)).toBe('namespace MyApp.Domain;\npublic class Customer {}\n');
    expect(plan.moves).toEqual([{ from: 'MyApp.Models', to: 'MyApp.Domain', types: ['Customer'] }]);
  });

  it('block namespace keeps braces', () => {
    const { out } = run([f('Domain/C.cs', 'namespace MyApp.Models\n{\n  class C {}\n}\n')]);
    expect(out(0)).toBe('namespace MyApp.Domain\n{\n  class C {}\n}\n');
  });

  it('using of gone namespace is replaced', () => {
    const { out } = run([f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'), f('Program.cs', 'using System;\nusing MyApp.Models;\nnamespace MyApp;\nclass P {}\n')]);
    expect(out(1)).toBe('using System;\nusing MyApp.Domain;\nnamespace MyApp;\nclass P {}\n');
  });

  it('gone using with two targets keeps indent, global and EOL', () => {
    const { out } = run([
      f('A/X.cs', 'namespace Old;\r\nclass X {}\r\n'), f('B/Y.cs', 'namespace Old;\r\nclass Y {}\r\n'),
      f('P.cs', 'namespace MyApp\r\n{\r\n    using Old;\r\n}\r\n'), f('G.cs', 'global using Old;\r\n'),
    ]);
    expect(out(2)).toBe('namespace MyApp\r\n{\r\n    using MyApp.A;\r\n    using MyApp.B;\r\n}\r\n');
    expect(out(3)).toBe('global using MyApp.A;\r\nglobal using MyApp.B;\r\n');
  });

  it('using of still-existing namespace gets an added using', () => {
    const { out } = run([
      f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'), f('Models/D.cs', 'namespace MyApp.Models;\nclass D {}\n'),
      f('P.cs', 'using MyApp.Models;\nclass P {}\n'), f('Domain/Q.cs', 'namespace MyApp.Domain;\nusing MyApp.Models;\nclass Q {}\n'),
    ]);
    expect(out(2)).toBe('using MyApp.Models;\nusing MyApp.Domain;\nclass P {}\n');
    expect(out(3)).toBe('namespace MyApp.Domain;\nusing MyApp.Models;\nclass Q {}\n');
  });

  it('qualified MyApp.Models.Customer becomes MyApp.Domain.Customer', () => {
    const { out } = run([
      f('Domain/Customer.cs', 'namespace MyApp.Models;\nclass Customer {}\n'),
      f('P.cs', 'namespace MyApp;\nclass P { MyApp.Models.Customer a; global::MyApp.Models.Customer b; var n = customer.Address.City; MyApp.Models.Other c; }\n'),
    ]);
    expect(out(1)).toBe('namespace MyApp;\nclass P { MyApp.Domain.Customer a; global::MyApp.Domain.Customer b; var n = customer.Address.City; MyApp.Models.Other c; }\n');
  });

  it('alias and static usings with a moved type are rewritten', () => {
    const { out } = run([
      f('Domain/Customer.cs', 'namespace MyApp.Models;\nclass Customer {}\n'),
      f('P.cs', 'using X = MyApp.Models.Customer;\nusing static MyApp.Models.Customer;\nclass P {}\n'),
    ]);
    expect(out(1)).toBe('using X = MyApp.Domain.Customer;\nusing static MyApp.Domain.Customer;\nclass P {}\n');
  });

  it('files with two namespaces, nested, #if, none are skipped with reasons', () => {
    const { plan } = run([
      f('Domain/a.cs', 'namespace A;\nnamespace B {}\n'),
      f('Domain/b.cs', 'namespace A { namespace B { } }\n'),
      f('Domain/c.cs', '#if X\nnamespace Z;\n#endif\nclass C {}\n'),
      f('Domain/d.cs', 'class D {}\n'),
    ]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['multipleNamespaces', 'nested', 'preprocessor', 'noNamespace']);
    expect(plan.edits.size).toBe(0);
  });

  it('#if files get no reference edits either', () => {
    const { plan } = run([
      f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'),
      f('P.cs', '#if X\nusing MyApp.Models;\n#endif\n', false),
    ]);
    expect(plan.edits.has(`${P}/P.cs`)).toBe(false);
  });

  it('out-of-scope files only get reference edits', () => {
    const { plan, out } = run([
      f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'),
      f('Other/Z.cs', 'namespace Wrong;\nusing MyApp.Models;\nclass Z {}\n', false),
    ]);
    expect(out(1)).toBe('namespace Wrong;\nusing MyApp.Domain;\nclass Z {}\n');
    expect(plan.skipped).toEqual([]);
  });

  it('folder named 2D and class keyword folder use namespaceFor sanitising', () => {
    const { out } = run([f('2D/A.cs', 'namespace X;\nclass A {}\n'), f('class/B.cs', 'namespace X;\nclass B {}\n')]);
    expect(out(0)).toBe('namespace MyApp._2D;\nclass A {}\n');
    expect(out(1)).toBe('namespace MyApp.@class;\nclass B {}\n');
  });

  it('no change when already in sync gives empty plan', () => {
    const plan = planSync([f('Domain/C.cs', 'namespace MyApp.Domain;\nclass C {}\n'), f('P.cs', 'using MyApp.Domain;\n', false)]);
    expect(plan.edits.size).toBe(0);
    expect(plan.moves).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('swapped folder names are computed from original text', () => {
    const { out } = run([
      f('B/X.cs', 'namespace MyApp.A;\nclass X {}\n'), f('A/Y.cs', 'namespace MyApp.B;\nclass Y {}\n'),
      f('P.cs', 'class P { MyApp.A.X x; MyApp.B.Y y; }\n'),
    ]);
    expect(out(0)).toBe('namespace MyApp.B;\nclass X {}\n');
    expect(out(1)).toBe('namespace MyApp.A;\nclass Y {}\n');
    expect(out(2)).toBe('class P { MyApp.B.X x; MyApp.A.Y y; }\n');
  });
});
