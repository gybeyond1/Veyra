import path from 'node:path';
import fs from 'node:fs';
import type { DownloadTask } from '../shared/types';
import { readSettings } from './store';
import { serverModules } from './server-modules';

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

export function create(payload: { id: string; title: string; cover?: string; source?: string; episodes?: number[] }): DownloadTask {
  const episodes = Array.isArray(payload.episodes) && payload.episodes.length
    ? payload.episodes.map((index) => ({ index }))
    : [];
  if (!episodes.length) throw new Error('没有选择要下载的集数');
  return dl().createTask({
    source: payload.source === 'huangguo' ? 'huangguo' : 'hongguo',
    title: String(payload.title || '未命名'),
    seriesId: String(payload.id || ''),
    cover: String(payload.cover || ''),
    episodes,
    owner: OWNER,
  }) as DownloadTask;
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
