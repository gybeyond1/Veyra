'use strict';
// 真实上游验证：WebUI 搜索是否与 APK 一样"全"
const { execFile } = require('child_process');
const { createHongguoContent } = require('../hongguo-content');

const fetchText = (url, timeoutMs) => new Promise((resolve, reject) => {
  execFile('curl', ['-s', '-L', '-m', String(timeoutMs || 10), '-A', 'Mozilla/5.0', url],
    { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout || ''));
});

(async () => {
  const api = createHongguoContent(fetchText);
  for (const q of process.argv.slice(2)) {
    const start = Date.now();
    const result = await api.search(q);
    console.log(`\n=== ${q} → ${result.items.length} 部 (${Date.now() - start}ms) base=${result.base}`);
    for (const item of result.items) {
      console.log(` ${item.id} [${item.type || '-'}] ${item.title} ${item.episodeCount ? item.episodeCount + '集' : ''}`);
    }
  }
})();
