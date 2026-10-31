'use strict';
// 后端联调：搜索合并 + 设备中继（注册/轮询/投递/回执）+ 下载目标校验
const BASE = process.env.BASE || 'http://127.0.0.1:18080';
const ADMIN = 'test-admin-pass';
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 200) }; } };
const post = (path, body, token) => fetch(BASE + path, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body || {}),
}).then(async r => ({ status: r.status, body: await json(r) }));
const get = (path, token) => fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
  .then(async r => ({ status: r.status, body: await json(r) }));

(async () => {
  const health = await get('/api/health');
  if (health.body.status !== 'ok') throw new Error('health failed ' + JSON.stringify(health));

  const admin = await post('/api/admin/login', { password: ADMIN });
  if (!admin.body.token) throw new Error('admin login failed ' + JSON.stringify(admin));
  const adminToken = admin.body.token;

  const otp = (await get('/api/otp', adminToken)).body;
  const username = 'dev' + String(Date.now()).slice(-6);
  const reg = await post('/api/register', { username, password: 'pw', code: otp.code, device: 'test' });
  if (!reg.body.token) throw new Error('register failed ' + JSON.stringify(reg));
  const userToken = reg.body.token;
  const userId = reg.body.user.id;

  // 设备上报
  const deviceId = 'dev-' + Math.random().toString(36).slice(2, 10);
  const regDevice = await post('/api/devices/register', {
    id: deviceId, name: 'Moto M332BF', model: 'moto m332bf', brand: 'motorola',
    platform: 'android', appVersion: '0.23.20',
  }, userToken);
  if (!regDevice.body.device || regDevice.body.device.userId !== userId) throw new Error('device register failed ' + JSON.stringify(regDevice));

  // 管理台能看到该账号的设备
  const list = await get('/api/admin/devices?userId=' + encodeURIComponent(userId), adminToken);
  if (!list.body.devices || !list.body.devices.length) throw new Error('admin device list empty ' + JSON.stringify(list));
  if (!list.body.devices[0].online) throw new Error('device should be online');

  // 投递下载指令
  const task = await post('/api/admin/device-tasks', {
    deviceId, source: 'hongguo', title: '测试短剧', seriesId: '7671966197985856536',
    episodes: [3, 1, 2, 2], cover: 'https://example.com/a.jpg',
  }, adminToken);
  if (!task.body.ok) throw new Error('create task failed ' + JSON.stringify(task));
  const commandId = task.body.id;

  // 设备轮询拿到指令（集数已排序去重）
  const poll = await post('/api/devices/poll', { id: deviceId }, userToken);
  const got = (poll.body.commands || [])[0];
  if (!got || got.id !== commandId) throw new Error('poll did not return command ' + JSON.stringify(poll));
  if (JSON.stringify(got.payload.episodes) !== '[1,2,3]') throw new Error('episodes not normalized ' + JSON.stringify(got.payload));

  // 再轮询不应重复下发
  const poll2 = await post('/api/devices/poll', { id: deviceId }, userToken);
  if ((poll2.body.commands || []).length) throw new Error('command delivered twice');

  // 回执
  const ack = await post('/api/devices/ack', { deviceId, id: commandId, ok: true }, userToken);
  if (ack.body.status !== 'done') throw new Error('ack failed ' + JSON.stringify(ack));

  const tasks = await get('/api/admin/device-tasks?deviceId=' + encodeURIComponent(deviceId), adminToken);
  if (!tasks.body.tasks.length || tasks.body.tasks[0].status !== 'done') throw new Error('task list wrong ' + JSON.stringify(tasks));

  // 未授权/异常入参
  const bad = await post('/api/admin/device-tasks', { deviceId, title: 'x', seriesId: '1', episodes: [] }, adminToken);
  if (bad.status !== 400) throw new Error('empty episodes should be 400');
  const noAuth = await post('/api/devices/poll', { id: deviceId }, 'x'.repeat(64));
  if (noAuth.status !== 401) throw new Error('device poll without token should be 401');

  // 搜索：与 APK 同策略（含按季穷举）
  const search = await get('/api/web/hongguo/search?q=' + encodeURIComponent('持械入宋'));
  const ids = (search.body.items || []).map(i => i.id);
  const has341 = (search.body.items || []).some(i => i.episodeCount === 341);
  if (ids.length < 12) throw new Error('search too few: ' + ids.length);
  if (!has341) throw new Error('search missing 341-episode release: ' + JSON.stringify((search.body.items || []).map(i => i.title + '/' + i.episodeCount)));

  console.log(JSON.stringify({
    ok: true, userId, deviceId,
    search: { count: ids.length, with341: (search.body.items || []).some(i => i.episodeCount === 341) },
    command: task.body.id,
  }, null, 2));
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
