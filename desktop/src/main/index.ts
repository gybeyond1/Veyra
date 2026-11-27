import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron';
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
let tray: Tray | null = null;
/** 只有走「退出」才会真的结束进程；点 ✕ 只是把窗口收进托盘 */
let quitting = false;

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

/**
 * 托盘图标。
 *
 * 打包后图标在 resources 根下（electron-builder 的 extraResources），开发时在 desktop/resources；
 * 两边都找不到就给一个空图，至少不要因为图标缺失让主进程起不来。
 */
function trayIcon(): Electron.NativeImage {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.ico'), path.join(process.resourcesPath, 'icon.png')]
    : [path.join(__dirname, '../../resources/icon.ico'), path.join(__dirname, '../../resources/icon.png')];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) return image;
    } catch {
      /* 换下一个候选 */
    }
  }
  return nativeImage.createEmpty();
}

/** 从托盘/二开把窗口叫回来 */
function showWindow(): void {
  if (!mainWindow) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
  } catch (error) {
    console.error('[tray] 创建托盘图标失败', error);
    return;
  }
  tray.setToolTip('Veyra · 点开继续用，右键退出');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主界面', click: () => showWindow() },
      {
        label: '打开下载目录',
        click: () => {
          void shell.openPath(readSettings().downloadDir);
        },
      },
      { type: 'separator' },
      {
        label: '退出 Veyra',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

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

  /* 播放器点全屏时，视频铺满整个窗口，但 Windows 上菜单栏（文件/视图/帮助）
     还挂在最上面 —— 看着像「放大的窗口」而不是全屏。这里跟着 HTML 全屏一起
     收起菜单栏，退出再恢复。 */
  win.on('enter-html-full-screen', () => {
    win.setMenuBarVisibility(false);
    if (!win.isFullScreen()) win.setFullScreen(true);
  });
  win.on('leave-html-full-screen', () => {
    win.setMenuBarVisibility(true);
    if (win.isFullScreen()) win.setFullScreen(false);
  });

  if (saved.maximized) win.maximize();

  /* 点 ✕ 不退出：窗口收进托盘，下载、投屏、媒体服务都继续跑。
     真要退出走托盘右键或菜单「文件 → 退出」（那条会先设 quitting）。 */
  let toldTray = false;
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    saveWindowState(win);
    win.hide();
    if (!toldTray) {
      toldTray = true;
      try {
        tray?.displayBalloon({
          title: 'Veyra 还在后台',
          content: '点右下角托盘图标可以重新打开；要完全退出请右键托盘图标。',
        });
      } catch {
        /* 系统不支持气泡通知就算了 */
      }
    }
  });

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
  // 收进托盘后再双击 exe：把已有窗口叫回来，别开第二个
  showWindow();
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
  createTray();
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
  // 窗口被真正销毁（退出流程）时才有必要停后台服务；收进托盘时窗口只是隐藏
  stopProgressLoop();
  stopDevice();
  stopMedia();
  stopMpv();
  if (process.platform !== 'darwin') app.quit();
});

// 主进程被强杀时也要收掉 mpv 进程，别留一个黑窗口在外面
app.on('before-quit', () => {
  quitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  stopMpv();
});
