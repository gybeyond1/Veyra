import type { AccountUser } from '../shared/types';
import { clearSession, readSession, saveSession, type StoredSession } from './store';

let current: StoredSession | null = readSession();

export function session(): StoredSession | null {
  return current;
}

export function token(): string {
  return current?.token || '';
}

export function server(): string {
  return current?.server || '';
}

export function user(): AccountUser | null {
  return current?.user || null;
}

export function setSession(next: StoredSession): void {
  current = next;
  saveSession(next);
}

export function dropSession(): void {
  current = null;
  clearSession();
}

/** 服务器地址归一化：允许用户只填 IP:端口，自动补 http://，去掉多余斜杠和 /api。 */
export function normalizeServer(input: string): string {
  let value = String(input || '').trim();
  if (!value) throw new Error('请填写服务器地址');
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  value = value.replace(/\/+$/, '').replace(/\/api$/i, '');
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) throw new Error('bad');
  } catch {
    throw new Error('服务器地址格式不对，示例：http://192.168.1.10:8080');
  }
  return value;
}
