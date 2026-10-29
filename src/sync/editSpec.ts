// Pure conversion of a SyncPlan into position-based edit specs. No `vscode` import.
import type { SyncPlan } from './plan';

export interface EditSpec {
  path: string;
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  newText: string;
  label: string;
}

/** Line starts of `text` (breaks: CRLF, LF, lone CR), as offsets. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) { if (text.charCodeAt(i + 1) === 10) i++; starts.push(i + 1); } else if (c === 10) starts.push(i + 1);
  }
  return starts;
}

/**
 * Offsets count a leading U+FEFF (disk text); VS Code positions do not, so line 0 loses one column.
 * Text without a BOM (an open document's getText()) is converted as is.
 */
function positionAt(text: string, starts: number[], offset: number): { line: number; col: number } {
  let lo = 0; let hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  const bom = lo === 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  return { line: lo, col: Math.max(0, offset - starts[lo] - bom) };
}

function labelOf(text: string, start: number, end: number, newText: string): string {
  const lineStart = Math.max(text.lastIndexOf('\n', start - 1), text.lastIndexOf('\r', start - 1)) + 1;
  const before = text.slice(lineStart, start);
  if (/\bnamespace\s+[\w.]*$/.test(before)) return 'Namespace declaration';
  if (/^\s*(global\s+)?using\b/.test(before) || /\busing\s/.test(newText) || /\busing\b/.test(text.slice(start, end))) return 'Using directive';
  return 'Qualified name';
}

export function toWorkspaceEditSpec(plan: SyncPlan, texts: Map<string, string>): EditSpec[] {
  const out: EditSpec[] = [];
  for (const [path, edits] of plan.edits) {
    const text = texts.get(path);
    if (text === undefined) continue;
    const starts = lineStarts(text);
    for (const e of edits) {
      const s = positionAt(text, starts, e.start);
      const t = positionAt(text, starts, e.end);
      out.push({
        path, newText: e.newText, label: labelOf(text, e.start, e.end, e.newText),
        range: { startLine: s.line, startCol: s.col, endLine: t.line, endCol: t.col },
      });
    }
  }
  return out;
}
