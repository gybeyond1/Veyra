import type { RemoteTask } from '../shared/types';
import { requestJson } from './http';
import { session } from './session';
import { deviceId } from './device';
import { nasUrl, remoteUrl } from './media';

/**
 * 汇总「别的设备上」的下载记录。
 *
 * 三端是同一账号下的一堆设备，谁下载了什么另外两端都该看得见：
 *  - 服务器（NAS）上的下载任务走 /api/download/tasks，文件从 /api/download/files 出；
 *  - 手机 / 电视 / 另一台电脑走 /api/devices，各自上报任务摘要与局域网媒体地址，
 *    在线且有成品时直接连它的 /file/<任务id>/0 播放（同一局域网才通）。
 *
 * 桌面端自己那一份由 downloads.list() 单独给，这里把它排除掉。
 */

interface DeviceTaskPayload {
  id?: string;
  title?: string;
  cover?: string;
  status?: string;
  percent?: number;
  doneCount?: number;
  totalCount?: number;
  episodeCount?: number;
  merged?: boolean;
}

interface DevicePayload {
  id?: string;
  name?: string;
  platform?: string;
  online?: boolean;
  lan?: { url?: string; token?: string } | null;
  tasks?: DeviceTaskPayload[];
}

const PLATFORM_LABEL: Record<string, RemoteTask['kind']> = {
  desktop: 'desktop',
  android: 'android',
  tv: 'tv',
};

function clamp(value: unknown): number {
  const number = Number(value) || 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

/** 服务器上的下载（NAS）：桌面端没有本地文件，播放统一交给本机媒体服务的 /nas 转发。 */
async function nasTasks(server: string, token: string): Promise<RemoteTask[]> {
  const data = await requestJson<{ tasks?: Record<string, unknown>[] }>(server, '/api/download/tasks', {
    token,
    timeoutMs: 12000,
  });
  const items = Array.isArray(data?.tasks) ? data.tasks : [];
  return items.map((raw) => {
    const task = raw as Record<string, unknown>;
    const id = String(task.id || '');
    const status = String(task.status || '');
    const done = status === 'done';
    const ready = status === 'ready';
    return {
      key: `nas:${id}`,
      kind: 'nas',
      deviceName: '服务器',
      deviceId: '',
      remoteId: id,
      title: String(task.title || '未命名'),
      cover: String(task.cover || ''),
      status,
      percent: clamp(task.percent),
      doneCount: Number(task.doneCount) || 0,
      totalCount: Number(task.totalCount) || 0,
      episodeCount: Number(task.episodeCount) || 0,
      merged: done,
      online: true,
      playUrl: id && (done || ready) ? nasUrl(id, done ? 0 : 1) : '',
      hint: done || ready ? '' : '还没下载完',
    } satisfies RemoteTask;
  });
}

function deviceTasks(device: DevicePayload, selfId: string): RemoteTask[] {
  const platform = String(device.platform || 'android');
  if (!device.id || device.id === selfId) return [];
  const online = Boolean(device.online);
  const kind = PLATFORM_LABEL[platform];
  if (!kind) return [];
  const lanUrl = String(device.lan?.url || '').replace(/\/+$/, '');
  const lanToken = String(device.lan?.token || '');
  const tasks = Array.isArray(device.tasks) ? device.tasks : [];

  return tasks
    .filter((task) => task && task.id)
    .map((task) => {
      const id = String(task.id);
      const status = String(task.status || '');
      const merged = Boolean(task.merged);
      // 有局域网媒体服务才能远程播；没有就只展示进度
      const playable = online && Boolean(lanUrl) && merged;
      return {
        key: `${device.id}:${id}`,
        kind,
        deviceName: String(device.name || (kind === 'desktop' ? '电脑' : kind === 'tv' ? '电视' : '手机')),
        deviceId: String(device.id),
        remoteId: id,
        title: String(task.title || '未命名'),
        cover: String(task.cover || ''),
        status,
        percent: clamp(task.percent),
        doneCount: Number(task.doneCount) || 0,
        totalCount: Number(task.totalCount) || 0,
        episodeCount: Number(task.episodeCount) || 0,
        merged,
        online,
        // 走本机媒体服务转发：既能透传 Range，又能在电脑解不了 H.265 时自动转码
        playUrl: playable ? remoteUrl(`${lanUrl}/file/${encodeURIComponent(id)}/0?t=${encodeURIComponent(lanToken)}`) : '',
        hint: !online ? '设备离线' : !merged ? '还没合并，先在设备上合并' : !lanUrl ? '该设备没有局域网媒体服务' : '',
      } satisfies RemoteTask;
    });
}

export async function list(): Promise<RemoteTask[]> {
  const current = session();
  if (!current) return [];
  const selfId = deviceId();
  const result: RemoteTask[] = [];

  const [devices, nas] = await Promise.all([
    requestJson<{ devices?: DevicePayload[] }>(current.server, '/api/devices', { token: current.token, timeoutMs: 12000 })
      .catch(() => ({ devices: [] as DevicePayload[] })),
    nasTasks(current.server, current.token).catch(() => [] as RemoteTask[]),
  ]);

  for (const device of Array.isArray(devices?.devices) ? devices.devices : []) {
    result.push(...deviceTasks(device, selfId));
  }
  result.push(...nas);
  return result;
}
