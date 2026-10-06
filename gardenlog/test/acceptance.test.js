import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { startServer, jpegWithExif } from './helpers.js';

let h;
test.before(async () => { h = await startServer(); });
const req = (m, p, b, o) => h.req(m, p, b, o);

test('1. 移到新环境后旧记录补传：旧观察快照保留旧盆/旧环境/旧条件，新观察跟随新环境', async () => {
  // 环境：南阳台(全日照)、北阳台(散射光)
  const l1 = (await req('POST', '/admin/locations', { name: '南阳台', kind: 'balcony', condition: '全日照', valid_from: '2024-01-01' })).data.id;
  const l2 = (await req('POST', '/admin/locations', { name: '北阳台', kind: 'balcony', condition: '散射光', valid_from: '2024-01-01' })).data.id;
  // 同品种两盆，分别建档（不允许混成一株）
  const pA = (await req('POST', '/admin/plants', { code: 'PL-A', display_name: '玉露 A', cultivar: 'Haworthia cooperi', location_id: l1, started_on: '2024-01-10' })).data.id;
  const pB = (await req('POST', '/admin/plants', { code: 'PL-B', display_name: '玉露 B', cultivar: 'Haworthia cooperi', location_id: l2, started_on: '2024-01-10' })).data.id;
  assert.notEqual(pA, pB, '同品种多盆是两个个体');
  const pot1 = (await req('POST', '/admin/pots', { code: 'P-01' })).data.id;
  const pot2 = (await req('POST', '/admin/pots', { code: 'P-02' })).data.id;
  // A 先在 P-01；2024-06-01 移盆到 P-02 并换到北阳台
  await req('POST', `/admin/plants/${pA}/repot`, { pot_id: pot1, location_id: l1, event_date: '2024-01-10' });
  await req('POST', `/admin/plants/${pA}/repot`, { pot_id: pot2, location_id: l2, event_date: '2024-06-01', note: '南阳台太晒，移到北侧' });

  // 换机/新环境：把设备2上离线写的旧观察补传（obs_date=2024-03-01，早于移盆）
  const ops = [
    { client_op_id: 'dev2-old-1', type: 'obs.create', payload: { plant_id: pA, obs_date: '2024-03-01', body: '三月：南阳台全日照下窗旁状态', device_id: 'device-2' } },
    { client_op_id: 'dev2-old-2', type: 'obs.create', payload: { plant_id: pA, obs_date: '2024-07-01', body: '七月：已在北阳台散射光', device_id: 'device-2' } }
  ];
  const sync = (await req('POST', '/admin/sync', { device_id: 'device-2', ops })).data;
  assert.equal(sync.results.every((r) => r.ok), true);
  const [oldId, newId] = sync.results.map((r) => r.id);

  const oldObs = (await req('GET', `/observations/${oldId}`, null, { token: null })).data;
  const newObs = (await req('GET', `/observations/${newId}`, null, { token: null })).data;
  assert.equal(oldObs.pot_code_snapshot, 'P-01');
  assert.equal(oldObs.location_name_snapshot, '南阳台');
  assert.equal(newObs.pot_code_snapshot, 'P-02');
  assert.equal(newObs.location_name_snapshot, '北阳台');

  // 幂等：同一批操作重复补传，不产生重复观察
  const again = (await req('POST', '/admin/sync', { device_id: 'device-2', ops })).data;
  assert.ok(again.results.every((r) => r.duplicate));
  const list = (await req('GET', `/observations?plant_id=${pA}`, null, { token: null })).data;
  assert.equal(list.length, 2);

  // 环境条件事后变化，不改写过去
  await req('POST', `/admin/locations/${l1}/conditions`, { condition: '加了遮阳网，半日照', valid_from: '2025-01-01' });
  const oldAgain = (await req('GET', `/observations/${oldId}`, null, { token: null })).data;
  assert.equal(oldAgain.condition_snapshot, '全日照', '旧观察条件不被改写');
});

test('2. 同一天多次观察 + 季节由站主规则决定（非全球同一套月份）', async () => {
  const l = (await req('GET', '/locations')).data[0];
  const plants = (await req('GET', '/plants')).data;
  const pid = plants[0].id;
  await req('POST', '/admin/observations', { plant_id: pid, obs_date: '2024-03-10', body: '早晨浇水' });
  await req('POST', '/admin/observations', { plant_id: pid, obs_date: '2024-03-10', body: '傍晚发现新芽' });
  const day = (await req('GET', `/observations?plant_id=${pid}&from=2024-03-10&to=2024-03-10`)).data;
  assert.equal(day.length, 2, '同一天多条观察并存');
  assert.ok(day.every((o) => o.season === 'spring'), '3/10 在北半球气象规则下为春');

  // 站主声明改为南半球悉尼的季节（春9/1、夏12/1、秋3/1、冬6/1），并重建索引
  await req('PUT', '/admin/settings', {
    region: '悉尼', rule_note: '南半球气象季节',
    season_rules: { spring: [9, 1], summer: [12, 1], autumn: [3, 1], winter: [6, 1] }
  });
  const rebuilt = (await req('POST', '/admin/reindex', {})).data;
  assert.ok(rebuilt.reindexed_observations >= 4);
  const day2 = (await req('GET', `/observations?plant_id=${pid}&from=2024-03-10&to=2024-03-10`)).data;
  assert.ok(day2.every((o) => o.season === 'autumn'), '悉尼 3 月是秋天');
  // 12 月 = 夏（跨年冬季判定不得误判）
  await req('POST', '/admin/observations', { plant_id: pid, obs_date: '2024-12-20', body: '盛夏观察' });
  const summer = (await req('GET', `/observations?plant_id=${pid}&season=summer`)).data;
  assert.ok(summer.length >= 1);
  // 恢复北半球，避免影响后续断言
  await req('PUT', '/admin/settings', {
    region: '测试地', rule_note: '北半球气象季节',
    season_rules: { spring: [3, 1], summer: [6, 1], autumn: [9, 1], winter: [12, 1] }
  });
  await req('POST', '/admin/reindex', {});
});

test('3. 照片 EXIF 隐私剥离：落盘文件无 APP1，元数据仍记录拍摄时间/GPS存在；说明跟随当时对象', async () => {
  const pA = (await req('GET', '/plants')).data.find((p) => p.code === 'PL-A').id;
  const obs = (await req('POST', '/admin/observations', { plant_id: pA, obs_date: '2024-05-14', body: '拍照记录' })).data;
  const jpg = jpegWithExif({ gps: true });
  assert.ok(jpg.includes(Buffer.from('Exif\0')), '前置：测试原图确实带 EXIF');

  const fd = new FormData();
  fd.append('observation_id', obs.id);
  fd.append('caption', '当时挂旧名牌“玉露A”的样子');
  fd.append('photos', new Blob([jpg], { type: 'image/jpeg' }), 'in.jpg');
  const up = (await req('POST', '/admin/photos', fd)).data;
  assert.equal(up.photos[0].exif_stripped, true);
  assert.equal(up.photos[0].gps_was_present, true, '识别到 GPS 并告知站主');
  assert.equal(up.photos[0].taken_at, '2024:05:14 09:30:00', '拍摄时间在剥离前已提取');

  // 下载落盘文件确认无 Exif
  const out = (await req('GET', '/photos/' + up.photos[0].id, null, { token: null, raw: true }));
  const outBuf = Buffer.from(out.data);
  assert.ok(!outBuf.includes(Buffer.from('Exif\0')), '输出 JPEG 不再包含 EXIF 段');
  assert.equal(outBuf[0], 0xff); assert.equal(outBuf[1], 0xd8);
  // 保留了 JFIF（APP0）
  assert.ok(outBuf.includes(Buffer.from('JFIF')), '良性 APP0 保留');

  // 品种订正后，照片快照标签不变
  await req('POST', `/admin/plants/${pA}/correct`, { cultivar_new: 'Haworthia cymbiformis', note: '买错了，实为宝草', event_date: '2024-08-01' });
  const meta = (await req('GET', '/photos/' + up.photos[0].id + '/meta')).data;
  assert.equal(meta.cultivar_snapshot, 'Haworthia cooperi', '照片说明快照不被最新品种覆盖');
  assert.equal(meta.caption, '当时挂旧名牌“玉露A”的样子');
});

test('4. 公开文章整篇覆盖 + 撤回 410；观察为追加式且原始观察版本不被覆盖', async () => {
  const art = (await req('POST', '/admin/articles', { title: '度夏笔记', body: '第一版：少浇水' })).data;
  await req('PUT', `/admin/articles/${art.id}`, { title: '度夏笔记（修订）', body: '第二版：通风比控水更重要' });
  await req('POST', `/admin/articles/${art.id}/publish`, {});
  let pub = await req('GET', `/articles/${art.id}`, null, { token: null });
  assert.equal(pub.status, 200);
  assert.equal(pub.data.body, '第二版：通风比控水更重要');
  assert.equal(pub.data.versions.length, 2, '整篇覆盖保留历史版本');

  // 撤回
  await req('POST', `/admin/articles/${art.id}/withdraw`, { reason: '内容有误，待核实' });
  const gone = await req('GET', `/articles/${art.id}`, null, { token: null });
  assert.equal(gone.status, 410);
  assert.equal(gone.data.error, 'withdrawn');
  // 公开列表不再出现，管理端仍在
  assert.equal((await req('GET', '/articles', null, { token: null })).data.some((a) => a.id === art.id), false);
  assert.ok((await req('GET', '/articles')).data.some((a) => a.id === art.id && a.status === 'withdrawn'));

  // 观察：追加修订不覆盖原始；经验总结单独版本化
  const pA = (await req('GET', '/plants')).data.find((p) => p.code === 'PL-A').id;
  const o = (await req('POST', '/admin/observations', { plant_id: pA, obs_date: '2024-04-01', body: '原始：叶片有点皱' })).data;
  await req('POST', `/admin/observations/${o.id}/revisions`, { kind: 'revision', body: '修订：是缺水，已补水', base_version: 1 });
  const exp = await req('POST', `/admin/observations/${o.id}/revisions`, { kind: 'experience', body: '经验：皱叶先摸介质再决定浇水（仅本人记录）' });
  assert.equal(exp.status, 200);
  const detail = (await req('GET', `/observations/${o.id}`)).data;
  const v1 = detail.versions.find((v) => v.version === 1);
  assert.equal(v1.kind, 'raw');
  assert.equal(v1.body, '原始：叶片有点皱', '原始观察不被覆盖');
  // 乐观锁冲突：旧版本号修订 → 409 + 冲突队列
  const conflict = await req('POST', `/admin/observations/${o.id}/revisions`, { kind: 'revision', body: '另一设备的旧版本修订', base_version: 1 });
  assert.equal(conflict.status, 409);
  assert.ok(conflict.data.conflict_id);
  // 公开侧看不到经验总结
  const pubDetail = (await req('GET', `/observations/${o.id}`, null, { token: null })).data;
  assert.ok(!pubDetail.versions.some((v) => v.kind === 'experience'));
});

test('5. 离线同步冲突处理 + 观察撤回（私有照片不可公开读）+ 重建索引', async () => {
  // 冲突：设备A/B 同时基于 v1 修订同一条观察；通过 sync 接口
  const pB = (await req('GET', '/plants')).data.find((p) => p.code === 'PL-B').id;
  const o = (await req('POST', '/admin/observations', { plant_id: pB, obs_date: '2024-05-01', body: '共同基线 v1' })).data;
  // 设备A 修订成功
  await req('POST', '/admin/sync', {
    device_id: 'A',
    ops: [{ client_op_id: 'a1', type: 'obs.revise', payload: { observation_id: o.id, base_version: 1, kind: 'revision', body: 'A 的修订' } }]
  });
  // 设备B 基于过期 v1 → 冲突入队，不覆盖 A
  const syncB = (await req('POST', '/admin/sync', {
    device_id: 'B',
    ops: [{ client_op_id: 'b1', type: 'obs.revise', payload: { observation_id: o.id, base_version: 1, kind: 'revision', body: 'B 的修订' } }]
  })).data;
  assert.equal(syncB.results[0].ok, false);
  assert.equal(syncB.results[0].reason, 'stale_version');
  const detail = (await req('GET', `/observations/${o.id}`)).data;
  assert.equal(detail.version, 2);
  assert.equal(detail.current_text, 'A 的修订', 'B 的过期写入未静默覆盖');

  // 冲突在同步中心可见并可处理（接受=按最新版本号重放）
  const st = (await req('GET', '/admin/sync/state')).data;
  const c = st.conflicts[0];
  assert.ok(c);
  const patched = JSON.parse(c.payload); patched.base_version = 2;
  await req('POST', `/admin/sync/conflicts/${c.id}/resolve`, { resolution: 'accepted', patched_payload: patched });

  // 撤回观察 → 公开侧 403，照片受控读取同样 403
  const withPhoto = (await req('POST', '/admin/observations', { plant_id: pB, obs_date: '2024-05-02', body: '附照片', published: 1 })).data;
  const jpg = jpegWithExif({ gps: false });
  const fd = new FormData();
  fd.append('observation_id', withPhoto.id);
  fd.append('photos', new Blob([jpg], { type: 'image/jpeg' }), 'x.jpg');
  const photo = (await req('POST', '/admin/photos', fd)).data.photos[0];
  assert.equal((await req('GET', '/photos/' + photo.id, null, { token: null })).status, 200);
  await req('POST', `/admin/observations/${withPhoto.id}/withdraw`, {});
  assert.equal((await req('GET', `/observations/${withPhoto.id}`, null, { token: null })).status, 403);
  assert.equal((await req('GET', '/photos/' + photo.id, null, { token: null })).status, 403, '撤回后照片不可公开访问');
  // 重新发布后恢复
  await req('POST', `/admin/observations/${withPhoto.id}/publish`, {});
  assert.equal((await req('GET', '/photos/' + photo.id, null, { token: null })).status, 200);
});

test('6. 分株与品种订正保留身份来源；身份链可回溯', async () => {
  const pA = (await req('GET', '/plants')).data.find((p) => p.code === 'PL-A').id;
  const sp = (await req('POST', `/admin/plants/${pA}/split`, {
    new_code: 'PL-C', new_name: '玉露 分株C', pot_id: null, location_id: null,
    note: '侧芽掰下', event_date: '2024-09-01'
  })).data;
  assert.equal(sp.origin_plant_id, pA);
  const child = (await req('GET', `/plants/${sp.id}`)).data;
  const splitEv = child.identity.find((e) => e.type === 'split_from');
  assert.ok(splitEv && splitEv.origin_plant_id === pA, '分株后代有身份来源');
  const parent = (await req('GET', `/plants/${pA}`)).data;
  assert.ok(parent.split_children.some((c) => c.plant_id === sp.id));

  // 个体数：同品种 3 株各自独立
  const all = (await req('GET', '/plants')).data;
  const cooperi = all.filter((p) => ['PL-A', 'PL-B', 'PL-C'].includes(p.code));
  assert.equal(cooperi.length, 3);
});

test('7. 统计按当时快照聚合，环境变化影响今后但不改写过去统计', async () => {
  const stats = (await req('GET', '/stats/overview')).data;
  const south = stats.by_location_condition.find((x) => x.location === '南阳台');
  assert.ok(south, '仍能按观察当时的环境名聚合');
  // 3月那条旧观察条件快照是全日照（即便该环境今天已变半日照）
  const fullSun = stats.by_location_condition.find((x) => x.condition === '全日照');
  assert.ok(fullSun, '旧观察统计保留旧条件');
});

test('8. 离线移盆/换环境补传后，历史观察仍指向旧盆，新观察指向新盆（同步路径）', async () => {
  const pB = (await req('GET', '/plants')).data.find((p) => p.code === 'PL-B').id;
  const p1 = (await req('POST', '/admin/pots', { code: 'P-B1' })).data.id;
  const p2 = (await req('POST', '/admin/pots', { code: 'P-B2' })).data.id;
  const loc = (await req('POST', '/admin/locations', { name: '角落', condition: '通风' })).data.id;
  const out = await req('POST', '/admin/sync', {
    device_id: 'offline-3',
    ops: [
      { client_op_id: 'rb1', type: 'plant.repot', payload: { plant_id: pB, pot_id: p1, event_date: '2024-02-01' } },
      { client_op_id: 'rb2', type: 'plant.repot', payload: { plant_id: pB, pot_id: p2, location_id: loc, event_date: '2024-08-01' } },
      { client_op_id: 'rb3', type: 'obs.create', payload: { plant_id: pB, obs_date: '2024-03-01', body: '在 P-B1' } },
      { client_op_id: 'rb4', type: 'obs.create', payload: { plant_id: pB, obs_date: '2024-09-01', body: '在 P-B2' } }
    ]
  });
  assert.equal(out.data.results.every((r) => r.ok), true, JSON.stringify(out.data.results));
  const [, , oldO, newO] = out.data.results.map((r) => r.id);
  const a = (await req('GET', '/observations/' + oldO)).data;
  const b = (await req('GET', '/observations/' + newO)).data;
  assert.equal(a.pot_code_snapshot, 'P-B1');
  assert.equal(b.pot_code_snapshot, 'P-B2');
  assert.equal(b.location_name_snapshot, '角落');
});
