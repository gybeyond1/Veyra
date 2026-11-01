'use strict';
/**
 * app-updater 单测：
 *   node test/app-update-test.js          只跑离线用例（默认）
 *   LIVE=1 node test/app-update-test.js   额外跑一次真实拉取（会下载两个 APK，约 21MB）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAppUpdater, compareVersion, fileName, parseAtom } = require('../app-updater');

let pass = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('ok   ' + label); }
  else { console.log('FAIL ' + label); process.exitCode = 1; }
}

/* ---------- 版本比较 ---------- */
ok(compareVersion('0.24.6', '0.24.5') === 1, '0.24.6 比 0.24.5 新');
ok(compareVersion('0.24.5', '0.24.5') === 0, '同版本相等');
ok(compareVersion('0.24.5', '0.25.0') === -1, '0.24.5 比 0.25.0 旧');
ok(compareVersion('0.9.0', '0.10.0') === -1, '0.9.0 比 0.10.0 旧（不按字符串比）');

/* ---------- 附件命名 ---------- */
ok(fileName('mobile', '0.24.6') === 'Veyra-0.24.6.apk', '手机包名');
ok(fileName('tv', '0.24.6') === 'Veyra-TV-0.24.6.apk', '电视包名');

/* ---------- atom 解析 ---------- */
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>v0.24.6</title>
    <link rel="alternate" href="https://github.com/gybeyond1/Veyra/releases/tag/v0.24.6"/>
    <content type="html">&lt;p&gt;修复下载速度&lt;/p&gt;&lt;ul&gt;&lt;li&gt;后端缓存&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
  <entry><title>v0.24.5</title></entry>
</feed>`;
const parsed = parseAtom(ATOM);
ok(parsed && parsed.version === '0.24.6', 'atom 取到最新版本');
ok(parsed && /修复下载速度/.test(parsed.notes) && /后端缓存/.test(parsed.notes), 'atom 里的更新说明转成纯文本');
ok(!/<p>/.test(parsed.notes), '说明里没有残留 HTML 标签');
ok(parseAtom('<feed><entry><title>nightly</title></entry></feed>') === null, '不是语义化版本就返回 null');

// GitHub 用 --generate-notes 生成的发布说明会列出几十条历史 commit，
// 整坨塞给客户端弹窗没法看 —— 只保留开头几行。
const LONG = '<?xml version="1.0"?><feed><entry><title>v0.24.6</title><content type="html">'
  + '&lt;p&gt;修复下载&lt;/p&gt;' + Array.from({ length: 40 }, (_, i) => `&lt;li&gt;feat: 第 ${i} 条历史提交，内容还挺长的&lt;/li&gt;`).join('')
  + '</content></entry></feed>';
const longNotes = parseAtom(LONG).notes;
ok(longNotes.split('\n').length <= 4, '发布说明最多 4 行（实际 ' + longNotes.split('\n').length + '）');
ok(longNotes.length <= 241, '发布说明不超过 240 字（实际 ' + longNotes.length + '）');
ok(/修复下载/.test(longNotes), '开头那句还在');

/* ---------- 手动投递的包也能识别 ---------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-upd-'));
const updater = createAppUpdater({ dataDir: dir, log: () => { } });
ok(updater.status('mobile', '0.24.5').status === 'none', '空目录返回 none');

fs.mkdirSync(path.join(dir, 'app-update', 'mobile'), { recursive: true });
fs.writeFileSync(path.join(dir, 'app-update', 'mobile', 'Veyra-0.24.7.apk'), Buffer.alloc(1024, 1));
const manual = updater.status('mobile', '0.24.5');
ok(manual.status === 'available' && manual.version === '0.24.7', '目录里手动丢的包能直接分发（' + manual.status + '）');
ok(manual.url === '/api/app-download/mobile/Veyra-0.24.7.apk', '下载地址指向后端（' + manual.url + '）');

/* ---------- 版本不比当前新就不推 ---------- */
ok(updater.status('mobile', '0.24.7').status === 'current', '同级版本不提示更新');
ok(updater.status('mobile', '0.24.8').status === 'current', '比服务器还新就不推（不降级）');

/* ---------- 下载路由的路径校验 ---------- */
ok(updater.fileOf('mobile', 'Veyra-0.24.7.apk') !== null, '登记过的文件可以下载');
ok(updater.fileOf('mobile', '../../etc/passwd') === null, '拒绝路径穿越');
ok(updater.fileOf('mobile', 'Veyra-0.9.9.apk') === null, '不存在的文件返回 null');
ok(updater.fileOf('nope', 'Veyra-0.24.7.apk') === null, '未知渠道返回 null');

/* ---------- 真实网络（可选） ---------- */
(async () => {
  if (process.env.LIVE === '1') {
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-live-'));
    const live = createAppUpdater({ dataDir: liveDir, log: (m) => console.log('     ' + m) });
    await live.poll();
    const m = live.manifest;
    ok(m && /^\d+\.\d+\.\d+$/.test(m.version), '真实拉取拿到版本号（' + (m && m.version) + '）');
    ok(m && m.channels.mobile && m.channels.mobile.size > 1000000, '手机包已落盘（' + (m && m.channels.mobile && Math.round(m.channels.mobile.size / 1048576)) + 'MB）');
    ok(m && m.channels.tv && m.channels.tv.size > 1000000, '电视包已落盘');
    ok(m && /^[0-9a-f]{64}$/.test(m.channels.mobile.sha256), '手机包 sha256 已计算');
    const status = live.status('mobile', '0.1.0');
    ok(status.status === 'available' && status.url.indexOf('/api/app-download/mobile/') === 0, '真实清单能产出下载地址');
  }
  console.log('\n' + pass + ' passed' + (process.exitCode ? ', FAILED' : ''));
})();
