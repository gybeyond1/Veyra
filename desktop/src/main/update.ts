import type { UpdateInfo } from '../shared/types';
import { requestJson } from './http';
import { session } from './session';

/** 比较 x.y.z；返回 >0 表示 a 比 b 新。 */
function compare(a: string, b: string): number {
  const left = String(a || '0').split('.').map((part) => Number(part) || 0);
  const right = String(b || '0').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * 检测更新：优先问自己的后端（后端会从 GitHub Release 拉安装包并缓存，
 * 国内直连 GitHub 基本不可用，用户只可能从这里下得动）。
 */
export async function check(): Promise<UpdateInfo> {
  const current = session();
  if (!current) throw new Error('请先登录账号');
  const currentVersion = __APP_VERSION__;
  const data = await requestJson<{ version?: string; url?: string; notes?: string; size?: number }>(
    current.server,
    '/api/app/latest?platform=desktop',
    { token: current.token, timeoutMs: 15000 },
  );
  const latest = String(data?.version || currentVersion);
  const rawUrl = String(data?.url || '');
  const url = rawUrl.startsWith('http') ? rawUrl : rawUrl ? new URL(rawUrl, current.server).toString() : '';
  return {
    current: currentVersion,
    latest,
    url,
    notes: String(data?.notes || ''),
    size: Number(data?.size) || 0,
    // 后端知道有新版但安装包还在路上时 url 为空，这时也算「有更新」，界面提示稍后再点
    hasUpdate: compare(latest, currentVersion) > 0,
  };
}
