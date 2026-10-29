import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPropertyEdits, checkDisjoint, PropertyEditError, type PropertyEdit } from '../../../src/properties/csprojEdit';
import { scanCsproj, originOf } from '../../../src/properties/csprojScan';

const FIX = join(__dirname, '../../fixtures/properties');
const webapi = readFileSync(join(FIX, 'webapi.csproj'), 'utf8');
const handmade = readFileSync(join(FIX, 'handmade.csproj'), 'utf8');

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof PropertyEditError) return e.code; throw e; }
  return undefined;
}

/** Asserts `out` equals `src` with [start,end) replaced by exactly `inserted`. */
function expectSingleSplice(src: string, out: string, start: number, end: number, inserted: string) {
  expect(out.slice(0, start)).toBe(src.slice(0, start));
  expect(out.slice(out.length - (src.length - end))).toBe(src.slice(end));
  expect(out.slice(start, out.length - (src.length - end))).toBe(inserted);
}

describe('fixtures', () => {
  it('hand-made fixture really has a BOM and CRLF', () => {
    const bytes = readFileSync(join(FIX, 'handmade.csproj'));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(handmade.charCodeAt(0)).toBe(0xfeff);
    expect(handmade.split('\n').length - 1).toBe(handmade.split('\r\n').length - 1);
    expect(handmade).toContain('\t\t<OutputType>');
  });
});

describe('applyPropertyEdits', () => {
  it('set existing changes only that element', () => {
    const o = scanCsproj(webapi).occurrences.find((x) => x.name === 'Nullable')!;
    const out = applyPropertyEdits(webapi, [{ kind: 'set', name: 'Nullable', value: 'disable' }]);
    expect(out).toBe(webapi.slice(0, o.valueStart) + 'disable' + webapi.slice(o.valueEnd));
  });

  it('set existing replaces the last unconditional duplicate only', () => {
    const xml = '<Project>\n  <PropertyGroup>\n    <A>1</A>\n    <A>2</A>\n  </PropertyGroup>\n</Project>\n';
    expect(applyPropertyEdits(xml, [{ kind: 'set', name: 'A', value: '3' }]))
      .toBe('<Project>\n  <PropertyGroup>\n    <A>1</A>\n    <A>3</A>\n  </PropertyGroup>\n</Project>\n');
  });

  it('set inherited appends to first unconditional group with matching indent and CRLF', () => {
    const s = scanCsproj(handmade);
    const g = s.groups.find((x) => !x.conditional)!;
    const lineStart = handmade.lastIndexOf('\n', g.closeStart) + 1;
    const out = applyPropertyEdits(handmade, [{ kind: 'set', name: 'LangVersion', value: 'latest' }]);
    expectSingleSplice(handmade, out, lineStart, lineStart, '\t\t<LangVersion>latest</LangVersion>\r\n');
    expect(out).toContain('</AssemblyName>\r\n\t\t<LangVersion>latest</LangVersion>\r\n\t</PropertyGroup>');
  });

  it('set inherited on webapi uses its two-space child indent and LF', () => {
    const out = applyPropertyEdits(webapi, [{ kind: 'set', name: 'RootNamespace', value: 'My.Api' }]);
    expect(out).toBe(webapi.replace(
      '    <ImplicitUsings>enable</ImplicitUsings>\n',
      '    <ImplicitUsings>enable</ImplicitUsings>\n    <RootNamespace>My.Api</RootNamespace>\n',
    ));
  });

  it('several inherited sets go into the group in edit order', () => {
    const out = applyPropertyEdits(webapi, [
      { kind: 'set', name: 'B', value: '2' },
      { kind: 'set', name: 'A', value: '1' },
    ]);
    expect(out).toContain('</ImplicitUsings>\n    <B>2</B>\n    <A>1</A>\n  </PropertyGroup>');
  });

  it('set inherited into an inline group inserts before the close tag', () => {
    const xml = '<Project>\n  <PropertyGroup><A>1</A></PropertyGroup>\n</Project>\n';
    expect(applyPropertyEdits(xml, [{ kind: 'set', name: 'B', value: '2' }]))
      .toBe('<Project>\n  <PropertyGroup><A>1</A><B>2</B></PropertyGroup>\n</Project>\n');
  });

  it('set when no unconditional group creates one after <Project>', () => {
    const xml = '\uFEFF<Project Sdk="X">\r\n\t<PropertyGroup Condition="1==1">\r\n\t\t<A>1</A>\r\n\t</PropertyGroup>\r\n</Project>\r\n';
    const s = scanCsproj(xml);
    const out = applyPropertyEdits(xml, [{ kind: 'set', name: 'B', value: '2' }]);
    expectSingleSplice(xml, out, s.projectOpenEnd, s.projectOpenEnd,
      '\r\n\t<PropertyGroup>\r\n\t\t<B>2</B>\r\n\t</PropertyGroup>');
  });

  it('set with no groups at all creates one with two-space indent', () => {
    const xml = '<Project Sdk="X">\n</Project>\n';
    expect(applyPropertyEdits(xml, [{ kind: 'set', name: 'B', value: '2' }, { kind: 'set', name: 'C', value: '3' }]))
      .toBe('<Project Sdk="X">\n  <PropertyGroup>\n    <B>2</B>\n    <C>3</C>\n  </PropertyGroup>\n</Project>\n');
  });

  it('set on conditional-only throws conditional', () => {
    expect(codeOf(() => applyPropertyEdits(handmade, [{ kind: 'set', name: 'Optimize', value: 'false' }]))).toBe('conditional');
  });

  it('remove deletes the element and its line', () => {
    const out = applyPropertyEdits(webapi, [{ kind: 'remove', name: 'Nullable' }]);
    expect(out).toBe(webapi.replace('    <Nullable>enable</Nullable>\n', ''));
  });

  it('remove on CRLF deletes the CRLF too', () => {
    const out = applyPropertyEdits(handmade, [{ kind: 'remove', name: 'OutputType' }]);
    expect(out).toBe(handmade.replace('\t\t<OutputType>Exe</OutputType>\r\n', ''));
  });

  it('remove of an absent or conditional-only property does nothing', () => {
    expect(applyPropertyEdits(handmade, [{ kind: 'remove', name: 'Nope' }])).toBe(handmade);
    expect(applyPropertyEdits(handmade, [{ kind: 'remove', name: 'Optimize' }])).toBe(handmade);
  });

  it('remove of an inline element keeps the rest of the line', () => {
    const xml = '<Project>\n  <PropertyGroup><A>1</A> <B>2</B></PropertyGroup>\n</Project>\n';
    expect(applyPropertyEdits(xml, [{ kind: 'remove', name: 'B' }]))
      .toBe('<Project>\n  <PropertyGroup><A>1</A></PropertyGroup>\n</Project>\n');
  });

  it('remove deletes every unconditional duplicate so the property goes back to inherited', () => {
    const xml = '<Project>\n  <PropertyGroup>\n    <A>1</A>\n    <B>b</B>\n  </PropertyGroup>\n'
      + '  <PropertyGroup Condition="1==1">\n    <A>c</A>\n  </PropertyGroup>\n'
      + '  <PropertyGroup>\n    <A>2</A>\n  </PropertyGroup>\n</Project>\n';
    const out = applyPropertyEdits(xml, [{ kind: 'remove', name: 'A' }]);
    expect(out).toBe('<Project>\n  <PropertyGroup>\n    <B>b</B>\n  </PropertyGroup>\n'
      + '  <PropertyGroup Condition="1==1">\n    <A>c</A>\n  </PropertyGroup>\n'
      + '  <PropertyGroup>\n  </PropertyGroup>\n</Project>\n');
    expect(originOf(scanCsproj(out), 'A').origin).toBe('conditional');
    const plain = '<Project>\n  <PropertyGroup>\n    <A>1</A>\n    <A>2</A>\n  </PropertyGroup>\n</Project>\n';
    const out2 = applyPropertyEdits(plain, [{ kind: 'remove', name: 'A' }]);
    expect(out2).toBe('<Project>\n  <PropertyGroup>\n  </PropertyGroup>\n</Project>\n');
    expect(originOf(scanCsproj(out2), 'A').origin).toBe('inherited');
  });

  it('remove next to a same-line comment keeps the comment (extra space accepted)', () => {
    const xml = '<Project>\n  <PropertyGroup>\n    <A>1</A> <!-- c -->\n  </PropertyGroup>\n</Project>\n';
    expect(applyPropertyEdits(xml, [{ kind: 'remove', name: 'A' }]))
      .toBe('<Project>\n  <PropertyGroup>\n     <!-- c -->\n  </PropertyGroup>\n</Project>\n');
  });

  it('targetFrameworks with 2 tfms replaces TargetFramework by TargetFrameworks', () => {
    const out = applyPropertyEdits(webapi, [{ kind: 'targetFrameworks', tfms: ['net8.0', 'net10.0'] }]);
    expect(out).toBe(webapi.replace(
      '<TargetFramework>net10.0</TargetFramework>',
      '<TargetFrameworks>net8.0;net10.0</TargetFrameworks>',
    ));
  });

  it('targetFrameworks with 1 tfm on a multi-target project goes back to TargetFramework', () => {
    const multi = webapi.replace('<TargetFramework>net10.0</TargetFramework>', '<TargetFrameworks>net8.0;net10.0</TargetFrameworks>');
    const out = applyPropertyEdits(multi, [{ kind: 'targetFrameworks', tfms: ['net10.0'] }]);
    expect(out).toBe(webapi);
  });

  it('targetFrameworks with 1 tfm on a single-target project just sets the value', () => {
    const out = applyPropertyEdits(handmade, [{ kind: 'targetFrameworks', tfms: ['net10.0'] }]);
    expect(out).toBe(handmade.replace('<TargetFramework>net8.0<', '<TargetFramework>net10.0<'));
  });

  it('targetFrameworks keeps attributes when renaming and removes a leftover', () => {
    const xml = '<Project>\n  <PropertyGroup>\n    <TargetFramework Label="t">net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n';
    expect(applyPropertyEdits(xml, [{ kind: 'targetFrameworks', tfms: ['net8.0', 'net9.0'] }]))
      .toBe('<Project>\n  <PropertyGroup>\n    <TargetFrameworks Label="t">net8.0;net9.0</TargetFrameworks>\n  </PropertyGroup>\n</Project>\n');
    const both = '<Project>\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <TargetFrameworks>net8.0;net9.0</TargetFrameworks>\n  </PropertyGroup>\n</Project>\n';
    expect(applyPropertyEdits(both, [{ kind: 'targetFrameworks', tfms: ['net9.0'] }]))
      .toBe('<Project>\n  <PropertyGroup>\n    <TargetFramework>net9.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n');
  });

  it('targetFrameworks rejects an empty list or a TFM with a newline', () => {
    expect(codeOf(() => applyPropertyEdits(webapi, [{ kind: 'targetFrameworks', tfms: [] }]))).toBe('invalidValue');
    expect(codeOf(() => applyPropertyEdits(webapi, [{ kind: 'targetFrameworks', tfms: ['net8.0', 'net9.0\n'] }]))).toBe('invalidValue');
  });

  it('targetFrameworks cannot be combined with a plain TargetFramework(s) edit, in either order', () => {
    const tf: PropertyEdit = { kind: 'targetFrameworks', tfms: ['net8.0', 'net10.0'] };
    const others: PropertyEdit[] = [
      { kind: 'set', name: 'TargetFrameworks', value: 'q;r' },
      { kind: 'set', name: 'TargetFramework', value: 'net8.0' },
      { kind: 'remove', name: 'TargetFramework' },
      { kind: 'remove', name: 'TargetFrameworks' },
      { kind: 'targetFrameworks', tfms: ['net9.0'] },
    ];
    for (const other of others) {
      expect(codeOf(() => applyPropertyEdits(webapi, [tf, other]))).toBe('invalidName');
      expect(codeOf(() => applyPropertyEdits(webapi, [other, tf]))).toBe('invalidName');
    }
    expect(applyPropertyEdits(webapi, [tf, { kind: 'set', name: 'Nullable', value: 'disable' }]))
      .toBe(webapi.replace('<TargetFramework>net10.0</TargetFramework>', '<TargetFrameworks>net8.0;net10.0</TargetFrameworks>')
        .replace('<Nullable>enable<', '<Nullable>disable<'));
  });

  it('rejects values with CR, LF or XML-illegal control characters, allows TAB', () => {
    for (const value of ['a\nb', 'a\r\nb', 'a\rb', '\u0000', '\u0001', '\u001F']) {
      expect(codeOf(() => applyPropertyEdits(webapi, [{ kind: 'set', name: 'Nullable', value }]))).toBe('invalidValue');
    }
    const out = applyPropertyEdits(webapi, [{ kind: 'set', name: 'Nullable', value: 'a\tb' }]);
    expect(out).toBe(webapi.replace('<Nullable>enable<', '<Nullable>a\tb<'));
  });

  it('keeps $(Prop) references literally', () => {
    const out = applyPropertyEdits(webapi, [{ kind: 'set', name: 'Product', value: '$(AssemblyName);$(Foo)' }]);
    expect(out).toContain('    <Product>$(AssemblyName);$(Foo)</Product>\n');
    expect(originOf(scanCsproj(out), 'Product').last!.value).toBe('$(AssemblyName);$(Foo)');
  });

  it('an existing &amp; round-trips through scan and set', () => {
    const company = originOf(scanCsproj(handmade), 'Company').last!;
    expect(company.value).toBe('Smith & Sons');
    expect(applyPropertyEdits(handmade, [{ kind: 'set', name: 'Company', value: company.value }])).toBe(handmade);
    const literal = applyPropertyEdits(handmade, [{ kind: 'set', name: 'Company', value: 'X &amp; Y' }]);
    expect(literal).toBe(handmade.replace('Smith &amp; Sons', 'X &amp;amp; Y'));
    expect(originOf(scanCsproj(literal), 'Company').last!.value).toBe('X &amp; Y');
  });

  it('checkDisjoint throws postcondition on overlapping splices', () => {
    const code = (s: { start: number; end: number }[]) => codeOf(() => checkDisjoint(s));
    expect(code([{ start: 0, end: 5 }, { start: 4, end: 8 }])).toBe('postcondition');
    expect(code([{ start: 2, end: 4 }, { start: 0, end: 10 }])).toBe('postcondition');
    expect(code([{ start: 0, end: 5 }, { start: 3, end: 3 }])).toBe('postcondition');
    expect(code([{ start: 0, end: 5 }, { start: 5, end: 5 }, { start: 5, end: 9 }, { start: 0, end: 0 }, { start: 9, end: 9 }])).toBeUndefined();
  });

  it('escapes & < >', () => {
    const out = applyPropertyEdits(handmade, [{ kind: 'set', name: 'Company', value: 'A & B <C> "q"' }]);
    expect(out).toBe(handmade.replace('Smith &amp; Sons', 'A &amp; B &lt;C&gt; "q"'));
    expect(originOf(scanCsproj(out), 'Company').last!.value).toBe('A & B <C> "q"');
  });

  it('escapes & < > in inserted and self-closing elements', () => {
    const out = applyPropertyEdits(webapi, [{ kind: 'set', name: 'Product', value: 'a&b<c>' }]);
    expect(out).toContain('    <Product>a&amp;b&lt;c&gt;</Product>\n');
    const sc = applyPropertyEdits(handmade, [{ kind: 'set', name: 'Nullable', value: '<&>' }]);
    expect(sc).toBe(handmade.replace('<Nullable />', '<Nullable>&lt;&amp;&gt;</Nullable>'));
  });

  it('self-closing element becomes element with value', () => {
    const out = applyPropertyEdits(handmade, [{ kind: 'set', name: 'Nullable', value: 'enable' }]);
    expect(out).toBe(handmade.replace('<Nullable />', '<Nullable>enable</Nullable>'));
    const xml = '<Project>\n  <PropertyGroup>\n    <X Label="a/>b"/>\n  </PropertyGroup>\n</Project>\n';
    expect(applyPropertyEdits(xml, [{ kind: 'set', name: 'X', value: '1' }]))
      .toBe('<Project>\n  <PropertyGroup>\n    <X Label="a/>b">1</X>\n  </PropertyGroup>\n</Project>\n');
  });

  it('BOM, comments and Condition groups of the hand-made fixture stay byte-identical outside the edit', () => {
    const s = scanCsproj(handmade);
    const o = originOf(s, 'AssemblyName').last!;
    const out = applyPropertyEdits(handmade, [{ kind: 'set', name: 'AssemblyName', value: 'Renamed' }]);
    expectSingleSplice(handmade, out, o.valueStart, o.valueEnd, 'Renamed');
    expect(out.charCodeAt(0)).toBe(0xfeff);
    const cond = handmade.slice(handmade.indexOf('\t<PropertyGroup Condition'), handmade.indexOf('\t<ItemGroup>'));
    expect(out).toContain(cond);
    expect(out).toContain('\t\t<!-- <RootNamespace>Old</RootNamespace> -->\r\n');
    expect(Buffer.from(out, 'utf8').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('several edits in one call apply on one scan', () => {
    const out = applyPropertyEdits(handmade, [
      { kind: 'set', name: 'OutputType', value: 'Library' },
      { kind: 'remove', name: 'Company' },
      { kind: 'set', name: 'LangVersion', value: '12' },
    ]);
    expect(out).toBe(handmade
      .replace('<OutputType>Exe<', '<OutputType>Library<')
      .replace('\t\t<Company>Smith &amp; Sons</Company>\r\n', '')
      .replace('</AssemblyName>\r\n', '</AssemblyName>\r\n\t\t<LangVersion>12</LangVersion>\r\n'));
  });

  it('a later edit of the same name wins', () => {
    const out = applyPropertyEdits(webapi, [
      { kind: 'set', name: 'Nullable', value: 'disable' },
      { kind: 'remove', name: 'Nullable' },
    ]);
    expect(out).toBe(webapi.replace('    <Nullable>enable</Nullable>\n', ''));
  });

  it('rejects invalid property names', () => {
    for (const name of ['', '1A', 'A B', 'A>', '<A', 'A/B', 'é']) {
      expect(codeOf(() => applyPropertyEdits(webapi, [{ kind: 'set', name, value: 'x' }]))).toBe('invalidName');
      expect(codeOf(() => applyPropertyEdits(webapi, [{ kind: 'remove', name }]))).toBe('invalidName');
    }
    expect(applyPropertyEdits(webapi, [{ kind: 'set', name: '_A.b-1', value: 'x' }])).toContain('<_A.b-1>x</_A.b-1>');
  });

  it('refuses to insert into a PropertyGroup with no real close tag', () => {
    const xml = '<Project>\n  <PropertyGroup>\n    <A>1</A>\n</Project>\n';
    expect(codeOf(() => applyPropertyEdits(xml, [{ kind: 'set', name: 'B', value: '2' }]))).toBe('postcondition');
    const empty = '<Project>\n  <PropertyGroup>\n</Project>\n';
    expect(codeOf(() => applyPropertyEdits(empty, [{ kind: 'set', name: 'B', value: '2' }]))).toBe('postcondition');
  });

  it('inserts into an empty but closed PropertyGroup', () => {
    const xml = '<Project>\n  <PropertyGroup></PropertyGroup>\n</Project>\n';
    expect(applyPropertyEdits(xml, [{ kind: 'set', name: 'B', value: '2' }]))
      .toBe('<Project>\n  <PropertyGroup><B>2</B></PropertyGroup>\n</Project>\n');
  });

  it('throws postcondition when there is no <Project> element', () => {
    expect(codeOf(() => applyPropertyEdits('<!-- nothing -->', [{ kind: 'set', name: 'B', value: '2' }]))).toBe('postcondition');
  });

  it('PropertyEditError carries its code', () => {
    const e = new PropertyEditError('conditional', 'msg');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('conditional');
    expect(e.name).toBe('PropertyEditError');
  });
});
