"""Domain services: the heart of the identity/versioning rules."""
import json
import os
import uuid
from datetime import datetime, timezone

from .db import get_config, set_config
from .seasons import active_rule, rule_boundaries, season_for_date, parse_date
from . import photos as photo_lib


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_client_uid():
    return uuid.uuid4().hex


# ---------------------------------------------------------------- utilities

def row_to_dict(row):
    return dict(row) if row is not None else None


def _snapshot_environment(conn, env_id, on_date):
    if env_id is None:
        return "", None
    e = conn.execute("SELECT * FROM environments WHERE id=?", (env_id,)).fetchone()
    if not e:
        return "", None
    return f"{e['name']}({e['kind']},{e['light']})", e


def current_pot_for_plant(conn, plant_id, on_date):
    row = conn.execute(
        """SELECT p.* FROM plant_events e JOIN pots p ON p.id = COALESCE(e.to_pot_id, e.from_pot_id)
           WHERE e.plant_id=? AND e.event_type IN ('acquire','repot') AND e.event_date<=?
           ORDER BY e.event_date DESC, e.id DESC LIMIT 1""",
        (plant_id, on_date),
    ).fetchone()
    return row


def environment_for_pot(conn, pot_id, on_date):
    row = conn.execute(
        """SELECT * FROM pot_placements
           WHERE pot_id=? AND placed_from<=?
           ORDER BY placed_from DESC, id DESC LIMIT 1""",
        (pot_id, on_date),
    ).fetchone()
    return row


def plant_name_as_of(conn, plant_id, on_date):
    """The label valid for a past date. Used so old observations can show what
    the plant was called then, independently of photos (which freeze captions)."""
    row = conn.execute(
        """SELECT name FROM plant_name_history
           WHERE plant_id=? AND valid_from<=?
           ORDER BY valid_from DESC, id DESC LIMIT 1""",
        (plant_id, on_date),
    ).fetchone()
    return row["name"] if row else None


# ---------------------------------------------------------------- plants / pots

def next_accession(conn):
    year = datetime.now().year
    prefix = f"G-{year}-"
    row = conn.execute(
        "SELECT accession FROM plant_individuals WHERE accession LIKE ? ORDER BY accession DESC LIMIT 1",
        (prefix + "%",),
    ).fetchone()
    n = int(row["accession"].rsplit("-", 1)[1]) + 1 if row else 1
    return f"{prefix}{n:04d}"


def create_plant(conn, *, name, acquired_date, source_note="", pot_id=None,
                 environment_id=None, position="", client_uid=None, device_id=""):
    accession = next_accession(conn)
    ts = now_iso()
    cur = conn.execute(
        """INSERT INTO plant_individuals
           (accession, current_name, acquired_date, source_note, created_at)
           VALUES (?,?,?,?,?)""",
        (accession, name, acquired_date, source_note, ts),
    )
    plant_id = cur.lastrowid
    conn.execute(
        """INSERT INTO plant_name_history(plant_id, name, reason, valid_from, created_at)
           VALUES (?,?,?,?,?)""",
        (plant_id, name, "入档定名", acquired_date, ts),
    )
    uid = client_uid or ("acq-" + new_client_uid())
    evcur = conn.execute(
        """INSERT INTO plant_events(plant_id, event_type, event_date, to_pot_id,
              to_environment_id, position, detail, client_uid, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (plant_id, "acquire", acquired_date, pot_id, environment_id, position,
         f"来源: {source_note}", uid, ts),
    )
    conn.execute(
        "UPDATE plant_individuals SET name_locked_from_event_id=? WHERE id=?",
        (evcur.lastrowid, plant_id),
    )
    if pot_id and environment_id:
        conn.execute(
            """INSERT INTO pot_placements(pot_id, environment_id, position, placed_from)
               VALUES (?,?,?,?)""",
            (pot_id, environment_id, position, acquired_date),
        )
    return plant_id, accession


def add_identity_event(conn, plant_id, payload, device_id=""):
    """Append to the identity ledger. Types: repot, move, divide_out, correct_name, note.
    Identity lineage is preserved; plants are never merged."""
    etype = payload["event_type"]
    edate = payload["event_date"]
    ts = now_iso()
    uid = payload.get("client_uid") or (etype + "-" + new_client_uid())
    if etype == "divide_out":
        # New individual descends from the parent; lineage columns retain origin.
        name = payload["new_name"]
        cur = conn.execute(
            """INSERT INTO plant_individuals(accession, current_name, acquired_date, source_note,
                  parent_plant_id, created_at)
               VALUES (?,?,?,?,?,?)""",
            (next_accession(conn), name, edate,
             f"由母株分株而来 (母株 {payload.get('parent_name','')})",
             plant_id, ts),
        )
        child_id = cur.lastrowid
        conn.execute(
            """INSERT INTO plant_name_history(plant_id, name, reason, valid_from, created_at)
               VALUES (?,?,?,?,?)""",
            (child_id, name, "分株定名", edate, ts),
        )
        evcur = conn.execute(
            """INSERT INTO plant_events(plant_id, event_type, event_date, from_pot_id, to_pot_id,
                  to_environment_id, position, detail, child_plant_id, new_name,
                  client_uid, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (plant_id, "divide_out", edate, payload.get("from_pot_id"),
             payload.get("to_pot_id"), payload.get("to_environment_id"),
             payload.get("position", ""), payload.get("detail", "分株"),
             child_id, name, uid, ts),
        )
        if payload.get("to_pot_id") and payload.get("to_environment_id"):
            conn.execute(
                """INSERT INTO pot_placements(pot_id, environment_id, position, placed_from)
                   VALUES (?,?,?,?)""",
                (payload["to_pot_id"], payload["to_environment_id"],
                 payload.get("position", ""), edate),
            )
        conn.execute(
            "UPDATE plant_individuals SET name_locked_from_event_id=? WHERE id=?",
            (evcur.lastrowid, child_id),
        )
        return {"event_id": evcur.lastrowid, "child_plant_id": child_id}

    if etype == "correct_name":
        old = conn.execute(
            "SELECT current_name FROM plant_individuals WHERE id=?", (plant_id,)
        ).fetchone()["current_name"]
        new = payload["new_name"]
        evcur = conn.execute(
            """INSERT INTO plant_events(plant_id, event_type, event_date, detail,
                  previous_name, new_name, client_uid, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (plant_id, "correct_name", edate,
             payload.get("detail", "品种订正"), old, new, uid, ts),
        )
        conn.execute(
            "UPDATE plant_individuals SET current_name=?, name_locked_from_event_id=? WHERE id=?",
            (new, evcur.lastrowid, plant_id),
        )
        conn.execute(
            """INSERT INTO plant_name_history(plant_id, name, reason, event_id, valid_from, created_at)
               VALUES (?,?,?,?,?,?)""",
            (plant_id, new, payload.get("detail", "品种订正"), evcur.lastrowid, edate, ts),
        )
        return {"event_id": evcur.lastrowid, "previous_name": old, "new_name": new}

    if etype == "repot":
        evcur = conn.execute(
            """INSERT INTO plant_events(plant_id, event_type, event_date, from_pot_id, to_pot_id,
                  to_environment_id, position, detail, client_uid, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (plant_id, "repot", edate, payload.get("from_pot_id"),
             payload.get("to_pot_id"), payload.get("to_environment_id"),
             payload.get("position", ""), payload.get("detail", "移盆"), uid, ts),
        )
        if payload.get("to_pot_id") and payload.get("to_environment_id"):
            # close previous open placement of the NEW pot? The new pot gets a placement.
            conn.execute(
                """INSERT INTO pot_placements(pot_id, environment_id, position, placed_from)
                   VALUES (?,?,?,?)""",
                (payload["to_pot_id"], payload["to_environment_id"],
                 payload.get("position", ""), edate),
            )
        return {"event_id": evcur.lastrowid}

    if etype == "move":
        # Same pot, new position/environment: open a new placement interval.
        evcur = conn.execute(
            """INSERT INTO plant_events(plant_id, event_type, event_date, from_pot_id, to_pot_id,
                  from_environment_id, to_environment_id, position, detail, client_uid, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (plant_id, "move", edate, payload.get("pot_id"), payload.get("pot_id"),
             payload.get("from_environment_id"), payload.get("to_environment_id"),
             payload.get("position", ""), payload.get("detail", "挪位"), uid, ts),
        )
        if payload.get("pot_id") and payload.get("to_environment_id"):
            conn.execute(
                "UPDATE pot_placements SET placed_to=? WHERE pot_id=? AND placed_to IS NULL",
                (edate, payload["pot_id"]),
            )
            conn.execute(
                """INSERT INTO pot_placements(pot_id, environment_id, position, placed_from)
                   VALUES (?,?,?,?)""",
                (payload["pot_id"], payload["to_environment_id"],
                 payload.get("position", ""), edate),
            )
        return {"event_id": evcur.lastrowid}

    # generic note event
    evcur = conn.execute(
        """INSERT INTO plant_events(plant_id, event_type, event_date, detail,
              client_uid, created_at) VALUES (?,?,?,?,?,?)""",
        (plant_id, "note", edate, payload.get("detail", ""), uid, ts),
    )
    return {"event_id": evcur.lastrowid}


# ---------------------------------------------------------------- observations

def _resolve_context(conn, plant_id, observed_date, explicit_env=None, explicit_pot=None):
    pot = None
    if explicit_pot:
        pot = conn.execute("SELECT * FROM pots WHERE id=?", (explicit_pot,)).fetchone()
    else:
        pot = current_pot_for_plant(conn, plant_id, observed_date)
    env = None
    if explicit_env:
        env = conn.execute("SELECT * FROM environments WHERE id=?", (explicit_env,)).fetchone()
    elif pot:
        pl = environment_for_pot(conn, pot["id"], observed_date)
        if pl:
            env = conn.execute("SELECT * FROM environments WHERE id=?",
                               (pl["environment_id"],)).fetchone()
    return pot, env


def create_observation(conn, data, device_id=""):
    """Append a raw observation. Multiple per day are allowed (no unique date).
    Environment/name/pot are snapshotted: later changes never rewrite history."""
    plant_id = int(data["plant_id"])
    observed_at = data["observed_at"]
    observed_date = observed_at[:10]
    d = parse_date(observed_date)

    region_id = data.get("region_id")
    rule = active_rule(conn, region_id)
    season = season_for_date(d, rule_boundaries(rule))

    pot, env = _resolve_context(
        conn, plant_id, observed_date,
        explicit_env=data.get("environment_id"), explicit_pot=data.get("pot_id"),
    )
    name_then = plant_name_as_of(conn, plant_id, observed_date)
    plant = conn.execute(
        "SELECT current_name FROM plant_individuals WHERE id=?", (plant_id,)
    ).fetchone()
    if name_then is None:
        name_then = plant["current_name"]
    env_snapshot = f"{env['name']}({env['kind']},{env['light']})" if env else ""
    pot_snapshot = f"{pot['code']}({pot['material']},{pot['diameter_cm']}cm)" if pot else ""

    uid = data.get("client_uid") or ("obs-" + new_client_uid())
    cur = conn.execute(
        """INSERT INTO observations(plant_id, observed_at, observed_date, season,
              season_rule_id, environment_id, env_snapshot, pot_id, pot_snapshot,
              plant_name_snapshot, title, body, tags, is_public,
              client_uid, device_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (plant_id, observed_at, observed_date, season, rule["id"],
         env["id"] if env else None, env_snapshot,
         pot["id"] if pot else None, pot_snapshot,
         name_then, data.get("title", ""), data["body"], data.get("tags", ""),
         1 if data.get("is_public", True) else 0, uid,
         device_id or data.get("device_id", ""), now_iso()),
    )
    oid = cur.lastrowid
    _index_one(conn, oid)
    return oid


def add_observation_revision(conn, observation_id, note, device_id="", client_uid=None):
    uid = client_uid or ("rev-" + new_client_uid())
    cur = conn.execute(
        """INSERT INTO observation_revisions(observation_id, note, device_id, client_uid, created_at)
           VALUES (?,?,?,?,?)""",
        (observation_id, note, device_id, uid, now_iso()),
    )
    return cur.lastrowid


def _index_one(conn, oid):
    o = conn.execute("SELECT * FROM observations WHERE id=?", (oid,)).fetchone()
    conn.execute("DELETE FROM observation_index WHERE observation_id=?", (oid,))
    conn.execute(
        """INSERT INTO observation_index(observation_id, observed_date, season,
              environment_id, plant_id, is_public, tags)
           VALUES (?,?,?,?,?,?,?)""",
        (oid, o["observed_date"], o["season"], o["environment_id"],
         o["plant_id"], o["is_public"], o["tags"]),
    )


def rebuild_index(conn):
    """Drop and rebuild the derived filter index from raw observations.
    Season is recomputed under the CURRENTLY active rule of the observation's
    region — raw rows keep their own season snapshot, so rebuilding the filter
    never rewrites the historical record itself."""
    conn.execute("DELETE FROM observation_index")
    rows = conn.execute("SELECT id FROM observations ORDER BY id").fetchall()
    for r in rows:
        _index_one(conn, r["id"])
    return len(rows)


# ---------------------------------------------------------------- photos

def save_photo(conn, *, blob, content_type, filename, plant_id, caption,
               observation_id=None, device_id="", client_uid=None, upload_dir=""):
    cleaned, summary = photo_lib.sanitize(blob, content_type)
    plant = conn.execute(
        "SELECT current_name FROM plant_individuals WHERE id=?", (plant_id,)
    ).fetchone()
    subject_label = plant["current_name"] if plant else ""
    uid = client_uid or ("pho-" + new_client_uid())
    ext = ".jpg" if content_type == "image/jpeg" else (
        ".png" if content_type == "image/png" else ".bin")
    stored_name = uid + ext
    os.makedirs(upload_dir, exist_ok=True)
    path = os.path.join(upload_dir, stored_name)
    with open(path, "wb") as f:
        f.write(cleaned)
    cur = conn.execute(
        """INSERT INTO photos(plant_id, observation_id, storage_path, original_filename,
              caption, subject_label, taken_at, gps_removed, exif_removed_count,
              bytes_size, client_uid, device_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (plant_id, observation_id, stored_name, filename, caption, subject_label,
         summary.taken_at, 1 if summary.has_gps else 0, summary.tag_count,
         len(cleaned), uid, device_id, now_iso()),
    )
    return cur.lastrowid, {"gps_removed": bool(summary.has_gps),
                           "exif_tags_seen": summary.tag_count,
                           "taken_at_kept_server_side": summary.taken_at}


def revise_photo_caption(conn, photo_id, new_caption, reason=""):
    p = conn.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()
    conn.execute(
        """INSERT INTO photo_caption_revisions(photo_id, old_caption, new_caption, reason, created_at)
           VALUES (?,?,?,?,?)""",
        (photo_id, p["caption"], new_caption, reason, now_iso()),
    )
    conn.execute("UPDATE photos SET caption=? WHERE id=?", (new_caption, photo_id))
    # subject_label is deliberately NOT touched: it follows the object then.


# ---------------------------------------------------------------- articles

def create_article(conn, *, slug, title, body, change_summary="初次建稿",
                   status="draft", device_id="", client_uid=None):
    ts = now_iso()
    cur = conn.execute(
        """INSERT INTO articles(slug, title, current_version, status, is_public,
              published_at, created_at, updated_at) VALUES (?,?,0,?,0,?,?,?)""",
        (slug, title, status, ts if status == "published" else None, ts, ts),
    )
    aid = cur.lastrowid
    uid = client_uid or ("av-" + new_client_uid())
    conn.execute(
        """INSERT INTO article_versions(article_id, version, title, body,
              change_summary, device_id, client_uid, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (aid, 1, title, body, change_summary, device_id, uid, ts),
    )
    conn.execute("UPDATE articles SET current_version=1, title=? WHERE id=?", (title, aid))
    if status == "published":
        conn.execute("UPDATE articles SET is_public=1, published_at=? WHERE id=?", (ts, aid))
    return aid, 1


def update_article(conn, article_id, *, title, body, change_summary="",
                   expected_version, device_id="", client_uid=None, force=False):
    """Whole-document overwrite under optimistic concurrency.
    Stale expected_version => 409 conflict unless force; nothing is silently lost."""
    a = conn.execute("SELECT * FROM articles WHERE id=?", (article_id,)).fetchone()
    if not force and expected_version is not None and a["current_version"] != expected_version:
        return None, {
            "error": "version_conflict",
            "current_version": a["current_version"],
            "your_version": expected_version,
            "hint": "文档已被其他设备覆盖，请拉取最新版本合并后用 force=true 再提交",
        }
    ts = now_iso()
    nv = a["current_version"] + 1
    uid = client_uid or ("av-" + new_client_uid())
    conn.execute(
        """INSERT INTO article_versions(article_id, version, title, body,
              change_summary, device_id, client_uid, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (article_id, nv, title, body, change_summary, device_id, uid, ts),
    )
    conn.execute(
        "UPDATE articles SET title=?, current_version=?, updated_at=? WHERE id=?",
        (title, nv, ts, article_id),
    )
    return nv, None


def set_article_status(conn, article_id, status):
    ts = now_iso()
    a = conn.execute("SELECT * FROM articles WHERE id=?", (article_id,)).fetchone()
    if status == "published":
        conn.execute(
            "UPDATE articles SET status='published', is_public=1, "
            "published_at=COALESCE(published_at, ?), withdrawn_at=NULL, updated_at=? WHERE id=?",
            (ts, ts, article_id),
        )
    elif status == "withdrawn":
        # Withdraw: public listing removes it; 410 at the public URL. History retained.
        conn.execute(
            "UPDATE articles SET status='withdrawn', is_public=0, withdrawn_at=?, updated_at=? WHERE id=?",
            (ts, ts, article_id),
        )
    else:
        conn.execute(
            "UPDATE articles SET status='draft', is_public=0, updated_at=? WHERE id=?",
            (ts, article_id),
        )
    return status


# ---------------------------------------------------------------- experiences

def create_experience(conn, *, plant_id, scope_note, title, body,
                      change_summary="初次总结", device_id="", client_uid=None):
    ts = now_iso()
    cur = conn.execute(
        """INSERT INTO experiences(plant_id, scope_note, current_version,
              is_personal_record, created_at, updated_at)
           VALUES (?, ?, 1, 1, ?, ?)""",
        (plant_id, scope_note, ts, ts),
    )
    eid = cur.lastrowid
    uid = client_uid or ("ev-" + new_client_uid())
    conn.execute(
        """INSERT INTO experience_versions(experience_id, version, title, body,
              change_summary, device_id, client_uid, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (eid, 1, title, body, change_summary, device_id, uid, ts),
    )
    return eid, 1


def add_experience_version(conn, experience_id, *, title, body, change_summary,
                           expected_version=None, device_id="", client_uid=None,
                           force=False):
    e = conn.execute("SELECT * FROM experiences WHERE id=?", (experience_id,)).fetchone()
    if not force and expected_version is not None and e["current_version"] != expected_version:
        return None, {
            "error": "version_conflict",
            "current_version": e["current_version"],
            "your_version": expected_version,
        }
    ts = now_iso()
    nv = e["current_version"] + 1
    uid = client_uid or ("ev-" + new_client_uid())
    conn.execute(
        """INSERT INTO experience_versions(experience_id, version, title, body,
              change_summary, device_id, client_uid, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (experience_id, nv, title, body, change_summary, device_id, uid, ts),
    )
    conn.execute("UPDATE experiences SET current_version=?, updated_at=? WHERE id=?",
                 (nv, ts, experience_id))
    return nv, None


# ---------------------------------------------------------------- sync

def sync_push(conn, batch, device_id, upload_dir=""):
    """Offline backfill: a batch of typed items with client_uids.
    - duplicate client_uid => skipped (idempotent replay across devices)
    - append items (observation/event) never conflict
    - document items (article/experience overwrite) report conflicts explicitly
    - the same (device, batch) replayed after a network failure is a no-op replay
    """
    batch_id = batch.get("client_batch_id", new_client_uid())
    prior = conn.execute(
        "SELECT * FROM sync_log WHERE device_id=? AND client_batch_id=?",
        (device_id, batch_id)).fetchone()
    if prior:
        return {
            "sync_log_id": prior["id"], "replay": True,
            "accepted": prior["accepted"], "duplicates": prior["duplicates"],
            "conflicts": prior["conflicts"],
            "errors": json.loads(prior["errors"] or "[]"),
            "items": [],
        }
    results = []
    accepted = duplicates = conflicts = 0
    errors = []

    def seen(table, uid):
        if not uid:
            return False
        col = "client_uid"
        row = conn.execute(
            f"SELECT 1 FROM {table} WHERE {col}=? LIMIT 1", (uid,)
        ).fetchone()
        return row is not None

    for item in batch.get("items", []):
        kind = item.get("kind")
        uid = item.get("client_uid")
        try:
            if kind == "observation":
                if seen("observations", uid):
                    duplicates += 1
                    results.append({"client_uid": uid, "status": "duplicate"})
                    continue
                oid = create_observation(conn, item["payload"], device_id=device_id)
                accepted += 1
                results.append({"client_uid": uid, "status": "accepted", "id": oid})
            elif kind == "observation_revision":
                if seen("observation_revisions", uid):
                    duplicates += 1
                    results.append({"client_uid": uid, "status": "duplicate"})
                    continue
                rid = add_observation_revision(
                    conn, item["payload"]["observation_id"],
                    item["payload"]["note"], device_id=device_id, client_uid=uid)
                accepted += 1
                results.append({"client_uid": uid, "status": "accepted", "id": rid})
            elif kind == "plant_event":
                p = item["payload"]
                if seen("plant_events", uid):
                    duplicates += 1
                    results.append({"client_uid": uid, "status": "duplicate"})
                    continue
                out = add_identity_event(conn, int(p.pop("plant_id")), p, device_id)
                accepted += 1
                results.append({"client_uid": uid, "status": "accepted", **out})
            elif kind == "article_version":
                p = item["payload"]
                if seen("article_versions", uid):
                    duplicates += 1
                    results.append({"client_uid": uid, "status": "duplicate"})
                    continue
                ver, err = update_article(
                    conn, p["article_id"], title=p["title"], body=p["body"],
                    change_summary=p.get("change_summary", "离线补记"),
                    expected_version=p.get("expected_version"),
                    device_id=device_id, client_uid=uid, force=p.get("force", False))
                if err:
                    conflicts += 1
                    results.append({"client_uid": uid, "status": "conflict", **err})
                else:
                    accepted += 1
                    results.append({"client_uid": uid, "status": "accepted", "version": ver})
            elif kind == "experience_version":
                p = item["payload"]
                if seen("experience_versions", uid):
                    duplicates += 1
                    results.append({"client_uid": uid, "status": "duplicate"})
                    continue
                ver, err = add_experience_version(
                    conn, p["experience_id"], title=p["title"], body=p["body"],
                    change_summary=p.get("change_summary", "离线补记"),
                    expected_version=p.get("expected_version"),
                    device_id=device_id, client_uid=uid, force=p.get("force", False))
                if err:
                    conflicts += 1
                    results.append({"client_uid": uid, "status": "conflict", **err})
                else:
                    accepted += 1
                    results.append({"client_uid": uid, "status": "accepted", "version": ver})
            else:
                errors.append({"client_uid": uid, "error": f"unknown kind {kind}"})
        except Exception as exc:  # one bad item must not kill the batch
            errors.append({"client_uid": uid, "error": str(exc)})
            results.append({"client_uid": uid, "status": "error", "error": str(exc)})

    logcur = conn.execute(
        """INSERT INTO sync_log(device_id, client_batch_id, received_at, accepted,
              duplicates, conflicts, errors) VALUES (?,?,?,?,?,?,?)""",
        (device_id, batch_id, now_iso(),
         accepted, duplicates, conflicts, json.dumps(errors, ensure_ascii=False)),
    )
    return {
        "sync_log_id": logcur.lastrowid,
        "accepted": accepted,
        "duplicates": duplicates,
        "conflicts": conflicts,
        "errors": errors,
        "items": results,
    }


# ---------------------------------------------------------------- stats

def environment_stats(conn, season=None, as_of=None):
    """Counts per environment from the RAW observations (frozen snapshots).
    Changing an environment today affects new/current stats only; old rows keep
    their environment_id/snapshot, so the past is never rewritten."""
    sql = """SELECT environment_id, env_snapshot, COUNT(*) n
             FROM observations WHERE 1=1"""
    args = []
    if season:
        sql += " AND season=?"
        args.append(season)
    if as_of:
        sql += " AND observed_date<=?"
        args.append(as_of)
    sql += " GROUP BY environment_id, env_snapshot ORDER BY n DESC"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]
