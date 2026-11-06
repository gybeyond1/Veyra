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
  proxyMode: 3,
  privateSite: 'huangguo',
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
  // 旧版本没有 proxyMode，默认按「走后端转发」处理，跟手机端一致
  const mode = Number(cachedSettings.proxyMode);
  cachedSettings.proxyMode = mode === 1 || mode === 2 ? mode : 3;
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
  } catch (error) {
    // 换机器/换用户后系统密钥失效，当作未登录；但要留痕，否则「每次启动都要登录」很难查
    console.warn('[session] 解密本地凭据失败，按未登录处理', (error as Error).message);
    return '';
  }
  return plain ? Buffer.from(data, 'base64').toString('utf8') : '';
}

export function readSession(): StoredSession | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (!raw || !raw.token || !raw.user) return null;
    let token = decrypt(raw.token, !!raw.plain);
    // 兜底：某些环境（换过 Windows 用户/以管理员身份运行/系统密钥重置）DPAPI 解不开，
    // 这时用同一份文件里的明文备份，避免「明明登录过，每次打开都要重登」。
    if (!token && raw.tokenPlain) {
      token = Buffer.from(String(raw.tokenPlain), 'base64').toString('utf8');
      if (token) console.warn('[session] 系统凭据解不开，改用明文备份恢复登录');
    }
    if (!token) return null;
    return { server: String(raw.server || ''), token, user: raw.user, savedAt: Number(raw.savedAt) || 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[session] 读取 session.json 失败，按未登录处理', (error as Error).message);
    }
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  const packed = encrypt(session.token);
  ensureDir(userDataDir);
  const payload = JSON.stringify({
    server: session.server,
    token: packed.data,
    plain: packed.plain,
    // 文件权限是 0600（仅当前用户可读），和手机端 AccountService 的存法一致；
    // 系统加密只是锦上添花，能用就用，解不开时还有这条备胎。
    tokenPlain: Buffer.from(session.token, 'utf8').toString('base64'),
    user: session.user,
    savedAt: session.savedAt,
  });
  // 先写临时文件再改名：直接覆盖时进程被杀会留下半截 JSON，下次启动就只能重新登录
  const tmp = `${sessionFile}.tmp`;
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, sessionFile);
  try {
    fs.chmodSync(sessionFile, 0o600);
  } catch {
    /* Windows 上不支持也无所谓 */
  }
}

export function clearSession(): void {
  try {
    fs.unlinkSync(sessionFile);
  } catch {
    /* 本来就没有 */
  }
}
