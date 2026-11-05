import type { AccountUser, SessionState } from '../shared/types';
import { requestJson } from './http';
import { deviceName } from './paths';
import { dropSession, normalizeServer, session, setSession } from './session';

interface LoginResponse {
  token: string;
  user: AccountUser;
}

function toState(server: string): SessionState {
  const current = session();
  return { server: current?.server || server, user: current?.user || null };
}

export async function login(payload: { server: string; username: string; password: string }): Promise<SessionState> {
  const server = normalizeServer(payload.server);
  const username = String(payload.username || '').trim();
  if (!username) throw new Error('请填写账号');
  if (!payload.password) throw new Error('请填写密码');

  const data = await requestJson<LoginResponse>(server, '/api/login', {
    method: 'POST',
    body: { username, password: payload.password, device: `desktop:${deviceName()}` },
    timeoutMs: 15000,
  });
  if (!data?.token || !data?.user) throw new Error('服务器返回数据不完整');

  setSession({ server, token: data.token, user: data.user, savedAt: Date.now() });
  return toState(server);
}

export async function register(payload: { server: string; username: string; password: string; code?: string }): Promise<SessionState> {
  const server = normalizeServer(payload.server);
  const username = String(payload.username || '').trim();
  const code = String(payload.code || '').replace(/\D/g, '');
  if (!username) throw new Error('请填写账号');
  if (!payload.password) throw new Error('请填写密码');
  if (code.length !== 6) throw new Error('注册需要管理员提供的 6 位动态码');

  const data = await requestJson<LoginResponse>(server, '/api/register', {
    method: 'POST',
    body: { username, password: payload.password, code, device: `desktop:${deviceName()}` },
    timeoutMs: 15000,
  });
  if (!data?.token || !data?.user) throw new Error('注册失败：服务器返回数据不完整');
  setSession({ server, token: data.token, user: data.user, savedAt: Date.now() });
  return toState(server);
}

/**
 * 冷启动恢复会话：先用本地 token 问一次 /api/me。
 * 服务器暂时连不上时不踢人，保留会话进离线模式（已下载的内容仍可看）。
 */
export async function restore(): Promise<{ state: SessionState; online: boolean; error?: string }> {
  const current = session();
  if (!current) return { state: { server: '', user: null }, online: false };
  try {
    const data = await requestJson<{ user: AccountUser }>(current.server, '/api/me', {
      token: current.token,
      timeoutMs: 8000,
    });
    if (data?.user) {
      setSession({ ...current, user: data.user, savedAt: Date.now() });
    }
    return { state: toState(current.server), online: true };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403) {
      dropSession();
      return { state: { server: current.server, user: null }, online: true, error: '登录已过期，请重新登录' };
    }
    return { state: toState(current.server), online: false, error: (error as Error).message };
  }
}

export async function logout(): Promise<void> {
  const current = session();
  if (current?.token) {
    try {
      await requestJson(current.server, '/api/logout', { method: 'POST', token: current.token, timeoutMs: 5000 });
    } catch {
      /* 服务器不可达也要能退出本地 */
    }
  }
  dropSession();
}

/** 扫码登录把会话直接推过来（手机端确认后调用）。 */
export function adoptScannedSession(payload: { server: string; token: string; user: AccountUser }): SessionState {
  const server = normalizeServer(payload.server);
  if (!payload.token || !payload.user?.id) throw new Error('扫码返回的会话不完整');
  setSession({ server, token: payload.token, user: payload.user, savedAt: Date.now() });
  return toState(server);
}
