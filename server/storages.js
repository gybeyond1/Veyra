'use strict';

/**
 * 远程存储（WebDAV / SMB / FTP）登记表。
 *
 * 三端共用一个账号：手机在「设置 → 远程服务器」里加过的条目会随心跳上报到这里，
 * 电脑和 WebUI 就能直接看到并选「下载到某某 WebDAV」。
 *
 * 分工：
 *   - WebDAV：后端能直连，下载 + 合并完成后由后端直接 PUT 上去（不走任何设备）；
 *   - SMB / FTP：多半只在家里局域网通，后端够不着 —— 交给添加这条配置的那台设备中转
 *     （设备自己下载，再用自带的 SMB/FTP 客户端传上去）。
 *
 * 口令只存在服务端这份文件里（0600），任何接口都不回传明文，只给 hasPass。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = { webdav: 'WebDAV', smb: 'SMB', ftp: 'FTP' };
const MAX_STORAGES = 40;

function text(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 120);
}

function cleanHost(raw) {
  let host = text(raw, 120);
  const scheme = host.indexOf('://');
  if (scheme >= 0) host = host.slice(scheme + 3);
  host = host.replace(/\/+$/, '');
  const colon = host.lastIndexOf(':');
  if (colon > 0 && host.indexOf(':') === colon && /^\d{1,5}$/.test(host.slice(colon + 1))) {
    host = host.slice(0, colon);
  }
  return host;
}

function cleanPath(raw) {
  const segs = String(raw == null ? '' : raw).replace(/\\/g, '/').split('/');
  const out = [];
  for (const seg of segs) {
    const value = seg.trim();
    if (!value || value === '.') continue;
    out.push(value);
  }
  return out.length ? '/' + out.join('/') : '';
}

function typeDefaultPort(type, secure) {
  if (type === 'smb') return 445;
  if (type === 'ftp') return secure ? 990 : 21;
  return secure ? 443 : 80;
}

function makeAddress(item) {
  const type = item.type;
  const port = Number(item.port) || typeDefaultPort(type, item.secure);
  if (type === 'smb') return `smb://${item.host}/${item.share || ''}${item.path || ''}`;
  const scheme = type === 'ftp' ? (item.secure ? 'ftps' : 'ftp') : (item.secure ? 'https' : 'http');
  const suffix = port === typeDefaultPort(type, item.secure) ? '' : `:${port}`;
  return `${scheme}://${item.host}${suffix}${item.path || ''}`;
}

function normalize(input) {
  const type = text(input && input.type, 20).toLowerCase();
  if (!TYPES[type]) throw Object.assign(new Error('不支持的存储类型'), { statusCode: 400 });
  const host = cleanHost(input.host);
  if (!host) throw Object.assign(new Error('请填写服务器地址'), { statusCode: 400 });
  const secure = Boolean(input.secure);
  let port = Number(input.port) || 0;
  if (!(port > 0 && port < 65536)) port = typeDefaultPort(type, secure);
  const item = {
    type,
    name: text(input.name, 40) || host,
    host,
    port,
    secure,
    user: text(input.user, 80),
    pass: String(input.pass == null ? '' : input.pass).slice(0, 200),
    share: type === 'smb' ? text(input.share, 80).replace(/^\/+|\/+$/g, '') : '',
    path: cleanPath(input.path),
    cleanup: input.cleanup !== false,
  };
  if (type === 'smb' && !item.share) throw Object.assign(new Error('SMB 需要填写共享文件夹名'), { statusCode: 400 });
  if (!item.name) item.name = item.host;
  item.address = makeAddress(item);
  return item;
}

function publicView(item) {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    typeName: TYPES[item.type] || item.type,
    address: item.address || makeAddress(item),
    host: item.host,
    port: item.port,
    share: item.share || '',
    path: item.path || '',
    user: item.user || '',
    secure: !!item.secure,
    cleanup: item.cleanup !== false,
    hasPass: !!item.pass,
    // 设备端本地的 id：手机重装/换机后靠它把配置认回来（列表恢复用）
    localId: item.localId || '',
    // 配置是在哪台设备上填的：SMB/FTP 要靠它中转；空 = 直接在服务端/网页上添加
    deviceId: item.deviceId || '',
    deviceName: item.deviceName || '',
    // 后端能不能自己去写：只有 WebDAV 可以，SMB/FTP 必须设备中转
    direct: item.type === 'webdav',
    updatedAt: item.updatedAt || 0,
  };
}

function createStorages(options) {
  const file = path.join(options.dataDir, 'storages.json');
  const log = options.log || ((...args) => console.log('[storages]', ...args));
  let items = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.items)) items = raw.items;
  } catch { /* 首次运行 */ }

  function persist() {
    try {
      fs.mkdirSync(options.dataDir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) { log('保存失败：' + error.message); }
  }

  function list(userId) {
    return items.filter(item => item.userId === userId)
      .sort((a, b) => (a.type === b.type ? b.updatedAt - a.updatedAt : a.type.localeCompare(b.type)))
      .map(publicView);
  }

  function find(id, userId) {
    return items.find(item => item.id === id && item.userId === userId) || null;
  }

  /** 手机心跳带上来的配置：整组替换这台设备名下的条目，设备上删掉的这里也跟着消失。 */
  function syncDevice(deviceId, userId, deviceName, remotes) {
    if (!Array.isArray(remotes)) return;
    const keep = new Set();
    for (const remote of remotes.slice(0, 20)) {
      try {
        const item = normalize(remote || {});
        const localId = text(remote && remote.id, 40) || crypto.randomBytes(4).toString('hex');
        // 同一个 localId 在账号里只留一条：手机重装/换机后从后端恢复，再次上报时沿用原来的 id，
        // 否则每重装一次就会凭空多出一份重复配置。
        const existing = items.find(entry => entry.userId === userId && entry.localId === localId && entry.deviceId);
        const id = existing ? existing.id : `d_${deviceId}_${localId}`.slice(0, 120);
        keep.add(id);
        const previous = existing || items.find(entry => entry.id === id);
        items = items.filter(entry => entry.id !== id);
        items.push({
          ...item,
          id,
          localId,
          userId,
          deviceId,
          deviceName: text(deviceName, 40),
          // 设备端不回传密码时沿用上次的（手机列表接口本来就不给明文）
          pass: item.pass || (previous && previous.pass) || '',
          updatedAt: Date.now(),
        });
      } catch (error) {
        log(`设备 ${deviceId} 的存储配置无效：${error.message}`);
      }
    }
    // 这台设备名下、这次没上报的（设备上删了）清掉
    items = items.filter(entry => !(entry.deviceId === deviceId && entry.userId === userId) || keep.has(entry.id));
    persist();
  }

  /**
   * 手机恢复用：本人名下全部存储，带明文口令。
   * 只给已登录的本账号调用（token 鉴权），列表接口 publicView 永远不含口令。
   */
  function restore(userId) {
    return items.filter(item => item.userId === userId)
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      .map(item => ({
        ...publicView(item),
        pass: item.pass || '',
        localId: item.localId || '',
        deviceId: item.deviceId || '',
      }));
  }

  function save(userId, input) {
    const item = normalize(input || {});
    const id = text(input && input.id, 120);
    const existing = id ? items.find(entry => entry.id === id && entry.userId === userId) : null;
    let saved;
    if (existing) {
      // 编辑时密码留空 = 保持原密码（界面只拿到 hasPass，拿不到明文）
      if (!item.pass) item.pass = existing.pass || '';
      saved = { ...existing, ...item, userId, updatedAt: Date.now() };
      items = items.filter(entry => entry.id !== id);
    } else {
      if (items.filter(entry => entry.userId === userId).length >= MAX_STORAGES) {
        throw Object.assign(new Error(`最多保存 ${MAX_STORAGES} 个存储`), { statusCode: 400 });
      }
      saved = { ...item, id: `s_${crypto.randomBytes(6).toString('hex')}`, userId, deviceId: '', deviceName: '', updatedAt: Date.now() };
    }
    items.push(saved);
    persist();
    return publicView(saved);
  }

  function remove(id, userId) {
    const before = items.length;
    items = items.filter(entry => !(entry.id === id && entry.userId === userId));
    if (items.length !== before) persist();
    return items.length !== before;
  }

  /**
   * WebDAV 上传：建目录（MKCOL，已存在会回 405，忽略）再 PUT。
   * 只支持 WebDAV —— SMB/FTP 交给设备中转，不在这里硬做。
   */
  async function upload(id, userId, filePath, fileName) {
    const item = find(id, userId);
    if (!item) throw new Error('存储不存在');
    if (item.type !== 'webdav') throw new Error(`${TYPES[item.type]} 需要由添加它的设备中转，后端不能直连`);
    const base = makeAddress(item).replace(/\/+$/, '');
    const auth = item.user
      ? 'Basic ' + Buffer.from(`${item.user}:${item.pass || ''}`).toString('base64')
      : '';
    const headers = auth ? { Authorization: auth } : {};
    // 逐级 MKCOL，少了中间目录 PUT 会 409
    const segs = [];
    for (const seg of String(item.path || '').split('/').filter(Boolean)) {
      segs.push(seg);
      const url = `${makeAddress({ ...item, path: '/' + segs.join('/') }).replace(/\/+$/, '')}/`;
      try {
        const res = await fetch(url, { method: 'MKCOL', headers, signal: AbortSignal.timeout(15000) });
        if (![200, 201, 204, 301, 405].includes(res.status)) {
          log(`MKCOL ${url} -> ${res.status}`);
        }
      } catch { /* 目录多半已存在，PUT 会告诉我们真实结果 */ }
    }
    const target = `${base}/${encodeURIComponent(fileName)}`;
    const size = fs.statSync(filePath).size;
    const res = await fetch(target, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
      body: fs.createReadStream(filePath),
      duplex: 'half',
      signal: AbortSignal.timeout(6 * 3600 * 1000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`WebDAV 上传失败（${res.status}）${detail ? '：' + detail.slice(0, 120) : ''}`);
    }
    return { url: target, size };
  }

  return { file, list, find, syncDevice, restore, save, remove, upload };
}

module.exports = { createStorages, TYPES };
