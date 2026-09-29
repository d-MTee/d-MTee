import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const host = process.env.REDIS_HOST ?? '127.0.0.1';
const port = Number(process.env.REDIS_PORT ?? 6379);
const redisBinary = process.env.REDIS_BIN ?? 'redis-server';

const command = process.platform === 'win32' ? 'where' : 'which';
const child = spawn(command, [redisBinary], {
  shell: true,
  stdio: 'pipe',
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});

child.on('close', (code) => {
  const found = code === 0 && output.trim().length > 0;

  if (!found) {
    console.warn('Redis is not installed or not on PATH. Use Docker: npm run docker:up');
    process.exit(0);
  }

  const server = spawn(redisBinary, ['--port', String(port), '--bind', host], {
    stdio: 'inherit',
  });

  server.on('exit', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
});
