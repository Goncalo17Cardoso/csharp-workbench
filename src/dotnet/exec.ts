import { execFile } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<ExecResult>;

/** Runs a process with execFile (no shell). Never rejects on a non-zero exit code. */
export const nodeExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        const code = typeof e.code === 'number' ? e.code : 1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || e.message });
      },
    );
  });

export class DotnetError extends Error {
  constructor(
    message: string,
    public args: string[],
    public code: number,
    public stdout: string,
    public stderr: string,
  ) {
    super(message);
    this.name = 'DotnetError';
  }
}
