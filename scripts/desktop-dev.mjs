import { spawn } from 'node:child_process';

const rendererUrl = 'http://127.0.0.1:5173';
const vite = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    '--config',
    'vite.desktop.config.ts',
    '--host',
    '127.0.0.1',
  ],
  { stdio: 'inherit' },
);

async function waitForRenderer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(rendererUrl);
      if (response.ok) return;
    } catch {
      // Vite ещё запускается.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Desktop renderer did not start');
}

await waitForRenderer();

const electron = spawn('node_modules/.bin/electron', ['.'], {
  stdio: 'inherit',
  env: { ...process.env, CODEX_USAGE_RENDERER_URL: rendererUrl },
});

function stop(signal = 'SIGTERM') {
  electron.kill(signal);
  vite.kill(signal);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

electron.on('exit', (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
