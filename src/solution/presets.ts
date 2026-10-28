/** Test-mode answers arrive as extra command args; menu invocations pass `(node, selectedNodes[])` instead. */
export const presetString = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);
export const presetPaths = (x: unknown): string[] | undefined =>
  Array.isArray(x) && x.every((p) => typeof p === 'string') ? (x as string[]) : undefined;
