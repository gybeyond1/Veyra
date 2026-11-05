import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, AccountUser } from '../shared/types';
import { ensureDir, userDataDir } from './paths';

const settingsFile = path.join(userDataDir, 'settings.json');
const sessionFile = path.join(userDataDir, 'session.json');

export const defaultSettings: AppSettings = {
  server: '',
  downloadDir: path.join(app.getPath('downloads'), 'Veyra'),
  concurrency: 6,
  theme: 'dark',
  proxy: '',
  autoMerge: true,
  keepEpisodes: false,
  lastAccount: '',
};

let cachedSettings: AppSettings | null = null;

export function readSettings(): AppSettings {
  if (cachedSettings) return cachedSettings;
  let stored: Partial<AppSettings> = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    stored = {};
  }
  cachedSettings = { ...defaultSettings, ...stored };
  return cachedSettings;
}

export function writeSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...readSettings(), ...patch };
  cachedSettings = next;
  ensureDir(userDataDir);
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
  } catch (error) {
    console.warn('[settings] 写入失败', error);
  }
  return next;
}

export interface StoredSession {
  server: string;
  token: string;
  user: AccountUser;
  savedAt: number;
}

function encrypt(value: string): { data: string; plain: boolean } {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { data: safeStorage.encryptString(value).toString('base64'), plain: false };
    }
  } catch {
    /* 落到明文分支 */
  }
  return { data: Buffer.from(value, 'utf8').toString('base64'), plain: true };
}

function decrypt(data: string, plain: boolean): string {
  try {
    if (!plain) return safeStorage.decryptString(Buffer.from(data, 'base64'));
  } catch {
    /* 换机器/换用户后系统密钥失效，当作未登录 */
  }
  return plain ? Buffer.from(data, 'base64').toString('utf8') : '';
}

export function readSession(): StoredSession | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (!raw || !raw.token || !raw.user) return null;
    const token = decrypt(raw.token, !!raw.plain);
    if (!token) return null;
    return { server: String(raw.server || ''), token, user: raw.user, savedAt: Number(raw.savedAt) || 0 };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  const packed = encrypt(session.token);
  ensureDir(userDataDir);
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({ server: session.server, token: packed.data, plain: packed.plain, user: session.user, savedAt: session.savedAt }),
    { mode: 0o600 },
  );
}

export function clearSession(): void {
  try {
    fs.unlinkSync(sessionFile);
  } catch {
    /* 本来就没有 */
  }
}
