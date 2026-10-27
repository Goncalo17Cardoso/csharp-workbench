/** Same shape as `vscode.l10n.t`, so pure modules can localise without importing `vscode`. */
export type Translate = (message: string, ...args: (string | number)[]) => string;

/** Untranslated fallback: substitutes `{0}`, `{1}`… like `vscode.l10n.t`. */
export const format: Translate = (message, ...args) =>
  message.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
