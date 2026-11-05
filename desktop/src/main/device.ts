import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requestJson } from './http';
import { session } from './session';
import { deviceName, userDataDir } from './paths';
import { list as listTasks } from './downloads';
import { info as mediaInfo } from './media';
import { emitEvent } from './bus';

/**
 * 设备注册与指令轮询（与手机/TV 端同一套 /api/devices 接口）。
 *
 * 桌面端上报 platform=desktop，附带局域网媒体服务地址与 token：
 * 手机端「投屏」就能把电脑列出来，电视也能直接拉电脑上的成品播放。
 * 任务摘要跟着心跳一起上报，手机下载页因此能看到电脑的下载记录。
 */

let registerTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let running = false;
let lastSignature = '';

function idFile(): string {
  return path.join(userDataDir, 'device.json');
}

export function deviceId(): string {
  try {
    const saved = JSON.parse(fs.readFileSync(idFile(), 'utf8')) as { id?: string };
    if (saved?.id && /^[A-Za-z0-9_-]{8,64}$/.test(saved.id)) return saved.id;
  } catch {
    /* 首次运行 */
  }
  const id = 'desktop' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(idFile(), JSON.stringify({ id }));
  } catch {
    /* 写不进去就本次会话用随机 id */
  }
  return id;
}

function taskSummary() {
  return listTasks()
    .slice(0, 40)
    .map((task) => ({
      id: task.id,
      title: task.title,
      // 私密源的封面是 base64 data URL，整包上报会把设备心跳撑爆，交空让手机端按标题兜底
      cover: task.cover && task.cover.startsWith('data:') ? '' : task.cover,
      status: task.status,
      percent: task.percent,
      doneCount: task.doneCount,
      totalCount: task.totalCount,
      episodeCount: task.episodeCount,
      merged: Boolean(task.output),
    }));
}

async function register(): Promise<void> {
  const current = session();
  if (!current) return;
  const media = mediaInfo();
  const tasks = taskSummary();
  const signature = JSON.stringify({ tasks: tasks.map((task) => [task.id, task.status, task.percent]), media: media.port });
  // 任务没变化时也照常发心跳，只是不用重新序列化整包
  const body: Record<string, unknown> = {
    id: deviceId(),
    name: deviceName(),
    model: deviceName(),
    brand: 'PC',
    platform: 'desktop',
    appVersion: __APP_VERSION__,
    lan: media.lan ? { url: media.lan, token: media.token } : null,
  };
  if (signature !== lastSignature) {
    body.tasks = tasks;
    lastSignature = signature;
  }
  await requestJson(current.server, '/api/devices/register', {
    method: 'POST',
    token: current.token,
    body,
    timeoutMs: 12000,
  });
}

async function poll(): Promise<void> {
  const current = session();
  if (!current) return;
  const result = await requestJson<{ commands?: { id: string; type: string; payload: Record<string, unknown> }[] }>(
    current.server,
    '/api/devices/poll',
    { method: 'POST', token: current.token, body: { id: deviceId() }, timeoutMs: 12000 },
  );
  const commands = Array.isArray(result?.commands) ? result.commands : [];
  for (const command of commands) {
    if (command.type === 'cast') {
      // 手机投屏：直接把 payload 交给渲染层，走同一个播放器
      emitEvent('cast', command.payload || {});
    }
    // 回执：桌面端只接受 cast 指令，下载指令由手机/TV 自己处理
    void requestJson(current.server, '/api/devices/ack', {
      method: 'POST',
      token: current.token,
      body: { deviceId: deviceId(), id: command.id, ok: command.type === 'cast', error: command.type === 'cast' ? '' : '桌面端暂不支持远程下载指令' },
      timeoutMs: 8000,
    }).catch(() => undefined);
  }
}

export function start(): void {
  if (running) return;
  running = true;
  const loopRegister = () => {
    register().catch((error) => console.warn('[device] 注册失败', (error as Error).message));
  };
  const loopPoll = () => {
    poll().catch((error) => console.warn('[device] 轮询失败', (error as Error).message));
  };
  loopRegister();
  loopPoll();
  registerTimer = setInterval(loopRegister, 30000);
  pollTimer = setInterval(loopPoll, 3000);
}

export function stop(): void {
  running = false;
  if (registerTimer) clearInterval(registerTimer);
  if (pollTimer) clearInterval(pollTimer);
  registerTimer = null;
  pollTimer = null;
}

/** 登录/退出后立刻重注册，不用等下一次心跳。 */
export function refresh(): void {
  lastSignature = '';
  register().catch(() => undefined);
}
