// 跨设备离线补记：客户端把离线期间的操作按序 POST 到这里。
// - 幂等：client_op_id 已应用则直接回放结果，换机/重复提交不会产生重复观察
// - 冲突：乐观锁版本不符 / 约束失败 → 进冲突队列，不静默丢弃
// - 观察事件追加式、文章整篇覆盖式在这里同样成立
import { Router } from 'express';
import { nowIso, getSettings } from '../db.js';
import { fail, validDate, currentSeason, buildObsSnapshots, markApplied, logConflict } from '../util.js';

export default function syncRouter(db, obsApi) {
  const r = Router();

  r.get('/admin/sync/state', (req, res) => {
    res.json({
      applied: db.prepare('SELECT client_op_id, op_type, entity, result_id, status, applied_at FROM sync_applied_ops ORDER BY applied_at DESC LIMIT 200').all(),
      conflicts: db.prepare('SELECT * FROM sync_conflicts ORDER BY id DESC LIMIT 100').all(),
      server_time: nowIso()
    });
  });

  r.post('/admin/sync/conflicts/:id/resolve', (req, res) => {
    const id = +req.params.id;
    const c = db.prepare('SELECT * FROM sync_conflicts WHERE id=?').get(id);
    if (!c) return fail(res, 404, 'not_found');
    const { resolution, patched_payload } = req.body || {};
    if (!['accepted', 'rejected'].includes(resolution)) return fail(res, 400, 'resolution_invalid');
    const now = nowIso();
    db.transaction(() => {
      if (resolution === 'accepted' && patched_payload) {
        const result = replayOne(patched_payload, req.query.device_id || c.device_id, { force: true });
        db.prepare('UPDATE sync_conflicts SET resolution=?, resolved_at=? WHERE id=?').run('accepted', now, id);
        return result;
      }
      db.prepare('UPDATE sync_conflicts SET resolution=?, resolved_at=? WHERE id=?').run(resolution, now, id);
    })();
    res.json({ ok: true });
  });

  // 批量同步
  r.post('/admin/sync', (req, res) => {
    const { ops = [], device_id } = req.body || {};
    if (!Array.isArray(ops)) return fail(res, 400, 'ops_array_required');
    const results = [];
    const refMap = {}; // local_ref -> server id（同一批次内引用解析）

    for (const op of ops) {
      const opId = op.client_op_id;
      if (opId) {
        const seen = db.prepare('SELECT * FROM sync_applied_ops WHERE client_op_id=?').get(opId);
        if (seen) {
          results.push({ client_op_id: opId, ok: true, duplicate: true, id: seen.result_id, status: seen.status });
          if (op.local_ref) refMap[op.local_ref] = seen.result_id;
          continue;
        }
      }
      let result;
      try {
        result = db.transaction((o) => replayOne(o, device_id, { refMap }))(op);
      } catch (e) {
        const cid = logConflict(db, {
          client_op_id: opId, device_id, op_type: op.type, entity: op.entity,
          payload: op.payload, reason: /UNIQUE/.test(e.message) ? 'constraint' : 'error: ' + e.message,
          server_state: null
        });
        if (opId) markApplied(db, { client_op_id: opId, device_id, op_type: op.type, entity: op.entity, status: 'conflicted', conflict_reason: 'queued' });
        results.push({ client_op_id: opId, ok: false, conflict_id: cid, reason: 'conflict_queued' });
        continue;
      }
      if (result.conflict) {
        results.push({ client_op_id: opId, ok: false, conflict_id: result.conflict_id, reason: result.reason, server_state: result.server_state });
      } else {
        if (op.local_ref && result.id) refMap[op.local_ref] = result.id;
        results.push({ client_op_id: opId, ok: true, id: result.id, local_ref: op.local_ref || null });
      }
    }
    res.json({ ok: true, device_id, results, server_time: nowIso() });
  });

  function replayOne(op, deviceId, ctx = {}) {
    const payload = op.payload || {};
    const opId = op.client_op_id;
    const mark = (type, entity, resultId, status = 'applied', reason = null) => {
      if (opId && !ctx.force) markApplied(db, { client_op_id: opId, device_id: deviceId, op_type: type, entity, result_id: resultId, status, conflict_reason: reason });
    };
    const needDate = (d) => { if (!validDate(d)) throw new Error('bad_date'); };

    switch (op.type) {
      case 'obs.create': {
        if (payload.plant_id_ref && ctx.refMap && ctx.refMap[payload.plant_id_ref]) {
          payload.plant_id = ctx.refMap[payload.plant_id_ref];
        }
        const out = obsApi.createObs({ ...payload, client_op_id: ctx.force ? undefined : opId, device_id: deviceId });
        if (out.error) throw new Error(out.reason);
        if (out.duplicate) return { id: out.id };
        return { id: out.id };
      }
      case 'obs.revise': {
        const oid = payload.observation_id;
        const o = db.prepare('SELECT * FROM observations WHERE id=?').get(oid);
        if (!o) throw new Error('not_found');
        if (!ctx.force && payload.base_version != null && Number(payload.base_version) !== o.version) {
          const cid = logConflict(db, {
            client_op_id: opId, device_id: deviceId, op_type: op.type, entity: 'observation',
            payload, reason: 'stale_version', server_state: { id: oid, version: o.version }
          });
          mark('obs.revise', 'observation', null, 'conflicted', 'stale_version');
          return { conflict: true, conflict_id: cid, reason: 'stale_version', server_state: { version: o.version } };
        }
        const kind = ['revision', 'experience'].includes(payload.kind) ? payload.kind : 'revision';
        const nv = o.version + 1;
        db.prepare(`INSERT INTO observation_versions(observation_id,version,kind,body,device_id,note,created_at)
                    VALUES(?,?,?,?,?,?,?)`).run(oid, nv, kind, payload.body, deviceId || null, payload.note || '', nowIso());
        db.prepare('UPDATE observations SET version=?, revised=1 WHERE id=?').run(nv, oid);
        mark('obs.revise', 'observation', oid);
        return { id: oid, version: nv };
      }
      case 'obs.withdraw':
      case 'obs.publish': {
        const oid = payload.observation_id;
        db.prepare('UPDATE observations SET published=? WHERE id=?').run(op.type === 'obs.publish' ? 1 : 0, oid);
        mark(op.type, 'observation', oid);
        return { id: oid };
      }
      case 'plant.create': {
        const now = nowIso(); const d = payload.started_on || new Date().toISOString().slice(0, 10); needDate(d);
        const pid = db.transaction(() => {
          const id = db.prepare(`INSERT INTO plants(code,display_name,cultivar,note,created_at) VALUES(?,?,?,?,?)`)
            .run(payload.code, payload.display_name, payload.cultivar || '', payload.note || '', now).lastInsertRowid;
          db.prepare(`INSERT INTO plant_identity_events(plant_id,type,cultivar_before,cultivar_after,note,event_date,created_at)
                      VALUES(?,?,?,?,?,?,?)`).run(id, 'acquired', null, payload.cultivar || '', '建档(离线补传)', d, now);
          db.prepare(`INSERT INTO plant_pot_periods(plant_id,pot_id,location_id,reason,started_on,note,created_at)
                      VALUES(?,?,?,?,?,?,?)`).run(id, payload.pot_id || null, payload.location_id || null, 'initial', d, '', now);
          return id;
        })();
        mark('plant.create', 'plant', pid);
        return { id: pid };
      }
      case 'plant.repot':
      case 'plant.move': {
        const d = payload.event_date || new Date().toISOString().slice(0, 10); needDate(d);
        const pid = payload.plant_id;
        const cur = db.prepare('SELECT pot_id,location_id FROM plant_pot_periods WHERE plant_id=? AND ended_on IS NULL ORDER BY started_on DESC,id DESC LIMIT 1').get(pid)
          || { pot_id: null, location_id: null };
        const potId = op.type === 'plant.repot' ? (payload.pot_id ?? null) : cur.pot_id;
        const locId = payload.location_id ?? cur.location_id;
        db.transaction(() => {
          db.prepare(`UPDATE plant_pot_periods SET ended_on=? WHERE id=(SELECT id FROM plant_pot_periods WHERE plant_id=? AND ended_on IS NULL ORDER BY started_on DESC,id DESC LIMIT 1)`).run(d, pid);
          db.prepare(`INSERT INTO plant_pot_periods(plant_id,pot_id,location_id,reason,started_on,note,created_at)
                      VALUES(?,?,?,?,?,?,?)`).run(pid, potId, locId, op.type === 'plant.repot' ? 'repot' : 'move_only', d, payload.note || '', nowIso());
        })();
        mark(op.type, 'plant', pid);
        return { id: pid };
      }
      case 'plant.correct': {
        const p = db.prepare('SELECT * FROM plants WHERE id=?').get(payload.plant_id);
        if (!p) throw new Error('not_found');
        const d = payload.event_date || new Date().toISOString().slice(0, 10); needDate(d);
        db.transaction(() => {
          db.prepare(`INSERT INTO plant_identity_events(plant_id,type,origin_plant_id,cultivar_before,cultivar_after,note,event_date,created_at)
                      VALUES(?,?,?,?,?,?,?,?)`)
            .run(p.id, 'correction', p.id, p.cultivar, payload.cultivar_new, payload.note || '', d, nowIso());
          db.prepare('UPDATE plants SET cultivar=? WHERE id=?').run(payload.cultivar_new, p.id);
        });
        mark('plant.correct', 'plant', p.id);
        return { id: p.id };
      }
      case 'plant.split': {
        const parent = db.prepare('SELECT * FROM plants WHERE id=?').get(payload.plant_id);
        if (!parent) throw new Error('not_found');
        const d = payload.event_date || new Date().toISOString().slice(0, 10); needDate(d);
        const now = nowIso();
        const nid = db.transaction(() => {
          const id = db.prepare(`INSERT INTO plants(code,display_name,cultivar,note,created_at) VALUES(?,?,?,?,?)`)
            .run(payload.new_code, payload.new_name, payload.cultivar ?? parent.cultivar, '分株自 ' + parent.code, now).lastInsertRowid;
          db.prepare(`INSERT INTO plant_identity_events(plant_id,type,origin_plant_id,cultivar_before,cultivar_after,note,event_date,created_at)
                      VALUES(?,?,?,?,?,?,?,?)`)
            .run(id, 'split_from', parent.id, parent.cultivar, payload.cultivar ?? parent.cultivar, payload.note || '', d, now);
          db.prepare(`INSERT INTO plant_pot_periods(plant_id,pot_id,location_id,reason,started_on,note,created_at)
                      VALUES(?,?,?,?,?,?,?)`).run(id, payload.pot_id || null, payload.location_id || null, 'split', d, '分株上盆(离线补传)', now);
          return id;
        })();
        mark('plant.split', 'plant', nid);
        return { id: nid };
      }
      case 'location.create': {
        const now = nowIso();
        const d = payload.valid_from || new Date().toISOString().slice(0, 10); needDate(d);
        const lid = db.transaction(() => {
          const id = db.prepare(`INSERT INTO locations(name,kind,current_condition,created_at) VALUES(?,?,?,?)`)
            .run(payload.name, payload.kind || '', payload.condition || '', now).lastInsertRowid;
          db.prepare(`INSERT INTO location_periods(location_id,condition,light,valid_from,created_at) VALUES(?,?,?,?,?)`)
            .run(id, payload.condition || '', payload.light || '', d, now);
          return id;
        })();
        mark('location.create', 'location', lid);
        return { id: lid };
      }
      case 'location.condition': {
        const d = payload.valid_from || new Date().toISOString().slice(0, 10); needDate(d);
        db.transaction(() => {
          db.prepare(`UPDATE location_periods SET valid_to=? WHERE location_id=? AND valid_to IS NULL AND valid_from < ?`).run(d, payload.location_id, d);
          db.prepare(`INSERT INTO location_periods(location_id,condition,light,valid_from,created_at) VALUES(?,?,?,?,?)`)
            .run(payload.location_id, payload.condition || '', payload.light || '', d, nowIso());
          db.prepare('UPDATE locations SET current_condition=? WHERE id=?').run(payload.condition || '', payload.location_id);
        });
        mark('location.condition', 'location', payload.location_id);
        return { id: payload.location_id };
      }
      case 'article.upsert': {
        // 整篇覆盖式（草稿期新建也走这里）
        const now = nowIso();
        if (payload.article_id) {
          const a = db.prepare('SELECT * FROM articles WHERE id=?').get(payload.article_id);
          if (!a) throw new Error('not_found');
          const nv = a.version + 1;
          db.transaction(() => {
            db.prepare('UPDATE articles SET title=?,body=?,version=?,updated_at=? WHERE id=?').run(payload.title, payload.body, nv, now, a.id);
            db.prepare('INSERT INTO article_versions(article_id,version,title,body,editor,created_at) VALUES(?,?,?,?,?,?)').run(a.id, nv, payload.title, payload.body, deviceId || 'owner', now);
          })();
          mark('article.upsert', 'article', a.id);
          return { id: a.id, version: nv };
        }
        const aid = db.transaction(() => {
          const id = db.prepare(`INSERT INTO articles(slug,title,body,version,status,created_at,updated_at) VALUES(?,?,?,?, 'draft', ?,?)`)
            .run(payload.slug || null, payload.title, payload.body, 1, now, now).lastInsertRowid;
          db.prepare('INSERT INTO article_versions(article_id,version,title,body,editor,created_at) VALUES(?,?,?,?,?,?)').run(id, 1, payload.title, payload.body, deviceId || 'owner', now);
          return id;
        })();
        mark('article.upsert', 'article', aid);
        return { id: aid, version: 1 };
      }
      case 'article.publish':
      case 'article.withdraw': {
        const a = db.prepare('SELECT * FROM articles WHERE id=?').get(payload.article_id);
        if (!a) throw new Error('not_found');
        if (op.type === 'article.publish') {
          db.prepare("UPDATE articles SET status='published', published_at=COALESCE(published_at,?), updated_at=? WHERE id=?").run(nowIso(), nowIso(), a.id);
        } else {
          db.prepare("UPDATE articles SET status='withdrawn', withdrawn_reason=?, updated_at=? WHERE id=?").run(payload.reason || '站主撤回', nowIso(), a.id);
        }
        mark(op.type, 'article', a.id);
        return { id: a.id };
      }
      default:
        throw new Error('unknown_op:' + op.type);
    }
  }

  return r;
}
