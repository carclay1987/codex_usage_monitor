import { spawn } from 'node:child_process';

const dataUrl = `http://127.0.0.1:${process.env.CODEX_USAGE_PORT || 64111}`;

async function dataServiceIsRunning() {
  try {
    const response = await fetch(`${dataUrl}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

const children = [];

if (!(await dataServiceIsRunning())) {
  children.push(
    spawn(process.execPath, ['scripts/codex-data-server.mjs'], {
      stdio: 'inherit',
    }),
  );
}

children.push(spawn('npm', ['run', 'dev'], { stdio: 'inherit' }));

function stop(signal = 'SIGTERM') {
  for (const child of children) child.kill(signal);
}

process.on('SIGINT', () => {
  stop('SIGINT');
  process.exit(0);
});
process.on('SIGTERM', () => {
  stop('SIGTERM');
  process.exit(0);
});

for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      stop();
      process.exit(code);
    }
  });
}
