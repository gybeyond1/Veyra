'use strict';
/**
 * GitHub Release Webhook 的纯逻辑部分（验签 + 该不该拉）。
 *
 * 单独拆出来是为了能脱离 express 单测：路由本身只管取 header、回状态码，
 * 判定规则全在这里。GitHub 用 HMAC-SHA256 对**原始字节**签名，
 * 所以调用方必须传收到的 raw body，不能传 JSON.stringify(req.body)。
 */
const crypto = require('crypto');

const TAG_RE = /^v\d+\.\d+\.\d+$/;

/** 按 GitHub 的规则算签名：sha256=<hex> */
function signatureOf(secret, raw) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(raw).digest('hex');
}

/** 定长比较，别让响应时间泄露「前缀对了几位」。 */
function verifySignature(secret, raw, header) {
  if (!secret || !header) return false;
  const given = String(header).trim();
  const expect = signatureOf(secret, raw);
  if (given.length !== expect.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expect)); }
  catch { return false; }
}

/**
 * 从 webhook payload 里挑出要拉的那一版。
 *
 * 只认 published / released：draft 阶段的资产用公开 URL 下不到（404），
 * 提前拉只会白白重试。tag 不合语义化版本的一律忽略。
 */
function releaseOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const action = String(payload.action || '');
  if (action !== 'published' && action !== 'released') return null;
  const release = payload.release;
  if (!release || typeof release !== 'object') return null;
  const tag = String(release.tag_name || '').trim();
  if (!TAG_RE.test(tag)) return null;
  return release;
}

/**
 * 把路由挂到 app 上。单独成函数是为了测试能挂在最小 express 上跑，
 * 不用把整个 index.js（还有下载器、设备中继、webui）都拉起来。
 *
 * 调用方必须保证 req.rawBody 存在：全局的 express.json 要带 verify 存原始字节。
 */
function mountReleaseHook(app, options) {
  const updater = options.updater;
  const log = options.log || (() => { });
  const secretOf = options.secretOf || (() => process.env.GITHUB_WEBHOOK_SECRET || '');

  app.post('/api/hook/release', (req, res) => {
    const secret = secretOf();
    if (!secret) return res.status(404).json({ error: 'not found' });

    const event = String(req.get('x-github-event') || '');
    if (event === 'ping') return res.json({ ok: true, pong: true });
    if (event !== 'release') return res.status(202).json({ ok: false, ignored: event });

    // 验签用的是 Node 收到的原始字节（express.verify 存下来的），不是 JSON.stringify 的结果
    if (!verifySignature(secret, req.rawBody || Buffer.alloc(0), req.get('x-hub-signature-256'))) {
      log('[hook] release 签名不对，已拒绝 ' + (req.ip || ''));
      return res.status(401).json({ error: '签名不对' });
    }

    const release = releaseOf(req.body);
    if (!release) {
      const action = String((req.body && req.body.action) || '');
      return res.status(202).json({ ok: false, ignored: action || 'no release' });
    }

    const accepted = updater.wake(release);
    log('[hook] release ' + String(req.body.action) + ' ' + release.tag_name
      + (accepted ? ' 已排进下载队列' : ' tag 不认识，忽略'));
    // 立刻回 2xx：GitHub 只等 10 秒，下载要跑几十秒，不能把它拖在这儿
    return res.status(202).json({ ok: accepted });
  });
}

module.exports = { signatureOf, verifySignature, releaseOf, mountReleaseHook };
