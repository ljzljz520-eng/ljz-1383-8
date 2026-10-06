// 无构建 SPA + 离线队列
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const SEASON_CN = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
const QKEY = 'gardenlog_queue', AKEY = 'gardenlog_applied', DEVKEY = 'gardenlog_device', TKEY = 'gardenlog_token';

const state = {
  token: localStorage.getItem(TKEY) || '',
  device: localStorage.getItem(DEVKEY) || ('dev-' + Math.random().toString(36).slice(2, 8)),
  settings: null, locations: [], plants: [], pots: []
};
localStorage.setItem(DEVKEY, state.device);

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (state.token) headers['x-admin-token'] = state.token;
  const res = await fetch('/api' + path, {
    ...opts,
    headers,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

// ---------- 离线队列 ----------
function loadQueue() { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } }
function saveQueue(q) { localStorage.setItem(QKEY, JSON.stringify(q)); renderQueueBadge(); }
function enqueue(op) { const q = loadQueue(); q.push(op); saveQueue(q); }
function newOpId() { return crypto.randomUUID(); }
async function opOrEnqueue(op, immediateFn) {
  if (navigator.onLine) {
    try { return await immediateFn(); }
    catch (e) {
      if (e.status === 401) throw e;
      enqueue(op); toast('已存入离线队列（' + (e.message) + '）'); return null;
    }
  } else { enqueue(op); toast('当前离线，已存入待传队列'); return null; }
}
function renderQueueBadge() {
  const n = loadQueue().length;
  const b = $('#queueBadge');
  b.textContent = `离线待传 ${n}`;
  b.classList.toggle('hidden', n === 0);
}

async function syncQueue() {
  const q = loadQueue();
  if (!q.length) { toast('队列为空'); return; }
  $('#syncStatus').textContent = '同步中…';
  try {
    const out = await api('/admin/sync', { method: 'POST', body: { device_id: state.device, ops: q } });
    const applied = JSON.parse(localStorage.getItem(AKEY) || '[]');
    const remain = [];
    out.results.forEach((r, i) => {
      const op = q[i];
      if (r.ok) applied.push({ client_op_id: r.client_op_id, ts: Date.now(), duplicate: !!r.duplicate });
      else remain.push(op); // 冲突的操作本地也保留
    });
    localStorage.setItem(AKEY, JSON.stringify(applied.slice(-500)));
    saveQueue(remain);
    const conflicts = out.results.filter((r) => !r.ok).length;
    toast(conflicts ? `同步完成，${conflicts} 条冲突待决` : '同步完成');
  } catch (e) { toast('同步失败：' + e.message); }
  $('#syncStatus').textContent = '';
  renderSyncPane(); refreshAll();
}

// ---------- 基础数据 ----------
async function loadSettings() {
  state.settings = await api('/settings');
  $('#siteDecl').textContent = `📍${state.settings.region} · 分季：${state.settings.rule_note || '站主声明'}（春${md(state.settings.season_rules.spring)}起）`;
}
const md = (a) => `${a[0]}/${a[1]}`;

async function loadCatalog() {
  [state.locations, state.plants, state.pots] = await Promise.all([
    api('/locations'), api('/plants'), api('/pots')
  ]);
}

// ---------- 浏览页 ----------
async function loadBrowse() {
  const params = new URLSearchParams();
  const s = $('#fSeason').value, l = $('#fLocation').value, p = $('#fPlant').value, qv = $('#fQ').value.trim();
  if (s) params.set('season', s);
  if (l) params.set('location_id', l);
  if (p) params.set('plant_id', p);
  if (qv) params.set('q', qv);
  const [obs, stats] = await Promise.all([
    api('/observations?' + params.toString()),
    api('/stats/overview' + (state.token ? '' : ''))
  ]);
  // 公开 stats 端点对所有访问者一致；带令牌时返回管理视角
  $('#stats').innerHTML = [
    ...stats.by_season.map((x) => `<span class="stat-pill">${SEASON_CN[x.season] || '未分季'}：${x.n} 条观察</span>`),
    ...stats.by_location_condition.slice(0, 5).map((x) => `<span class="stat-pill">${x.location}：${x.n}</span>`)
  ].join('');
  $('#obsList').innerHTML = obs.map(obsCard).join('') || '<p class="hint">暂无观察记录</p>';
  $$('#obsList [data-photos]').forEach(async (el) => {
    const id = el.getAttribute('data-photos');
    const detail = await api('/observations/' + id);
    el.innerHTML = (detail.photos || []).map((p) =>
      `<a href="/api/photos/${p.id}" target="_blank"><img src="/api/photos/${p.id}" loading="lazy" alt=""></a>`).join('');
  });
}

function obsCard(o) {
  return `<div class="card">
    <h4><span class="season-tag">${SEASON_CN[o.season] || '—'}</span>${escapeHtml(o.plant_name_snapshot || '?')}
      ${o.published ? '' : '<span class="private-badge">已撤回/私有</span>'}</h4>
    <div class="dates">观察日期：${o.obs_date} ｜ 发表：${new Date(o.created_at).toLocaleString()}</div>
    <div class="snap">当时：${escapeHtml(o.cultivar_snapshot || '')} · 盆 ${escapeHtml(o.pot_code_snapshot || '—')} · 环境 ${escapeHtml(o.location_name_snapshot || '—')}
      ${o.condition_snapshot ? '<br>条件：' + escapeHtml(o.condition_snapshot) : ''}</div>
    <div>${escapeHtml(o.body).replace(/\n/g, '<br>')}</div>
    ${o.photo_count ? `<div class="photos" data-photos="${o.id}"></div>` : ''}
    ${o.revised ? `<div class="ver-line">原始观察保留 · 当前为第 v${o.version} 版</div>` : ''}
  </div>`;
}

// ---------- 植物页 ----------
function renderPlantList() {
  $('#plantList').innerHTML = state.plants.map((p) =>
    `<div class="plant-card" data-id="${p.id}"><b>${escapeHtml(p.display_name)}</b>
      <div class="hint">${p.code} · ${escapeHtml(p.cultivar || '品种未定')} · ${p.status}</div></div>`).join('');
  $$('#plantList .plant-card').forEach((c) => c.onclick = () => showPlant(+c.dataset.id));
}

async function showPlant(id) {
  const d = await api('/plants/' + id);
  const tl = (ev) => ev.map((e) =>
    `<li>${e.event_date}｜${typeCn(e.type)}${e.cultivar_before != null ? `：${escapeHtml(e.cultivar_before || '∅')} → ${escapeHtml(e.cultivar_after || '∅')}` : ''}
      ${e.origin_plant_id ? `（来源个体 #${e.origin_plant_id}）` : ''} ${e.note ? '· ' + escapeHtml(e.note) : ''}</li>`).join('');
  $('#plantDetail').classList.remove('hidden');
  $('#plantDetail').innerHTML = `
    <button onclick="document.getElementById('plantDetail').classList.add('hidden')">← 返回</button>
    <h3>${escapeHtml(d.plant.display_name)} <small>${d.plant.code} · ${escapeHtml(d.plant.cultivar || '')}</small></h3>
    ${state.token ? plantAdminActions(d) : ''}
    <h4>身份与品种来源（不可改写，只可追加订正）</h4>
    <ul class="timeline">${tl(d.identity)}</ul>
    <h4>栽培记录（盆器 / 环境时段）</h4>
    <ul class="timeline">${d.periods.map((p) =>
      `<li>${p.started_on} → ${p.ended_on || '至今'}｜${reasonCn(p.reason)}｜盆 ${escapeHtml(p.pot_code || '地栽/无盆')}｜环境 ${escapeHtml(p.location_name || '—')} ${p.note ? '· ' + escapeHtml(p.note) : ''}</li>`).join('')}</ul>
    ${d.split_children.length ? `<h4>分株后代</h4><ul class="timeline">${d.split_children.map((c) => `<li>#${c.plant_id} ${escapeHtml(c.display_name)}（${c.event_date}）</li>`).join('')}</ul>` : ''}
    <h4>观察时间线</h4>
    <ul class="timeline">${d.observations.map((o) =>
      `<li>${o.obs_date}（${SEASON_CN[o.season] || '—'}）@ ${escapeHtml(o.location_name_snapshot || '—')}：${escapeHtml(o.body.slice(0, 60))}… ${o.published ? '' : '<span class="private-badge">私有</span>'}</li>`).join('') || '<li class="hint">暂无</li>'}</ul>`;
  bindPlantAdminActions(id, d);
}

function plantAdminActions(d) {
  return `<div class="admin-bar">
    <button data-act="correct">品种订正</button>
    <button data-act="rename">改名</button>
    <button data-act="repot">移盆</button>
    <button data-act="move">换环境</button>
    <button data-act="split">分株建档</button>
  </div>`;
}

function bindPlantAdminActions(id) {
  $$('#plantDetail [data-act]').forEach((b) => b.onclick = async () => {
    try {
      if (b.dataset.act === 'correct') {
        const cv = prompt('订正后的品种名（身份与旧观察中的品种快照保留）'); if (!cv) return;
        const note = prompt('订正依据（可选）') || '';
        await opOrEnqueue({ type: 'plant.correct', client_op_id: newOpId(), payload: { plant_id: id, cultivar_new: cv, note } },
          () => api('/admin/plants/' + id + '/correct', { method: 'POST', body: { cultivar_new: cv, note } }));
      } else if (b.dataset.act === 'rename') {
        const nm = prompt('新标签名（旧照片说明不回写）'); if (!nm) return;
        await opOrEnqueue(null, () => api('/admin/plants/' + id + '/rename', { method: 'POST', body: { display_name: nm } }));
      } else if (b.dataset.act === 'repot' || b.dataset.act === 'move') {
        const opts = b.dataset.act === 'repot'
          ? state.pots.map((p) => `${p.id}:${p.code}`).join(', ')
          : state.locations.map((l) => `${l.id}:${l.name}`).join(', ');
        const pick = prompt('选择' + (b.dataset.act === 'repot' ? '盆器' : '环境') + ' id（' + opts + '）');
        if (!pick) return;
        const d0 = prompt('生效日期 YYYY-MM-DD（可补记）', new Date().toISOString().slice(0, 10));
        if (b.dataset.act === 'repot') {
          const body = { pot_id: +pick, event_date: d0 };
          await opOrEnqueue({ type: 'plant.repot', client_op_id: newOpId(), payload: { plant_id: id, ...body } },
            () => api('/admin/plants/' + id + '/repot', { method: 'POST', body }));
        } else {
          const body = { location_id: +pick, event_date: d0 };
          await opOrEnqueue({ type: 'plant.move', client_op_id: newOpId(), payload: { plant_id: id, ...body } },
            () => api('/admin/plants/' + id + '/move', { method: 'POST', body }));
        }
      } else if (b.dataset.act === 'split') {
        const code = prompt('新个体编号（分株是独立植株，不与母株合并）'); if (!code) return;
        const nm = prompt('新个体标签名'); if (!nm) return;
        const body = { new_code: code, new_name: nm };
        await opOrEnqueue({ type: 'plant.split', client_op_id: newOpId(), payload: { plant_id: id, ...body } },
          () => api('/admin/plants/' + id + '/split', { method: 'POST', body }));
      }
      await loadCatalog(); await showPlant(id); refreshAll(); toast('已保存');
    } catch (e) { toast(e.message); }
  });
}

function typeCn(t) {
  return { acquired: '引种建档', split_from: '分株来源', correction: '品种订正', rename: '改名', merge_note: '合并说明' }[t] || t;
}
function reasonCn(r) { return { initial: '初植', repot: '移盆', split: '分株', move_only: '换环境', removed: '移出' }[r] || r; }

// ---------- 文章 ----------
async function loadArticles() {
  const list = await api('/articles');
  $('#articleList').innerHTML = list.map((a) =>
    `<div class="article-item" data-id="${a.id}"><b>${escapeHtml(a.title)}</b>
      <div class="hint">${a.status === 'published' ? `已发表 ${a.published_at ? new Date(a.published_at).toLocaleDateString() : ''}` : a.status === 'withdrawn' ? '已撤回：' + a.withdrawn_reason : '草稿'}
       · v${a.version} · 整篇覆盖式</div></div>`).join('') || '<p class="hint">暂无文章</p>';
  $$('#articleList .article-item').forEach((el) => el.onclick = () => openArticle(+el.dataset.id));
}

async function openArticle(id) {
  let a;
  try { a = await api('/articles/' + id); } catch (e) {
    if (e.status === 410) return toast('该文章已被撤回（公开访问 410 Gone）');
    throw e;
  }
  $('#articleEditor').classList.remove('hidden');
  $('#articleList').classList.add('hidden');
  $('#articleEditor').innerHTML = `
    <button id="artBack">← 返回列表</button>
    <h3>${escapeHtml(a.title)} <small>v${a.version} · ${a.status}</small></h3>
    <div style="white-space:pre-wrap">${escapeHtml(a.body)}</div>
    <div class="hint">版本数 ${a.versions.length}；引用观察 ${a.linked_observations.length} 条（手动关联，经验不自动推广）</div>
    ${state.token ? `<hr><h4>整篇覆盖编辑</h4>
      <div class="form">
        <input id="artTitle" value="${escapeAttr(a.title)}">
        <textarea id="artBody" rows="8">${escapeHtml(a.body)}</textarea>
        <button id="artSave">保存为新版本</button>
        <div><button id="artPub">${a.status === 'published' ? '' : '发表'}</button>
        <button id="artWithdraw">撤回公开文章</button></div>
      </div>` : ''}`;
  $('#artBack').onclick = () => { $('#articleEditor').classList.add('hidden'); $('#articleList').classList.remove('hidden'); };
  if (state.token) {
    $('#artSave').onclick = async () => {
      await opOrEnqueue({ type: 'article.upsert', client_op_id: newOpId(), payload: { article_id: id, title: $('#artTitle').value, body: $('#artBody').value } },
        () => api('/admin/articles/' + id, { method: 'PUT', body: { title: $('#artTitle').value, body: $('#artBody').value } }));
      await loadArticles(); openArticle(id);
    };
    const pb = $('#artPub'); if (pb) pb.onclick = async () => { await api('/admin/articles/' + id + '/publish', { method: 'POST', body: {} }); loadArticles(); openArticle(id); };
    $('#artWithdraw').onclick = async () => {
      const reason = prompt('撤回原因') || '站主撤回';
      await opOrEnqueue({ type: 'article.withdraw', client_op_id: newOpId(), payload: { article_id: id, reason } },
        () => api('/admin/articles/' + id + '/withdraw', { method: 'POST', body: { reason } }));
      loadArticles(); $('#articleEditor').classList.add('hidden'); $('#articleList').classList.remove('hidden');
    };
  }
}

$('#newArticleBtn')?.addEventListener('click', async () => {
  const title = prompt('文章标题'); if (!title) return;
  const body = prompt('正文（可先建草稿，之后整篇覆盖编辑）') || '';
  await opOrEnqueue({ type: 'article.upsert', client_op_id: newOpId(), payload: { title, body } },
    () => api('/admin/articles', { method: 'POST', body: { title, body } }));
  loadArticles();
});

// ---------- 录入 ----------
function fillEntrySelects() {
  const sel = $('#obsForm select[name=plant_id]');
  sel.innerHTML = state.plants.map((p) => `<option value="${p.id}">${p.display_name}（${p.code}）</option>`).join('');
  $('#obsForm [name=obs_date]').value = new Date().toISOString().slice(0, 10);
}

$('#obsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const plant_id = +f.get('plant_id'), obs_date = f.get('obs_date');
  const body = f.get('body'), published = f.get('published') === 'on';
  const files = f.getAll('photos').filter((x) => x.size);
  const caption = f.get('caption');
  const opId = newOpId();

  const doCreate = () => api('/admin/observations', { method: 'POST', body: { plant_id, obs_date, body, published, device_id: state.device, client_op_id: opId } });
  let r = null;
  try {
    r = await opOrEnqueue({ type: 'obs.create', client_op_id: opId, payload: { plant_id, obs_date, body, published: published ? 1 : 0, device_id: state.device } }, doCreate);
  } catch (err) { return toast(err.message); }

  if (r && files.length) {
    const fd = new FormData();
    files.forEach((x) => fd.append('photos', x));
    fd.append('observation_id', r.id); fd.append('caption', caption);
    try {
      const pr = await api('/admin/photos', { method: 'POST', body: fd });
      const gpsNote = pr.photos.some((p) => p.gps_was_present) ? ' 原片含 GPS，已剥离。' : '';
      $('#entryResult').innerHTML = `<div class="card">保存成功。EXIF 已剥离${gpsNote}<br>季节：${SEASON_CN[r.season] || '—'}；快照：${escapeHtml((r.snapshots || {}).location_name_snapshot || '')}</div>`;
    } catch (err) { toast('照片上传失败（观察已保存）：' + err.message); }
  } else if (r) {
    $('#entryResult').innerHTML = `<div class="card">保存成功，季节：${SEASON_CN[r.season] || '—'}</div>`;
  } else {
    toast('观察已入离线队列；照片请在联网后于该观察补传（或先不传）');
  }
  e.target.body.value = ''; e.target.caption.value = ''; e.target.photos.value = '';
  refreshAll();
});

// ---------- 目录管理 ----------
async function renderManage() {
  const sf = $('#settingsForm');
  sf.region.value = state.settings.region;
  sf.rule_note.value = state.settings.rule_note || '';
  for (const k of ['spring', 'summer', 'autumn', 'winter']) sf[k].value = state.settings.season_rules[k].join(',');

  $('#locAdmin').innerHTML = state.locations.map((l) =>
    `<div class="op-row">${l.archived ? '📦' : '📍'} <b>${escapeHtml(l.name)}</b> ${escapeHtml(l.kind || '')}
      <small>${escapeHtml(l.current_condition || '')}</small>
      <button data-lid="${l.id}" data-act="loccond">登记环境变化</button></div>`).join('');
  $$('#locAdmin [data-act=loccond]').forEach((b) => b.onclick = async () => {
    const condition = prompt('新条件描述（自何日起生效；旧观察保留旧条件）'); if (condition === null) return;
    const valid_from = prompt('生效日', new Date().toISOString().slice(0, 10));
    const body = { condition, valid_from, location_id: +b.dataset.lid };
    await opOrEnqueue({ type: 'location.condition', client_op_id: newOpId(), payload: body },
      () => api('/admin/locations/' + b.dataset.lid + '/conditions', { method: 'POST', body }));
    await loadCatalog(); renderManage();
  });

  $('#potAdmin').innerHTML = state.pots.map((p) => `<div class="op-row">🪴 ${p.code} ${escapeHtml(p.name || '')} ${escapeHtml(p.material || '')}</div>`).join('');
  $('#plantAdmin').innerHTML = state.plants.map((p) =>
    `<div class="op-row">🌱 #${p.id} ${p.code} <b>${escapeHtml(p.display_name)}</b> <small>${escapeHtml(p.cultivar || '')}</small>
      <button data-pid="${p.id}" data-act="addexp">追加经验总结</button></div>`).join('');
  $$('#plantAdmin [data-act=addexp]').forEach((b) => b.onclick = async () => {
    const text = prompt('事后经验总结（个人记录，独立版本化，不会变成其他植物的养护指令）'); if (!text) return;
    const obs = await api('/observations?plant_id=' + b.dataset.pid);
    const pick = prompt('要挂在哪条观察？\n' + obs.slice(0, 10).map((o) => `#${o.id} ${o.obs_date} ${o.body.slice(0, 20)}`).join('\n'));
    if (!pick) return;
    const oid = +pick.replace(/^#/, '');
    await api('/admin/observations/' + oid + '/revisions', { method: 'POST', body: { kind: 'experience', body: text } });
    toast('经验总结已作为个人记录追加');
  });

  // 表单里的盆/位置下拉
  $('#plantForm select[name=pot_id]').innerHTML = '<option value="">无盆</option>' + state.pots.map((p) => `<option value="${p.id}">${p.code}</option>`).join('');
  $('#plantForm select[name=location_id]').innerHTML = '<option value="">无位置</option>' + state.locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
}

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const season_rules = {};
  for (const k of ['spring', 'summer', 'autumn', 'winter']) season_rules[k] = String(f.get(k)).split(',').map((x) => +x.trim());
  try {
    const r = await api('/admin/settings', { method: 'PUT', body: { region: f.get('region'), rule_note: f.get('rule_note'), season_rules } });
    toast('声明已保存。' + r.notice); loadSettings();
  } catch (err) { toast(err.message); }
});
$('#reindexBtn').onclick = async () => {
  const r = await api('/admin/reindex', { method: 'POST', body: {} });
  toast('索引已重建：' + r.reindexed_observations + ' 条观察按当前分季规则重算'); refreshAll();
};

$('#locForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = new FormData(e.target);
  const payload = { name: f.get('name'), kind: f.get('kind'), condition: f.get('condition'), light: '', valid_from: f.get('valid_from') || undefined };
  await opOrEnqueue({ type: 'location.create', client_op_id: newOpId(), payload },
    () => api('/admin/locations', { method: 'POST', body: payload }));
  e.target.reset(); await loadCatalog(); renderManage();
});
$('#potForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = new FormData(e.target);
  const body = { code: f.get('code'), name: f.get('name'), material: f.get('material') };
  await opOrEnqueue(null, () => api('/admin/pots', { method: 'POST', body }));
  e.target.reset(); await loadCatalog(); renderManage();
});
$('#plantForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = new FormData(e.target);
  const payload = { code: f.get('code'), display_name: f.get('display_name'), cultivar: f.get('cultivar'),
    pot_id: f.get('pot_id') ? +f.get('pot_id') : null, location_id: f.get('location_id') ? +f.get('location_id') : null };
  await opOrEnqueue({ type: 'plant.create', client_op_id: newOpId(), payload },
    () => api('/admin/plants', { method: 'POST', body: payload }));
  e.target.reset(); await loadCatalog(); renderManage(); renderPlantList();
});

// ---------- 同步中心 ----------
async function renderSyncPane() {
  const q = loadQueue();
  $('#queueList').innerHTML = q.map((o) =>
    `<div class="op-row">${o.type} <small>${o.client_op_id?.slice(0, 8)}</small> ${escapeHtml(JSON.stringify(o.payload).slice(0, 80))}</div>`).join('')
    || '<p class="hint">无待传操作</p>';
  if (state.token) {
    try {
      const st = await api('/admin/sync/state');
      $('#conflictList').innerHTML = st.conflicts.map((c) =>
        `<div class="op-row conflict">#${c.id} ${c.op_type}：${c.reason}
          <button data-cid="${c.id}" data-r="accepted">接受(用服务端版本号重放)</button>
          <button data-cid="${c.id}" data-r="rejected">拒绝</button></div>`).join('')
        || '<p class="hint">无冲突</p>';
      $$('#conflictList button').forEach((b) => b.onclick = async () => {
        const c = st.conflicts.find((x) => x.id === +b.dataset.cid);
        let patched;
        if (b.dataset.r === 'accepted') {
          const p = JSON.parse(c.payload); p.base_version = JSON.parse(c.server_state).version;
          patched = p;
        }
        await api('/admin/sync/conflicts/' + c.id + '/resolve', { method: 'POST', body: { resolution: b.dataset.r, patched_payload: patched } });
        renderSyncPane();
      });
    } catch { /* 未登录时忽略 */ }
  }
}
$('#syncNowBtn').onclick = syncQueue;
$('#clearAppliedBtn').onclick = () => { localStorage.removeItem(AKEY); toast('已清除本机应用记录（服务器幂等表不受影响）'); };

// ---------- 框架 ----------
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

$$('.tabs button').forEach((b) => b.onclick = () => {
  $$('.tabs button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $$('main .tab').forEach((t) => t.classList.add('hidden'));
  $('#tab-' + b.dataset.tab).classList.remove('hidden');
  if (b.dataset.tab === 'browse') loadBrowse();
  if (b.dataset.tab === 'plants') renderPlantList();
  if (b.dataset.tab === 'articles') { $('#articleList').classList.remove('hidden'); loadArticles(); }
  if (b.dataset.tab === 'manage' && state.token) renderManage();
  if (b.dataset.tab === 'sync') renderSyncPane();
});

function refreshBrowseFilters() {
  $('#fLocation').innerHTML = '<option value="">全部</option>' + state.locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  $('#fPlant').innerHTML = '<option value="">全部</option>' + state.plants.map((p) => `<option value="${p.id}">${p.display_name}</option>`).join('');
}
['fSeason', 'fLocation', 'fPlant'].forEach((id) => $('#' + id).addEventListener('change', loadBrowse));
$('#fQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadBrowse(); });

$('#loginBtn').onclick = async () => {
  state.token = $('#tokenInput').value.trim();
  try {
    await fetch('/api/admin/sync/state', { headers: { 'x-admin-token': state.token } }).then((r) => { if (!r.ok) throw new Error('bad token'); });
    localStorage.setItem(TKEY, state.token);
    document.body.classList.add('admin');
    toast('已登录管理模式'); bootAdmin();
  } catch { state.token = ''; localStorage.removeItem(TKEY); toast('令牌无效'); }
};

window.addEventListener('online', () => { setNet(); toast('网络恢复，可点"立即同步"'); });
window.addEventListener('offline', () => setNet());
function setNet() {
  const d = $('#netDot');
  d.className = 'dot ' + (navigator.onLine ? 'online' : 'offline');
}

async function refreshAll() {
  await Promise.all([loadCatalog(), loadSettings()]);
  refreshBrowseFilters(); fillEntrySelects();
  if (state.token && document.body.classList.contains('admin')) renderManage();
  loadBrowse(); renderPlantList();
}
async function bootAdmin() {
  document.body.classList.add('admin');
  await loadCatalog();
  refreshBrowseFilters(); fillEntrySelects(); renderManage();
}

(async function init() {
  setNet(); renderQueueBadge();
  await loadSettings();
  await loadCatalog();
  refreshBrowseFilters(); fillEntrySelects();
  if (state.token) {
    $('#tokenInput').value = state.token;
    try {
      await fetch('/api/admin/sync/state', { headers: { 'x-admin-token': state.token } }).then((r) => { if (!r.ok) throw new Error(); });
      document.body.classList.add('admin'); renderManage();
    } catch { state.token = ''; localStorage.removeItem(TKEY); }
  }
  loadBrowse(); renderPlantList();
})();
