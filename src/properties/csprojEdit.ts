// Minimal-diff editor for unconditional PropertyGroup property elements in a .csproj.
// Everything outside the edited ranges stays byte-identical (BOM, EOLs, comments,
// attributes, Condition groups). All edits are planned on one scan of the original
// text, applied in descending offset order, and then verified by a rescan.
//
// Choices:
// - Several edits of the same property name in one call: the last one wins.
// - A `targetFrameworks` edit owns both TargetFramework and TargetFrameworks: a second
//   `targetFrameworks` edit, or a plain set/remove of either name, in the same call
//   throws PropertyEditError('invalidName').
// - `remove` deletes ALL unconditional occurrences, so the property goes back to
//   inherited (or conditional-only). Conditional occurrences are kept.
// - A PropertyGroup without a real `</PropertyGroup>` (malformed XML; the scanner keeps
//   closeStart === openEnd) is never inserted into: PropertyEditError('postcondition').
//   We do not skip to a later group, because the scanner stops recording groups after
//   an unclosed one and the file is not valid MSBuild anyway.
// - Values with CR, LF or other XML-illegal control characters (U+0000-U+001F except
//   TAB), and an empty `targetFrameworks` list, throw PropertyEditError('invalidValue').
// - Splices must not overlap (checked before any text is built): 'postcondition'.

import { scanCsproj, originOf, type CsprojScan, type PropertyOccurrence } from './csprojScan';

export type PropertyEdit =
  | { kind: 'set'; name: string; value: string }
  | { kind: 'remove'; name: string }
  | { kind: 'targetFrameworks'; tfms: string[] }; // 1 → TargetFramework, >1 → TargetFrameworks; removes the other one

export type PropertyEditErrorCode = 'conditional' | 'postcondition' | 'invalidName' | 'invalidValue';

export class PropertyEditError extends Error {
  constructor(public readonly code: PropertyEditErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PropertyEditError';
  }
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ILLEGAL_VALUE_RE = /[\u0000-\u0008\u000A-\u001F]/;
const TF_NAMES = new Set(['TargetFramework', 'TargetFrameworks']);

type Op = { kind: 'set'; name: string; value: string } | { kind: 'remove'; name: string } | { kind: 'rename'; from: PropertyOccurrence; name: string; value: string };

interface Splice { start: number; end: number; text: string; seq: number }

function escapeXmlText(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function checkName(name: string): void {
  if (!NAME_RE.test(name)) throw new PropertyEditError('invalidName', `Invalid property name: ${JSON.stringify(name)}`);
}

function checkValue(value: string): void {
  if (ILLEGAL_VALUE_RE.test(value)) {
    throw new PropertyEditError('invalidValue', `Invalid property value: ${JSON.stringify(value)}`);
  }
}

/** Open-tag attributes (with leading whitespace) of an element, without `>` or `/>`. */
function attrsOf(xml: string, o: PropertyOccurrence): string {
  const openEnd = o.selfClosing ? o.end : o.valueStart;
  const tag = xml.slice(o.start, openEnd);
  return tag.slice(1 + o.name.length).replace(/\s*\/?>$/, '');
}

/** Expand edits into per-name ops (last edit per name wins), validating names. */
function normalize(scan: CsprojScan, edits: PropertyEdit[]): Op[] {
  const byName = new Map<string, Op>();
  const put = (op: Op) => { byName.delete(op.name); byName.set(op.name, op); };
  const tfEdits = edits.filter((e) => e.kind === 'targetFrameworks').length;
  if (tfEdits > 1 || (tfEdits === 1 && edits.some((e) => e.kind !== 'targetFrameworks' && TF_NAMES.has(e.name)))) {
    throw new PropertyEditError('invalidName', 'targetFrameworks cannot be combined with other TargetFramework(s) edits');
  }
  for (const e of edits) {
    if (e.kind === 'targetFrameworks') {
      if (e.tfms.length === 0) throw new PropertyEditError('invalidValue', 'targetFrameworks needs at least one TFM');
      e.tfms.forEach(checkValue);
      const [want, other] = e.tfms.length === 1 ? ['TargetFramework', 'TargetFrameworks'] : ['TargetFrameworks', 'TargetFramework'];
      const value = e.tfms.join(';');
      const wantOrigin = originOf(scan, want).origin;
      const otherInfo = originOf(scan, other);
      if (wantOrigin === 'inherited' && otherInfo.origin === 'project' && !otherInfo.duplicates) {
        // Rename the existing element in place so the property keeps its position.
        byName.delete(other);
        put({ kind: 'rename', from: otherInfo.last!, name: want, value });
      } else {
        put({ kind: 'set', name: want, value });
        put({ kind: 'remove', name: other });
      }
      continue;
    }
    checkName(e.name);
    if (e.kind === 'set') checkValue(e.value);
    put(e.kind === 'set' ? { kind: 'set', name: e.name, value: e.value } : { kind: 'remove', name: e.name });
  }
  return [...byName.values()];
}

function removalRange(xml: string, o: PropertyOccurrence): { start: number; end: number } {
  let s = o.start;
  while (s > 0 && (xml[s - 1] === ' ' || xml[s - 1] === '\t')) s--;
  let e = o.end;
  while (e < xml.length && (xml[e] === ' ' || xml[e] === '\t')) e++;
  const atLineStart = s === 0 || xml[s - 1] === '\n' || (s === 1 && xml[0] === '\uFEFF');
  const eolLen = xml.startsWith('\r\n', e) ? 2 : xml[e] === '\n' ? 1 : e === xml.length ? 0 : -1;
  if (atLineStart && eolLen >= 0) return { start: s, end: e + eolLen };
  // Inline element: drop it with its leading whitespace, unless that whitespace is the line's indent.
  return { start: atLineStart ? o.start : s, end: o.end };
}

function hasRealClose(xml: string, closeStart: number): boolean {
  return /^<\/\s*PropertyGroup\s*>/.test(xml.slice(closeStart, closeStart + 64));
}

interface Plan {
  splices: Splice[];
  /** Original occurrences replaced or deleted by a splice. */
  touched: Set<PropertyOccurrence>;
  /** Number of property elements the splices write. */
  produced: number;
}

function plan(xml: string, scan: CsprojScan, ops: Op[]): Plan {
  const splices: Splice[] = [];
  const touched = new Set<PropertyOccurrence>();
  let seq = 0;
  const inserts: string[] = [];

  for (const op of ops) {
    if (op.kind === 'rename') {
      const o = op.from;
      touched.add(o);
      splices.push({ start: o.start, end: o.end, text: `<${op.name}${attrsOf(xml, o)}>${escapeXmlText(op.value)}</${op.name}>`, seq: seq++ });
      continue;
    }
    const info = originOf(scan, op.name);
    if (op.kind === 'remove') {
      for (const o of scan.occurrences) {
        if (o.name !== op.name || o.conditional) continue;
        touched.add(o);
        splices.push({ ...removalRange(xml, o), text: '', seq: seq++ });
      }
      continue;
    }
    if (info.origin === 'conditional') {
      throw new PropertyEditError('conditional', `${op.name} is only set under a condition`);
    }
    const esc = escapeXmlText(op.value);
    if (info.origin === 'project') {
      const o = info.last!;
      touched.add(o);
      if (o.selfClosing) splices.push({ start: o.start, end: o.end, text: `<${op.name}${attrsOf(xml, o)}>${esc}</${op.name}>`, seq: seq++ });
      else splices.push({ start: o.valueStart, end: o.valueEnd, text: esc, seq: seq++ });
    } else {
      inserts.push(`<${op.name}>${esc}</${op.name}>`);
    }
  }

  if (inserts.length) {
    const eol = scan.eol;
    const g = scan.groups.find((x) => !x.conditional);
    if (g) {
      if (!hasRealClose(xml, g.closeStart)) {
        throw new PropertyEditError('postcondition', 'PropertyGroup has no closing tag');
      }
      const lineStart = xml.lastIndexOf('\n', g.closeStart - 1) + 1;
      const before = xml.slice(lineStart, g.closeStart);
      if (/^[ \t]*$/.test(before) && lineStart >= g.openEnd) {
        splices.push({ start: lineStart, end: lineStart, text: inserts.map((el) => g.childIndent + el + eol).join(''), seq: seq++ });
      } else {
        splices.push({ start: g.closeStart, end: g.closeStart, text: inserts.join(''), seq: seq++ });
      }
    } else {
      if (scan.projectOpenEnd === 0) throw new PropertyEditError('postcondition', 'No <Project> element found');
      const ref = scan.groups[0];
      const indent = ref ? ref.indent : '  ';
      const childIndent = ref ? ref.childIndent : '    ';
      const text = eol + indent + '<PropertyGroup>' + eol
        + inserts.map((el) => childIndent + el + eol).join('')
        + indent + '</PropertyGroup>';
      splices.push({ start: scan.projectOpenEnd, end: scan.projectOpenEnd, text, seq: seq++ });
    }
  }
  const produced = ops.filter((op) => op.kind !== 'remove').length;
  return { splices, touched, produced };
}

function verify(original: string, before: CsprojScan, out: string, ops: Op[], p: Plan): void {
  const fail = (why: string): never => { throw new PropertyEditError('postcondition', why); };
  const after = scanCsproj(out);

  for (const op of ops) {
    const info = originOf(after, op.name);
    if (op.kind === 'remove') {
      if (info.origin === 'project') fail(`${op.name} is still set after remove`);
    } else if (info.origin !== 'project' || info.last!.value !== op.value) {
      fail(`${op.name} does not have the intended value`);
    }
  }

  // Every occurrence that was not edited must survive at its shifted offset with identical text.
  const shiftOf = (pos: number) =>
    p.splices.reduce((d, s) => (s.end <= pos ? d + s.text.length - (s.end - s.start) : d), 0);
  const matched = new Set<PropertyOccurrence>();
  const byStart = new Map(after.occurrences.map((o) => [o.start, o]));
  for (const o of before.occurrences) {
    if (p.touched.has(o)) continue;
    const n = byStart.get(o.start + shiftOf(o.start));
    if (!n || n.name !== o.name || n.rawValue !== o.rawValue || n.conditional !== o.conditional
      || out.slice(n.start, n.end) !== original.slice(o.start, o.end)) {
      fail(`${o.name} changed unexpectedly`);
    }
    matched.add(n!);
  }
  const edited = new Set(ops.map((op) => op.name));
  const fresh = after.occurrences.filter((n) => !matched.has(n));
  if (fresh.length !== p.produced || fresh.some((n) => !edited.has(n.name) || n.conditional)) {
    fail('unexpected property elements after edit');
  }
}

/**
 * Throws 'postcondition' if two splices overlap. Zero-width inserts may touch a range's
 * boundary or each other, but not sit strictly inside a replaced range. Exported for tests.
 */
export function checkDisjoint(splices: ReadonlyArray<{ start: number; end: number }>): void {
  const sorted = [...splices].sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new PropertyEditError('postcondition', 'Internal error: overlapping edits');
    }
  }
}

export function applyPropertyEdits(xml: string, edits: PropertyEdit[]): string {
  const scan = scanCsproj(xml);
  const ops = normalize(scan, edits);
  const p = plan(xml, scan, ops);
  if (p.splices.length === 0) return xml;
  checkDisjoint(p.splices);
  const ordered = [...p.splices].sort((a, b) => b.start - a.start || b.seq - a.seq);
  let out = xml;
  for (const s of ordered) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  verify(xml, scan, out, ops, p);
  return out;
}
