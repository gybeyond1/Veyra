import path from 'node:path';
import fs from 'node:fs';
import type { DownloadDispatchResult, DownloadTarget, DownloadTask } from '../shared/types';
import { readSettings } from './store';
import { serverModules } from './server-modules';
import { requestJson } from './http';
import { session } from './session';
import { deviceId } from './device';

const OWNER = 'desktop';

function dl() {
  return serverModules().downloader;
}

/** 把设置里的下载目录和并发数灌进下载器；目录不可写时下载器会自己回退并返回实际目录。 */
export function configureDownloads(): { downloadDir: string; concurrency: number; keepEpisodes: boolean } {
  const settings = readSettings();
  const downloader = dl();
  const dir = downloader.setDownloadDir(settings.downloadDir);
  const concurrency = downloader.setConcurrency(settings.concurrency);
  const merge = downloader.setMergeOptions({ keepEpisodes: settings.keepEpisodes });
  return { downloadDir: dir, concurrency, keepEpisodes: !!merge?.keepEpisodes };
}

export function list(): DownloadTask[] {
  return dl().listTasks(OWNER, true) as DownloadTask[];
}

const PLATFORM_TEXT: Record<string, string> = { android: '手机', tv: '电视', desktop: '电脑' };

/**
 * 「下载到」下拉的数据源：本机 / 服务器 / 同账号在线设备 / 共享的远程存储。
 * 服务器和存储都要登录后才读得到，读不到就只给本机，不阻塞下载。
 */
export async function targets(): Promise<DownloadTarget[]> {
  const list: DownloadTarget[] = [
    { key: 'local', kind: 'local', name: '本机', hint: readSettings().downloadDir, available: true },
  ];
  const current = session();
  if (!current) return list;

  list.push({ key: 'nas', kind: 'nas', name: '服务器（NAS）', hint: '由服务器下载并合并，其它设备可直接播放', available: true });

  const [devices, storages] = await Promise.all([
    requestJson<{ devices?: { id?: string; name?: string; platform?: string; online?: boolean }[] }>(
      current.server, '/api/devices', { token: current.token, timeoutMs: 8000 },
    ).catch(() => ({ devices: [] })),
    requestJson<{ storages?: Record<string, unknown>[] }>(current.server, '/api/storages', {
      token: current.token, timeoutMs: 8000,
    }).catch(() => ({ storages: [] })),
  ]);

  const self = deviceId();
  for (const device of Array.isArray(devices?.devices) ? devices.devices : []) {
    const id = String(device.id || '');
    if (!id || id === self) continue;
    const platform = String(device.platform || 'android');
    list.push({
      key: `device:${id}`,
      kind: 'device',
      name: `${PLATFORM_TEXT[platform] || '设备'} · ${String(device.name || '未命名')}`,
      hint: device.online ? '在线，立即开始下载' : '离线，上线后自动开始',
      platform,
      online: Boolean(device.online),
      available: true,
    });
  }

  for (const raw of Array.isArray(storages?.storages) ? storages.storages : []) {
    const type = String(raw.type || '');
    const direct = Boolean(raw.direct);
    const owner = String(raw.deviceName || '');
    const available = direct || Boolean(raw.deviceId);
    const hint = direct
      ? '下载完成后由服务器直接上传'
      : owner
        ? `由 ${owner} 中转上传`
        : '缺少中转设备（在这台设备上重新添加一次）';
    list.push({
      key: `storage:${String(raw.id || '')}`,
      kind: 'storage',
      name: `${String(raw.typeName || type.toUpperCase())} · ${String(raw.name || raw.address || '')}`,
      hint,
      available,
    });
  }

  return list;
}

/** 下载：target 为空 = 本机；其余交给服务器分发（NAS / 设备 / 远程存储）。 */
export async function create(payload: {
  id: string;
  title: string;
  cover?: string;
  source?: string;
  episodes?: number[];
  target?: string;
}): Promise<DownloadDispatchResult> {
  const episodes = Array.isArray(payload.episodes) && payload.episodes.length ? payload.episodes : [];
  if (!episodes.length) throw new Error('没有选择要下载的集数');
  const target = String(payload.target || 'local');
  const title = String(payload.title || '未命名');

  if (target === 'local' || target === '') {
    const task = dl().createTask({
      source: payload.source === 'huangguo' ? 'huangguo' : 'hongguo',
      title,
      seriesId: String(payload.id || ''),
      cover: String(payload.cover || ''),
      episodes: episodes.map((index) => ({ index })),
      owner: OWNER,
    }) as DownloadTask;
    return { mode: 'local', title: task.title, message: `已加入本机下载队列（${episodes.length} 集）`, task };
  }

  const current = session();
  if (!current) throw new Error('下载到 NAS / 设备需要先登录账号');

  const targetBody: Record<string, string> = { kind: target.split(':')[0] };
  if (target.startsWith('device:')) targetBody.deviceId = target.slice(7);
  if (target.startsWith('storage:')) targetBody.storageId = target.slice(8);

  const result = await requestJson<{ ok?: boolean; mode?: string; message?: string }>(
    current.server, '/api/download/dispatch', {
      method: 'POST',
      token: current.token,
      timeoutMs: 20000,
      body: {
        source: payload.source === 'huangguo' ? 'huangguo' : 'hongguo',
        title,
        seriesId: String(payload.id || ''),
        cover: String(payload.cover || ''),
        episodes,
        target: targetBody,
      },
    },
  );
  return {
    mode: (result?.mode as DownloadDispatchResult['mode']) || 'nas',
    title,
    message: String(result?.message || `已提交（${episodes.length} 集）`),
  };
}

export function remove(id: string): void {
  const task = dl().getRawTask(id, OWNER, true);
  if (task?.status === 'downloading' || task?.status === 'merging') {
    task.status = 'canceled';
  }
  dl().deleteTask(id, OWNER, true);
}

export function merge(id: string): DownloadTask {
  const result = dl().mergeTask(id, OWNER, true);
  if (!result) throw new Error('任务不存在');
  return result as DownloadTask;
}

export function retry(id: string): DownloadTask {
  const result = dl().retryFailedEpisodes(id, OWNER, true);
  if (!result) throw new Error('任务不存在');
  return result as DownloadTask;
}

/** 任务的工作目录（分集文件在这里）或最终产物所在目录。 */
export function taskFolder(id: string): string {
  const task = dl().getRawTask(id, OWNER, true);
  if (!task) return readSettings().downloadDir;
  if (task.output && fs.existsSync(task.output)) return path.dirname(task.output);
  return dl().taskDirOf(task);
}
