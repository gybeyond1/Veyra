'use strict';
/**
 * 私密模式多源网关。
 *
 * 一份解析代码跑在服务器，手机 / 平板 / 电视 / 电脑 / WebUI 共用，
 * 客户端只传"哪个源、哪一页"，不再每端各写一套抓取逻辑。
 *
 * 为什么新源一律走后端：
 *   剧果的播放要 CloudFront 签名 cookie、野果的接口要 AES 加签、
 *   黄果旧版要派生密钥双向加解密、黄果 AI 得靠镜像探活 ——
 *   每端复刻一遍既写不完也修不动。黄果保持原样（直连/代理/后端三通道不变）。
 *
 * 输出结构沿用客户端已有的字段（featured / items / homepageRecommend / homepageNewest /
 * recommend / newest / episodes[].number|url），所以前端数据层不用改，只加"切源"。
 */

const { request, requestVia, cached, issueToken, readToken, rewritePlaylist, baseUrlOf } = require('./util');
const { assertPublicUrl } = require('../ssrf-guard');

const providers = [
  require('./huangju'),
  require('./yeguo'),
  require('./jinguoduanju'),
  require('./jinguo'),
  require('./cloudfront'),
  require('./huangguoai'),
];
const byId = new Map(providers.map((item) => [item.id, item]));

const CACHE_TTL = { home: 5 * 60 * 1000, list: 3 * 60 * 1000, detail: 10 * 60 * 1000 };
const MEDIA_MAX = 64 * 1024 * 1024;

function list() {
  return providers.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description || '',
    content: item.content || '',
  }));
}

/** 详情里的 _episodes 只在服务端用，绝不能回给客户端 */
function publicDetail(info) {
  const { _episodes, ...rest } = info;
  return rest;
}

/* ---------------- 网络模式 ----------------
 * 私密模式的全局设置：1 仅直连 / 2 仅代理 / 3 走后端转发（默认）。
 * 黄果在客户端有自己的一套通道实现；接口型源的解析只能跑在服务端，
 * 所以这三档落在「取流」这一段上，语义保持一致：
 *   1 仅直连   → 只发源站真实地址，播放器自己连，后端不代取一个字节（源站拦 Referer 就按失败报错）
 *   2 仅代理   → 后端经代理取流：优先用客户端传上来的代理地址，没传就用管理台配置的后端代理
 *   3 走后端转发 → 后端直连取流（默认，最稳，含签名续期）
 */
const NET_DIRECT = 1;
const NET_PROXY = 2;
const NET_BACKEND = 3;

/** 代理地址只接受代理协议，避免这个参数变成任意跳板 */
function safeProxy(raw) {
  const value = String(raw || '').trim().slice(0, 200);
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return /^(http|https|socks5):$/.test(parsed.protocol) ? value : '';
  } catch {
    return '';
  }
}

function netOf(req, deps) {
  const mode = Number(req.query.net) || NET_BACKEND;
  if (mode === NET_DIRECT) return { mode, proxy: '' };
  if (mode !== NET_PROXY) return { mode: NET_BACKEND, proxy: '' };
  const raw = String(req.query.proxy || '').trim();
  const own = safeProxy(raw);
  if (own) return { mode, proxy: own };
  // 客户端没填或填坏时退回管理台配的后端代理
  const fallback = deps && deps.getProxy ? safeProxy(deps.getProxy()) : '';
  return { mode, proxy: fallback, badProxy: Boolean(raw) && !own };
}

/**
 * 分片的 Content-Type 不可信：这几个源的 CDN 会随手回一个
 * text/vnd.trolltech.linguist 之类的类型，播放器据此判断容器会直接报错。
 * 按扩展名兜底，认不出来才用上游的。
 */
const MEDIA_TYPES = {
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  vtt: 'text/vtt',
  key: 'application/octet-stream',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function mediaType(pathname, upstreamType) {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(pathname) || [])[1];
  const known = ext && MEDIA_TYPES[String(ext).toLowerCase()];
  if (known) return known;
  if (/^(video|audio|image)\//i.test(upstreamType)) return upstreamType;
  return 'application/octet-stream';
}

/** 播放列表里所有引用到的地址（普通 URI 行 + URI="..." 属性） */
function playlistUris(text) {
  const out = [];
  for (const match of text.matchAll(/URI="([^"]+)"/g)) out.push(match[1]);
  for (const line of text.split('\n')) {
    const uri = line.trim();
    if (uri && !uri.startsWith('#')) out.push(uri);
  }
  return out;
}

/**
 * 媒体代理：令牌里带着源地址、Referer、Cookie，客户端只认令牌。
 * 分片地址同样走这里，所以 m3u8 重写时把令牌原样带上。
 */
async function stream(req, res) {
  const token = readToken(String(req.query.t || ''));
  if (!token) return res.status(404).json({ error: '播放地址已过期，请重新点开这一集' });

  const origin = new URL(token.url).origin;
  let target;
  try {
    target = req.query.u ? new URL(String(req.query.u)) : new URL(token.url);
  } catch {
    return res.status(400).json({ error: '无效地址' });
  }
  /*
   * 只允许令牌自带的主机集合，防止拿令牌当跳板。
   * 野果这类源的播放列表和分片分属不同 CDN（op.* / as.*），
   * 所以重写播放列表时会把新出现的主机并入令牌，逐层继承。
   */
  const allowed = Array.isArray(token.hosts) && token.hosts.length ? token.hosts : [origin];
  if (!allowed.includes(target.origin)) return res.status(403).json({ error: '地址不在允许范围内' });

  const headers = {
    Referer: token.referer || `${origin}/`,
    Accept: '*/*',
    ...(token.cookie ? { Cookie: token.cookie } : {}),
  };
  if (token.userAgent) headers['User-Agent'] = token.userAgent;

  /*
   * Range 必须一路透到源站。播放器取分片、seek、以及 iOS 原生 HLS 都会先发
   * Range: bytes=0-1 探能力；后端若吞掉它回 200 全量，播放器会判定「服务端不支持
   * 断点」，seek 失效、大分片整段重下，弱网下直接卡死。
   */
  const rangeHeader = String(req.headers.range || '').trim();
  if (rangeHeader) {
    headers.Range = rangeHeader;
    headers['Accept-Encoding'] = 'identity'; // 压缩字节与 Range 互斥
  }

  // 「仅代理」的令牌带着代理地址，播放列表 / 密钥 / 分片全部经它出去
  const proxy = token.proxy || '';

  let upstream;
  try {
    upstream = await requestVia(target.toString(), { headers, timeout: 25000, maxBytes: MEDIA_MAX }, proxy);
    /*
     * 野果这类源的播放地址带十几秒有效的签名，用户点开暂停一会儿再播就会 403。
     * 根地址失效时让 provider 重新要一次，分片/子列表不重签（它们由播放列表实时下发）。
     */
    const provider = byId.get(String(token.source || ''));
    if (upstream.status >= 400 && target.toString() === token.url && provider && provider.refresh && token.id) {
      const fresh = await provider.refresh(token.id, Number(token.episode) || 1);
      if (fresh && fresh.url && fresh.url !== token.url) {
        token.url = fresh.url;
        headers.Referer = fresh.referer || headers.Referer;
        if (fresh.cookie) headers.Cookie = fresh.cookie;
        target = new URL(fresh.url);
        upstream = await requestVia(target.toString(), { headers, timeout: 25000, maxBytes: MEDIA_MAX }, proxy);
      }
    }
  } catch (error) {
    return res.status(502).json({ error: '上游连接失败：' + (error.message || '') });
  }
  if (upstream.status === 416 && rangeHeader) {
    res.status(416);
    if (upstream.headers['content-range']) res.setHeader('Content-Range', String(upstream.headers['content-range']));
    return res.end();
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    return res.status(502).json({ error: `上游返回 ${upstream.status}` });
  }

  const type = String(upstream.headers['content-type'] || '');
  const isPlaylist =
    /mpegurl/i.test(type) ||
    /\.m3u8?(\?|#|$)/i.test(target.pathname) ||
    upstream.text().slice(0, 16).includes('#EXTM3U');

  if (isPlaylist) {
    const text = upstream.text();
    /*
     * 播放列表里出现的新主机（分片 CDN、密钥服务器）并入令牌，下一层就放行；
     * 没有新主机时沿用原令牌，避免每个请求都签一次。
     */
    const hosts = new Set(allowed);
    for (const uri of playlistUris(text)) {
      try {
        hosts.add(new URL(uri, target).origin);
      } catch {
        /* 相对地址解析失败就当没有 */
      }
    }
    let key = String(req.query.t);
    if (hosts.size > allowed.length) {
      key = issueToken(token.userId, {
        url: target.toString(),
        referer: token.referer,
        cookie: token.cookie,
        userAgent: token.userAgent,
        source: token.source,
        id: token.id,
        episode: token.episode,
        hosts: [...hosts],
        // 「仅代理」的通道必须逐层继承，否则子列表一分片就退回直连
        proxy: token.proxy,
      });
    }
    const body = rewritePlaylist(text, target.toString(), (absolute) =>
      `${baseUrlOf(req)}/api/sources/stream?t=${key}&u=${encodeURIComponent(absolute)}`
    );
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(Buffer.from(body, 'utf8'));
  }

  res.status(upstream.status === 206 ? 206 : 200);
  const contentRange = upstream.headers['content-range'];
  if (contentRange) res.setHeader('Content-Range', String(contentRange));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mediaType(target.pathname, type));
  res.setHeader('Content-Length', String(upstream.body.length));
  res.setHeader('Cache-Control', 'no-store');
  res.end(upstream.body);
}

/**
 * 把路由挂到现有 express 上。
 * deps: { auth, needUser, requireUser }
 */
function mount(app, deps) {
  /* gate：普通账号 token 与 WebUI 管理员 token 都放行（WebUI 也要能浏览私密源） */
  const auth = deps.gate || deps.auth;
  const needUser = (req, res) => (req.user ? true : (res.status(401).json({ error: '请先登录' }), false));

  // 源清单：客户端据此渲染"切源"列表
  app.get('/api/sources', auth, (req, res) => {
    if (!needUser(req, res)) return;
    res.json({ sources: list() });
  });

  /*
   * 一键体检。用户报「这个源用不了」，先跑这个：首页 → 分类 → 详情 → 播放地址 →
   * 清单 → 子清单 → 密钥 → 分片，每步成败与耗时都留痕。断在哪一层一眼看得见，
   * 不用再靠「黑屏」「转圈」这类描述去猜，也省掉「是不是你没更新」的来回。
   */
  const DIAG_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

  async function diagnose(provider, budgetMs) {
    const deadline = Date.now() + budgetMs;
    const steps = [];
    const push = (name, ok, started, detail) => steps.push({ name, ok, ms: Date.now() - started, detail: String(detail || '') });
    const run = async (name, fn, required) => {
      if (Date.now() > deadline) throw Object.assign(new Error('体检总时长超限'), { steps });
      const started = Date.now();
      try {
        const result = await fn();
        push(name, true, started, result && result.detail);
        return result && result.value;
      } catch (error) {
        push(name, false, started, error.message || '失败');
        if (required) throw Object.assign(new Error(error.message || '失败'), { steps });
        return null;
      }
    };
    const firstUriOf = (text) => {
      for (const line of text.split('\n')) {
        const value = line.trim();
        if (value && !value.startsWith('#')) return value;
      }
      return '';
    };

    const home = await run('首页', async () => {
      const data = await provider.home();
      const items = data.homepageRecommend || data.items || data.featured || data.recommend || [];
      if (!items.length) throw new Error('没有条目');
      return { detail: `${items.length} 条，首条《${items[0].title}》`, value: items[0] };
    }, true);

    await run('分类', async () => {
      const items = provider.categories ? await provider.categories() : [];
      if (!items.length) throw new Error('分类为空');
      return { detail: `${items.length} 个：${items.slice(0, 4).map((item) => item.name).join('/')}` };
    }, false);

    await run('详情', async () => {
      const detail = await provider.detail(home.id);
      const episodes = (detail && detail.episodes) || [];
      if (!episodes.length) throw new Error('没有分集');
      return { detail: `${episodes.length} 集` };
    }, false);

    const info = await run('播放地址', async () => {
      const result = await provider.episode(home.id, 1);
      if (!result || !result.url) throw new Error('源站没给地址');
      return { detail: result.url.slice(0, 96), value: result };
    }, true);

    const headers = { 'User-Agent': info.userAgent || DIAG_UA, Accept: '*/*' };
    if (info.referer) headers.Referer = info.referer;
    if (info.cookie) headers.Cookie = info.cookie;

    const fetchText = async (url) => {
      const response = await request(url, { headers, maxBytes: MEDIA_MAX, timeout: 20000 });
      if (response.status !== 200) throw new Error(`源站返回 ${response.status}`);
      return response.text();
    };

    let baseUrl = info.url;
    let playlist = '';
    await run('清单', async () => {
      playlist = await fetchText(info.url);
      if (!playlist.startsWith('#EXTM3U')) throw new Error('不是 m3u8');
      return { detail: `${playlist.split('\n').length} 行` };
    }, true);

    // master → 变体清单，最多再下钻两层（剧果是三层结构）
    for (let round = 0; round < 2 && /#EXT-X-STREAM-INF/.test(playlist); round += 1) {
      const uri = firstUriOf(playlist);
      if (!uri) break;
      const next = new URL(uri, baseUrl).toString();
      const text = await run(round === 0 ? '子清单' : '子清单(2)', async () => {
        const body = await fetchText(next);
        if (!body.startsWith('#EXTM3U')) throw new Error('不是 m3u8');
        return { detail: `${body.split('\n').length} 行`, value: body };
      }, false);
      if (!text) break;
      baseUrl = next;
      playlist = text;
    }

    const keyLine = playlist.split('\n').find((line) => line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(line));
    const keyUri = keyLine && /URI="([^"]+)"/.exec(keyLine);
    if (keyUri) {
      await run('解密密钥', async () => {
        const response = await request(new URL(keyUri[1], baseUrl).toString(), { headers, maxBytes: 8192, timeout: 20000 });
        if (response.status !== 200) throw new Error(`源站返回 ${response.status}`);
        if (response.body.length !== 16) throw new Error(`返回 ${response.body.length} 字节，应为 16`);
        return { detail: '16 字节，AES-128 正常' };
      }, false);
    }

    const segment = firstUriOf(playlist);
    if (segment) {
      await run('分片', async () => {
        const response = await request(new URL(segment, baseUrl).toString(), { headers, maxBytes: MEDIA_MAX, timeout: 25000 });
        if (response.status !== 200) throw new Error(`源站返回 ${response.status}`);
        return { detail: `${(response.body.length / 1024).toFixed(0)}KB` };
      }, false);
    }
    return steps;
  }

  app.get('/api/sources/diag', auth, async (req, res) => {
    if (!needUser(req, res)) return;
    const site = String(req.query.site || '');
    const targets = site ? [byId.get(site)].filter(Boolean) : providers;
    if (!targets.length) return res.status(404).json({ error: '未知的源' });
    const results = [];
    for (const provider of targets) {
      const started = Date.now();
      let steps = [];
      try {
        steps = await diagnose(provider, site ? 60000 : 25000);
      } catch (error) {
        steps = error.steps || steps;
      }
      results.push({
        id: provider.id,
        name: provider.name,
        ms: Date.now() - started,
        ok: steps.length > 0 && steps.every((item) => item.ok),
        steps,
      });
    }
    res.json({ results });
  });

  const providerOf = (req, res) => {
    const provider = byId.get(String(req.params.source || ''));
    if (!provider) {
      res.status(404).json({ error: '未知的源' });
      return null;
    }
    return provider;
  };

  app.get('/api/sources/:source/categories', auth, async (req, res) => {
    if (!needUser(req, res)) return;
    const provider = providerOf(req, res);
    if (!provider) return;
    try {
      res.json({ items: provider.categories ? await provider.categories() : [] });
    } catch (error) {
      res.status(502).json({ error: error.message || '分类加载失败' });
    }
  });

  app.get('/api/sources/:source/home', auth, async (req, res) => {
    if (!needUser(req, res)) return;
    const provider = providerOf(req, res);
    if (!provider) return;
    try {
      res.json(await cached(`${provider.id}:home`, CACHE_TTL.home, () => provider.home()));
    } catch (error) {
      res.status(502).json({ error: error.message || '首页加载失败' });
    }
  });

  app.get('/api/sources/:source/category', auth, async (req, res) => {
    if (!needUser(req, res)) return;
    const provider = providerOf(req, res);
    if (!provider) return;
    const slug = String(req.query.slug || '');
    const page = Math.min(200, Math.max(1, Number(req.query.page) || 1));
    try {
      res.json(await cached(`${provider.id}:cat:${slug}:${page}`, CACHE_TTL.list, () => provider.category(slug, page)));
    } catch (error) {
      res.status(502).json({ error: error.message || '分类加载失败' });
    }
  });

  app.get('/api/sources/:source/search', auth, async (req, res) => {
    if (!needUser(req, res)) return;
    const provider = providerOf(req, res);
    if (!provider) return;
    const keyword = String(req.query.q || '').trim().slice(0, 80);
    const page = Math.min(50, Math.max(1, Number(req.query.page) || 1));
    if (!keyword) return res.json({ items: [], nextPage: null });
    try {
      res.json(await provider.search(keyword, page));
    } catch (error) {
      res.status(502).json({ error: error.message || '搜索失败' });
    }
  });

  app.get('/api/sources/:source/detail', auth, async (req, res) => {
    if (!needUser(req, res)) return;
    const provider = providerOf(req, res);
    if (!provider) return;
    try {
      res.json(publicDetail(await provider.detail(String(req.query.id || ''))));
    } catch (error) {
      res.status(502).json({ error: error.message || '详情加载失败' });
    }
  });

  /**
   * 某一集的播放信息。
   *   net=3（默认）→ source 换成后端 media 令牌地址，播放器直接播，令牌绑账号 10 分钟。
   *   net=1 仅直连 → source 就是源站真实地址，一个字节都不经后端；headers 给能注入请求头的端用。
   *   net=2 仅代理 → 令牌里带代理，后端经代理取流。
   */
  app.get('/api/sources/:source/episode', auth, async (req, res) => {
    if (!needUser(req, res)) return;
    const provider = providerOf(req, res);
    if (!provider) return;
    const id = String(req.query.id || '');
    const number = Math.max(1, Number(req.query.episode) || 1);
    const { mode: net, proxy, badProxy } = netOf(req, deps);
    if (net === NET_PROXY && !proxy) {
      return res.status(400).json({
        error: badProxy
          ? '代理地址格式不支持，只接受 http:// 或 socks5://'
          : '「仅代理」还没填代理地址：设置里填，或让管理员在管理台配好',
      });
    }
    try {
      const info = await provider.episode(id, number);
      const headers = {};
      if (info.referer) headers.Referer = info.referer;
      if (info.cookie) headers.Cookie = info.cookie;
      if (info.userAgent) headers['User-Agent'] = info.userAgent;

      // 客户端带 carry=1 表示它会把这几个头原样贴到播放请求上（手机 / 电视 / 电脑
      // 的原生播放器都能做到）。浏览器做不到 —— 它改不了 Referer，也拿不到源站 Cookie，
      // 所以 WebUI 不传这个参数，仍按 provider.noDirect 自动降级。
      const carry = req.query.carry === '1';

      if (net === NET_DIRECT && provider.noDirect && !carry) {
        // 这个源只能后端代取（比如剧果的 CloudFront 签名 Cookie 浏览器带不上），
        // 与其让用户看到莫名 403，不如自动降级并说明原因
        const notice = `${provider.name}的播放要签名 Cookie，当前环境带不上，已自动走后端转发`;
        const token = issueToken(req.user.id, {
          url: info.url,
          referer: info.referer,
          cookie: info.cookie,
          userAgent: info.userAgent,
          source: provider.id,
          id,
          episode: number,
        });
        return res.json({
          id,
          episode: number,
          title: info.title || '',
          cover: info.cover || '',
          source: `${baseUrlOf(req)}/api/sources/stream?t=${token}`,
          net: NET_BACKEND,
          fallback: true,
          notice,
          nextUrl: '',
        });
      }

      if (net === NET_DIRECT) {
        return res.json({
          id,
          episode: number,
          title: info.title || '',
          cover: info.cover || '',
          source: info.url,
          direct: true,
          net,
          // 源站只认这套头：Referer 决定防盗链，Cookie 是 CloudFront 签名 / 登录态。
          // 客户端必须原样贴到清单、分片、密钥三条请求上，少一条就 403。
          headers,
          requiresCredentials: Boolean(info.cookie),
          mimeType: /\.mp4(\?|$)/i.test(info.url) ? 'video/mp4' : 'application/vnd.apple.mpegurl',
          nextUrl: '',
        });
      }

      const token = issueToken(req.user.id, {
        url: info.url,
        referer: info.referer,
        cookie: info.cookie,
        userAgent: info.userAgent,
        source: provider.id,
        // 供 provider.refresh 重新签发（野果的播放地址只有十几秒有效）
        id,
        episode: number,
        proxy,
      });
      res.json({
        id,
        episode: number,
        title: info.title || '',
        cover: info.cover || '',
        source: `${baseUrlOf(req)}/api/sources/stream?t=${token}`,
        net,
        nextUrl: '',
      });
    } catch (error) {
      res.status(502).json({ error: error.message || '播放地址解析失败' });
    }
  });

  /**
   * 封面：接口型源的封面是普通图片，客户端按 data URI 渲染，统一从后端取。
   * 只放行公网 http/https，避免被当成内网探测跳板。
   */
  app.get('/api/sources/:source/cover', auth, async (req, res) => {
    if (!needUser(req, res)) return;
    let target;
    try {
      target = new URL(String(req.query.url || ''));
    } catch {
      return res.status(400).json({ error: '无效封面地址' });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return res.status(400).json({ error: '仅支持 http/https' });
    try {
      await assertPublicUrl(target.toString());
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    try {
      const upstream = await request(target.toString(), {
        headers: { Referer: `${target.origin}/`, Accept: 'image/*,*/*' },
        timeout: 15000,
        maxBytes: 8 << 20,
      });
      if (upstream.status < 200 || upstream.status >= 300) return res.status(502).json({ error: `封面返回 ${upstream.status}` });
      const type = String(upstream.headers['content-type'] || '');
      res.setHeader('Content-Type', /^image\//.test(type) ? type : 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.end(upstream.body);
    } catch (error) {
      res.status(502).json({ error: error.message || '封面下载失败' });
    }
  });

  // 媒体（m3u8 + 分片）：不需要 auth，靠令牌本身鉴权（播放器不会带 Bearer）
  app.get('/api/sources/stream', (req, res) => stream(req, res).catch(() => res.status(500).end()));
}

module.exports = { mount, list };
