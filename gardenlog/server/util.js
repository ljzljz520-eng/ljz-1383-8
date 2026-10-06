import crypto from 'node:crypto';
import { getSettings, seasonOf, resolvePlacement, nowIso } from './db.js';

export function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN || 'devtoken';
  const got = req.get('x-admin-token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!got || token.length !== got.length ||
      !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

export const json = (req, res) => req.body || {};

export function fail(res, code, msg, extra = {}) {
  return res.status(code).json({ error: msg, ...extra });
}

export const dateRe = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(s) {
  if (typeof s !== 'string' || !dateRe.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function currentSeason(db, dateStr) {
  const st = getSettings(db);
  let rules;
  try { rules = JSON.parse(st.season_rules); } catch { rules = null; }
  if (!rules) return null;
  return seasonOf(dateStr, rules);
}

// 构建观察日期当时的对象快照（标签跟随当时对象，不被最新标签覆盖）
export function buildObsSnapshots(db, plantId, obsDate) {
  const plant = db.prepare('SELECT * FROM plants WHERE id=?').get(plantId);
  const placement = resolvePlacement(db, plantId, obsDate);
  return {
    plant,
    placement,
    snap: {
      plant_id: plantId,
      location_id: placement ? placement.location_id : null,
      pot_id: placement ? placement.pot_id : null,
      location_name_snapshot: placement ? placement.location_name : null,
      pot_code_snapshot: placement ? placement.pot_code : null,
      plant_name_snapshot: plant ? plant.display_name : null,
      cultivar_snapshot: plant ? plant.cultivar : null,
      condition_snapshot: placement ? (placement.period_condition || placement.current_condition || '') : ''
    }
  };
}

export function idempotent(db, clientOpId) {
  if (!clientOpId) return null;
  return db.prepare('SELECT * FROM sync_applied_ops WHERE client_op_id=?').get(clientOpId);
}

export function markApplied(db, { client_op_id, device_id, op_type, entity, result_id, status = 'applied', conflict_reason = null }) {
  db.prepare(`INSERT OR IGNORE INTO sync_applied_ops
    (client_op_id, device_id, op_type, entity, result_id, status, conflict_reason, applied_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(client_op_id, device_id || null, op_type, entity || null, result_id || null, status, conflict_reason, nowIso());
}

export function logConflict(db, { client_op_id, device_id, op_type, entity, payload, reason, server_state }) {
  return db.prepare(`INSERT INTO sync_conflicts
    (client_op_id, device_id, op_type, entity, payload, reason, server_state, created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(client_op_id || null, device_id || null, op_type || null, entity || null,
         JSON.stringify(payload || {}), reason, JSON.stringify(server_state || {}), nowIso()).lastInsertRowid;
}

export function newClientOpId() {
  return crypto.randomUUID();
}
export { nowIso };
