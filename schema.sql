-- Gardener's journal: domain schema.
-- Key identity rules:
--   * plant_individuals are the living subjects; pots/positions are separate tables.
--   * Same cultivar in two pots => two plant individuals, never merged.
--   * identity_events is an append-only provenance ledger (repot / move / divide / correct_name / acquire).
--   * observations are append-only raw field notes (amendments are appended, never overwritten).
--   * photos freeze subject name + caption at capture time; later renames do not overwrite them.
--   * articles and experiences are whole-document, versioned (optimistic concurrency).
--   * observation_index is a derived filter table; rebuildable at any time.

CREATE TABLE IF NOT EXISTS site_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO site_config(key, value) VALUES
  ('admin_token', 'devtoken'),
  ('active_region_id', '1');

CREATE TABLE IF NOT EXISTS regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,           -- e.g. kunming, harbin
  name TEXT NOT NULL,                 -- human label: 昆明
  climate_note TEXT NOT NULL DEFAULT ''
);

-- A region may have several rule versions, but only one active at a time.
-- Intervals use day-of-year computed in a leap year (2000) so Feb 29 works.
CREATE TABLE IF NOT EXISTS season_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id INTEGER NOT NULL REFERENCES regions(id),
  label TEXT NOT NULL,                -- e.g. 昆明温和四季
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- season boundaries: start_doy inclusive per season; engine sorts and wraps year end
  spring_doy INTEGER NOT NULL,
  summer_doy INTEGER NOT NULL,
  autumn_doy INTEGER NOT NULL,
  winter_doy INTEGER NOT NULL DEFAULT 60,  -- winter usually crosses new year
  CHECK (spring_doy BETWEEN 1 AND 366
     AND summer_doy BETWEEN 1 AND 366
     AND autumn_doy BETWEEN 1 AND 366
     AND winter_doy BETWEEN 1 AND 366)
);

CREATE TABLE IF NOT EXISTS environments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                -- 南阳台 / 北窗台 / 露台
  kind TEXT NOT NULL DEFAULT 'indoor', -- indoor | outdoor | greenhouse
  light TEXT NOT NULL DEFAULT '',      -- 全日照 / 散射光 ...
  active_from TEXT NOT NULL,          -- ISO date when this environment started being used
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,         -- human code, e.g. P-007
  material TEXT NOT NULL DEFAULT '',  -- 红陶 / 塑料 / 紫砂
  diameter_cm REAL,
  created_at TEXT NOT NULL
);

-- Where a pot physically sits, over time. Move history is retained.
CREATE TABLE IF NOT EXISTS pot_placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pot_id INTEGER NOT NULL REFERENCES pots(id),
  environment_id INTEGER NOT NULL REFERENCES environments(id),
  position TEXT NOT NULL DEFAULT '',   -- 东侧第二层
  placed_from TEXT NOT NULL,           -- ISO date
  placed_to TEXT                       -- NULL = current
);

CREATE TABLE IF NOT EXISTS plant_individuals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accession TEXT NOT NULL UNIQUE,      -- stable site accession, e.g. G-2026-0001
  current_name TEXT NOT NULL,          -- latest corrected cultivar/species label
  name_locked_from_event_id INTEGER,   -- event that established current_name
  acquired_date TEXT NOT NULL,
  source_note TEXT NOT NULL DEFAULT '',-- 来源: 朋友分享的扦插苗 ...
  -- lineage: division provenance
  origin_event_id INTEGER REFERENCES plant_events(id),
  parent_plant_id INTEGER REFERENCES plant_individuals(id),
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plant_name_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER NOT NULL REFERENCES plant_individuals(id),
  name TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  event_id INTEGER REFERENCES plant_events(id),
  valid_from TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Append-only identity / cultivation event ledger for one living subject.
CREATE TABLE IF NOT EXISTS plant_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER NOT NULL REFERENCES plant_individuals(id),
  event_type TEXT NOT NULL,            -- acquire | repot | move | divide_out | merge_forbidden_enforced | correct_name | note
  event_date TEXT NOT NULL,
  from_pot_id INTEGER REFERENCES pots(id),
  to_pot_id INTEGER REFERENCES pots(id),
  from_environment_id INTEGER REFERENCES environments(id),
  to_environment_id INTEGER REFERENCES environments(id),
  position TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  -- division / correction provenance
  child_plant_id INTEGER REFERENCES plant_individuals(id),
  previous_name TEXT NOT NULL DEFAULT '',
  new_name TEXT NOT NULL DEFAULT '',
  client_uid TEXT,                     -- idempotency key from offline clients
  created_at TEXT NOT NULL,
  UNIQUE(plant_id, event_type, client_uid)
);

-- Raw observations: append-only. Multiple per day per plant allowed.
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER NOT NULL REFERENCES plant_individuals(id),
  observed_at TEXT NOT NULL,          -- ISO datetime, the real field time
  observed_date TEXT NOT NULL,        -- local date part, for grouping
  season TEXT NOT NULL,               -- snapshot under rule in force when recorded
  season_rule_id INTEGER REFERENCES season_rules(id),
  environment_id INTEGER REFERENCES environments(id),
  env_snapshot TEXT NOT NULL DEFAULT '', -- frozen name/kind/light at observation time
  pot_id INTEGER REFERENCES pots(id),
  pot_snapshot TEXT NOT NULL DEFAULT '',
  plant_name_snapshot TEXT NOT NULL,   -- name in force at that time
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',       -- comma separated
  is_public INTEGER NOT NULL DEFAULT 1,
  client_uid TEXT UNIQUE,              -- idempotency key for offline sync
  device_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,            -- 录入/发表时间 (may differ from observed_at when backfilled)
  amended_by_id INTEGER REFERENCES observations(id)
);
CREATE INDEX IF NOT EXISTS idx_obs_date ON observations(observed_date);

-- Structured amendments to a raw observation: appended, never edits the original body.
CREATE TABLE IF NOT EXISTS observation_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  note TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT '',
  client_uid TEXT UNIQUE,
  created_at TEXT NOT NULL
);

-- After-the-fact personal growing experience, independently versioned.
-- Explicitly NOT pushed as universal care instructions to other plants.
CREATE TABLE IF NOT EXISTS experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER REFERENCES plant_individuals(id),
  scope_note TEXT NOT NULL DEFAULT '', -- 适用范围声明, e.g. 仅本人南阳台这一盆
  current_version INTEGER NOT NULL DEFAULT 0,
  is_personal_record INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS experience_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experience_id INTEGER NOT NULL REFERENCES experiences(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  client_uid TEXT UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE(experience_id, version)
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER REFERENCES plant_individuals(id),
  observation_id INTEGER REFERENCES observations(id),
  storage_path TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL,               -- written at upload time, follows that moment
  subject_label TEXT NOT NULL,         -- frozen name of the subject at capture
  taken_at TEXT,                        -- EXIF DateTimeOriginal if present (privacy kept server-side only)
  gps_removed INTEGER NOT NULL DEFAULT 0,
  exif_removed_count INTEGER NOT NULL DEFAULT 0,
  bytes_size INTEGER NOT NULL DEFAULT 0,
  client_uid TEXT UNIQUE,
  device_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS photo_caption_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id INTEGER NOT NULL REFERENCES photos(id),
  old_caption TEXT NOT NULL DEFAULT '',
  new_caption TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Whole-document blog articles with version history; overwrite uses optimistic lock.
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | published | withdrawn
  is_public INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,                   -- first publication (not rewritten on edits/withdraw)
  withdrawn_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS article_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  client_uid TEXT UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE(article_id, version)
);
CREATE TABLE IF NOT EXISTS article_observations (
  article_id INTEGER NOT NULL REFERENCES articles(id),
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  PRIMARY KEY (article_id, observation_id)
);

-- Idempotency / audit log for offline sync batches.
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  client_batch_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  duplicates INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]',
  UNIQUE(device_id, client_batch_id)
);

-- Derived, rebuildable filter index for season/environment browsing.
CREATE TABLE IF NOT EXISTS observation_index (
  observation_id INTEGER PRIMARY KEY REFERENCES observations(id),
  observed_date TEXT NOT NULL,
  season TEXT NOT NULL,
  environment_id INTEGER,
  plant_id INTEGER NOT NULL,
  is_public INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_oi_season ON observation_index(season);
CREATE INDEX IF NOT EXISTS idx_oi_env ON observation_index(environment_id);
CREATE INDEX IF NOT EXISTS idx_oi_date ON observation_index(observed_date);
