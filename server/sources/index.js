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

const { request, cached, issueToken, readToken, rewritePlaylist, baseUrlOf } = require('./util');
const { assertPublicUrl } = require('../ssrf-guard');

const providers = [
  require('./huangju'),
  require('./yeguo'),
  require('./jinguoduanju'),
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

  let upstream;
  try {
    upstream = await request(target.toString(), { headers, timeout: 25000, maxBytes: MEDIA_MAX });
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
        upstream = await request(target.toString(), { headers, timeout: 25000, maxBytes: MEDIA_MAX });
      }
    }
  } catch (error) {
    return res.status(502).json({ error: '上游连接失败：' + (error.message || '') });
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
      });
    }
    const body = rewritePlaylist(text, target.toString(), (absolute) =>
      `${baseUrlOf(req)}/api/sources/stream?t=${key}&u=${encodeURIComponent(absolute)}`
    );
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(Buffer.from(body, 'utf8'));
  }

  res.setHeader('Content-Type', mediaType(target.pathname, type));
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
   * 某一集的播放信息：source 换成后端 media 令牌地址，播放器直接播。
   * 令牌绑当前账号，10 分钟过期。
   */
  app.get('/api/sources/:source/episode', auth, async (req, res) => {
    if (!needUser(req, res)) return;
    const provider = providerOf(req, res);
    if (!provider) return;
    const id = String(req.query.id || '');
    const number = Math.max(1, Number(req.query.episode) || 1);
    try {
      const info = await provider.episode(id, number);
      const token = issueToken(req.user.id, {
        url: info.url,
        referer: info.referer,
        cookie: info.cookie,
        userAgent: info.userAgent,
        source: provider.id,
        // 供 provider.refresh 重新签发（野果的播放地址只有十几秒有效）
        id,
        episode: number,
      });
      res.json({
        id,
        episode: number,
        title: info.title || '',
        cover: info.cover || '',
        source: `${baseUrlOf(req)}/api/sources/stream?t=${token}`,
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
