// Pure Sync Namespaces planner. No `vscode` import.
//
// All edits are computed from the original text of every file in a single pass, so folder
// swaps (A<->B) need no ordering. Files containing any `#if` are skipped entirely: they get no
// declaration and no reference edits (in-scope ones are reported as 'preprocessor'; out-of-scope
// ones are skipped silently). Their namespaces and types (best-effort) still count as existing.
//
// Implicit access: a file that declared Old (or a descendant) or was moved out of Old saw Old's
// types without a `using`; it now gets `using T;` for every target T of Old, and a moved file
// gets `using Old;` when Old still exists. A qualified `Old.T` is rewritten only when T moved to
// exactly one target and no file declares T in Old after the sync; otherwise it is reported in
// `ambiguous` (`targets` lists the moved targets plus Old when T also stays there).

import { dirname } from 'node:path';
import { namespaceFor } from '../solution/naming';
import { analyzeCs, type CsFileInfo, type UsingDirective } from './csTokens';

export interface SyncInputFile { path: string; text: string; projectDir: string; rootNamespace: string; inScope: boolean }
export interface TextEdit { start: number; end: number; newText: string; kind: 'declaration' | 'using' | 'qualified' }
export interface SyncPlan {
  edits: Map<string, TextEdit[]>;
  skipped: { path: string; reason: 'noNamespace' | 'multipleNamespaces' | 'nested' | 'preprocessor' }[];
  moves: { from: string; to: string; types: string[] }[];
  ambiguous: { from: string; type: string; targets: string[] }[];
}

/** Full dotted names of every namespace declaration, rebuilt from document order and depth. */
function fullNames(info: CsFileInfo): string[] {
  const stack: string[] = [];
  return info.namespaces.map((n) => {
    const full = n.depth > 0 && stack[n.depth - 1] ? `${stack[n.depth - 1]}.${n.name}` : n.name;
    stack[n.depth] = full;
    stack.length = n.depth + 1;
    return full;
  });
}

/** The names plus all their dotted ancestors. */
function withAncestors(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    const parts = n.split('.');
    for (let k = 1; k <= parts.length; k++) out.add(parts.slice(0, k).join('.'));
  }
  return out;
}

export function planSync(files: SyncInputFile[]): SyncPlan {
  const plan: SyncPlan = { edits: new Map(), skipped: [], moves: [], ambiguous: [] };
  const infos = new Map<string, CsFileInfo>();
  const fulls = new Map<string, string[]>();
  for (const f of files) {
    const info = analyzeCs(f.text);
    infos.set(f.path, info);
    fulls.set(f.path, fullNames(info));
  }
  const add = (path: string, e: TextEdit) => {
    const list = plan.edits.get(path);
    if (list) list.push(e); else plan.edits.set(path, [e]);
  };

  const declared = new Set<string>(); // namespaces (with ancestors) that exist after the moves
  const postTypes = new Map<string, Set<string>>(); // namespace -> types declared there after the moves
  const addPost = (ns: string, types: string[]) => {
    const s = postTypes.get(ns) ?? new Set<string>();
    types.forEach((t) => s.add(t));
    postTypes.set(ns, s);
  };
  const newNsOf = new Map<string, string>();
  const oldNsOf = new Map<string, string>();
  const targetsOf = new Map<string, string[]>(); // old ns -> distinct new namespaces
  const typeMoves = new Map<string, Map<string, Set<string>>>(); // old ns -> type -> new namespaces

  for (const f of files) {
    const info = infos.get(f.path)!;
    let moved: string | undefined;
    if (info.hasConditional || info.hasPreprocessorAroundNamespace) {
      if (f.inScope) plan.skipped.push({ path: f.path, reason: 'preprocessor' });
    } else if (f.inScope) {
      const reason = info.namespaces.length === 0 ? 'noNamespace'
        : info.namespaces.some((n) => n.depth > 0) ? 'nested'
        : info.namespaces.length > 1 ? 'multipleNamespaces' : undefined;
      if (reason) plan.skipped.push({ path: f.path, reason });
      else {
        const ns = info.namespaces[0];
        const expected = namespaceFor(f.rootNamespace, f.projectDir, dirname(f.path));
        if (ns.name !== expected) {
          add(f.path, { start: ns.nameStart, end: ns.nameEnd, newText: expected, kind: 'declaration' });
          plan.moves.push({ from: ns.name, to: expected, types: [...info.typeNames] });
          moved = expected;
          oldNsOf.set(f.path, ns.name);
          const t = targetsOf.get(ns.name) ?? [];
          if (!t.includes(expected)) t.push(expected);
          targetsOf.set(ns.name, t);
          const tm = typeMoves.get(ns.name) ?? new Map<string, Set<string>>();
          for (const type of info.typeNames) tm.set(type, (tm.get(type) ?? new Set<string>()).add(expected));
          typeMoves.set(ns.name, tm);
        }
      }
    }
    const names = moved !== undefined ? [moved] : fulls.get(f.path)!;
    if (moved !== undefined) newNsOf.set(f.path, moved);
    withAncestors(names).forEach((n) => declared.add(n));
    for (const n of names) addPost(n, info.typeNames);
  }
  if (plan.moves.length === 0) return plan;

  const ambKeys = new Set<string>();
  const rewritePrefix = (path: string, text: string, name: string, start: number) => {
    const segs = name.split('.');
    for (let k = segs.length - 1; k >= 1; k--) {
      const prefix = segs.slice(0, k).join('.');
      const to = typeMoves.get(prefix)?.get(segs[k]);
      if (to === undefined) continue;
      const stays = postTypes.get(prefix)?.has(segs[k]) ?? false;
      if (to.size === 1 && !stays) {
        if (text.slice(start, start + prefix.length) === prefix) add(path, { start, end: start + prefix.length, newText: [...to][0], kind: 'qualified' });
      } else if (!ambKeys.has(`${prefix}\0${segs[k]}`)) {
        ambKeys.add(`${prefix}\0${segs[k]}`);
        plan.ambiguous.push({ from: prefix, type: segs[k], targets: [...(stays ? [prefix] : []), ...[...to].sort()].sort() });
      }
      return;
    }
  };

  // Reference edits.
  for (const f of files) {
    const info = infos.get(f.path)!;
    if (info.hasConditional || info.hasPreprocessorAroundNamespace) continue;
    const text = f.text;
    const movedTo = newNsOf.get(f.path);
    const oldName = oldNsOf.get(f.path);
    const own = withAncestors(movedTo !== undefined ? [movedTo] : fulls.get(f.path)!);
    const imported = new Set(info.usings.filter((u) => !u.alias && !u.isStatic).map((u) => u.name));
    const eol = /\r\n|\n|\r/.exec(text)?.[0] ?? '\n';
    const deleted = new Map<UsingDirective, { edit: TextEdit; alone: boolean; indent: string }>();

    const indentOf = (u: UsingDirective) => {
      const lineStart = Math.max(text.lastIndexOf('\n', u.start - 1), text.lastIndexOf('\r', u.start - 1)) + 1;
      const before = text.slice(lineStart, u.start);
      return { lineStart, indent: /^[ \t]*$/.test(before) ? before : '' , alone: /^[ \t]*$/.test(before) };
    };
    /** End of the directive's line when only a comment follows it, else the directive end. */
    const insertPos = (u: UsingDirective) => u.end + (/^[ \t]*(\/\/[^\r\n]*)?(?=\r\n|\n|\r|$)/.exec(text.slice(u.end))?.[0].length ?? 0);

    for (const u of info.usings) {
      if (u.alias || u.isStatic) { rewritePrefix(f.path, text, u.name, u.nameStart); continue; }
      const targets = targetsOf.get(u.name);
      if (!targets) continue;
      let extra: string[];
      if (!declared.has(u.name)) {
        const cand = targets.filter((t) => !own.has(t) && !imported.has(t));
        if (cand.length === 0) {
          const { lineStart, indent, alone } = indentOf(u);
          const after = /^[ \t]*(\/\/[^\r\n]*)?(\r\n|\n|\r|$)/.exec(text.slice(u.end));
          const whole = alone && after;
          const edit = { start: whole ? lineStart : u.start, end: whole ? u.end + after![0].length : u.end, newText: '', kind: 'using' as const };
          add(f.path, edit);
          deleted.set(u, { edit, alone: !!whole, indent });
          continue;
        }
        add(f.path, { start: u.nameStart, end: u.nameEnd, newText: cand[0], kind: 'using' });
        imported.add(cand[0]);
        extra = cand.slice(1);
      } else extra = targets.filter((t) => !own.has(t) && !imported.has(t));
      if (extra.length === 0) continue;
      const head = `${u.isGlobal ? 'global ' : ''}using ${u.globalQualified ? 'global::' : ''}`;
      const nextEol = /^(\r\n|\n|\r)/.exec(text.slice(insertPos(u)))?.[0] ?? eol;
      const pos = insertPos(u);
      add(f.path, { start: pos, end: pos, newText: extra.map((t) => `${nextEol}${indentOf(u).indent}${head}${t};`).join(''), kind: 'using' });
      extra.forEach((t) => imported.add(t));
    }

    // Implicit access: the file's own (old) namespaces and their ancestors.
    const need: string[] = [];
    const push = (t: string) => { if (!own.has(t) && !imported.has(t) && !need.includes(t)) need.push(t); };
    const implicit = withAncestors(oldName !== undefined ? [oldName] : fulls.get(f.path)!);
    for (const o of implicit) for (const t of targetsOf.get(o) ?? []) push(t);
    if (oldName !== undefined && declared.has(oldName)) push(oldName);
    if (need.length > 0) {
      const top = info.usings.filter((u) => !u.inNamespace);
      const plain = top.filter((u) => !u.isGlobal);
      const pool = plain.length > 0 ? plain : top;
      const anchor = pool.length > 0 ? pool.reduce((a, b) => (b.end > a.end ? b : a)) : undefined;
      if (anchor) {
        const del = deleted.get(anchor);
        const { indent } = indentOf(anchor);
        if (del) {
          const pad = del.alone ? del.indent : '';
          del.edit.newText = need.map((t) => `${pad}using ${t};`).join(eol) + (del.alone ? eol : '');
        } else {
          const pos = insertPos(anchor);
          add(f.path, { start: pos, end: pos, newText: need.map((t) => `${eol}${indent}using ${t};`).join(''), kind: 'using' });
        }
      } else {
        const code = info.firstCodeStart;
        if (code !== undefined) {
          // Before the first code token: after BOM, leading comments and extern aliases.
          const lines = need.map((t) => `using ${t};`).join(eol);
          const gap = info.lastExternAliasEnd !== undefined ? eol : eol + eol; // blank line unless after extern alias
          let ls = Math.max(text.lastIndexOf('\n', code - 1), text.lastIndexOf('\r', code - 1)) + 1;
          if (ls === 0 && text.charCodeAt(0) === 0xfeff) ls = 1;
          const before = text.slice(ls, code);
          if (/^[ \t]*$/.test(before)) add(f.path, { start: ls, end: ls, newText: lines + gap, kind: 'using' });
          else add(f.path, { start: code - /[ \t]*$/.exec(before)![0].length, end: code, newText: eol + lines + gap, kind: 'using' });
        }
      }
    }

    for (const q of info.qualified) {
      if (text.slice(q.start, q.end) === q.text) rewritePrefix(f.path, text, q.text, q.start);
    }
  }

  for (const [path, list] of plan.edits) {
    list.sort((a, b) => a.start - b.start || a.end - b.end); // stable: equal offsets keep insertion order
    const merged: TextEdit[] = [];
    for (const e of list) {
      const last = merged[merged.length - 1];
      if (last && last.start === last.end && e.start === e.end && last.start === e.start) last.newText += e.newText;
      else merged.push(e);
    }
    plan.edits.set(path, merged);
  }
  return plan;
}
