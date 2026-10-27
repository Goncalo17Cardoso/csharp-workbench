interface Parsed { nums: number[]; pre: string[] }

function parse(v: string): Parsed {
  const noMeta = v.trim().split('+')[0];
  const dash = noMeta.indexOf('-');
  const core = dash === -1 ? noMeta : noMeta.slice(0, dash);
  const pre = dash === -1 ? '' : noMeta.slice(dash + 1);
  const nums = core.split('.').map((p) => parseInt(p, 10) || 0);
  while (nums.length < 4) { nums.push(0); }
  return { nums, pre: pre ? pre.toLowerCase().split('.') : [] };
}

const isNumeric = (s: string): boolean => /^\d+$/.test(s);

export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) { return d < 0 ? -1 : 1; }
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) { return 0; }
  if (pa.pre.length === 0) { return 1; }
  if (pb.pre.length === 0) { return -1; }
  const n = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === y) { continue; }
    const nx = isNumeric(x);
    const ny = isNumeric(y);
    if (nx && ny) { return Number(x) < Number(y) ? -1 : 1; }
    if (nx) { return -1; }
    if (ny) { return 1; }
    return x < y ? -1 : 1;
  }
  const d = pa.pre.length - pb.pre.length;
  return d === 0 ? 0 : d < 0 ? -1 : 1;
}

export function isPrerelease(v: string): boolean {
  return v.split('+')[0].includes('-');
}

export function maxVersion(vs: string[]): string | undefined {
  let best: string | undefined;
  for (const v of vs) {
    if (best === undefined || compareVersions(v, best) > 0) { best = v; }
  }
  return best;
}
