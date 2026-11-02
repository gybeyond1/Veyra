'use strict';
/**
 * Release Webhook 测试（纯离线，不碰网络）：
 *   node test/app-update-webhook-test.js
 *
 * 覆盖：HMAC 验签、payload 筛选（draft/非法 tag 不拉）、wake 的快车道、
 *       以及 webhook 触发的 poll 收尾时不会傻等 10 分钟。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAppUpdater, hasApks } = require('../app-updater');
const { signatureOf, verifySignature, releaseOf } = require('../release-hook');

let pass = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('ok   ' + label); }
  else { console.log('FAIL ' + label); process.exitCode = 1; }
}

/* ---------- 附件齐全判定 ---------- */
const both = [{ name: 'Veyra-0.24.8.apk' }, { name: 'Veyra-TV-0.24.8.apk' }];
const phoneOnly = [{ name: 'Veyra-0.24.8.apk' }];
ok(hasApks(both, '0.24.8') === true, '两个包都在 → 齐全');
ok(hasApks(phoneOnly, '0.24.8') === false, '只有手机包 → 不齐');
ok(hasApks([], '0.24.8') === false, '空资产 → 不齐');
ok(hasApks(both, '0.24.7') === false, '版本对不上 → 不齐');

/* ---------- 验签 ---------- */
const SECRET = 's3cret';
const BODY = Buffer.from(JSON.stringify({ action: 'published', release: { tag_name: 'v0.24.8' } }));
const GOOD = signatureOf(SECRET, BODY);
ok(GOOD.indexOf('sha256=') === 0 && GOOD.length === 71, '签名格式 sha256=<64 hex>');
ok(verifySignature(SECRET, BODY, GOOD) === true, '正确签名通过');
ok(verifySignature(SECRET, BODY, GOOD.slice(0, -1) + '0') === false, '改一位就拒');
ok(verifySignature('other', BODY, GOOD) === false, '换个 secret 就拒');
ok(verifySignature(SECRET, Buffer.from(BODY.toString() + ' '), GOOD) === false, 'body 多一个字节就拒');
ok(verifySignature(SECRET, BODY, '') === false, '没有签名头就拒');
ok(verifySignature(SECRET, BODY, 'sha1=abc') === false, '算法不对就拒');
ok(verifySignature('', BODY, GOOD) === false, '没配 secret 一律拒（端点同时会 404）');
// 关键：必须按原始字节算。解析再序列化会因空格/键序变化而验不过 —— 这正是要留 rawBody 的原因
ok(verifySignature(SECRET, Buffer.from(JSON.stringify(JSON.parse(BODY), null, 2)), GOOD) === false,
  '重新格式化过的 body 验不过（证明必须用 raw body）');

/* ---------- payload 筛选 ---------- */
const rel = (tag) => ({ tag_name: tag, body: 'x', assets: both });
ok(releaseOf({ action: 'published', release: rel('v0.24.8') }) !== null, 'published 通过');
ok(releaseOf({ action: 'released', release: rel('v0.24.8') }) !== null, 'released 也通过（老事件名）');
ok(releaseOf({ action: 'created', release: rel('v0.24.8') }) === null, 'created 不拉（资产还没传）');
ok(releaseOf({ action: 'edited', release: rel('v0.24.8') }) === null, 'edited 不拉');
ok(releaseOf({ action: 'published', release: rel('nightly') }) === null, '非语义化 tag 不拉');
ok(releaseOf({ action: 'published', release: rel('0.24.8') }) === null, '不带 v 的 tag 不拉');
ok(releaseOf({ action: 'published' }) === null, '缺 release 字段不拉');
ok(releaseOf(null) === null, 'null payload 不拉');

/* ---------- wake：快车道状态 ---------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-hook-'));
const lines = [];
// autoPoll: false —— 只验证排队逻辑，不联网（单测里不该真去打 GitHub）
const updater = createAppUpdater({ dataDir: dir, log: (m) => lines.push(m), autoPoll: false });

ok(updater.wakeState === null, '初始没有快车道');
ok(updater.wake({ tag_name: 'nightly' }) === false, 'wake 拒绝非语义化 tag');
ok(updater.wake(null) === false, 'wake 拒绝空 payload');
ok(updater.wakeState === null, '被拒的 wake 不留状态');

const both999 = [{ name: 'Veyra-9.9.9.apk' }, { name: 'Veyra-TV-9.9.9.apk' }];
const accepted = updater.wake({ tag_name: 'v9.9.9', body: '测试', assets: both999 });
ok(accepted === true, 'wake 接受合法 tag');
const state = updater.wakeState;
ok(state && state.tag === 'v9.9.9', '快车道记住了 tag ' + (state && state.tag));
ok(state && state.version === '9.9.9', '版本号去掉了 v');
ok(state && state.round === 0, '刚唤醒时重试轮次为 0');
ok(lines.some(l => /webhook 触发/.test(l)), '日志里能看到 webhook 触发');
ok(lines.some(l => /两个包都在/.test(l)), '资产齐全时日志明确说不用等');

// 只有手机包时应该走「缺包 → 秒级重试」分支
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-hook2-'));
const lines2 = [];
const partial = createAppUpdater({ dataDir: dir2, log: (m) => lines2.push(m), autoPoll: false });
partial.wake({ tag_name: 'v9.9.8', assets: [{ name: 'Veyra-9.9.8.apk' }] });
ok(lines2.some(l => /还缺包/.test(l)), '只有手机包时明确走重试分支');

// 重复投递同一个 tag（GitHub 会重试失败的投递）不应该出问题
ok(updater.wake({ tag_name: 'v9.9.9', assets: both999 }) === true, '重复投递同一 tag 仍返回 true');

/* ---------- 旧版本重复投递：不能倒回清单、不能白下旧包 ---------- */
// 关键：wake 的 assets 齐全时 discover 会直接返回，所以这一轮 poll 完全不走网络
(async () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-hook3-'));
  for (const c of ['mobile', 'tv']) fs.mkdirSync(path.join(dir3, 'app-update', c), { recursive: true });
  fs.writeFileSync(path.join(dir3, 'app-update', 'latest.json'), JSON.stringify({
    version: '9.9.9', tag: 'v9.9.9', notes: '', fetchedAt: Date.now(), channels: {},
  }));
  const lines3 = [];
  const older = createAppUpdater({ dataDir: dir3, log: (m) => lines3.push(m), autoPoll: false });
  older.wake({ tag_name: 'v8.8.8', assets: [{ name: 'Veyra-8.8.8.apk' }, { name: 'Veyra-TV-8.8.8.apk' }] });
  await older.poll();
  ok(older.manifest && older.manifest.version === '9.9.9', '旧 tag 不会把清单倒回去');
  ok(older.wakeState === null, '旧 tag 直接退出快车道，不消耗重试');
  ok(lines3.some(l => /忽略旧版本 8\.8\.8/.test(l)), '日志明确说忽略了旧版本');
  older.stop();

  updater.stop();
  partial.stop();
  console.log('\n' + pass + ' passed' + (process.exitCode ? ', FAILED' : ''));
  process.exit(process.exitCode || 0);
})();
