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
    expect(out(0)).toBe('using MyApp.@class;\n\nnamespace MyApp._2D;\nclass A {}\n');
    expect(out(1)).toBe('using MyApp._2D;\n\nnamespace MyApp.@class;\nclass B {}\n');
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
    expect(out(0)).toBe('using MyApp.A;\n\nnamespace MyApp.B;\nclass X {}\n');
    expect(out(1)).toBe('using MyApp.B;\n\nnamespace MyApp.A;\nclass Y {}\n');
    expect(out(2)).toBe('class P { MyApp.B.X x; MyApp.A.Y y; }\n');
  });

  // ---- review fixes ----
  const replan = (files: SyncInputFile[], plan: ReturnType<typeof planSync>) =>
    planSync(files.map((x) => ({ ...x, text: apply(x.text, plan.edits.get(x.path)) })));

  it('nested namespace declaration keeps Old alive', () => {
    const files = [
      f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'),
      f('Lib/Other.cs', 'namespace MyApp { namespace Models { class Other {} } }\n', false),
      f('P.cs', 'using MyApp.Models;\nclass P {}\n', false),
    ];
    const { out } = run(files);
    expect(out(2)).toBe('using MyApp.Models;\nusing MyApp.Domain;\nclass P {}\n');
  });

  it('partial class left in Old is not rewritten and is reported ambiguous', () => {
    const files = [
      f('Domain/Customer.cs', 'namespace MyApp.Models;\npartial class Customer {}\n'),
      f('Models/Customer2.cs', 'namespace MyApp.Models;\npartial class Customer {}\n'),
      f('P.cs', 'class P { MyApp.Models.Customer c; }\n', false),
    ];
    const { plan, out } = run(files);
    expect(out(2)).toBe('class P { MyApp.Models.Customer c; }\n');
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0]).toMatchObject({ from: 'MyApp.Models', type: 'Customer' });
  });

  it('out-of-scope declaration of the same type blocks the rewrite', () => {
    const { plan, out } = run([
      f('Domain/Customer.cs', 'namespace MyApp.Models;\nclass Customer {}\n'),
      f('Lib/C.cs', 'namespace MyApp.Models;\nclass Customer {}\n', false),
      f('P.cs', 'class P { MyApp.Models.Customer c; MyApp.Models.Customer d; }\n', false),
    ]);
    expect(out(2)).toBe('class P { MyApp.Models.Customer c; MyApp.Models.Customer d; }\n');
    expect(plan.ambiguous).toHaveLength(1);
  });

  it('same type moved to two targets is ambiguous', () => {
    const { plan, out } = run([
      f('A/C.cs', 'namespace Old;\nclass C {}\n'), f('B/C.cs', 'namespace Old;\nclass C {}\n'),
      f('P.cs', 'class P { Old.C c; }\n', false),
    ]);
    expect(out(2)).toBe('class P { Old.C c; }\n');
    expect(plan.ambiguous).toEqual([{ from: 'Old', type: 'C', targets: ['MyApp.A', 'MyApp.B'] }]);
  });

  it('moved file gets using Old when Old still exists, and replan is empty', () => {
    const files = [
      f('Domain/Customer.cs', 'using System;\nnamespace MyApp.Models;\nclass Customer { Order o; }\n'),
      f('Models/Order.cs', 'namespace MyApp.Models;\nclass Order { Customer c; }\n'),
    ];
    const { plan, out } = run(files);
    expect(out(0)).toBe('using System;\nusing MyApp.Models;\nnamespace MyApp.Domain;\nclass Customer { Order o; }\n');
    expect(replan(files, plan).edits.size).toBe(0);
  });

  it('unmoved sibling gets using Target before the namespace, BOM kept', () => {
    const files = [
      f('Domain/Customer.cs', 'namespace MyApp.Models;\nclass Customer {}\n'),
      f('Models/Order.cs', '\uFEFFnamespace MyApp.Models;\r\nclass Order { Customer c; }\r\n'),
    ];
    const { plan, out } = run(files);
    expect(out(1)).toBe('\uFEFFusing MyApp.Domain;\r\n\r\nnamespace MyApp.Models;\r\nclass Order { Customer c; }\r\n');
    expect(replan(files, plan).edits.size).toBe(0);
  });

  it('split targets give each moved file the others', () => {
    const files = [
      f('A/X.cs', 'namespace Old;\nclass X {}\n'), f('B/Y.cs', 'namespace Old;\nclass Y {}\n'),
    ];
    const { plan, out } = run(files);
    expect(out(0)).toBe('using MyApp.B;\n\nnamespace MyApp.A;\nclass X {}\n');
    expect(out(1)).toBe('using MyApp.A;\n\nnamespace MyApp.B;\nclass Y {}\n');
    expect(replan(files, plan).edits.size).toBe(0);
  });

  it('gone using whose target is already imported is deleted', () => {
    const files = [
      f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'),
      f('P.cs', 'using System;\nusing MyApp.Models;\nusing MyApp.Domain;\nclass P {}\n', false),
    ];
    const { plan, out } = run(files);
    expect(out(1)).toBe('using System;\nusing MyApp.Domain;\nclass P {}\n');
    expect(replan(files, plan).edits.size).toBe(0);
  });

  it('deleted anchor directive still receives implicit usings', () => {
    const files = [
      f('A/X.cs', 'using MyApp.Z;\nusing Old2;\nnamespace Old;\nclass X {}\n'),
      f('B/Y.cs', 'namespace Old;\nclass Y {}\n'),
      f('Z/W.cs', 'namespace Old2;\nclass W {}\n'),
    ];
    const { plan, out } = run(files);
    expect(out(0)).toBe('using MyApp.Z;\nusing MyApp.B;\nnamespace MyApp.A;\nclass X {}\n');
    expect(replan(files, plan).edits.size).toBe(0);
  });


  it('usings go before assembly attributes (block form)', () => {
    const files = [
      f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'),
      f('Models/D.cs', '// header\n[assembly: System.CLSCompliant(true)]\nnamespace MyApp.Models\n{\n  class D {}\n}\n'),
    ];
    const { plan, out } = run(files);
    expect(out(1)).toBe('// header\nusing MyApp.Domain;\n\n[assembly: System.CLSCompliant(true)]\nnamespace MyApp.Models\n{\n  class D {}\n}\n');
    expect(replan(files, plan).edits.size).toBe(0);
  });

  it('usings go after extern alias and before module attributes', () => {
    const files = [
      f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'),
      f('Models/D.cs', 'extern alias Z;\n[module: System.CLSCompliant(true)]\nnamespace MyApp.Models;\nclass D {}\n'),
    ];
    const { plan, out } = run(files);
    expect(out(1)).toBe('extern alias Z;\nusing MyApp.Domain;\n[module: System.CLSCompliant(true)]\nnamespace MyApp.Models;\nclass D {}\n');
    expect(replan(files, plan).edits.size).toBe(0);
  });

  it('extern alias alone: usings follow it', () => {
    const files = [
      f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'),
      f('Models/D.cs', 'extern alias Z; // c\r\nnamespace MyApp.Models\r\n{\r\n}\r\n'),
    ];
    const { plan, out } = run(files);
    expect(out(1)).toBe('extern alias Z; // c\r\nusing MyApp.Domain;\r\nnamespace MyApp.Models\r\n{\r\n}\r\n');
    expect(replan(files, plan).edits.size).toBe(0);
  });

  it('an indexer is not an attribute list', () => {
    const { out } = run([
      f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'),
      f('Models/D.cs', 'var a = args[0];\nnamespace MyApp.Models;\nclass D {}\n'),
    ]);
    expect(out(1)).toBe('var a = args[0];\nusing MyApp.Domain;\n\nnamespace MyApp.Models;\nclass D {}\n');
  });

  it('two inserts at the same offset merge into one edit in a fixed order', () => {
    const files = [
      f('A/X.cs', 'namespace Old1;\nclass X {}\n'), f('B/Y.cs', 'namespace Old1;\nclass Y {}\n'),
      f('C/Z.cs', 'namespace Old2;\nclass Z {}\n'),
      f('P.cs', 'using Old1;\nnamespace Old2 { }\n', false),
    ];
    const { plan, out } = run(files);
    expect(out(3)).toBe('using MyApp.A;\nusing MyApp.B;\nusing MyApp.C;\nnamespace Old2 { }\n');
    expect(plan.edits.get(files[3].path)).toHaveLength(2); // name replacement + one merged insert
  });

  it('deleting a using with a trailing comment removes the whole line', () => {
    const { out } = run([
      f('Domain/C.cs', 'namespace MyApp.Models;\nclass C {}\n'),
      f('P.cs', 'using MyApp.Domain;\nusing MyApp.Models; // old\nclass P {}\n', false),
    ]);
    expect(out(1)).toBe('using MyApp.Domain;\nclass P {}\n');
  });
});
