// 数据库层：SQLite schema + 初始化 + 小工具
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = 1;

const SCHEMA = `
-- 站主声明：地区与分季规则（单行）
CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  region TEXT NOT NULL,                       -- 地区名，如"上海"/"悉尼"
  season_rule_kind TEXT NOT NULL,             -- meteorological(气象季节) | solar(节气式固定日) | custom
  season_rules TEXT NOT NULL,                 -- JSON: {spring:[m,d], summer:..., autumn:..., winter:...}
  rule_note TEXT DEFAULT '',                  -- 站主对分季规则的说明
  updated_at TEXT NOT NULL                    -- ISO
);

-- 地区/分季规则变更留痕（规则是站主声明，可订正，历史不静默消失）
CREATE TABLE IF NOT EXISTS settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region TEXT, season_rule_kind TEXT, season_rules TEXT, rule_note TEXT,
  changed_at TEXT NOT NULL
);

-- 环境（摆放位置）。改名/归档只影响今后；旧观察通过快照保留当时环境名
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                         -- 如"南阳台"
  kind TEXT DEFAULT '',                       -- indoor/outdoor/balcony/greenhouse...
  current_condition TEXT DEFAULT '',          -- 当前环境条件（自由文本，如"全日照，西晒"）
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 位置条件的时段记录：环境变化影响今后统计，不改写过去条件
CREATE TABLE IF NOT EXISTS location_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  condition TEXT NOT NULL,
  light TEXT DEFAULT '',
  valid_from TEXT NOT NULL,                   -- 该条件开始生效的当地日期 YYYY-MM-DD
  valid_to TEXT,                              -- NULL = 至今
  created_at TEXT NOT NULL
);

-- 盆器（独立于植物：盆可空置、可换盆）
CREATE TABLE IF NOT EXISTS pots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                  -- 盆器编号，如 P-07
  name TEXT DEFAULT '',
  material TEXT DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 植物个体。同品种多盆 = 多行，绝不合并
CREATE TABLE IF NOT EXISTS plants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                  -- 个体编号，如 PL-002
  display_name TEXT NOT NULL,                 -- 当前名（标签），如"玉露 A"
  cultivar TEXT NOT NULL DEFAULT '',          -- 当前品种名（可被"品种订正"改变）
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'alive',       -- alive | dead | gifted | disposed
  created_at TEXT NOT NULL
);

-- 身份事件：移盆/分株/品种订正都保留身份来源
-- origin_from 指向来源植物 id（分株、合栽拆分时），并保留当时品种名快照
CREATE TABLE IF NOT EXISTS plant_identity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER NOT NULL REFERENCES plants(id),
  type TEXT NOT NULL,                         -- acquired(引种建档) | split_from(分株自) | correction(品种订正) | rename | merge_note
  origin_plant_id INTEGER REFERENCES plants(id),
  cultivar_before TEXT, cultivar_after TEXT,
  note TEXT DEFAULT '',
  event_date TEXT NOT NULL,                   -- 当地日期
  created_at TEXT NOT NULL
);

-- 植物↔盆器 的占用时段（栽培记录核心）
CREATE TABLE IF NOT EXISTS plant_pot_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER NOT NULL REFERENCES plants(id),
  pot_id INTEGER REFERENCES pots(id),         -- NULL = 地栽/无盆
  location_id INTEGER REFERENCES locations(id),
  reason TEXT NOT NULL,                       -- initial | repot(移盆) | split(分株上盆) | move_only(只换位置) | removed
  started_on TEXT NOT NULL,                   -- 生效日（可早于建档日：支持补记）
  ended_on TEXT,                              -- NULL = 正在占用
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

-- 观察事件（追加式，原始观察不可变；订正产生新版本）
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER NOT NULL REFERENCES plants(id),
  obs_date TEXT NOT NULL,                     -- 观察日期（当地日期，非发表时间）
  season TEXT,                                -- 冗余索引：按创建时规则算出；reindex 可重建
  location_id INTEGER,                        -- 观察当时所在位置（快照来源）
  pot_id INTEGER,                             -- 观察当时所在盆（快照来源）
  location_name_snapshot TEXT,                -- 观察当时环境名
  pot_code_snapshot TEXT,                     -- 观察当时盆编号
  plant_name_snapshot TEXT,                   -- 观察当时植物标签
  cultivar_snapshot TEXT,                     -- 观察当时品种
  condition_snapshot TEXT,                    -- 观察当时环境条件（历史不改写）
  body TEXT NOT NULL,                         -- 原始观察正文
  version INTEGER NOT NULL DEFAULT 1,         -- 当前版本号（追加修订后 +1）
  revised INTEGER NOT NULL DEFAULT 0,         -- 是否曾被修订
  published INTEGER NOT NULL DEFAULT 1,       -- 是否公开（可撤回到私有）
  client_op_id TEXT UNIQUE,                   -- 幂等键：跨设备/离线补传去重
  device_id TEXT,
  created_at TEXT NOT NULL,                   -- 发表/录入时间（与 obs_date 区分显示）
  created_by TEXT DEFAULT 'owner'
);

CREATE INDEX IF NOT EXISTS idx_obs_date ON observations(obs_date);
CREATE INDEX IF NOT EXISTS idx_obs_season ON observations(season);
CREATE INDEX IF NOT EXISTS idx_obs_plant ON observations(plant_id);
CREATE INDEX IF NOT EXISTS idx_obs_loc ON observations(location_id);

-- 观察版本：原始观察与事后经验总结分开版本化
-- kind = raw(原始观察) | revision(观察订正) | experience(事后经验总结)
CREATE TABLE IF NOT EXISTS observation_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  editor TEXT DEFAULT 'owner',
  device_id TEXT,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(observation_id, version)
);

-- 照片：说明跟随"当时对象"，存上传时快照标签；最新标签不回写
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER REFERENCES observations(id),
  plant_id INTEGER REFERENCES plants(id),
  stored_name TEXT NOT NULL,
  original_name TEXT,
  content_type TEXT,
  bytes INTEGER,
  caption TEXT DEFAULT '',                     -- 说明（拍时对象快照式描述）
  plant_name_snapshot TEXT,
  cultivar_snapshot TEXT,
  location_name_snapshot TEXT,
  taken_at TEXT,                              -- EXIF DateTimeOriginal（隐私剥离前提取，仅站内用）
  gps_present INTEGER NOT NULL DEFAULT 0,     -- 原片是否含 GPS（已剥离，仅告知站主）
  exif_stripped INTEGER NOT NULL DEFAULT 1,
  client_op_id TEXT,
  created_at TEXT NOT NULL
);

-- 公开文章：整篇覆盖式编辑（与观察的"事件追加"相对），有撤回
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | published | withdrawn
  withdrawn_reason TEXT DEFAULT '',
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  editor TEXT DEFAULT 'owner',
  created_at TEXT NOT NULL,
  UNIQUE(article_id, version)
);

-- 文章引用的观察（博主自己挑选原始素材；经验不自动推广）
CREATE TABLE IF NOT EXISTS article_observations (
  article_id INTEGER NOT NULL REFERENCES articles(id),
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  PRIMARY KEY (article_id, observation_id)
);

-- 离线同步：已应用的客户端操作（幂等去重）
CREATE TABLE IF NOT EXISTS sync_applied_ops (
  client_op_id TEXT PRIMARY KEY,
  device_id TEXT,
  op_type TEXT NOT NULL,
  entity TEXT,
  result_id INTEGER,
  status TEXT NOT NULL DEFAULT 'applied',     -- applied | conflicted
  conflict_reason TEXT,
  applied_at TEXT NOT NULL
);

-- 冲突待决队列
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_op_id TEXT,
  device_id TEXT,
  op_type TEXT,
  entity TEXT,
  payload TEXT NOT NULL,                       -- 原始操作 JSON
  reason TEXT NOT NULL,                        -- duplicate_unknown | stale_version | constraint
  server_state TEXT,                           -- 服务端当前状态 JSON
  resolution TEXT DEFAULT 'pending',          -- pending | accepted | rejected
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
`;

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'gardenlog.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureMeta(db);
  if (!db.prepare('SELECT id FROM site_settings WHERE id=1').get()) {
    const now = new Date().toISOString();
    // 默认：北半球气象季节（3/1春、6/1夏、9/1秋、12/1冬）。站主可随时声明订正。
    const rules = JSON.stringify({
      spring: [3, 1], summer: [6, 1], autumn: [9, 1], winter: [12, 1],
      hemisphere: 'north', kind: 'meteorological'
    });
    db.prepare(`INSERT INTO site_settings(id, region, season_rule_kind, season_rules, rule_note, updated_at)
                VALUES (1, ?, 'meteorological', ?, ?, ?)`)
      .run('未设置地区（默认北半球气象季节）', rules, '默认规则，请站主按实际地区声明', now);
  }
  return db;
}

function ensureMeta(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)`);
  const v = db.prepare(`SELECT value FROM metadata WHERE key='schema_version'`).get();
  if (!v) db.prepare(`INSERT INTO metadata(key,value) VALUES('schema_version', ?)`).run(String(SCHEMA_VERSION));
}

// ---------- 季节判定 ----------
// 规则由站主声明；绝不只凭月份对所有地区套同一季节。
// rules: {spring:[m,d], summer:..., autumn:..., winter:...}
export function seasonOf(dateStr, rules) {
  if (!dateStr || !rules) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  const t = new Date(y, m - 1, d).getTime();
  const names = ['spring', 'summer', 'autumn', 'winter'];
  const marks = names.map((name) => ({
    name,
    ts: new Date(y, rules[name][0] - 1, rules[name][1]).getTime()
  })).sort((a, b) => a.ts - b.ts);
  // 年内起点最晚的季节负责"跨年段"（北半球规则是冬季12月，南半球规则也是冬季6月）。
  const last = marks[marks.length - 1];
  if (t < marks[0].ts) return last.name;
  let cur = last.name;
  for (const mk of marks) if (t >= mk.ts) cur = mk.name;
  return cur;
}


// 历史快照解析：观察日期当时，植物在哪盆、哪环境
export function resolvePlacement(db, plantId, onDate) {
  return db.prepare(`
    SELECT ppp.*, l.name AS location_name, l.current_condition,
           lp.condition AS period_condition, lp.light,
           po.code AS pot_code
    FROM plant_pot_periods ppp
    LEFT JOIN locations l ON l.id = ppp.location_id
    LEFT JOIN pots po ON po.id = ppp.pot_id
    LEFT JOIN location_periods lp ON lp.location_id = ppp.location_id
      AND lp.valid_from <= ? AND (lp.valid_to IS NULL OR lp.valid_to > ?)
    WHERE ppp.plant_id = ? AND ppp.started_on <= ?
      AND (ppp.ended_on IS NULL OR ppp.ended_on > ?)
    ORDER BY ppp.started_on DESC, ppp.id DESC LIMIT 1
  `).get(onDate, onDate, plantId, onDate, onDate);
}

export function getSettings(db) {
  return db.prepare('SELECT * FROM site_settings WHERE id=1').get();
}

export function nowIso() { return new Date().toISOString(); }
