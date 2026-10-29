import { describe, expect, it } from 'vitest';
import { analyzeCs } from '../../../src/sync/csTokens';

/** Every reported span must slice back to exactly the reported name. */
function spans(text: string) {
  const r = analyzeCs(text);
  return {
    r,
    ns: r.namespaces.map((n) => text.slice(n.nameStart, n.nameEnd)),
    usings: r.usings.map((u) => text.slice(u.nameStart, u.nameEnd)),
    q: r.qualified.map((q) => q.text),
    qSlices: r.qualified.map((q) => text.slice(q.start, q.end)),
  };
}

describe('analyzeCs', () => {
  it('file-scoped namespace with offsets', () => {
    const text = 'using System;\n\nnamespace Acme.Models;\n\npublic class Customer { }\n';
    const r = analyzeCs(text);
    expect(r.namespaces).toEqual([{ name: 'Acme.Models', nameStart: text.indexOf('Acme'), nameEnd: text.indexOf(';\n\npublic'), fileScoped: true, depth: 0 }]);
    expect(r.typeNames).toEqual(['Customer']);
  });

  it('offsets index the JS string including a leading BOM', () => {
    const text = '﻿namespace A.B;\nclass C {}';
    const ns = analyzeCs(text).namespaces[0];
    expect(ns.nameStart).toBe(11);
    expect(text.slice(ns.nameStart, ns.nameEnd)).toBe('A.B');
  });

  it('block namespace and nested namespace depth', () => {
    const text = 'namespace Outer.X\n{\n  namespace Inner\n  {\n    class A {}\n  }\n  class B { class Nested {} }\n}\nnamespace Second { }\n';
    const { r, ns } = spans(text);
    expect(r.namespaces.map((n) => [n.name, n.depth, n.fileScoped])).toEqual([['Outer.X', 0, false], ['Inner', 1, false], ['Second', 0, false]]);
    expect(ns).toEqual(['Outer.X', 'Inner', 'Second']);
    expect(r.typeNames).toEqual(['A', 'B']);
  });

  it('namespace text inside // /* */ "…" @"…" $"…" and """…""" is ignored', () => {
    const text = [
      '// namespace C1;',
      '/* namespace C2 { } */',
      'class S {',
      '  string a = "namespace S1; \\" namespace S2;";',
      '  string b = @"namespace V1 ""namespace V2;"" ";',
      '  string c = $"namespace I1 {{ }} {x} namespace I2;";',
      '  string d = """',
      '    namespace R1; " "" ',
      '    """;',
      '  string e = $$"""namespace R2 {x} {{y}} """;',
      '  string f = """"namespace R3 """ namespace R4"""";',
      '  char g = \'"\'; char h = \'\\\'\';',
      '  string i = @$"namespace VI1 ""{z}"" namespace VI2";',
      '  string j = $@"namespace VI3 {z} ""namespace VI4""";',
      '}',
      'namespace Real;',
    ].join('\n');
    expect(analyzeCs(text).namespaces.map((n) => n.name)).toEqual(['Real']);
  });

  it('interpolation holes are code', () => {
    const text = 'class C { string s = $"a {Foo.Bar.Baz} b {"x".Length} {Q.R:N2} {(c ? D.E : 1)}"; }';
    const { q, qSlices } = spans(text);
    expect(q).toEqual(['Foo.Bar.Baz', 'Q.R', 'D.E']);
    expect(qSlices).toEqual(q);
  });

  it('nested strings inside holes, raw holes with multiple $, and format clauses', () => {
    const text = [
      'class C {',
      '  string a = $"{M($"{In.Ner} \\"not.Code\\"")} {Out.Er}";',
      '  string b = $$"""{literal.Text} {{Raw.Hole}} {{{Three.Brace}}}""";',
      '  string c = $"{d:yyyy.MM}" + After.Str;',
      '  string e = $@"{V.Erb} ""quoted.Text"" ";',
      '}',
    ].join('\n');
    expect(spans(text).q).toEqual(['In.Ner', 'Out.Er', 'Raw.Hole', 'Three.Brace', 'After.Str', 'V.Erb']);
  });

  it('char literals do not open strings', () => {
    const text = "class C { char a = '\"'; char b = '\\''; char c = '{'; object d = X.Y; }";
    expect(spans(text).q).toEqual(['X.Y']);
  });

  it('using, global using, using static, using alias = X.Y', () => {
    const text = [
      'global using System.Text;',
      'using System;',
      'using static System.Math;',
      'using Alias = Acme.Models.Customer;',
      'using G = global::Acme.Other;',
      'namespace N',
      '{',
      '  using Inner.Thing;',
      '  class C { void M() { using var x = Open(); using (var y = Open()) {} } }',
      '}',
    ].join('\n');
    const { r, usings } = spans(text);
    expect(r.usings.map((u) => ({ name: u.name, g: u.isGlobal, s: u.isStatic, a: u.alias, inNs: u.inNamespace, gq: u.globalQualified }))).toEqual([
      { name: 'System.Text', g: true, s: false, a: undefined, inNs: false, gq: false },
      { name: 'System', g: false, s: false, a: undefined, inNs: false, gq: false },
      { name: 'System.Math', g: false, s: true, a: undefined, inNs: false, gq: false },
      { name: 'Acme.Models.Customer', g: false, s: false, a: 'Alias', inNs: false, gq: false },
      { name: 'Acme.Other', g: false, s: false, a: 'G', inNs: false, gq: true },
      { name: 'Inner.Thing', g: false, s: false, a: undefined, inNs: true, gq: false },
    ]);
    expect(usings).toEqual(r.usings.map((u) => u.name));
    const first = r.usings[0];
    expect(text.slice(first.start, first.end)).toBe('global using System.Text;');
    const st = r.usings[2];
    expect(text.slice(st.start, st.end)).toBe('using static System.Math;');
  });

  it('usings after a file-scoped namespace are inNamespace', () => {
    const r = analyzeCs('namespace A;\nusing B.C;\nclass X {}');
    expect(r.usings.map((u) => [u.name, u.inNamespace])).toEqual([['B.C', true]]);
  });

  it('type names of top-level types', () => {
    const text = [
      'namespace N;',
      '[Serializable] public sealed partial class Customer<T> : Base.Type where T : class, new() { class Nested {} }',
      'public struct Point { }',
      'internal interface IThing { }',
      'enum Color : byte { Red }',
      'public record Person(string Name);',
      'record struct Money(decimal Amount);',
      'record class Ref { }',
      'public delegate Task<int> Handler<T>(T arg);',
      'delegate (int A, int B) TupleMaker();',
      'public class @class { }',
      'file static class Helpers { static void M() { var f = delegate (int x) { return x; }; } }',
    ].join('\n');
    expect(analyzeCs(text).typeNames).toEqual(['Customer', 'Point', 'IThing', 'Color', 'Person', 'Money', 'Ref', 'Handler', 'TupleMaker', '@class', 'Helpers']);
  });

  it('types outside any namespace are not reported', () => {
    expect(analyzeCs('class Global {}\nnamespace N { class Inside {} }').typeNames).toEqual(['Inside']);
  });

  it('#if around namespace sets flag', () => {
    expect(analyzeCs('#if DEBUG\nnamespace A;\n#endif\nclass C {}').hasPreprocessorAroundNamespace).toBe(true);
    expect(analyzeCs('#if DEBUG\nusing X;\n#endif\nnamespace A { }').hasPreprocessorAroundNamespace).toBe(false);
    expect(analyzeCs('#region R\nnamespace A { }\n#endregion').hasPreprocessorAroundNamespace).toBe(false);
    expect(analyzeCs('namespace A {\n#if X\nnamespace B { }\n#endif\n}').hasPreprocessorAroundNamespace).toBe(false);
    expect(analyzeCs('#if A\n#if B\n#endif\nnamespace N { }\n#endif').hasPreprocessorAroundNamespace).toBe(true);
  });

  it('preprocessor lines are skipped as text', () => {
    const text = '#pragma warning disable Foo.Bar // namespace P;\n#region namespace Q\nnamespace Real;\n#endregion\n#error "unterminated\nclass C { object o = A.B; }';
    const { r, q } = spans(text);
    expect(r.namespaces.map((n) => n.name)).toEqual(['Real']);
    expect(q).toEqual(['A.B']);
  });

  it('qualified names exclude using and namespace lines', () => {
    const text = [
      'using Acme.Models;',
      'using M = Acme.Models.Customer;',
      'namespace Acme.Services;',
      'class S : Acme.Models.IThing {',
      '  Acme.Models.Customer c = new Acme.Models.Customer();',
      '  object one = Single;',
      '  string s = string.Empty + this.Name.Length + x?.Y.Z + Call().Prop.Sub;',
      '  // Acme.Models.Commented',
      '  string t = "Acme.Models.InString";',
      '}',
    ].join('\n');
    const { q, qSlices } = spans(text);
    expect(q).toEqual(['Acme.Models.IThing', 'Acme.Models.Customer', 'Acme.Models.Customer']);
    expect(qSlices).toEqual(q);
  });

  it('qualified names: global::, generics, verbatim ids, trivia around dots', () => {
    const text = 'class C { global::Acme.Models.Customer a; global::Single b; Acme.List<Acme.Models.Item, X.Y> c; @namespace.@class d; Acme /* c */ . Models\n.Thing e; alias::Not.Reported f; }';
    const r = analyzeCs(text);
    expect(r.qualified.map((q) => [q.text, q.global])).toEqual([
      ['Acme.Models.Customer', true],
      ['Acme.List', false],
      ['Acme.Models.Item', false],
      ['X.Y', false],
      ['@namespace.@class', false],
      ['Acme.Models.Thing', false],
    ]);
    const g = r.qualified[0];
    expect(text.slice(g.start, g.end)).toBe('Acme.Models.Customer');
    expect(text.slice(g.start - 8, g.start)).toBe('global::');
    const t = r.qualified[5];
    expect(text.slice(t.start, t.end)).toBe('Acme /* c */ . Models\n.Thing');
  });

  it('numbers and range operators do not form chains', () => {
    expect(analyzeCs('class C { double d = 1.5e+3 + .5; var r = a..b; }').qualified).toEqual([]);
  });
});
