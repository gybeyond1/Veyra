import type { AccountUser } from '../shared/types';
import { clearSession, readSession, saveSession, type StoredSession } from './store';

/**
 * 会话必须等 app ready 之后再读。
 *
 * session.json 里的 token 是用 safeStorage（Windows 走 DPAPI）加密的，而这个模块
 * 是在 index.ts 顶部静态 import 的，执行时机早于 app.whenReady()。safeStorage 在
 * ready 之前调用会直接抛错，旧代码把异常吞掉当成「没有会话」——表现就是每次启动
 * 都被踢回登录页（扫码登录也一样，因为写是好的，只有读失败）。
 * 所以这里改成惰性读取，第一次真正用到时（一定已经 ready）再落盘读取。
 */
let current: StoredSession | null = null;
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    current = readSession();
  } catch (error) {
    console.warn('[session] 读取本地会话失败', error);
    current = null;
  }
}

/** ready 之后调用一次，把磁盘上的会话读进内存（早读会踩 safeStorage 的坑）。 */
export function reload(): StoredSession | null {
  loaded = false;
  ensureLoaded();
  return current;
}

export function session(): StoredSession | null {
  ensureLoaded();
  return current;
}

export function token(): string {
  return session()?.token || '';
}

export function server(): string {
  return session()?.server || '';
}

export function user(): AccountUser | null {
  return session()?.user || null;
}

export function setSession(next: StoredSession): void {
  current = next;
  loaded = true;
  saveSession(next);
}

export function dropSession(): void {
  current = null;
  loaded = true;
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
