import type { ApiResult } from '@shared/types';

export async function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  const result = (await window.veyra.call(method, ...args)) as ApiResult;
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result.data as T;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || '未知错误');
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
