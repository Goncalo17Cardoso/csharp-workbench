// Pure, offset-tracking scanner of property elements in a .csproj.
// Offsets index the string exactly as read (a leading U+FEFF counts as offset 0).
//
// Choices: self-closing <PropertyGroup/> elements are ignored (not recorded,
// no groupIndex consumed) because nothing can be inserted into them in place.

export interface PropertyOccurrence {
  name: string;
  rawValue: string;
  value: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  selfClosing: boolean;
  conditional: boolean;
  groupIndex: number;
}

export interface CsprojGroup {
  index: number;
  conditional: boolean;
  openEnd: number;
  closeStart: number;
  indent: string;
  childIndent: string;
}

export interface CsprojScan {
  occurrences: PropertyOccurrence[];
  groups: CsprojGroup[];
  projectOpenEnd: number;
  eol: '\n' | '\r\n';
}

export type PropertyOrigin = 'project' | 'conditional' | 'inherited';

const CHOOSE_PARTS = new Set(['Choose', 'When', 'Otherwise']);

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => c.replace(/&/g, '\u0000amp;'))
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
      switch (e) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
      }
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    })
    .replace(/\u0000amp;/g, '&');
}

/** End offset (exclusive) of an open/self-closing tag starting at `from` ('<'), quote-aware. */
function tagEnd(xml: string, from: number): number {
  let q = '';
  for (let i = from + 1; i < xml.length; i++) {
    const c = xml[i];
    if (q) { if (c === q) q = ''; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i + 1;
  }
  return xml.length;
}

/** Find `</name>` from `from`, skipping comments and CDATA. */
function findClose(xml: string, from: number, name: string): { start: number; end: number } {
  let i = from;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt + 9); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml[lt + 1] === '/') {
      const e = tagEnd(xml, lt);
      if (xml.slice(lt + 2, e - 1).trim() === name) return { start: lt, end: e };
      i = e;
      continue;
    }
    i = lt + 1;
  }
  return { start: xml.length, end: xml.length };
}

function lineIndent(xml: string, pos: number): string {
  const ls = xml.lastIndexOf('\n', pos - 1) + 1;
  const m = /^[ \t]*/.exec(xml.slice(ls, pos));
  return m ? m[0] : '';
}

export function scanCsproj(xml: string): CsprojScan {
  const occurrences: PropertyOccurrence[] = [];
  const groups: CsprojGroup[] = [];
  const firstChildIndent = new Map<number, string>();
  let projectOpenEnd = 0;
  const nl = xml.indexOf('\n');
  const eol: '\n' | '\r\n' = nl > 0 && xml[nl - 1] === '\r' ? '\r\n' : '\n';

  const stack: string[] = [];
  let curGroup: CsprojGroup | undefined;
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt + 9); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt + 2); i = e < 0 ? xml.length : e + 2; continue; }
    if (xml.startsWith('<!', lt)) { i = tagEnd(xml, lt); continue; }
    if (xml[lt + 1] === '/') {
      const end = tagEnd(xml, lt);
      const name = xml.slice(lt + 2, end - 1).trim();
      const idx = stack.lastIndexOf(name);
      if (name === 'PropertyGroup' && curGroup && stack[stack.length - 1] === 'PropertyGroup') { curGroup.closeStart = lt; curGroup = undefined; }
      if (idx >= 0) stack.length = idx;
      i = end;
      continue;
    }
    const end = tagEnd(xml, lt);
    const tag = xml.slice(lt, end);
    const name = /^<([^\s/>]+)/.exec(tag)?.[1] ?? '';
    const selfClosing = tag.endsWith('/>');
    const hasCondition = /\sCondition\s*=/.test(tag);

    if (stack.length === 0 && name === 'Project') {
      projectOpenEnd = end;
    }

    if (curGroup && stack[stack.length - 1] === 'PropertyGroup') {
      // Direct child of a property group: a property element.
      let valueStart = end, valueEnd = end, elEnd = end;
      if (!selfClosing) {
        const found = findClose(xml, end, name);
        valueEnd = found.start;
        elEnd = found.end;
      }
      const rawValue = xml.slice(valueStart, valueEnd);
      if (!firstChildIndent.has(curGroup.index)) firstChildIndent.set(curGroup.index, lineIndent(xml, lt));
      occurrences.push({
        name, rawValue, value: decodeEntities(rawValue),
        start: lt, end: elEnd, valueStart, valueEnd, selfClosing,
        conditional: curGroup.conditional || hasCondition,
        groupIndex: curGroup.index,
      });
      i = elEnd;
      continue;
    }

    const parentsOk = stack.length >= 1 && stack[0] === 'Project' && stack.slice(1).every((p) => CHOOSE_PARTS.has(p));
    if (name === 'PropertyGroup' && parentsOk && !selfClosing) {
      const inChoose = stack.length > 1;
      const g: CsprojGroup = {
        index: groups.length,
        conditional: inChoose || hasCondition,
        openEnd: end, closeStart: end, indent: lineIndent(xml, lt), childIndent: '',
      };
      groups.push(g);
      curGroup = g;
      stack.push(name);
      i = end;
      continue;
    }
    if (!selfClosing) stack.push(name);
    i = end;
  }

  // Indent unit: first group that has children with a childIndent extending its indent.
  let unit = '';
  for (const g of groups) {
    const ci = firstChildIndent.get(g.index);
    if (ci !== undefined && ci.length > g.indent.length && ci.startsWith(g.indent)) { unit = ci.slice(g.indent.length); break; }
  }
  if (!unit) unit = '  ';
  for (const g of groups) g.childIndent = firstChildIndent.get(g.index) ?? g.indent + unit;

  return { occurrences, groups, projectOpenEnd, eol };
}

export function originOf(
  scan: CsprojScan,
  name: string,
): { origin: PropertyOrigin; duplicates: boolean; last?: PropertyOccurrence } {
  const all = scan.occurrences.filter((o) => o.name === name);
  const plain = all.filter((o) => !o.conditional);
  if (plain.length) return { origin: 'project', duplicates: plain.length > 1, last: plain[plain.length - 1] };
  if (all.length) return { origin: 'conditional', duplicates: false };
  return { origin: 'inherited', duplicates: false };
}
