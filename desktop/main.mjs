import { app, BrowserWindow, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startDataServer } from '../scripts/codex-data-server.mjs';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const DATA_PORT = Number(process.env.CODEX_USAGE_PORT || 64111);
let dataServer = null;

function log(message, error) {
  const detail =
    error instanceof Error ? `${error.stack || error.message}` : '';
  console.log(`[desktop] ${message}`, detail);
}

async function dataServiceAlreadyRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${DATA_PORT}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureDataService() {
  try {
    dataServer = await startDataServer(DATA_PORT);
  } catch (error) {
    if (error?.code !== 'EADDRINUSE' || !(await dataServiceAlreadyRunning())) {
      throw error;
    }
  }
}

function createWindow() {
  const window = new BrowserWindow({
    title: 'Codex Usage Monitor',
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: '#080d14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (process.env.CODEX_USAGE_RENDERER_URL) {
    void window.loadURL(process.env.CODEX_USAGE_RENDERER_URL);
  } else {
    void window.loadFile(join(currentDirectory, '../desktop-dist/index.html'));
  }
}

log('main module loaded');
process.on('uncaughtException', (error) => log('uncaught exception', error));
process.on('unhandledRejection', (error) => log('unhandled rejection', error));

app
  .whenReady()
  .then(async () => {
    log('app ready');
    app.setName('Codex Usage Monitor');
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Codex Usage Monitor',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );

    await ensureDataService();
    log('data service ready');
    createWindow();
    log('window created');
  })
  .catch((error) => {
    log('startup failed', error);
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  dataServer?.close();
});
