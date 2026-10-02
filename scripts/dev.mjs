import { spawn } from 'node:child_process';
import { join } from 'node:path';

const executable = process.platform === 'win32' ? 'vercel.cmd' : 'vercel';
const vercel = join(process.cwd(), 'node_modules', '.bin', executable);
const child = spawn(vercel, ['dev', '--listen', '3000'], {
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Could not start the Vercel development runtime: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
