'use strict';
/**
 * 旧版 App 接口的公共底座（黄果旧版 / 禁果 用的是同一套协议）。
 *
 * 协议长这样：
 *   1. 参数 JSON 用 AES-128-CBC（parameterKey / parameterIV）加密，塞进 data 查询参数；
 *   2. 响应是个信封，data 是密文，前 12 字节随机前缀 + interfaceKey 派生出 AES-256 的 key/iv；
 *   3. 还要带一个自己拼的设备号换访客 token，token 过期回 5005。
 *
 * 两个源只有三处不同：接口域名（可多个轮换）、UA 里的包名/版本、设备号格式。
 * 所以这里做成工厂，两边各传一份配置，别再复制一遍加解密。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { request } = require('./util');

/** 官网前端脚本里的那套密钥；抓不到脚本时用它顶上（和官方当前一致） */
const FALLBACK = {
  interfaceKey: '65dc07d1b7915c6b2937432b091837a7',
  paramKey: 'BxJand%xf5h3sycH',
  paramIv: 'BxJand%xf5h3sycH',
};

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function pkcs7(buffer) {
  const pad = 16 - (buffer.length % 16);
  return Buffer.concat([buffer, Buffer.alloc(pad, pad)]);
}

function unpad(buffer) {
  const pad = buffer[buffer.length - 1];
  return pad > 0 && pad <= 16 ? buffer.subarray(0, buffer.length - pad) : buffer;
}

function encryptParam(value, key, iv) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pkcs7(Buffer.from(JSON.stringify(value)))), cipher.final()]).toString('base64');
}

/** 前 12 字节是随机前缀，用它和 interfaceKey 派生出 key 与 iv */
function decryptResponse(dataString, interfaceKey) {
  const payload = Buffer.from(String(dataString).trim(), 'base64');
  if (payload.length < 12) throw new Error('响应密文过短');
  const prefix = payload.subarray(0, 12);
  const mixed = Buffer.concat([interfaceKey, prefix]);
  const half = mixed.length >> 1;
  const seed = crypto.createHash('sha256').update(mixed).digest().subarray(8, 24);
  const left = Buffer.concat([seed, mixed.subarray(0, half)]);
  const right = Buffer.concat([mixed.subarray(half), seed]);
  const h1 = crypto.createHash('sha256').update(left).digest();
  const h2 = crypto.createHash('sha256').update(right).digest();
  const key = Buffer.concat([h1.subarray(0, 8), h2.subarray(8, 24), h1.subarray(24)]);
  const iv = Buffer.concat([h2.subarray(0, 4), h1.subarray(12, 20), h2.subarray(28)]);
  const body = payload.subarray(12);
  if (body.length % 16) throw new Error('响应密文未对齐');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  return unpad(Buffer.concat([decipher.update(body), decipher.final()]));
}

/**
 * @param {object} config
 * @param {string} config.key        缓存文件与日志里的标识
 * @param {string} config.name       用户看到的名字，用于报错
 * @param {string[]} config.bases    接口域名，按顺序试，成功过的排前面
 * @param {string} config.front      前端站（Origin / Referer / 播放页）
 * @param {string} config.cdn        播放接口要带的 c 参数（没有就不带）
 * @param {(device:string)=>string} config.userAgent  X-User-Agent
 * @param {()=>string} config.newDevice 设备号生成
 * @param {string} [config.ua]       真实 UA
 * @param {Record<string,string>} [config.headers] 额外请求头
 */
function createLegacyClient(config) {
  const cacheFile = path.join(DATA_DIR, `legacy-${config.key}.json`);
  const label = config.name;

  function loadSaved() {
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (!saved || !saved.interfaceKey || !saved.paramKey || !saved.paramIv) return null;
      // 密钥偶尔会被官方换掉，一周后强制重抓一次
      if (Date.now() - Number(saved.at || 0) > 7 * 24 * 3600 * 1000) return null;
      return saved;
    } catch {
      return null;
    }
  }

  const saved = loadSaved();
  const state = {
    token: '',
    device: (saved && saved.device) || '',
    protocol: saved ? { interfaceKey: saved.interfaceKey, paramKey: saved.paramKey, paramIv: saved.paramIv } : null,
    protocolAt: saved ? Number(saved.at) : 0,
    base: (saved && saved.base) || '',
  };

  function saveState() {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({
        ...state.protocol,
        device: state.device,
        base: state.base,
        at: state.protocolAt,
      }));
    } catch {
      /* 落盘失败不影响请求 */
    }
  }

  let refreshing = null;

  /** 抓一次官网脚本把新密钥捞回来；失败保持原值，绝不把能用的密钥冲掉 */
  function refreshProtocol() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const front = config.front;
        const page = await request(`${front}/`, { headers: { Referer: `${front}/` }, timeout: 8000, maxBytes: 1 << 20 });
        const html = page.text();
        const entryRef = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1])[0];
        if (!entryRef) throw new Error('未找到前端脚本');
        const script = (await request(new URL(entryRef, `${front}/`).toString(), { headers: { Referer: `${front}/` }, timeout: 10000, maxBytes: 4 << 20 })).text();
        const pick = (name) => {
          const match = new RegExp(`["']${name}["']\\s*[:,]\\s*["']([^"'\\\\\\r\\n]+)["']`).exec(script);
          return match ? match[1] : '';
        };
        const found = { interfaceKey: pick('interfaceKey'), paramKey: pick('parameterKey'), paramIv: pick('parameterIv') };
        if (!found.interfaceKey || found.paramKey.length !== 16 || found.paramIv.length !== 16) throw new Error('协议解析失败');
        state.protocol = found;
        state.protocolAt = Date.now();
        saveState();
      } catch {
        if (!state.protocol) {
          state.protocol = FALLBACK;
          state.protocolAt = Date.now();
        }
      } finally {
        refreshing = null;
      }
      return state.protocol;
    })();
    return refreshing;
  }

  async function protocol(force) {
    // 有的源把密钥写死在客户端里，没有可抓的官网脚本
    if (config.fixedProtocol) return config.fixedProtocol;
    if (force) {
      state.protocol = null;
      state.protocolAt = 0;
      return refreshProtocol();
    }
    if (state.protocol && Date.now() - state.protocolAt < 24 * 3600 * 1000) return state.protocol;
    if (state.protocol) {
      refreshProtocol();
      return state.protocol;
    }
    state.protocol = FALLBACK;
    state.protocolAt = Date.now();
    refreshProtocol();
    return state.protocol;
  }

  function uaHeader() {
    return config.userAgent(state.device || '00000000000000000000000000000');
  }

  /** 各源对 Origin / Referer 的要求不一样：有的必须带，有的带了反而被拦 */
  function apiHeaders() {
    const headers = {
      Accept: 'application/json',
      temp: 'test',
      'X-User-Agent': uaHeader(),
      'User-Agent': config.ua || 'Mozilla/5.0',
    };
    if (config.front) {
      headers.Origin = config.front;
      headers.Referer = `${config.front}/`;
    }
    return { ...headers, ...(config.headers || {}) };
  }

  function bases() {
    const list = config.bases.slice();
    if (state.base) {
      const index = list.indexOf(state.base);
      if (index > 0) list.splice(index, 1);
      if (index !== 0) list.unshift(state.base);
    }
    return list;
  }

  async function login(force) {
    if (state.token && !force) return state.token;
    if (!state.device) {
      state.device = config.newDevice();
      saveState();
    }
    const keys = force ? await protocol(true) : await protocol();
    const device = state.device;
    let lastError = null;
    for (const base of bases()) {
      try {
        const res = await request(`${base}/api/app/mine/login/h5`, {
          method: 'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: encryptParam({ devID: device, sysType: 'ios', isAppStore: false }, Buffer.from(keys.paramKey), Buffer.from(keys.paramIv)) }),
          timeout: 8000,
        });
        const envelope = JSON.parse(res.text());
        let data = envelope.data;
        if (typeof data === 'string') data = JSON.parse(decryptResponse(data, Buffer.from(keys.interfaceKey)).toString('utf8'));
        const token = data && (data.token || data.accessToken);
        if (!token) throw new Error(`${label}访客登录失败`);
        state.token = String(token);
        state.base = base;
        saveState();
        return state.token;
      } catch (error) {
        lastError = error;
      }
    }
    // 内置那份密钥可能真被官方换了：重抓一次脚本再来
    if (!force) return login(true);
    throw lastError || new Error(`${label}访客登录失败`);
  }

  /** 统一请求：参数加密进 data，响应按需解密，多域名轮换 */
  async function api(apiPath, params, retried = false) {
    const keys = await protocol();
    const token = await login();
    let lastError = null;
    for (const base of bases()) {
      try {
        let url = `${base}${apiPath}`;
        const headers = { ...apiHeaders(), Authorization: token };
        if (params) url += `${url.includes('?') ? '&' : '?'}data=${encodeURIComponent(encryptParam(params, Buffer.from(keys.paramKey), Buffer.from(keys.paramIv)))}`;

        const res = await request(url, { headers, timeout: 15000, maxBytes: 8 << 20 });
        let envelope;
        try {
          envelope = JSON.parse(res.text());
        } catch {
          throw new Error(`${label}返回 ${res.status}`);
        }
        const code = String(envelope.code === undefined || envelope.code === null ? '' : envelope.code).replace(/"/g, '');
        if (code && code !== '200' && code !== '0' && code !== 'null') {
          // 5005/5009：访客 token 过期，重登一次
          if ((code === '5005' || code === '5009') && !retried) {
            state.token = '';
            return api(apiPath, params, true);
          }
          throw new Error(`${label}：${String(envelope.msg || code).slice(0, 100)}`);
        }
        let data = envelope.data;
        if (typeof data === 'string' && envelope.hash) {
          try {
            data = JSON.parse(decryptResponse(data, Buffer.from(keys.interfaceKey)).toString('utf8'));
          } catch {
            if (!retried) {
              state.token = '';
              state.protocol = null;
              return api(apiPath, params, true);
            }
            throw new Error(`${label}响应解密失败`);
          }
        }
        if (data === null || data === undefined) throw new Error(`${label}没有返回数据`);
        if (state.base !== base) {
          state.base = base;
          saveState();
        }
        return data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`${label}请求失败`);
  }

  /**
   * 播放地址：{base}/api/app/vid/h5/m3u8/{路径}?token=… [&c=CDN]
   * 有的源的 Referer 是接口 host 自己，有的是前端站，所以一起返回。
   */
  async function playUrl(videoUrl) {
    const token = await login();
    const base = state.base || config.bases[0];
    const query = new URLSearchParams({ token });
    if (config.cdn) query.set('c', config.cdn);
    return {
      url: `${base}/api/app/vid/h5/m3u8/${encodeURIComponent(videoUrl)}?${query.toString()}`,
      referer: config.playReferer ? config.playReferer(base) : `${config.front}/`,
    };
  }

  return {
    api,
    login,
    protocol,
    playUrl,
    bases,
    uaHeader,
    state,
    label,
    front: config.front,
  };
}

module.exports = { createLegacyClient, FALLBACK, encryptParam, decryptResponse };
