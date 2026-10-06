// 管理：站点声明（地区/分季）、环境、盆器、植物个体、身份事件（移盆/分株/品种订正）
import { Router } from 'express';
import { getSettings, nowIso } from '../db.js';
import { fail, validDate, currentSeason } from '../util.js';

export default function catalogRouter(db) {
  const r = Router();

  // ---------- 站点声明 ----------
  r.get('/settings', (req, res) => {
    const s = getSettings(db);
    res.json({
      region: s.region, season_rule_kind: s.season_rule_kind,
      season_rules: JSON.parse(s.season_rules), rule_note: s.rule_note,
      updated_at: s.updated_at
    });
  });

  r.put('/admin/settings', (req, res) => {
    const { region, season_rules, rule_note = '' } = req.body || {};
    if (!region || typeof region !== 'string') return fail(res, 400, 'region_required');
    // 校验四季起点 [month,day]
    const keys = ['spring', 'summer', 'autumn', 'winter'];
    if (!season_rules || keys.some((k) => !Array.isArray(season_rules[k]) || season_rules[k].length !== 2 ||
        season_rules[k][0] < 1 || season_rules[k][0] > 12)) {
      return fail(res, 400, 'season_rules_invalid', { expect: '{spring:[m,d],...}' });
    }
    const old = getSettings(db);
    const now = nowIso();
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO settings_history(region, season_rule_kind, season_rules, rule_note, changed_at)
                  VALUES(?,?,?,?,?)`).run(old.region, old.season_rule_kind, old.season_rules, old.rule_note, now);
      db.prepare(`UPDATE site_settings SET region=?, season_rule_kind=?, season_rules=?, rule_note=?, updated_at=? WHERE id=1`)
        .run(region, 'custom', JSON.stringify(season_rules), rule_note, now);
    });
    tx();
    res.json({ ok: true, settings: getSettings(db),
               notice: '规则已更新。旧观察的季节标签是按当时规则的快照；如要按新规则重筛，请调用重建索引。' });
  });

  // 重建筛选索引：季节冗余字段按当前规则全量重算
  r.post('/admin/reindex', (req, res) => {
    const obs = db.prepare('SELECT id, obs_date FROM observations').all();
    const upd = db.prepare('UPDATE observations SET season=? WHERE id=?');
    let n = 0;
    const tx = db.transaction(() => {
      for (const o of obs) { upd.run(currentSeason(db, o.obs_date), o.id); n++; }
    });
    tx();
    res.json({ ok: true, reindexed_observations: n });
  });

  // ---------- 环境（位置） ----------
  r.get('/locations', (req, res) => {
    res.json(db.prepare('SELECT * FROM locations ORDER BY archived, id').all());
  });

  r.post('/admin/locations', (req, res) => {
    const { name, kind = '', condition = '', light = '', valid_from } = req.body || {};
    if (!name) return fail(res, 400, 'name_required');
    const vf = valid_from || new Date().toISOString().slice(0, 10);
    if (!validDate(vf)) return fail(res, 400, 'bad_date');
    const now = nowIso();
    const id = db.transaction(() => {
      const lid = db.prepare(`INSERT INTO locations(name, kind, current_condition, created_at)
                              VALUES(?,?,?,?)`).run(name, kind, condition, now).lastInsertRowid;
      db.prepare(`INSERT INTO location_periods(location_id, condition, light, valid_from, created_at)
                  VALUES(?,?,?,?,?)`).run(lid, condition, light, vf, now);
      return lid;
    })();
    res.json({ ok: true, id });
  });

  // 环境变化：登记新条件时段（影响今后统计，不改写过去）
  r.post('/admin/locations/:id/conditions', (req, res) => {
    const id = +req.params.id;
    const loc = db.prepare('SELECT * FROM locations WHERE id=?').get(id);
    if (!loc) return fail(res, 404, 'not_found');
    const { condition = '', light = '', valid_from } = req.body || {};
    const vf = valid_from || new Date().toISOString().slice(0, 10);
    if (!validDate(vf)) return fail(res, 400, 'bad_date');
    const now = nowIso();
    db.transaction(() => {
      db.prepare(`UPDATE location_periods SET valid_to=? WHERE location_id=? AND valid_to IS NULL AND valid_from < ?`)
        .run(vf, id, vf);
      db.prepare(`INSERT INTO location_periods(location_id, condition, light, valid_from, created_at)
                  VALUES(?,?,?,?,?)`).run(id, condition, light, vf, now);
      db.prepare('UPDATE locations SET current_condition=? WHERE id=?').run(condition, id);
    })();
    res.json({ ok: true, notice: '新条件自 ' + vf + ' 起生效；历史观察保留旧条件快照。' });
  });

  r.patch('/admin/locations/:id', (req, res) => {
    const id = +req.params.id;
    const loc = db.prepare('SELECT * FROM locations WHERE id=?').get(id);
    if (!loc) return fail(res, 404, 'not_found');
    const { name, kind, archived } = req.body || {};
    db.prepare('UPDATE locations SET name=COALESCE(?,name), kind=COALESCE(?,kind), archived=COALESCE(?,archived) WHERE id=?')
      .run(name ?? null, kind ?? null, archived ?? null, id);
    res.json({ ok: true, notice: '改名仅影响今后选择；旧观察中的环境名快照不变。' });
  });

  // ---------- 盆器 ----------
  r.get('/pots', (req, res) => res.json(db.prepare('SELECT * FROM pots ORDER BY archived, id').all()));

  r.post('/admin/pots', (req, res) => {
    const { code, name = '', material = '' } = req.body || {};
    if (!code) return fail(res, 400, 'code_required');
    try {
      const id = db.prepare('INSERT INTO pots(code,name,material,created_at) VALUES(?,?,?,?)')
        .run(code, name, material, nowIso()).lastInsertRowid;
      res.json({ ok: true, id });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return fail(res, 409, 'pot_code_exists');
      throw e;
    }
  });

  r.patch('/admin/pots/:id', (req, res) => {
    const { name, material, archived } = req.body || {};
    db.prepare('UPDATE pots SET name=COALESCE(?,name), material=COALESCE(?,material), archived=COALESCE(?,archived) WHERE id=?')
      .run(name ?? null, material ?? null, archived ?? null, +req.params.id);
    res.json({ ok: true });
  });

  // ---------- 植物个体 ----------
  r.get('/plants', (req, res) => res.json(db.prepare('SELECT * FROM plants ORDER BY id').all()));

  // 建档（可选初始盆/位置；同品种多盆请分别建档）
  r.post('/admin/plants', (req, res) => {
    const { code, display_name, cultivar = '', note = '', pot_id = null, location_id = null, started_on } = req.body || {};
    if (!code || !display_name) return fail(res, 400, 'code_and_name_required');
    const on = started_on || new Date().toISOString().slice(0, 10);
    if (!validDate(on)) return fail(res, 400, 'bad_date');
    if (pot_id && !db.prepare('SELECT id FROM pots WHERE id=?').get(pot_id)) return fail(res, 400, 'bad_pot');
    if (location_id && !db.prepare('SELECT id FROM locations WHERE id=?').get(location_id)) return fail(res, 400, 'bad_location');
    const now = nowIso();
    try {
      const result = db.transaction(() => {
        const pid = db.prepare(`INSERT INTO plants(code,display_name,cultivar,note,created_at)
                                VALUES(?,?,?,?,?)`).run(code, display_name, cultivar, note, now).lastInsertRowid;
        db.prepare(`INSERT INTO plant_identity_events(plant_id,type,cultivar_before,cultivar_after,note,event_date,created_at)
                    VALUES(?,?,?,?,?,?,?)`).run(pid, 'acquired', null, cultivar, '建档', on, now);
        db.prepare(`INSERT INTO plant_pot_periods(plant_id,pot_id,location_id,reason,started_on,note,created_at)
                    VALUES(?,?,?,?,?,?,?)`).run(pid, pot_id, location_id, 'initial', on, '', now);
        return pid;
      })();
      res.json({ ok: true, id: result });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return fail(res, 409, 'plant_code_exists');
      throw e;
    }
  });

  // 品种订正：保留身份与来源，仅记录订正事件并更新当前品种标签
  r.post('/admin/plants/:id/correct', (req, res) => {
    const id = +req.params.id;
    const p = db.prepare('SELECT * FROM plants WHERE id=?').get(id);
    if (!p) return fail(res, 404, 'not_found');
    const { cultivar_new, note = '', event_date } = req.body || {};
    if (!cultivar_new) return fail(res, 400, 'cultivar_new_required');
    const d = event_date || new Date().toISOString().slice(0, 10);
    if (!validDate(d)) return fail(res, 400, 'bad_date');
    const now = nowIso();
    db.transaction(() => {
      db.prepare(`INSERT INTO plant_identity_events(plant_id,type,origin_plant_id,cultivar_before,cultivar_after,note,event_date,created_at)
                  VALUES(?,?,?,?,?,?,?,?)`)
        .run(id, 'correction', id, p.cultivar, cultivar_new, note, d, now);
      db.prepare('UPDATE plants SET cultivar=? WHERE id=?').run(cultivar_new, id);
    });
    res.json({ ok: true,
      notice: `品种已订正：${p.cultivar || '(未知)'} → ${cultivar_new}。个体身份(#${id})与历史观察中的品种快照保留不变。` });
  });

  r.post('/admin/plants/:id/rename', (req, res) => {
    const id = +req.params.id;
    const p = db.prepare('SELECT * FROM plants WHERE id=?').get(id);
    if (!p) return fail(res, 404, 'not_found');
    const { display_name, note = '', event_date } = req.body || {};
    if (!display_name) return fail(res, 400, 'display_name_required');
    const d = event_date || new Date().toISOString().slice(0, 10);
    db.transaction(() => {
      db.prepare(`INSERT INTO plant_identity_events(plant_id,type,cultivar_before,cultivar_after,note,event_date,created_at)
                  VALUES(?,?,?,?,?,?,?)`).run(id, 'rename', p.cultivar, p.cultivar, `改名：${p.display_name} → ${display_name}；${note}`, d, nowIso());
      db.prepare('UPDATE plants SET display_name=? WHERE id=?').run(display_name, id);
    });
    res.json({ ok: true, notice: '当前标签已更新；照片说明与历史观察中的名称快照不回写。' });
  });

  // 分株：新建独立个体，身份来源指向母株；可同时给两株安排盆/位置
  r.post('/admin/plants/:id/split', (req, res) => {
    const parentId = +req.params.id;
    const parent = db.prepare('SELECT * FROM plants WHERE id=?').get(parentId);
    if (!parent) return fail(res, 404, 'parent_not_found');
    const { new_code, new_name, cultivar, pot_id = null, location_id = null, parent_pot_id, parent_location_id,
            note = '', event_date } = req.body || {};
    if (!new_code || !new_name) return fail(res, 400, 'new_code_and_name_required');
    const d = event_date || new Date().toISOString().slice(0, 10);
    if (!validDate(d)) return fail(res, 400, 'bad_date');
    const now = nowIso();
    try {
      const newId = db.transaction(() => {
        const pid = db.prepare(`INSERT INTO plants(code,display_name,cultivar,note,created_at)
                                VALUES(?,?,?,?,?)`).run(new_code, new_name, cultivar ?? parent.cultivar, '分株自 ' + parent.code, now).lastInsertRowid;
        db.prepare(`INSERT INTO plant_identity_events(plant_id,type,origin_plant_id,cultivar_before,cultivar_after,note,event_date,created_at)
                    VALUES(?,?,?,?,?,?,?,?)`)
          .run(pid, 'split_from', parentId, parent.cultivar, cultivar ?? parent.cultivar, note, d, now);
        db.prepare(`INSERT INTO plant_pot_periods(plant_id,pot_id,location_id,reason,started_on,note,created_at)
                    VALUES(?,?,?,?,?,?,?)`).run(pid, pot_id, location_id, 'split', d, '分株上盆', now);
        // 母株如换了盆/位置，同步结束其当前占用
        if (parent_pot_id || parent_location_id) {
          closeAndOpen(db, parentId, { pot_id: parent_pot_id ?? curPot(db, parentId),
            location_id: parent_location_id ?? curLoc(db, parentId), reason: 'split', on: d, note: '分株后母株安置' });
        }
        return pid;
      })();
      res.json({ ok: true, id: newId, origin_plant_id: parentId,
        notice: `新个体 #${newId} 已建档，身份来源记录为母株 #${parentId}（${parent.display_name}）；二者独立计数。` });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return fail(res, 409, 'plant_code_exists');
      throw e;
    }
  });

  // 移盆 / 只换位置
  r.post('/admin/plants/:id/repot', (req, res) => {
    const id = +req.params.id;
    if (!db.prepare('SELECT id FROM plants WHERE id=?').get(id)) return fail(res, 404, 'not_found');
    const { pot_id = null, location_id, note = '', event_date } = req.body || {};
    const d = event_date || new Date().toISOString().slice(0, 10);
    if (!validDate(d)) return fail(res, 400, 'bad_date');
    if (pot_id && !db.prepare('SELECT id FROM pots WHERE id=?').get(pot_id)) return fail(res, 400, 'bad_pot');
    const locId = location_id ?? curLoc(db, id);
    db.transaction(() => closeAndOpen(db, id, { pot_id, location_id: locId, reason: 'repot', on: d, note }))();
    res.json({ ok: true, notice: '移盆记录已追加；该日期之前的观察仍指向旧盆。' });
  });

  r.post('/admin/plants/:id/move', (req, res) => {
    const id = +req.params.id;
    if (!db.prepare('SELECT id FROM plants WHERE id=?').get(id)) return fail(res, 404, 'not_found');
    const { location_id, note = '', event_date } = req.body || {};
    if (!location_id || !db.prepare('SELECT id FROM locations WHERE id=?').get(location_id)) return fail(res, 400, 'bad_location');
    const d = event_date || new Date().toISOString().slice(0, 10);
    if (!validDate(d)) return fail(res, 400, 'bad_date');
    db.transaction(() => closeAndOpen(db, id, { pot_id: curPot(db, id), location_id, reason: 'move_only', on: d, note }))();
    res.json({ ok: true });
  });

  // 个体档案：身份链 + 栽培时段 + 观察时间线
  r.get('/plants/:id', (req, res) => {
    const id = +req.params.id;
    const p = db.prepare('SELECT * FROM plants WHERE id=?').get(id);
    if (!p) return fail(res, 404, 'not_found');
    const identity = db.prepare('SELECT * FROM plant_identity_events WHERE plant_id=? ORDER BY event_date, id').all(id);
    const periods = db.prepare(`
      SELECT ppp.*, po.code AS pot_code, l.name AS location_name
      FROM plant_pot_periods ppp
      LEFT JOIN pots po ON po.id=ppp.pot_id
      LEFT JOIN locations l ON l.id=ppp.location_id
      WHERE ppp.plant_id=? ORDER BY started_on, id`).all(id);
    const observations = db.prepare(
      'SELECT id,obs_date,season,body,version,revised,published,location_name_snapshot,pot_code_snapshot FROM observations WHERE plant_id=? ORDER BY obs_date,id').all(id);
    const children = db.prepare(`SELECT pi.*, p.code, p.display_name FROM plant_identity_events pi
                                 JOIN plants p ON p.id=pi.plant_id WHERE pi.type='split_from' AND pi.origin_plant_id=?`).all(id);
    res.json({ plant: p, identity, periods, observations, split_children: children });
  });

  return r;
}

// 原子地"关闭旧占用 + 开新时段"。必须作为整体传入外层事务：
// better-sqlite3 的事务可嵌套（SAVEPOINT），但裸 close+insert 会导致外层事务
// 先关闭再插入，从而把新时段也关掉。
function closeAndOpen(db, plantId, { pot_id, location_id, reason, on, note }) {
  db.prepare(`UPDATE plant_pot_periods SET ended_on=?
              WHERE id = (SELECT id FROM plant_pot_periods
                          WHERE plant_id=? AND ended_on IS NULL
                          ORDER BY started_on DESC, id DESC LIMIT 1)`).run(on, plantId);
  return db.prepare(`INSERT INTO plant_pot_periods(plant_id,pot_id,location_id,reason,started_on,note,created_at)
                     VALUES(?,?,?,?,?,?,?)`).run(plantId, pot_id, location_id, reason, on, note || '', nowIso()).lastInsertRowid;
}
function curPot(db, plantId) {
  const r = db.prepare('SELECT pot_id FROM plant_pot_periods WHERE plant_id=? ORDER BY started_on DESC,id DESC LIMIT 1').get(plantId);
  return r ? r.pot_id : null;
}
function curLoc(db, plantId) {
  const r = db.prepare('SELECT location_id FROM plant_pot_periods WHERE plant_id=? ORDER BY started_on DESC,id DESC LIMIT 1').get(plantId);
  return r ? r.location_id : null;
}
