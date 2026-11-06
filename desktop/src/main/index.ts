import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { installFileLogger } from './log';
import { devServerUrl, isDev, primeRuntimeEnv, userDataDir } from './paths';
import { readSettings } from './store';
import { serverModules } from './server-modules';
import { bindWindow, registerIpc, restoreSession, startProgressLoop, stopProgressLoop } from './ipc';
import { reload as reloadSession } from './session';
import { configureDownloads } from './downloads';
import { start as startMedia, stop as stopMedia } from './media';
import { close as stopMpv } from './mpv';
import { start as startDevice, stop as stopDevice } from './device';

installFileLogger();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

function windowStateFile(): string {
  return path.join(userDataDir, 'window.json');
}

function loadWindowState(): { width: number; height: number; x?: number; y?: number; maximized?: boolean } {
  try {
    return JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
  } catch {
    return { width: 1320, height: 860 };
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
  } catch {
    /* 写不进去不影响使用 */
  }
}

const PROJECT_URL = 'https://github.com/gybeyond1/Veyra';

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开下载目录',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const dir = readSettings().downloadDir;
            void shell.openPath(dir);
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'togglefullscreen', label: '全屏' },
        ...(isDev ? ([{ role: 'toggleDevTools', label: '开发者工具' }] as Electron.MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          // 之前是给渲染层发 about 事件，但界面根本没监听，点了像没反应。
          // 直接打开项目主页，也顺便让用户能看到更新日志。
          label: '关于 Veyra',
          click: () => {
            void shell.openExternal(PROJECT_URL);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(): Promise<void> {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    backgroundColor: '#0E1116',
    title: 'Veyra',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow = win;
  bindWindow(win);

  if (saved.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());
  win.on('resize', () => saveWindowState(win));
  win.on('move', () => saveWindowState(win));
  win.on('closed', () => {
    mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl) {
    await win.loadURL(devServerUrl);
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  // 必须在 ready 之后再读会话：safeStorage 在 ready 之前不可用（见 session.ts）
  const restored = reloadSession();
  const settings = readSettings();
  primeRuntimeEnv({
    dataDir: path.join(userDataDir, 'data'),
    downloadDir: settings.downloadDir,
  });

  try {
    serverModules();
    const applied = configureDownloads();
    console.log('[boot] 下载目录', applied.downloadDir, '并发', applied.concurrency);
  } catch (error) {
    console.error('[boot] 下载模块初始化失败', error);
  }

  registerIpc();
  buildMenu();
  try {
    await startMedia();
    startDevice();
  } catch (error) {
    console.error('[boot] 媒体服务/设备注册启动失败', error);
  }
  await createWindow();
  startProgressLoop();
  if (restored) {
    // 有本地凭据就跟服务器核一次：凭据还有效就把用户信息刷新，失效才真的退出登录
    void restoreSession();
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  stopProgressLoop();
  stopDevice();
  stopMedia();
  stopMpv();
  if (process.platform !== 'darwin') app.quit();
});

// 主进程被强杀时也要收掉 mpv 进程，别留一个黑窗口在外面
app.on('before-quit', () => {
  stopMpv();
});
