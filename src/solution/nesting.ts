/** Visual Studio file nesting within one folder. Returns child -> parent (file names). */
export function nestFiles(fileNames: string[]): Map<string, string> {
  const byLower = new Map<string, string>();
  for (const n of fileNames) byLower.set(n.toLowerCase(), n);
  const find = (name: string) => byLower.get(name.toLowerCase());
  const out = new Map<string, string>();
  for (const name of fileNames) {
    const parent = parentOf(name, find);
    if (parent && parent.toLowerCase() !== name.toLowerCase()) out.set(name, parent);
  }
  return out;
}

function parentOf(name: string, find: (n: string) => string | undefined): string | undefined {
  const lower = name.toLowerCase();
  const suffixRules: Array<[string, string[]]> = [
    ['.xaml.cs', ['.xaml']],
    ['.razor.cs', ['.razor']], ['.razor.css', ['.razor']], ['.razor.js', ['.razor']],
    ['.cshtml.cs', ['.cshtml']],
    ['.designer.cs', ['.resx', '.cs']],
    ['.g.i.cs', ['.cs']], ['.g.cs', ['.cs']],
    ['.min.js', ['.js']], ['.min.css', ['.css']],
  ];
  for (const [suffix, parents] of suffixRules) {
    if (!lower.endsWith(suffix) || name.length === suffix.length) continue;
    const stem = name.slice(0, name.length - suffix.length);
    for (const p of parents) {
      const hit = find(stem + p);
      if (hit) return hit;
    }
    return undefined;
  }
  if (lower.endsWith('.json')) {
    // X.*.json -> X.json, nearest (longest) existing prefix first
    const stem = name.slice(0, -'.json'.length);
    for (let i = stem.lastIndexOf('.'); i > 0; i = stem.lastIndexOf('.', i - 1)) {
      const hit = find(stem.slice(0, i) + '.json');
      if (hit) return hit;
    }
  }
  return undefined;
}
