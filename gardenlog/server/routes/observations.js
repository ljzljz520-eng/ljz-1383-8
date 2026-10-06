// 观察事件（追加式）、照片（快照式说明 + 隐私剥离）、统计
import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { nowIso } from '../db.js';
import { fail, validDate, currentSeason, buildObsSnapshots, idempotent, markApplied, logConflict } from '../util.js';
import { sanitizeImage } from '../exif.js';

const MEMORY = { storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } };

export default function observationRouter(db, dataDir) {
  const r = Router();
  const uploadDir = path.join(dataDir, 'photos');
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer(MEMORY);

  // 可复用于同步的核心：创建观察（幂等）
  function createObs(payload, { fromSync = false } = {}) {
    const { plant_id, obs_date, body, published = 1, client_op_id, device_id } = payload;
    if (!plant_id || !db.prepare('SELECT id FROM plants WHERE id=?').get(plant_id)) {
      return { error: 400, reason: 'bad_plant' };
    }
    if (!validDate(obs_date)) return { error: 400, reason: 'bad_obs_date' };
    if (!body || !String(body).trim()) return { error: 400, reason: 'body_required' };

    if (client_op_id) {
      const seen = idempotent(db, client_op_id);
      if (seen) return { duplicate: true, id: seen.result_id, status: seen.status };
    }
    const { snap } = buildObsSnapshots(db, plant_id, obs_date);
    const season = currentSeason(db, obs_date);
    const now = nowIso();
    const id = db.transaction(() => {
      const oid = db.prepare(`INSERT INTO observations
        (plant_id, obs_date, season, location_id, pot_id, location_name_snapshot, pot_code_snapshot,
         plant_name_snapshot, cultivar_snapshot, condition_snapshot, body, client_op_id, device_id, created_at, published)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          plant_id, obs_date, season, snap.location_id, snap.pot_id, snap.location_name_snapshot,
          snap.pot_code_snapshot, snap.plant_name_snapshot, snap.cultivar_snapshot, snap.condition_snapshot,
          body, client_op_id || null, device_id || null, now, published ? 1 : 0).lastInsertRowid;
      db.prepare(`INSERT INTO observation_versions(observation_id,version,kind,body,editor,device_id,note,created_at)
                  VALUES(?,1,'raw',?,'owner',?, '原始观察', ?)`).run(oid, body, device_id || null, now);
      if (client_op_id) markApplied(db, { client_op_id, device_id, op_type: 'obs.create', entity: 'observation', result_id: oid });
      return oid;
    })();
    return { id, season, snapshots: snap, created_at: now };
  }

  // ---------- 录入 ----------
  r.post('/admin/observations', (req, res) => {
    const out = createObs(req.body || {});
    if (out.error) return fail(res, out.error, out.reason);
    if (out.duplicate) return res.status(200).json({ ok: true, id: out.id, duplicate: true });
    res.status(201).json({ ok: true, id: out.id, season: out.season, snapshots: out.snapshots });
  });

  // 同一天多次观察：无限制，按 obs_date + created_at 并存
  r.get('/observations', (req, res) => {
    const admin = req.admin === true;
    const { plant_id, season, location_id, from, to, q } = req.query;
    const where = [];
    const args = [];
    if (!admin) where.push('published=1');
    if (plant_id) { where.push('plant_id=?'); args.push(+plant_id); }
    if (season) { where.push('season=?'); args.push(String(season)); }
    if (location_id) { where.push('location_id=?'); args.push(+location_id); }
    if (from) { where.push('obs_date>=?'); args.push(from); }
    if (to) { where.push('obs_date<=?'); args.push(to); }
    if (q) { where.push('(body LIKE ? OR plant_name_snapshot LIKE ? OR cultivar_snapshot LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const sql = `SELECT id,plant_id,obs_date,season,body,version,revised,published,created_at,
                 location_name_snapshot,pot_code_snapshot,plant_name_snapshot,cultivar_snapshot,condition_snapshot
                 FROM observations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY obs_date DESC, id DESC LIMIT 500`;
    const rows = db.prepare(sql).all(...args);
    const withPhotoCount = rows.map((o) => ({
      ...o,
      photo_count: db.prepare('SELECT COUNT(*) c FROM photos WHERE observation_id=?').get(o.id).c
    }));
    res.json(withPhotoCount);
  });

  function fetchObs(id, admin) {
    const o = db.prepare('SELECT * FROM observations WHERE id=?').get(id);
    if (!o) return null;
    if (!admin && !o.published) return { forbidden: true };
    const photos = db.prepare('SELECT * FROM photos WHERE observation_id=? ORDER BY id').all(id);
    let versions = db.prepare('SELECT * FROM observation_versions WHERE observation_id=? ORDER BY version').all(id);
    if (!admin) versions = versions.filter((v) => v.kind !== 'experience'); // 经验总结：个人记录，公开侧默认不展示
    const current = [...versions].reverse().find((v) => v.kind !== 'experience') || versions[0];
    return { ...o, photos, versions, current_text: current ? current.body : o.body };
  }

  r.get('/observations/:id', (req, res) => {
    const o = fetchObs(+req.params.id, req.admin === true);
    if (!o) return fail(res, 404, 'not_found');
    if (o.forbidden) return fail(res, 403, 'not_public');
    res.json(o);
  });

  // 事后修订（保留原始观察，追加新版本；可选乐观锁 base_version）
  r.post('/admin/observations/:id/revisions', (req, res) => {
    const id = +req.params.id;
    const o = db.prepare('SELECT * FROM observations WHERE id=?').get(id);
    if (!o) return fail(res, 404, 'not_found');
    const { body, kind = 'revision', note = '', base_version, device_id } = req.body || {};
    if (!['revision', 'experience'].includes(kind)) return fail(res, 400, 'kind_invalid');
    if (!body || !String(body).trim()) return fail(res, 400, 'body_required');
    if (base_version != null && Number(base_version) !== o.version) {
      const cid = logConflict(db, {
        client_op_id: req.body.client_op_id, device_id, op_type: 'obs.revise', entity: 'observation',
        payload: req.body, reason: 'stale_version',
        server_state: { id, version: o.version }
      });
      return fail(res, 409, 'stale_version', { server_version: o.version, conflict_id: cid });
    }
    const now = nowIso();
    const v = db.transaction(() => {
      const nv = o.version + 1;
      db.prepare(`INSERT INTO observation_versions(observation_id,version,kind,body,device_id,note,created_at)
                  VALUES(?,?,?,?,?,?,?)`).run(id, nv, kind, body, device_id || null, note, now);
      if (kind === 'revision') {
        db.prepare('UPDATE observations SET version=?, revised=1 WHERE id=?').run(nv, id);
      } else {
        db.prepare('UPDATE observations SET version=? WHERE id=?').run(nv, id);
      }
      return nv;
    })();
    res.json({ ok: true, version: v,
      notice: kind === 'experience' ? '经验总结已作为个人记录单独追加，不会自动成为其他植物的养护指令。' : '修订已追加；原始观察(v1)保留不变。' });
  });

  // 公开撤回 / 重新发布
  r.post('/admin/observations/:id/withdraw', (req, res) => {
    const id = +req.params.id;
    const o = db.prepare('SELECT * FROM observations WHERE id=?').get(id);
    if (!o) return fail(res, 404, 'not_found');
    db.prepare('UPDATE observations SET published=0 WHERE id=?').run(id);
    res.json({ ok: true, notice: '已从公开侧撤回，管理端仍可见可恢复。' });
  });
  r.post('/admin/observations/:id/publish', (req, res) => {
    const id = +req.params.id;
    if (!db.prepare('SELECT id FROM observations WHERE id=?').get(id)) return fail(res, 404, 'not_found');
    db.prepare('UPDATE observations SET published=1 WHERE id=?').run(id);
    res.json({ ok: true });
  });

  // ---------- 照片 ----------
  // 上传：multipart，服务端剥离 EXIF 后落盘；说明与标签使用"当时对象"快照
  r.post('/admin/photos', upload.array('photos', 10), (req, res) => {
    const observationId = req.body.observation_id ? +req.body.observation_id : null;
    const o = observationId && db.prepare('SELECT * FROM observations WHERE id=?').get(observationId);
    if (!o) return fail(res, 400, 'observation_required');
    const files = req.files || [];
    if (!files.length) return fail(res, 400, 'no_files');
    const caption = req.body.caption || '';
    const saved = [];
    const now = nowIso();
    for (const f of files) {
      const san = sanitizeImage(f.buffer, f.mimetype);
      const ext = (f.mimetype === 'image/png') ? '.png' : '.jpg';
      const fname = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(uploadDir, fname), san.out);
      const id = db.prepare(`INSERT INTO photos
        (observation_id, plant_id, stored_name, original_name, content_type, bytes, caption,
         plant_name_snapshot, cultivar_snapshot, location_name_snapshot, taken_at, gps_present, exif_stripped, client_op_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          o.id, o.plant_id, fname, f.originalname, f.mimetype, san.out.length, caption,
          o.plant_name_snapshot, o.cultivar_snapshot, o.location_name_snapshot,
          san.takenAt, san.gpsPresent ? 1 : 0, 1, req.body.client_op_id || null, now).lastInsertRowid;
      saved.push({ id, stored_name: fname, gps_was_present: !!san.gpsPresent, exif_stripped: true, taken_at: san.takenAt });
    }
    res.status(201).json({ ok: true, photos: saved,
      notice: '照片已剥离 EXIF 后保存；说明与对象标签为上传时快照，之后改名不会回写。' });
  });

  // 受控读取：公开侧只能读取已发表观察的照片；绝不直接暴露原始上传
  r.get('/photos/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM photos WHERE id=?').get(+req.params.id);
    if (!p) return fail(res, 404, 'not_found');
    const o = db.prepare('SELECT published FROM observations WHERE id=?').get(p.observation_id);
    if (!o || (!o.published && req.admin !== true)) return fail(res, 403, 'not_public');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(path.join(uploadDir, p.stored_name));
  });

  r.get('/photos/:id/meta', (req, res) => {
    const p = db.prepare('SELECT id,observation_id,plant_id,original_name,content_type,bytes,caption,plant_name_snapshot,cultivar_snapshot,location_name_snapshot,taken_at,gps_present,exif_stripped,created_at FROM photos WHERE id=?').get(+req.params.id);
    if (!p) return fail(res, 404, 'not_found');
    res.json(p);
  });

  // 只改说明文本；快照标签依然不跟随最新名称
  r.patch('/admin/photos/:id', (req, res) => {
    const { caption } = req.body || {};
    if (caption === undefined) return fail(res, 400, 'caption_required');
    db.prepare('UPDATE photos SET caption=? WHERE id=?').run(String(caption), +req.params.id);
    res.json({ ok: true });
  });

  // ---------- 统计：按观察时快照聚合，环境变化不改写过去 ----------
  r.get('/stats/overview', (req, res) => {
    const admin = req.admin === true;
    const pub = admin ? '' : 'WHERE published=1';
    const bySeason = db.prepare(
      `SELECT season, COUNT(*) n FROM observations ${pub} GROUP BY season`).all();
    const byLocation = db.prepare(
      `SELECT COALESCE(location_name_snapshot,'(未定位)') location, COALESCE(condition_snapshot,'') condition, COUNT(*) n
       FROM observations ${pub} GROUP BY location_name_snapshot, condition_snapshot ORDER BY n DESC`).all();
    const byPlant = db.prepare(
      `SELECT p.id, p.code, p.display_name, p.cultivar, COUNT(o.id) n
       FROM plants p LEFT JOIN observations o ON o.plant_id=p.id ${admin ? '' : 'AND o.published=1'}
       GROUP BY p.id ORDER BY p.id`).all();
    res.json({ by_season: bySeason, by_location_condition: byLocation, by_plant: byPlant,
      note: '统计来自每条观察当时的季节/环境快照；环境订正只影响今后观察。' });
  });

  r.createObs = createObs;
  return r;
}
