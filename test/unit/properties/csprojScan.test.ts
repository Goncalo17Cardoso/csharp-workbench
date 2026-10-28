import { describe, it, expect } from 'vitest';
import { scanCsproj, originOf } from '../../../src/properties/csprojScan';

const wrap = (body: string, eol = '\n') =>
  `<Project Sdk="Microsoft.NET.Sdk">${eol}${body}${eol}</Project>${eol}`;

describe('scanCsproj', () => {
  it('finds a simple property with exact offsets', () => {
    const xml = wrap('  <PropertyGroup>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>');
    const s = scanCsproj(xml);
    expect(s.occurrences).toHaveLength(1);
    const o = s.occurrences[0];
    expect(xml.slice(o.start, o.end)).toBe('<Nullable>enable</Nullable>');
    expect(xml.slice(o.valueStart, o.valueEnd)).toBe('enable');
    expect(o).toMatchObject({ name: 'Nullable', value: 'enable', rawValue: 'enable', selfClosing: false, conditional: false, groupIndex: 0 });
    expect(xml.slice(0, s.projectOpenEnd)).toBe('<Project Sdk="Microsoft.NET.Sdk">');
    const g = s.groups[0];
    expect(xml.slice(g.closeStart, g.closeStart + 16)).toBe('</PropertyGroup>');
    expect(xml.slice(g.openEnd - 1, g.openEnd + 1)).toBe('>\n');
  });

  it('marks properties in a Condition group as conditional', () => {
    const xml = wrap(`  <PropertyGroup Condition="'$(Configuration)'=='Debug'">\n    <DebugType>full</DebugType>\n  </PropertyGroup>`);
    const s = scanCsproj(xml);
    expect(s.groups[0].conditional).toBe(true);
    expect(s.occurrences[0].conditional).toBe(true);
  });

  it('marks an element with its own Condition as conditional', () => {
    const xml = wrap(`  <PropertyGroup>\n    <A Condition="'$(X)'=='1'">a</A>\n    <B>b</B>\n  </PropertyGroup>`);
    const s = scanCsproj(xml);
    expect(s.groups[0].conditional).toBe(false);
    expect(s.occurrences.map((o) => o.conditional)).toEqual([true, false]);
  });

  it('ignores commented-out properties', () => {
    const xml = wrap(`  <PropertyGroup>\n    <!-- <Nullable>enable</Nullable> -->\n    <A>1</A>\n  </PropertyGroup>`);
    expect(scanCsproj(xml).occurrences.map((o) => o.name)).toEqual(['A']);
  });

  it('handles self-closing <Nullable />', () => {
    const xml = wrap(`  <PropertyGroup>\n    <Nullable />\n    <B></B>\n  </PropertyGroup>`);
    const [n, b] = scanCsproj(xml).occurrences;
    expect(xml.slice(n.start, n.end)).toBe('<Nullable />');
    expect(n).toMatchObject({ rawValue: '', value: '', selfClosing: true, valueStart: n.valueEnd });
    expect(b).toMatchObject({ rawValue: '', selfClosing: false });
    expect(xml.slice(b.start, b.end)).toBe('<B></B>');
  });

  it('decodes &amp; in value but keeps rawValue', () => {
    const xml = wrap(`  <PropertyGroup>\n    <Company>A &amp; B &#65;</Company>\n  </PropertyGroup>`);
    const o = scanCsproj(xml).occurrences[0];
    expect(o.rawValue).toBe('A &amp; B &#65;');
    expect(o.value).toBe('A & B A');
  });

  it('detects CRLF and BOM files without shifting offsets', () => {
    const xml = '﻿' + wrap(`  <PropertyGroup>\r\n    <A>1</A>\r\n  </PropertyGroup>`, '\r\n');
    const s = scanCsproj(xml);
    expect(s.eol).toBe('\r\n');
    const o = s.occurrences[0];
    expect(xml.slice(o.start, o.end)).toBe('<A>1</A>');
    expect(xml.slice(0, s.projectOpenEnd)).toBe('﻿<Project Sdk="Microsoft.NET.Sdk">');
    expect(s.groups[0].childIndent).toBe('    ');
  });

  it('originOf returns last unconditional and duplicates', () => {
    const xml = wrap(
      `  <PropertyGroup>\n    <A>1</A>\n    <C>x</C>\n  </PropertyGroup>\n  <PropertyGroup Condition="true">\n    <A>9</A>\n    <D>d</D>\n  </PropertyGroup>\n  <PropertyGroup>\n    <A>2</A>\n  </PropertyGroup>`,
    );
    const s = scanCsproj(xml);
    const a = originOf(s, 'A');
    expect(a.origin).toBe('project');
    expect(a.duplicates).toBe(true);
    expect(a.last?.value).toBe('2');
    expect(originOf(s, 'C')).toMatchObject({ origin: 'project', duplicates: false });
    expect(originOf(s, 'D')).toMatchObject({ origin: 'conditional', duplicates: false });
    expect(originOf(s, 'Z')).toEqual({ origin: 'inherited', duplicates: false });
  });

  it('PropertyGroup inside Choose/When is conditional', () => {
    const xml = wrap(
      `  <Choose>\n    <When Condition="true">\n      <PropertyGroup>\n        <A>1</A>\n      </PropertyGroup>\n    </When>\n    <Otherwise>\n      <PropertyGroup><A>2</A></PropertyGroup>\n    </Otherwise>\n  </Choose>`,
    );
    const s = scanCsproj(xml);
    expect(s.occurrences).toHaveLength(2);
    expect(s.occurrences.every((o) => o.conditional)).toBe(true);
    expect(originOf(s, 'A').origin).toBe('conditional');
  });

  it('ignores ItemGroup content and self-closing groups', () => {
    const xml = wrap(`  <PropertyGroup/>\n  <ItemGroup>\n    <Foo>1</Foo>\n  </ItemGroup>\n  <PropertyGroup>\n    <A>1</A>\n  </PropertyGroup>`);
    const s = scanCsproj(xml);
    expect(s.occurrences.map((o) => o.name)).toEqual(['A']);
    expect(s.groups).toHaveLength(1);
  });

  it('records group indent and child indent', () => {
    const tabs = wrap(`\t<PropertyGroup>\n\t\t<A>1</A>\n\t</PropertyGroup>\n\t<PropertyGroup>\n\t</PropertyGroup>`);
    const t = scanCsproj(tabs).groups;
    expect(t[0]).toMatchObject({ indent: '\t', childIndent: '\t\t' });
    expect(t[1]).toMatchObject({ indent: '\t', childIndent: '\t\t' });
    const sp = wrap(`  <PropertyGroup>\n    <A>1</A>\n  </PropertyGroup>`);
    expect(scanCsproj(sp).groups[0]).toMatchObject({ indent: '  ', childIndent: '    ' });
    const empty = wrap(`<PropertyGroup>\n</PropertyGroup>`);
    expect(scanCsproj(empty).groups[0]).toMatchObject({ indent: '', childIndent: '  ' });
  });
});
