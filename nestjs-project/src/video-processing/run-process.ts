import { spawn } from 'node:child_process';

export interface ProcessResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

// Runs a binary without a shell (arguments are never interpolated) and
// collects its output. Rejects only when the binary cannot be started.
export function runProcess(
  command: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}
