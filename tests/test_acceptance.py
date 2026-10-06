import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from tests.helpers import Client, jpeg_with_exif, make_app
from app.seasons import season_for_date, parse_date, validate_boundaries
from datetime import date


class GardenTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app, self.api = make_app(self.tmp.name)
        self.conn = self.app.conn()
        # one region + rule for the base scenario
        sc, body, _ = self.api.post("/api/admin/region",
                                    {"code": "base", "name": "基线地区", "climate_note": "test"})
        self.assertEqual(sc, 200)
        sc, body, _ = self.api.post("/api/admin/season-rules", {
            "label": "基线四季", "spring_doy": 80, "summer_doy": 152,
            "autumn_doy": 244, "winter_doy": 335})
        self.assertEqual(sc, 200)
        sc, body, _ = self.api.post("/api/admin/environments", {
            "name": "南阳台", "kind": "indoor", "light": "全日照", "active_from": "2026-01-01"})
        self.env = body["id"]
        sc, body, _ = self.api.post("/api/admin/environments", {
            "name": "北窗台", "kind": "indoor", "light": "散射光", "active_from": "2026-01-01"})
        self.env2 = body["id"]
        sc, p1, _ = self.api.post("/api/admin/pots", {"code": "P-1", "material": "红陶", "diameter_cm": 12})
        self.pot1 = p1["id"]
        sc, p2, _ = self.api.post("/api/admin/pots", {"code": "P-2", "material": "塑料", "diameter_cm": 10})
        self.pot2 = p2["id"]

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    # 1. Same cultivar in two pots => two distinct individuals
    def test_01_same_cultivar_two_pots_distinct(self):
        _, a, _ = self.api.post("/api/admin/plants", {
            "name": "玉露", "acquired_date": "2026-02-01", "pot_id": self.pot1,
            "environment_id": self.env})
        _, b, _ = self.api.post("/api/admin/plants", {
            "name": "玉露", "acquired_date": "2026-02-01", "pot_id": self.pot2,
            "environment_id": self.env2})
        self.assertNotEqual(a["id"], b["id"])
        self.assertNotEqual(a["accession"], b["accession"])
        _, listing, _ = self.api.get("/api/plants")
        self.assertEqual(len(listing), 2)

    # 2. Repot / division / name correction preserve identity & lineage
    def test_02_repot_division_correction_lineage(self):
        _, a, _ = self.api.post("/api/admin/plants", {
            "name": "月影", "acquired_date": "2026-02-01", "pot_id": self.pot1,
            "environment_id": self.env})
        _, p3, _ = self.api.post("/api/admin/pots", {"code": "P-3", "material": "紫砂", "diameter_cm": 9})
        _, div, _ = self.api.post(f"/api/admin/plants/{a['id']}/events", {
            "event_type": "divide_out", "event_date": "2026-06-01",
            "from_pot_id": self.pot1, "to_pot_id": p3["id"],
            "to_environment_id": self.env, "new_name": "月影分株",
            "parent_name": "月影"})
        child_id = div["child_plant_id"]
        _, corr, _ = self.api.post(f"/api/admin/plants/{a['id']}/events", {
            "event_type": "correct_name", "event_date": "2026-09-01",
            "new_name": "月影杂交", "detail": "品种订正"})
        self.assertEqual(corr["previous_name"], "月影")
        self.assertEqual(corr["new_name"], "月影杂交")
        _, detail, _ = self.api.get(f"/api/plants/{child_id}")
        self.assertEqual(detail["plant"]["parent_plant_id"], a["id"])
        # mother current name changed; child name unchanged
        self.assertEqual(detail["plant"]["current_name"], "月影分株")
        # event ledger append-only: all event types present
        _, mother, _ = self.api.get(f"/api/plants/{a['id']}")
        types = [e["event_type"] for e in mother["events"]]
        self.assertEqual(types, ["acquire", "divide_out", "correct_name"])

    # 3. Region-declared seasons: same date, different regions -> different season
    def test_03_seasons_follow_owner_region_not_month(self):
        # base region boundaries
        _, reg, _ = self.api.get("/api/region")
        self.assertIn(reg["today_season"], {"spring", "summer", "autumn", "winter"})
        # Add Harbin-like rule in another region and check a date that is
        # autumn in one calendar but could differ by rule
        _, r2, _ = self.api.post("/api/admin/region", {"code": "north", "name": "北方站"})
        north_id = reg["region"]["id"]
        # create rule for the NEW region then re-read its season via engine
        sc, rule, _ = self.api.post("/api/admin/season-rules", {
            "region_id": r2["region"]["id"], "label": "北方四季",
            "spring_doy": 117, "summer_doy": 168, "autumn_doy": 224,
            "winter_doy": 280, "activate": False})
        from app.db import connect
        from app.seasons import active_rule, rule_boundaries
        north_rule = self.conn.execute(
            "SELECT * FROM season_rules WHERE id=?", (rule["id"],)).fetchone()
        base_rule = self.conn.execute(
            "SELECT * FROM season_rules WHERE region_id=? AND is_active=1",
            (north_id,)).fetchone()
        d = parse_date("2026-10-06")
        # base: spring80 summer152 autumn244 winter335 ; Oct6 doy279 -> autumn
        self.assertEqual(season_for_date(d, rule_boundaries(base_rule)), "autumn")
        # north: winter starts doy280 => Oct6 doy279 still autumn; Oct7 doy280 winter
        d2 = parse_date("2026-10-07")
        self.assertEqual(season_for_date(d2, rule_boundaries(north_rule)), "winter")
        d3 = parse_date("2026-04-15")  # doy105: base spring(80..) vs north still winter
        self.assertEqual(season_for_date(d3, rule_boundaries(base_rule)), "spring")
        self.assertEqual(season_for_date(d3, rule_boundaries(north_rule)), "winter")

    # 4. Observations append; multiple per day; created_at differs from observed
    def test_04_observation_append_multiple_per_day_and_backfill(self):
        _, a, _ = self.api.post("/api/admin/plants", {
            "name": "玉露", "acquired_date": "2026-02-01", "pot_id": self.pot1,
            "environment_id": self.env})
        _, o1, _ = self.api.post("/api/admin/observations", {
            "plant_id": a["id"], "observed_at": "2026-04-10T08:00",
            "title": "早", "body": "第一条"})
        _, o2, _ = self.api.post("/api/admin/observations", {
            "plant_id": a["id"], "observed_at": "2026-04-10T18:00",
            "title": "晚", "body": "第二条"})
        self.assertNotEqual(o1["id"], o2["id"])
        _, rows, _ = self.api.get("/api/observations?date=2026-04-10")
        self.assertEqual(len(rows), 2)
        # observation date != publication/record date both displayed
        self.assertTrue(rows[0]["observed_at"].startswith("2026-04-10"))
        self.assertTrue(rows[0]["created_at"].startswith("2026"))
        # page shows both dates
        sc, html_doc, _ = self.api.get(f"/observations/{o1['id']}")
        self.assertEqual(sc, 200)
        self.assertIn("观察日期", html_doc.decode())
        self.assertIn("录入/发表日期", html_doc.decode())
        # raw revision appended, original body untouched
        _, rev, _ = self.api.post(f"/api/admin/observations/{o1['id']}/revisions",
                                  {"note": "后补：当时判断有误"})
        _, rows2, _ = self.api.get("/api/observations?date=2026-04-10")
        first = [r for r in rows2 if r["id"] == o1["id"]][0]
        self.assertEqual(first["body"], "第一条")

    # 5. Offline backfill to another environment: replay idempotent, dedup
    def test_05_offline_backfill_after_move_replays_safely(self):
        _, a, _ = self.api.post("/api/admin/plants", {
            "name": "玉露", "acquired_date": "2026-02-01", "pot_id": self.pot1,
            "environment_id": self.env})
        # device A writes while offline (simulated by batch push later)
        batch = {"client_batch_id": "batch-1", "items": [
            {"kind": "observation", "client_uid": "u-obs-1", "payload": {
                "plant_id": a["id"], "observed_at": "2026-03-01T10:00",
                "title": "离线补记1", "body": "旧环境观察"}},
            {"kind": "observation", "client_uid": "u-obs-2", "payload": {
                "plant_id": a["id"], "observed_at": "2026-03-02T10:00",
                "title": "离线补记2", "body": "又一条"}},
        ]}
        api_b = Client(self.app, device="phone-B")
        sc, res, _ = api_b.post("/api/admin/sync/push", batch)
        self.assertEqual(sc, 200)
        self.assertEqual(res["accepted"], 2)
        # replay the SAME batch from the "new environment" after moving: duplicates skipped
        sc, res2, _ = api_b.post("/api/admin/sync/push", batch)
        # replay is idempotent: stored batch is echoed with no new rows
        self.assertTrue(res2["replay"])
        _, rows, _ = self.api.get("/api/observations")
        self.assertEqual(len(rows), 2)

    # 6. Photo EXIF/GPS stripped; caption frozen under subject name then
    def test_06_photo_exif_privacy_and_frozen_caption(self):
        _, a, _ = self.api.post("/api/admin/plants", {
            "name": "月影", "acquired_date": "2026-02-01", "pot_id": self.pot1,
            "environment_id": self.env})
        blob = jpeg_with_exif()
        sc, res, raw = self.api.multipart("/api/admin/photos", {
            "plant_id": str(a["id"]), "caption": "当时叫月影的样子"},
            {"file": ("a.jpg", "image/jpeg", blob)})
        self.assertEqual(sc, 200)
        self.assertTrue(res["privacy"]["gps_removed"])
        self.assertEqual(res["privacy"]["taken_at_kept_server_side"], "2026:03:03 07:07:07")
        # served file has no EXIF, no secret text, still valid jpeg
        sc, served, _ = self.api.get("/media/" + [f for f in os.listdir(
            os.path.join(self.tmp.name, "uploads"))][0])
        self.assertEqual(sc, 200)
        self.assertEqual(served[:2], b"\xff\xd8")
        self.assertNotIn(b"Exif\x00\x00", served)
        self.assertNotIn(b"SECRET DESC", served)
        # now correct the plant name; photo subject_label & caption unchanged
        self.api.post(f"/api/admin/plants/{a['id']}/events", {
            "event_type": "correct_name", "event_date": "2026-09-01",
            "new_name": "月影杂交", "detail": "订正"})
        from app.db import connect
        row = self.conn.execute("SELECT caption, subject_label FROM photos").fetchone()
        self.assertEqual(row["caption"], "当时叫月影的样子")
        self.assertEqual(row["subject_label"], "月影")  # not overwritten by latest label
        sc, page, _ = self.api.get(f"/plants/{a['id']}")
        self.assertIn("拍摄时对象标签", page.decode())
        self.assertIn("月影", page.decode())

    # 7. Public article withdrawal -> 410, removed from listing
    def test_07_article_withdraw_and_version_overwrite_conflict(self):
        _, art, _ = self.api.post("/api/admin/articles", {
            "slug": "post-a", "title": "T1", "body": "v1 body", "status": "published"})
        _, pub, _ = self.api.get("/articles/post-a")
        self.assertEqual(pub.status, "200 OK") if hasattr(pub, "status") else None
        sc, html_doc, _ = self.api.get("/articles/post-a")
        self.assertEqual(sc, 200)
        # stale overwrite => 409
        _, v2, _ = self.api.post(f"/api/admin/articles/{art['id']}/versions", {
            "title": "T2", "body": "device-X edit", "expected_version": 1})
        self.assertEqual(v2["version"], 2)
        sc, conflict, _ = self.api.post(f"/api/admin/articles/{art['id']}/versions", {
            "title": "T3", "body": "device-Y stale edit", "expected_version": 1})
        self.assertEqual(sc, 409)
        self.assertEqual(conflict["error"], "version_conflict")
        # force after manual merge succeeds
        sc, forced, _ = self.api.post(f"/api/admin/articles/{art['id']}/versions", {
            "title": "T3 merged", "body": "merged", "expected_version": 1, "force": True})
        self.assertEqual(sc, 200)
        self.assertEqual(forced["version"], 3)
        # withdraw
        sc, _, _ = self.api.post(f"/api/admin/articles/{art['id']}/status",
                                 {"status": "withdrawn"})
        sc, gone, _ = self.api.get("/articles/post-a")
        self.assertEqual(sc, 410)
        sc, listing, _ = self.api.get("/api/articles")
        self.assertEqual(listing, [])

    # 8. Filter index rebuild
    def test_08_index_rebuild(self):
        _, a, _ = self.api.post("/api/admin/plants", {
            "name": "玉露", "acquired_date": "2026-02-01", "pot_id": self.pot1,
            "environment_id": self.env})
        self.api.post("/api/admin/observations", {
            "plant_id": a["id"], "observed_at": "2026-04-10T08:00", "body": "x"})
        sc, st, _ = self.api.get("/api/index/status")
        self.assertTrue(st["in_sync"])
        # corrupt index, then browse must look empty until rebuild
        self.conn.execute("DELETE FROM observation_index")
        self.conn.commit()
        sc, st2, _ = self.api.get("/api/index/status")
        self.assertFalse(st2["in_sync"])
        sc, rb, _ = self.api.post("/api/admin/index/rebuild", {})
        self.assertEqual(rb["rebuilt"], 1)
        sc, page, _ = self.api.get("/browse?season=spring")
        self.assertIn("x", page.decode())

    # 9. Experience versions are personal/scoped and independent of raw obs
    def test_09_experience_personal_versioned(self):
        _, a, _ = self.api.post("/api/admin/plants", {
            "name": "玉露", "acquired_date": "2026-02-01", "pot_id": self.pot1,
            "environment_id": self.env})
        _, e, _ = self.api.post("/api/admin/experiences", {
            "plant_id": a["id"], "scope_note": "仅本人南阳台这盆",
            "title": "浇水", "body": "10天一次"})
        _, v2, _ = self.api.post(f"/api/admin/experiences/{e['id']}/versions", {
            "title": "浇水v2", "body": "14天一次", "expected_version": 1})
        self.assertEqual(v2["version"], 2)
        row = self.conn.execute("SELECT * FROM experiences WHERE id=?", (e["id"],)).fetchone()
        self.assertEqual(row["is_personal_record"], 1)
        vers = self.conn.execute(
            "SELECT COUNT(*) c FROM experience_versions WHERE experience_id=?",
            (e["id"],)).fetchone()["c"]
        self.assertEqual(vers, 2)

    # 10. Environment changes affect new stats but never rewrite past conditions
    def test_10_environment_change_keeps_history(self):
        _, a, _ = self.api.post("/api/admin/plants", {
            "name": "玉露", "acquired_date": "2026-02-01", "pot_id": self.pot1,
            "environment_id": self.env})
        self.api.post("/api/admin/observations", {
            "plant_id": a["id"], "observed_at": "2026-03-01T08:00", "body": "在南阳台"})
        # move pot to new environment
        self.api.post(f"/api/admin/plants/{a['id']}/events", {
            "event_type": "move", "event_date": "2026-05-01",
            "pot_id": self.pot1, "from_environment_id": self.env,
            "to_environment_id": self.env2, "detail": "挪到北窗台"})
        self.api.post("/api/admin/observations", {
            "plant_id": a["id"], "observed_at": "2026-05-02T08:00", "body": "在北窗台"})
        old = self.conn.execute(
            "SELECT environment_id, env_snapshot FROM observations ORDER BY id LIMIT 1").fetchone()
        self.assertEqual(old["environment_id"], self.env)
        self.assertIn("南阳台", old["env_snapshot"])
        sc, stats, _ = self.api.get("/api/stats/environments")
        by_env = {s["environment_id"]: s["n"] for s in stats}
        self.assertEqual(by_env[self.env], 1)
        self.assertEqual(by_env[self.env2], 1)

    # 11. Invalid season boundaries rejected
    def test_11_invalid_rule_rejected(self):
        sc, err, _ = self.api.post("/api/admin/season-rules", {
            "label": "bad", "spring_doy": 80, "summer_doy": 80,
            "autumn_doy": 244, "winter_doy": 335})
        self.assertEqual(sc, 400)
        self.assertIn("四季", err["error"])

    # 12. Auth required for admin endpoints
    def test_12_admin_requires_token(self):
        anon = Client(self.app, token="wrong")
        sc, err, _ = anon.post("/api/admin/pots", {"code": "X", "created_at": "2026-01-01"})
        self.assertEqual(sc, 401)

    # 13. Conflict items in offline batch reported per-item without losing others
    def test_13_sync_batch_mixed_conflict_and_accept(self):
        _, art, _ = self.api.post("/api/admin/articles", {
            "slug": "s", "title": "t", "body": "b", "status": "draft"})
        batch = {"client_batch_id": "b2", "items": [
            {"kind": "article_version", "client_uid": "av-x", "payload": {
                "article_id": art["id"], "title": "n", "body": "n", "expected_version": 1}},
            {"kind": "article_version", "client_uid": "av-y", "payload": {
                "article_id": art["id"], "title": "stale", "body": "s", "expected_version": 1}},
        ]}
        sc, res, _ = self.api.post("/api/admin/sync/push", batch)
        self.assertEqual(res["accepted"], 1)
        self.assertEqual(res["conflicts"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
