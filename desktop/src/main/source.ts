import { requestJson } from './http';
import { session } from './session';

/**
 * 内容源状态。
 *
 * 红果（hongguo）是公开源，走官方 App 接口；黄果（huangguo）是私密源，走网页解析。
 * 私密模式必须先用动态码解锁——桌面端和电视端一样，每次冷启动后的首次进入都要输，
 * 不能只凭账号在服务器上的解锁标记放行（共用电脑同样不能免码）。
 */
export type ContentSource = 'hongguo' | 'huangguo';

let active: ContentSource = 'hongguo';
let unlocked = false;

export interface SourceState {
  active: ContentSource;
  unlocked: boolean;
  username: string;
}

export function state(): SourceState {
  return { active, unlocked, username: session()?.user?.username || '' };
}

export async function enterPrivate(code: string): Promise<SourceState> {
  const current = session();
  if (!current) throw new Error('请先登录账号');
  const digits = String(code || '').replace(/\D/g, '');
  if (digits.length !== 6) throw new Error('请输入 6 位动态码');
  // 管理员/特权组由服务端直接放行；普通用户验证通过后账号永久解锁
  await requestJson(current.server, '/api/otp/verify', {
    method: 'POST',
    token: current.token,
    body: { code: digits },
    timeoutMs: 12000,
  });
  unlocked = true;
  active = 'huangguo';
  return state();
}

export function leavePrivate(): SourceState {
  active = 'hongguo';
  return state();
}

/** 参数里带 source 的接口统一走这里，避免未解锁就抓到私密内容。 */
export function requireSource(source?: string): ContentSource {
  const next: ContentSource = source === 'huangguo' ? 'huangguo' : 'hongguo';
  if (next === 'huangguo' && !unlocked) throw new Error('请先输入动态码进入私密模式');
  return next;
}

/** 切号/退出登录时清掉解锁状态，下次登录重新验证。 */
export function reset(): void {
  active = 'hongguo';
  unlocked = false;
}
