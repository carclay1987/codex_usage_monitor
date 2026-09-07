import { app, BrowserWindow, Menu, Tray } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startDataServer } from '../scripts/codex-data-server.mjs';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const DATA_PORT = Number(process.env.CODEX_USAGE_PORT || 64111);
let dataServer = null;
let mainWindow = null;
let tray = null;
let trayTimer = null;
let isQuitting = false;

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
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
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
  mainWindow = window;

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (process.env.CODEX_USAGE_RENDERER_URL) {
    void window.loadURL(process.env.CODEX_USAGE_RENDERER_URL);
  } else {
    void window.loadFile(join(currentDirectory, '../desktop-dist/index.html'));
  }
  window.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => {
    mainWindow = null;
  });
  return window;
}

function formatReset(timestamp) {
  if (!timestamp) return 'время сброса неизвестно';
  return `сброс ${new Date(timestamp).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

async function updateTray() {
  if (!tray) return;
  try {
    const response = await fetch(`http://127.0.0.1:${DATA_PORT}/api/overview`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const overview = await response.json();
    const rateLimit = overview.rateLimit;
    const running = overview.threads.filter(
      (thread) => thread.status === 'running',
    );
    tray.setTitle(rateLimit ? ` ${Math.round(rateLimit.usedPercent)}%` : ' —');
    const lines = [
      'Codex Usage Monitor',
      rateLimit
        ? `Недельный лимит: ${Math.round(rateLimit.usedPercent)}% использовано, ${Math.max(0, Math.round(100 - rateLimit.usedPercent))}% осталось · ${formatReset(rateLimit.resetsAt)}`
        : 'Недельный лимит: нет данных',
      `Активные чаты: ${running.length}`,
      ...running.slice(0, 4).map((thread) => {
        const context =
          thread.contextPercent == null
            ? 'контекст —'
            : `контекст ${Math.round(thread.contextPercent)}%`;
        return `• ${String(thread.title).slice(0, 52)} · ${context}`;
      }),
      ...(running.length > 4 ? [`…и ещё ${running.length - 4}`] : []),
    ];
    tray.setToolTip(lines.join('\n'));
  } catch {
    tray.setTitle(' !');
    tray.setToolTip('Codex Usage Monitor\nЛокальная служба данных не отвечает');
  }
}

function createTray() {
  tray = new Tray(
    join(currentDirectory, '../build/icon.iconset/icon_16x16.png'),
  );
  tray.setTitle(' …');
  tray.setToolTip('Codex Usage Monitor\nЗагружаю состояние…');
  tray.on('click', () => {
    if (!mainWindow) return void createWindow();
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  tray.on('right-click', () => {
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Открыть dashboard',
          click: () => createWindow(),
        },
        {
          label: 'Обновить сейчас',
          click: () => void updateTray(),
        },
        { type: 'separator' },
        { label: 'Выйти', role: 'quit' },
      ]),
    );
  });
  void updateTray();
  trayTimer = setInterval(() => void updateTray(), 5000);
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
    createTray();
    log('tray created');
  })
  .catch((error) => {
    log('startup failed', error);
    app.quit();
  });

app.on('activate', () => {
  createWindow();
});

app.on('window-all-closed', () => {
  // Приложение продолжает работать в строке меню.
});

app.on('before-quit', () => {
  isQuitting = true;
  if (trayTimer) clearInterval(trayTimer);
  dataServer?.close();
});
