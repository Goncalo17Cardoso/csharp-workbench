import { describe, it, expect } from 'vitest';
import { nodeExec } from '../../../src/dotnet/exec';

describe('nodeExec', () => {
  it('passes args with spaces and # verbatim', async () => {
    const r = await nodeExec(process.execPath, ['-e', 'console.log(process.argv[1])', 'My App #1'], { cwd: process.cwd() });
    expect(r.stdout.trim()).toBe('My App #1');
    expect(r.code).toBe(0);
  });
  it('returns non-zero code without throwing', async () => {
    const r = await nodeExec(process.execPath, ['-e', 'process.exit(3)'], { cwd: process.cwd() });
    expect(r.code).toBe(3);
  });
});

describe('nodeExec timeout', () => {
  it('kills a hung process and resolves with a non-zero code', async () => {
    const r = await nodeExec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { cwd: process.cwd(), timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/^Timed out after 200 ms\. /);
  });
});
