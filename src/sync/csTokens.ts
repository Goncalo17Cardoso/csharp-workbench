// Pure C# tokenizer for Sync Namespaces. No `vscode` import.
//
// A single-pass lexer with a mode stack turns the source into code tokens (identifiers,
// punctuation, literal placeholders), skipping comments, strings, char literals and
// preprocessor lines. Interpolation holes are lexed as code. A small structural pass over
// those tokens then finds namespace declarations, using directives, top-level type names
// and dotted name chains. All offsets index the JS string (a leading U+FEFF counts).
//
// Known limits (text-level, not Roslyn):
// - Both branches of `#if/#else` are tokenized; braces split across branches confuse nesting.
// - Unicode escapes in identifiers (`A`) are not decoded.
// - Names that span trivia (`A /* c */ . B`) report `text` without trivia; the span covers it.

export interface NsDecl { name: string; nameStart: number; nameEnd: number; fileScoped: boolean; depth: number } // depth 0 = top level
export interface UsingDirective {
  name: string; nameStart: number; nameEnd: number; isGlobal: boolean; isStatic: boolean; alias?: string; start: number; end: number; inNamespace: boolean;
  /** Name was written as `global::Name`; the prefix is outside name/nameStart..nameEnd. */
  globalQualified: boolean;
}
export interface QualifiedName {
  text: string; start: number; end: number; // dotted identifier chains in code (not in using/namespace lines)
  /** Chain was written as `global::A.B`; the prefix is outside text/start..end. */
  global: boolean;
}
export interface CsFileInfo { namespaces: NsDecl[]; usings: UsingDirective[]; typeNames: string[] /* top-level types per namespace */; qualified: QualifiedName[]; hasPreprocessorAroundNamespace: boolean }

interface Tok { k: 'id' | 'p' | 'lit'; text: string; start: number; end: number; pp: number }

interface StrFrame { k: 'str'; verbatim: boolean; quotes: number /* 0 = not raw */; dollars: number /* 0 = not interpolated */ }
interface HoleFrame { k: 'hole'; str: StrFrame; depth: number }
interface FmtFrame { k: 'fmt'; str: StrFrame }
type Frame = StrFrame | HoleFrame | FmtFrame;

const ID_START = /[\p{L}\p{Nl}_]/u;
const ID_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]/u;
const isNewline = (c: string) => c === '\n' || c === '\r' || c === '\u0085' || c === ' ' || c === ' ';
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

function charAt(text: string, i: number): string {
  const cp = text.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

function run(text: string, i: number, ch: string): number {
  let j = i;
  while (text[j] === ch) j++;
  return j - i;
}

function lex(text: string): Tok[] {
  const toks: Tok[] = [];
  const stack: Frame[] = [];
  const n = text.length;
  let pp = 0;
  let lineStart = true;
  let i = 0;

  const emit = (k: Tok['k'], start: number, end: number) => toks.push({ k, text: text.slice(start, end), start, end, pp });
  const barrier = (at: number) => emit('lit', at, at);

  /** Opens a string whose first quote is at `q`; the token starts at `start` (`@`/`$` prefix). */
  const openString = (start: number, q: number, dollars: number, verbatim: boolean) => {
    emit('lit', start, start);
    const quotes = verbatim ? 1 : run(text, q, '"');
    if (quotes >= 3) {
      stack.push({ k: 'str', verbatim: false, quotes, dollars });
      i = q + quotes;
    } else {
      stack.push({ k: 'str', verbatim, quotes: 0, dollars: dollars > 0 ? 1 : 0 });
      i = q + 1;
    }
  };

  const codeStep = (base: boolean) => {
    const c = text[i];
    const next = text[i + 1];
    if (isNewline(c)) { lineStart = true; i++; return; }
    if (/\s/.test(c)) { i++; return; }
    if (base && lineStart && c === '#') {
      let j = i + 1;
      while (j < n && !isNewline(text[j])) j++;
      const kw = /^\s*(\w+)/.exec(text.slice(i + 1, j))?.[1];
      if (kw === 'if') pp++;
      else if (kw === 'endif') pp = Math.max(0, pp - 1);
      i = j;
      return;
    }
    lineStart = false;
    if (c === '/' && next === '/') {
      while (i < n && !isNewline(text[i])) i++;
      return;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      return;
    }
    if (c === '"') { openString(i, i, 0, false); return; }
    if (c === '@') {
      if (next === '"') { openString(i, i + 1, 0, true); return; }
      if (next === '$' && text[i + 2] === '"') { openString(i, i + 2, 1, true); return; }
      const cp = charAt(text, i + 1);
      if (cp && ID_START.test(cp)) { lexIdent(i, i + 1); return; }
      emit('p', i, i + 1); i++; return;
    }
    if (c === '$') {
      const d = run(text, i, '$');
      const j = i + d;
      if (d === 1 && text[j] === '@' && text[j + 1] === '"') { openString(i, j + 1, 1, true); return; }
      if (text[j] === '"') { openString(i, j, d, false); return; }
      emit('p', i, i + 1); i++; return;
    }
    if (c === "'") {
      let j = i + 1;
      j += text[j] === '\\' ? 2 : 1;
      while (j < n && text[j] !== "'" && !isNewline(text[j])) j++;
      if (text[j] === "'") j++;
      emit('lit', i, j); i = j; return;
    }
    if (isDigit(c) || (c === '.' && isDigit(next))) {
      let j = i;
      for (;;) {
        while (j < n && /[0-9A-Za-z_]/.test(text[j])) {
          j++;
          if ((text[j - 1] === 'e' || text[j - 1] === 'E') && (text[j] === '+' || text[j] === '-') && isDigit(text[j + 1])) j++;
        }
        if (text[j] === '.' && isDigit(text[j + 1])) { j++; continue; }
        break;
      }
      emit('lit', i, j); i = j; return;
    }
    const cp = charAt(text, i);
    if (ID_START.test(cp)) { lexIdent(i, i); return; }
    if (c === ':' && next === ':') { emit('p', i, i + 2); i += 2; return; }
    emit('p', i, i + 1); i++;
  };

  const lexIdent = (start: number, from: number) => {
    let j = from;
    for (;;) {
      const cp = charAt(text, j);
      if (!cp || !ID_PART.test(cp)) break;
      j += cp.length;
    }
    emit('id', start, j);
    i = j;
  };

  const popString = () => { stack.pop(); };

  while (i < n) {
    const top = stack[stack.length - 1];
    if (!top) { codeStep(true); continue; }
    const c = text[i];

    if (top.k === 'str') {
      if (top.quotes > 0) {
        if (c === '"') { const r = run(text, i, '"'); i += r; if (r >= top.quotes) popString(); continue; }
        if (top.dollars > 0 && c === '{') {
          const r = run(text, i, '{'); i += r;
          if (r >= top.dollars) { stack.push({ k: 'hole', str: top, depth: 0 }); barrier(i); }
          continue;
        }
        i++; continue;
      }
      if (c === '"') {
        if (top.verbatim && text[i + 1] === '"') { i += 2; continue; }
        i++; popString(); continue;
      }
      if (!top.verbatim && c === '\\') { i += 2; continue; }
      if (!top.verbatim && isNewline(c)) { popString(); continue; }
      if (top.dollars > 0 && c === '{') {
        if (text[i + 1] === '{') { i += 2; continue; }
        i++; stack.push({ k: 'hole', str: top, depth: 0 }); barrier(i); continue;
      }
      i++; continue;
    }

    if (top.k === 'hole') {
      if (c === '}' && top.depth === 0) {
        i += top.str.quotes > 0 ? Math.min(run(text, i, '}'), top.str.dollars) : 1;
        stack.pop(); barrier(i); continue;
      }
      if (c === ':' && text[i + 1] !== ':' && top.depth === 0) {
        stack[stack.length - 1] = { k: 'fmt', str: top.str };
        i++; continue;
      }
      if (c === '(' || c === '[' || c === '{') top.depth++;
      else if ((c === ')' || c === ']' || c === '}') && top.depth > 0) top.depth--;
      codeStep(false);
      continue;
    }

    // top.k === 'fmt': format clause text up to the closing brace.
    const s = top.str;
    if (s.quotes > 0) {
      if (c === '}') {
        const r = run(text, i, '}');
        if (r >= s.dollars) { i += s.dollars; stack.pop(); barrier(i); } else i += r;
        continue;
      }
      if (c === '"') {
        const r = run(text, i, '"'); i += r;
        if (r >= s.quotes) { stack.pop(); popString(); }
        continue;
      }
      i++; continue;
    }
    if (c === '}') { i++; stack.pop(); barrier(i); continue; }
    if (c === '"') {
      if (s.verbatim && text[i + 1] === '"') { i += 2; continue; }
      i++; stack.pop(); popString(); continue;
    }
    if (!s.verbatim && c === '\\') { i += 2; continue; }
    if (!s.verbatim && isNewline(c)) { stack.pop(); popString(); continue; }
    i++;
  }
  return toks;
}

const KEYWORDS = new Set(('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event '
  + 'explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out '
  + 'override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try '
  + 'typeof uint ulong unchecked unsafe ushort using virtual void volatile while').split(' '));
const TYPE_KW = new Set(['class', 'struct', 'interface', 'enum']);

const isP = (t: Tok | undefined, s: string) => t !== undefined && t.k === 'p' && t.text === s;
const isId = (t: Tok | undefined, s?: string) => t !== undefined && t.k === 'id' && (s === undefined || t.text === s);
const isName = (t: Tok | undefined) => isId(t) && !KEYWORDS.has(t!.text);

export function analyzeCs(text: string): CsFileInfo {
  const toks = lex(text);
  const info: CsFileInfo = { namespaces: [], usings: [], typeNames: [], qualified: [], hasPreprocessorAroundNamespace: false };
  const stack: ('ns' | 'type' | 'other')[] = [];
  let fileScoped = false;
  let pending: 'type' | null = null;
  let pendingParen = 0;

  const nsCtx = () => stack.length === 0 || stack[stack.length - 1] === 'ns';
  const typeCtx = () => (stack.length > 0 && stack[stack.length - 1] === 'ns') || (stack.length === 0 && fileScoped);
  const atBoundary = (i: number) => i === 0 || isP(toks[i - 1], ';') || isP(toks[i - 1], '{') || isP(toks[i - 1], '}');

  /** Parses `using …;` starting at `s` (`global` or `using`); returns the index after `;` or -1. */
  const parseUsing = (s: number): number => {
    const isGlobal = isId(toks[s], 'global');
    let j = isGlobal ? s + 2 : s + 1;
    const isStatic = isId(toks[j], 'static');
    if (isStatic) j++;
    let alias: string | undefined;
    if (isId(toks[j], 'unsafe') && isId(toks[j + 1]) && isP(toks[j + 2], '=')) j++;
    if (isId(toks[j]) && isP(toks[j + 1], '=')) { alias = toks[j].text; j += 2; }
    let globalQualified = false;
    if (isId(toks[j], 'global') && isP(toks[j + 1], '::')) { globalQualified = true; j += 2; }
    const first = j;
    if (alias !== undefined) {
      while (j < toks.length && !isP(toks[j], ';')) {
        if (isP(toks[j], '{') || isP(toks[j], '}') || isP(toks[j], '=')) return -1;
        j++;
      }
    } else {
      if (!isId(toks[j])) return -1;
      j++;
      for (;;) {
        if (isP(toks[j], '.') && isId(toks[j + 1])) { j += 2; continue; }
        if (isP(toks[j], '<')) {
          let depth = 0;
          for (; j < toks.length; j++) {
            const t = toks[j];
            if (isP(t, ';') || isP(t, '{') || isP(t, '}') || isP(t, '=')) return -1;
            if (isP(t, '<')) depth++;
            else if (isP(t, '>') && --depth === 0) break;
          }
          j++;
          continue;
        }
        break;
      }
    }
    if (j === first || !isP(toks[j], ';')) return -1;
    const nameToks = toks.slice(first, j);
    info.usings.push({
      name: nameToks.map((t) => t.text).join(''), nameStart: nameToks[0].start, nameEnd: nameToks[nameToks.length - 1].end,
      isGlobal, isStatic, ...(alias !== undefined ? { alias } : {}), start: toks[s].start, end: toks[j].end,
      inNamespace: stack.length > 0 || fileScoped, globalQualified,
    });
    return j + 1;
  };

  /** Parses `namespace A.B` followed by `;` or `{` at `s`; returns the index after it or -1. */
  const parseNamespace = (s: number): number => {
    let j = s + 1;
    if (!isName(toks[j])) return -1;
    const parts = [toks[j].text];
    j++;
    while (isP(toks[j], '.') && isName(toks[j + 1])) { parts.push(toks[j + 1].text); j += 2; }
    const isFile = isP(toks[j], ';');
    if (!isFile && !isP(toks[j], '{')) return -1;
    const depth = stack.length;
    info.namespaces.push({ name: parts.join('.'), nameStart: toks[s + 1].start, nameEnd: toks[j - 1].end, fileScoped: isFile, depth });
    if (depth === 0 && toks[s].pp > 0) info.hasPreprocessorAroundNamespace = true;
    if (isFile) fileScoped = true; else stack.push('ns');
    return j + 1;
  };

  /** Name declared by a type keyword at `i`, or undefined if `i` does not start a type declaration. */
  const typeName = (i: number): string | undefined => {
    const t = toks[i];
    if (TYPE_KW.has(t.text)) return isName(toks[i + 1]) ? toks[i + 1].text : undefined;
    if (t.text === 'record') {
      const k = isId(toks[i + 1], 'class') || isId(toks[i + 1], 'struct') ? i + 2 : i + 1;
      return isName(toks[k]) ? toks[k].text : undefined;
    }
    if (t.text === 'delegate') {
      let angle = 0;
      let paren = 0;
      let last: string | undefined;
      for (let j = i + 1; j < toks.length && !isP(toks[j], ';') && !isP(toks[j], '{'); j++) {
        const u = toks[j];
        if (paren === 0 && angle === 0 && isP(u, '(')) {
          if (last !== undefined) return last;
          paren++;
        } else if (isP(u, '(')) paren++;
        else if (isP(u, ')')) paren--;
        else if (paren === 0 && isP(u, '<')) angle++;
        else if (paren === 0 && isP(u, '>')) angle--;
        else if (paren === 0 && angle === 0 && isName(u)) last = u.text;
      }
    }
    return undefined;
  };

  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    if (pending) {
      if (isP(t, '(') || isP(t, '[')) pendingParen++;
      else if (isP(t, ')') || isP(t, ']')) pendingParen--;
      else if (pendingParen === 0 && (isP(t, '{') || isP(t, ';'))) {
        if (isP(t, '{')) stack.push(pending);
        pending = null;
        i++;
        continue;
      }
    } else {
      if (isP(t, '{')) { stack.push('other'); i++; continue; }
      if (isP(t, '}')) { stack.pop(); i++; continue; }
      if (nsCtx() && t.k === 'id') {
        let next = -1;
        if (t.text === 'namespace' && atBoundary(i)) next = parseNamespace(i);
        else if ((t.text === 'using' || (t.text === 'global' && isId(toks[i + 1], 'using'))) && atBoundary(i)) next = parseUsing(i);
        if (next >= 0) { i = next; continue; }
        if (TYPE_KW.has(t.text) || t.text === 'record' || t.text === 'delegate') {
          const name = typeName(i);
          if (name !== undefined || t.text === 'delegate') {
            if (name !== undefined && typeCtx() && !info.typeNames.includes(name)) info.typeNames.push(name);
            pending = 'type';
            pendingParen = 0;
            i++;
            continue;
          }
        }
      }
    }

    // Dotted chains: A.B(.C)* or global::A.B, not continuing a member access.
    if (isName(t) && isP(toks[i + 1], '.') && !isP(toks[i - 1], '.')) {
      let global = false;
      let ok = true;
      if (isP(toks[i - 1], '::')) {
        global = isId(toks[i - 2], 'global');
        ok = global;
      }
      let j = i;
      const parts = [t.text];
      while (isP(toks[j + 1], '.') && isName(toks[j + 2])) { parts.push(toks[j + 2].text); j += 2; }
      if (ok && parts.length >= 2) info.qualified.push({ text: parts.join('.'), start: t.start, end: toks[j].end, global });
      i = j + 1;
      continue;
    }
    i++;
  }
  return info;
}
