import type { ExecResult } from './dotnet/exec';

export function createOutput(channel: { appendLine(s: string): void }) {
  return {
    log(args: string[], r: ExecResult): void {
      channel.appendLine(`$ dotnet ${args.join(' ')}`);
      if (r.stdout.trim()) channel.appendLine(r.stdout.trimEnd());
      if (r.stderr.trim()) channel.appendLine(r.stderr.trimEnd());
      channel.appendLine(`(exit ${r.code})`);
    },
    info(s: string): void {
      channel.appendLine(s);
    },
  };
}
export type Output = ReturnType<typeof createOutput>;
