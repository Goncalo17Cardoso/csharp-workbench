// Pure Sync Namespaces planner. No `vscode` import.
//
// All edits are computed from the original text of every file in a single pass, so folder
// swaps (A<->B) need no ordering. Files containing any `#if` are skipped entirely: they get no
// declaration and no reference edits (in-scope ones are reported as 'preprocessor'; out-of-scope
// ones are skipped silently). Their declared namespaces still count as existing.
//
// Known limit: a moved file loses implicit access to siblings left in its old namespace.

import { dirname } from 'node:path';
import { namespaceFor } from '../solution/naming';
import { analyzeCs, type CsFileInfo } from './csTokens';

export interface SyncInputFile { path: string; text: string; projectDir: string; rootNamespace: string; inScope: boolean }
export interface TextEdit { start: number; end: number; newText: string }
export interface SyncPlan {
  edits: Map<string, TextEdit[]>;
  skipped: { path: string; reason: 'noNamespace' | 'multipleNamespaces' | 'nested' | 'preprocessor' }[];
  moves: { from: string; to: string; types: string[] }[];
}

export function planSync(files: SyncInputFile[]): SyncPlan {
  const plan: SyncPlan = { edits: new Map(), skipped: [], moves: [] };
  const infos = new Map<string, CsFileInfo>();
  for (const f of files) infos.set(f.path, analyzeCs(f.text));
  const add = (path: string, e: TextEdit) => {
    const list = plan.edits.get(path);
    if (list) list.push(e); else plan.edits.set(path, [e]);
  };

  // Declaration edits.
  const declared = new Set<string>(); // namespaces declared after the moves
  const newNsOf = new Map<string, string>(); // path -> namespace after the move
  const targetsOf = new Map<string, string[]>(); // old ns -> distinct new namespaces
  const typeMoves = new Map<string, Map<string, string>>(); // old ns -> type -> new ns
  for (const f of files) {
    const info = infos.get(f.path)!;
    const names = info.namespaces.map((n) => n.name);
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
          add(f.path, { start: ns.nameStart, end: ns.nameEnd, newText: expected });
          plan.moves.push({ from: ns.name, to: expected, types: [...info.typeNames] });
          moved = expected;
          const t = targetsOf.get(ns.name) ?? [];
          if (!t.includes(expected)) t.push(expected);
          targetsOf.set(ns.name, t);
          const tm = typeMoves.get(ns.name) ?? new Map<string, string>();
          for (const type of info.typeNames) if (!tm.has(type)) tm.set(type, expected);
          typeMoves.set(ns.name, tm);
        }
      }
    }
    if (moved !== undefined) { declared.add(moved); newNsOf.set(f.path, moved); }
    else for (const n of names) declared.add(n);
  }
  if (plan.moves.length === 0) return plan;

  const rewritePrefix = (path: string, text: string, name: string, start: number) => {
    const segs = name.split('.');
    for (let k = segs.length - 1; k >= 1; k--) {
      const prefix = segs.slice(0, k).join('.');
      const to = typeMoves.get(prefix)?.get(segs[k]);
      if (to !== undefined) {
        if (text.slice(start, start + prefix.length) === prefix) add(path, { start, end: start + prefix.length, newText: to });
        return;
      }
    }
  };

  // Reference edits.
  for (const f of files) {
    const info = infos.get(f.path)!;
    if (info.hasConditional || info.hasPreprocessorAroundNamespace) continue;
    const own = new Set(newNsOf.has(f.path) ? [newNsOf.get(f.path)!] : info.namespaces.map((n) => n.name));
    const imported = new Set(info.usings.filter((u) => !u.alias && !u.isStatic).map((u) => u.name));
    const eol = /\r\n|\n|\r/.exec(f.text)?.[0] ?? '\n';
    for (const u of info.usings) {
      if (u.alias || u.isStatic) {
        // Alias / static targets are type names: rewrite the namespace prefix only.
        if (u.alias || u.isStatic) rewritePrefix(f.path, f.text, u.name, u.nameStart);
        continue;
      }
      const targets = targetsOf.get(u.name);
      if (!targets) continue;
      const gone = !declared.has(u.name);
      let extra = targets.filter((t) => !own.has(t) && !imported.has(t));
      if (gone) {
        add(f.path, { start: u.nameStart, end: u.nameEnd, newText: targets[0] });
        extra = extra.filter((t) => t !== targets[0]);
        extra.forEach((t) => imported.add(t));
      }
      if (extra.length === 0) continue;
      const lineStart = Math.max(f.text.lastIndexOf('\n', u.start - 1), f.text.lastIndexOf('\r', u.start - 1)) + 1;
      const before = f.text.slice(lineStart, u.start);
      const indent = /^[ \t]*$/.test(before) ? before : '';
      const nextEol = /^(\r\n|\n|\r)/.exec(f.text.slice(u.end))?.[0] ?? eol;
      const head = `${u.isGlobal ? 'global ' : ''}using ${u.globalQualified ? 'global::' : ''}`;
      add(f.path, { start: u.end, end: u.end, newText: extra.map((t) => `${nextEol}${indent}${head}${t};`).join('') });
      extra.forEach((t) => imported.add(t));
    }
    for (const q of info.qualified) {
      if (f.text.slice(q.start, q.end) === q.text) rewritePrefix(f.path, f.text, q.text, q.start);
    }
  }

  for (const list of plan.edits.values()) list.sort((a, b) => a.start - b.start || a.end - b.end);
  return plan;
}
