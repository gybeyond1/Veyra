'use strict';

/**
 * 设备中继：Web 端「下载到手机」的落地实现。
 *
 * - APK 启动/登录后用账号 token 把设备信息上报（型号、品牌、系统、App 版本），
 *   后端按账号 → 设备建立索引；
 * - Web 管理台选账号 → 选设备 → 创建下载指令；
 * - APK 在前台每 40 秒轮询一次，取到指令后在本机解析播放地址、加入本地下载队列，
 *   后续下载与合并完全走 APK 现有本地逻辑，完成后回执。
 *
 * 状态全部落在 DATA_DIR/devices.json，容器重启不丢。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ONLINE_MS = 90 * 1000;        // 90 秒内有心跳视为在线
const COMMAND_TTL_MS = 24 * 3600 * 1000;
const MAX_COMMANDS = 200;
const MAX_PENDING_PER_DEVICE = 12;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function text(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 80);
}

function createDeviceHub(options) {
  const file = path.join(options.dataDir, 'devices.json');
  let state = { devices: {}, commands: [], revoked: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.devices && Array.isArray(raw.commands)) {
      state = { devices: raw.devices, commands: raw.commands, revoked: raw.revoked || {} };
    }
  } catch { /* 首次运行或文件损坏：从空状态开始 */ }

  let saveTimer = null;
  function persistNow() {
    try {
      fs.mkdirSync(options.dataDir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (error) { console.log('[devices] 保存失败:', error.message); }
  }
  /** 短时间内的多次变更合并成一次落盘，避免轮询高峰频繁写盘。 */
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 800);
  }

  function prune() {
    const cutoff = Date.now() - COMMAND_TTL_MS;
    state.commands = state.commands.filter(c => c.createdAt >= cutoff || c.status === 'pending');
    if (state.commands.length > MAX_COMMANDS) state.commands = state.commands.slice(-MAX_COMMANDS);
  }

  function publicDevice(device) {
    return {
      id: device.id, userId: device.userId, username: device.username,
      name: device.name, model: device.model, brand: device.brand,
      platform: device.platform || 'android', appVersion: device.appVersion,
      createdAt: device.createdAt, lastSeen: device.lastSeen,
      online: Date.now() - (device.lastSeen || 0) < ONLINE_MS,
      // 桌面端：局域网媒体服务地址 + 访问 token，手机/TV 直连播放用
      lan: device.lan || null,
      // 桌面端上报的下载任务摘要；手机下载页据此显示「电脑上的下载」
      tasks: Array.isArray(device.tasks) ? device.tasks : [],
    };
  }

  /** 设备上报：同一 deviceId 换账号登录会重新绑定到新账号（旧账号自动失去该设备）。 */
  function register(user, info) {
    const id = text(info && info.id, 64);
    if (!DEVICE_ID_RE.test(id)) { const e = new Error('设备标识不合法'); e.statusCode = 400; throw e; }
    // 被移除的设备：必须先在别处重新登录（登录会解除标记），否则心跳一律拒绝
    const revoked = state.revoked[id];
    if (revoked && revoked.userId === user.id) {
      const e = new Error('这台设备已被移除，请重新登录');
      e.statusCode = 403;
      e.revoked = true;
      throw e;
    }
    const now = Date.now();
    const previous = state.devices[id];
    const device = {
      id, userId: user.id, username: user.username,
      name: text((info && info.name) || '', 40)
        || [text(info && info.brand, 20), text(info && info.model, 40)].filter(Boolean).join(' ')
        || '未命名设备',
      model: text(info && info.model, 40), brand: text(info && info.brand, 20),
      platform: text((info && info.platform) || 'android', 20),
      appVersion: text(info && info.appVersion, 24),
      createdAt: previous && previous.userId === user.id ? previous.createdAt : now,
      lastSeen: now,
      // 心跳可能只带 lan 不带 tasks（省流量），缺省时沿用上一次上报的摘要
      lan: info && info.lan && typeof info.lan === 'object'
        ? { url: text(info.lan.url, 120), token: text(info.lan.token, 80) }
        : (previous && previous.lan) || null,
      tasks: info && Array.isArray(info.tasks)
        ? info.tasks.slice(0, 40).map(t => ({
          id: text(t && t.id, 80), title: text(t && t.title, 120), cover: text(t && t.cover, 300),
          status: text(t && t.status, 24), percent: Number(t && t.percent) || 0,
          doneCount: Number(t && t.doneCount) || 0, totalCount: Number(t && t.totalCount) || 0,
          episodeCount: Number(t && t.episodeCount) || 0, merged: Boolean(t && t.merged),
        }))
        : (previous && previous.tasks) || [],
    };
    state.devices[id] = device;
    if (previous && previous.userId !== user.id) {
      // 设备换绑：清掉旧账号挂在它身上的待投递指令，避免把新账号的内容下到旧任务里
      state.commands = state.commands.filter(c => !(c.deviceId === id && c.status === 'pending'));
    }
    persist();
    const pending = state.commands.filter(c => c.deviceId === id && c.status === 'pending').length;
    return { device: publicDevice(device), pending };
  }

  function touch(deviceId, userId) {
    const device = state.devices[deviceId];
    if (!device || device.userId !== userId) return null;
    device.lastSeen = Date.now();
    persist();
    return device;
  }

  function list(userId) {
    const items = Object.values(state.devices)
      .filter(d => !userId || d.userId === userId)
      .map(publicDevice)
      .sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
    return items;
  }

  function remove(deviceId) {
    if (!state.devices[deviceId]) return false;
    delete state.devices[deviceId];
    state.commands = state.commands.filter(c => c.deviceId !== deviceId);
    persist();
    return true;
  }

  /** 改名：只改显示名，不动设备身份，也不需要动态码。 */
  function rename(deviceId, userId, name) {
    const device = state.devices[deviceId];
    if (!device || device.userId !== userId) {
      const e = new Error('设备不存在'); e.statusCode = 404; throw e;
    }
    const next = text(name, 24);
    if (!next) { const e = new Error('设备名不能为空'); e.statusCode = 400; throw e; }
    device.name = next;
    persist();
    return publicDevice(device);
  }

  /**
   * 移除设备：删掉记录 + 打上撤销标记。
   * 标记不清掉的话，那台设备下一次心跳就会把自己重新注册回来 —— 等于没删。
   * 用户在任意一端重新登录时（login 路由）会调用 clearRevoked 解除。
   */
  function revoke(deviceId, userId) {
    const device = state.devices[deviceId];
    if (!device || device.userId !== userId) {
      const e = new Error('设备不存在'); e.statusCode = 404; throw e;
    }
    state.revoked[deviceId] = { userId, at: Date.now() };
    delete state.devices[deviceId];
    state.commands = state.commands.filter(c => c.deviceId !== deviceId);
    persistNow();
    return true;
  }

  /** 重新登录 = 重新授权这台设备，撤销标记作废。 */
  function clearRevoked(userId) {
    let changed = false;
    for (const [id, item] of Object.entries(state.revoked)) {
      if (item.userId === userId) { delete state.revoked[id]; changed = true; }
    }
    if (changed) persistNow();
  }

  function createCommand(deviceId, payload, type) {
    const device = state.devices[deviceId];
    if (!device) { const e = new Error('设备不在线或未注册'); e.statusCode = 404; throw e; }
    const kind = type === 'cast' ? 'cast' : 'download';
    // 投屏是「当前状态」而不是任务：连着点两部剧，只该播最后点的那部，
    // 所以新的 cast 把旧的未领取 cast 直接作废，别在电视上排队播一遍。
    if (kind === 'cast') {
      state.commands = state.commands.filter(c => !(c.deviceId === deviceId && c.type === 'cast' && c.status === 'pending'));
    }
    const pending = state.commands.filter(c => c.deviceId === deviceId && c.status === 'pending').length;
    if (pending >= MAX_PENDING_PER_DEVICE) { const e = new Error('该设备待领取的指令过多，请稍后'); e.statusCode = 429; throw e; }
    const command = {
      id: crypto.randomBytes(8).toString('hex'),
      deviceId, userId: device.userId, username: device.username,
      type: kind, status: 'pending',
      payload, createdAt: Date.now(), updatedAt: Date.now(), deliveredAt: 0, error: '',
    };
    state.commands.push(command);
    prune();
    persist();
    return command;
  }

  /** 设备轮询：只返回待领取指令，并立刻置为已投递（避免同一条被两次执行）。 */
  function poll(deviceId, userId) {
    const device = touch(deviceId, userId);
    if (!device) return null;
    const now = Date.now();
    const mine = state.commands.filter(c => c.deviceId === deviceId && c.status === 'pending');
    for (const c of mine) { c.status = 'delivered'; c.deliveredAt = now; c.updatedAt = now; }
    if (mine.length) persist();
    return { device: publicDevice(device), commands: mine.map(c => ({ id: c.id, type: c.type, payload: c.payload, createdAt: c.createdAt })) };
  }

  function ack(deviceId, userId, commandId, ok, error) {
    const command = state.commands.find(c => c.id === commandId && c.deviceId === deviceId);
    if (!command) { const e = new Error('指令不存在'); e.statusCode = 404; throw e; }
    if (command.userId !== userId) { const e = new Error('无权回执该指令'); e.statusCode = 403; throw e; }
    command.status = ok ? 'done' : 'failed';
    command.error = text(error, 200);
    command.updatedAt = Date.now();
    persist();
    return { id: command.id, status: command.status };
  }

  function commands(filter) {
    const f = filter || {};
    return state.commands
      .filter(c => (!f.deviceId || c.deviceId === f.deviceId) && (!f.userId || c.userId === f.userId))
      .slice(-40).reverse()
      .map(c => ({ id: c.id, deviceId: c.deviceId, username: c.username, type: c.type, status: c.status,
        payload: c.payload, createdAt: c.createdAt, updatedAt: c.updatedAt, error: c.error }));
  }

  return { register, poll, ack, list, remove, rename, revoke, clearRevoked, createCommand, commands, file };
}

module.exports = { createDeviceHub, ONLINE_MS };
