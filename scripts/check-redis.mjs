import net from 'node:net';

const host = process.env.REDIS_HOST ?? '127.0.0.1';
const port = Number(process.env.REDIS_PORT ?? 6379);

const socket = net.createConnection({ host, port });

socket.on('connect', () => {
  console.log(`Redis connectivity OK: ${host}:${port}`);
  socket.end();
  process.exit(0);
});

socket.on('error', (error) => {
  console.error(`Redis connectivity FAILED: ${host}:${port}`);
  console.error(String(error.message ?? error));
  process.exit(1);
});
