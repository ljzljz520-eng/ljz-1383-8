"""WSGI application: public pages + token-authenticated management JSON API.

Run:  python3 -m app.server   (serves on 0.0.0.0:8000)
DB:   GARDEN_DB env var, default ./data/garden.db
"""
import io
import json
import os
import re
import traceback
from urllib.parse import parse_qs

from .db import init_db, connect, get_config, set_config
from . import services as svc
from . import web
from .seasons import (SEASONS, SEASON_CN, validate_boundaries, active_rule,
                      rule_boundaries, season_for_date, parse_date)

ROOT = os.path.dirname(os.path.dirname(__file__))
UPLOAD_DIR = os.path.join(ROOT, "data", "uploads")


# ---------------------------------------------------------------- HTTP helpers

class Response(Exception):
    def __init__(self, status, body=b"", headers=None):
        self.status = status
        self.body = body if isinstance(body, bytes) else str(body).encode("utf-8")
        self.headers = headers or []


def json_response(obj, status="200 OK"):
    raise Response(status, json.dumps(obj, ensure_ascii=False, indent=1).encode("utf-8"),
                   [("Content-Type", "application/json; charset=utf-8")])


class Request:
    def __init__(self, environ):
        self.environ = environ
        self.method = environ["REQUEST_METHOD"]
        self.path = environ.get("PATH_INFO", "/")
        self.query = parse_qs(environ.get("QUERY_STRING", ""))
        self.ctype = environ.get("CONTENT_TYPE", "")
        length = int(environ.get("CONTENT_LENGTH") or 0)
        self.raw = environ["wsgi.input"].read(length) if length else b""
        self.device_id = environ.get("HTTP_X_DEVICE_ID", "")

    def json(self):
        return json.loads(self.raw.decode("utf-8"))

    def bearer(self):
        auth = self.environ.get("HTTP_AUTHORIZATION", "")
        if auth.startswith("Bearer "):
            return auth[7:]
        return self.query.get("token", [None])[0]

    def form(self):
        """Parse multipart/form-data -> (fields dict, files {name:(filename,ctype,bytes)})."""
        fields, files = {}, {}
        m = re.search(r"boundary=([^;]+)", self.ctype)
        if not m:
            return fields, files
        boundary = m.group(1).strip().strip('"')
        delim = b"--" + boundary.encode()
        parts = self.raw.split(delim)
        for part in parts:
            if part in (b"--\r\n", b"--", b"\r\n", b""):
                continue
            part = part[2:] if part.startswith(b"\r\n") else part
            if part.endswith(b"\r\n"):
                part = part[:-2]
            if b"\r\n\r\n" not in part:
                continue
            header_blob, content = part.split(b"\r\n\r\n", 1)
            headers = {}
            for line in header_blob.decode("utf-8", "replace").split("\r\n"):
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            cd = headers.get("content-disposition", "")
            name_m = re.search(r'name="([^"]+)"', cd)
            file_m = re.search(r'filename="([^"]*)"', cd)
            if not name_m:
                continue
            name = name_m.group(1)
            if file_m and file_m.group(1):
                files[name] = (file_m.group(1), headers.get("content-type", "application/octet-stream"), content)
            else:
                fields[name] = content.decode("utf-8")
        return fields, files


# ---------------------------------------------------------------- app

class GardenApp:
    def __init__(self, db_path=None):
        self.db_path = db_path or os.environ.get(
            "GARDEN_DB", os.path.join(ROOT, "data", "garden.db"))
        init_db(self.db_path)

    def conn(self):
        return connect(self.db_path)

    def require_admin(self, req, conn):
        token = get_config(conn, "admin_token", "devtoken")
        if req.bearer() != token:
            json_response({"error": "unauthorized"}, "401 Unauthorized")

    # ------------------------------------------------------------ dispatch

    def __call__(self, environ, start_response):
        req = Request(environ)
        try:
            with self.conn() as conn:
                status, body, headers = self.route(req, conn)
                conn.commit()
        except Response as r:
            status, body, headers = r.status, r.body, r.headers
        except ValueError as exc:
            status = "400 Bad Request"
            body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode()
            headers = [("Content-Type", "application/json; charset=utf-8")]
        except Exception as exc:
            traceback.print_exc()
            status, body = "500 Internal Server Error", str(exc).encode()
            headers = [("Content-Type", "text/plain; charset=utf-8")]
        start_response(status, headers + [("Content-Length", str(len(body)))])
        return [body]

    def route(self, req, conn):
        p = req.path
        # ---- static / media
        if p.startswith("/static/"):
            return self.serve_file(os.path.join(ROOT, "app", p.lstrip("/")), "text/css; charset=utf-8")
        if p.startswith("/media/"):
            ext = os.path.splitext(p)[1].lower()
            media_ct = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                        ".png": "image/png", ".webp": "image/webp"}.get(
                ext, "application/octet-stream")
            return self.serve_file(os.path.join(UPLOAD_DIR, os.path.basename(p)), media_ct)
        # ---- public pages
        if req.method == "GET":
            page = self.pages(req, conn)
            if page is not None:
                st, doc = page
                return st, doc.encode("utf-8"), [("Content-Type", "text/html; charset=utf-8")]
        # ---- admin console
        if p == "/admin/" and req.method == "GET":
            return self.serve_file(os.path.join(ROOT, "app", "admin.html"),
                                   "text/html; charset=utf-8")
        if p.startswith("/api/"):
            return self.api(req, conn)
        return "404 Not Found", b"not found", [("Content-Type", "text/plain")]

    def pages(self, req, conn):
        p = req.path
        if p == "/":
            return web.home(conn)
        if p == "/browse":
            return web.browse(conn, season=req.query.get("season", [None])[0],
                              environment_id=req.query.get("environment", [None])[0],
                              q=req.query.get("q", [None])[0])
        if p == "/plants":
            return web.plants_list(conn)
        m = re.fullmatch(r"/plants/(\d+)", p)
        if m:
            return web.plant_detail(conn, int(m.group(1)))
        m = re.fullmatch(r"/observations/(\d+)", p)
        if m:
            return web.observation_page(conn, int(m.group(1)))
        if p == "/articles":
            return web.articles_list(conn)
        m = re.fullmatch(r"/articles/([\w\-]+)", p)
        if m:
            return web.article_page(conn, m.group(1))
        if p == "/environments":
            return web.environments_page(conn)
        return None

    def serve_file(self, path, ctype, download=False):
        if not os.path.isfile(path):
            return "404 Not Found", b"missing", [("Content-Type", "text/plain")]
        with open(path, "rb") as f:
            data = f.read()
        return "200 OK", data, [("Content-Type", ctype),
                                ("X-Content-Type-Options", "nosniff")]

    # ------------------------------------------------------------ API

    def api(self, req, conn):
        p = req.path
        # public read endpoints
        if req.method == "GET":
            if p == "/api/health":
                return self.ok({"ok": True})
            if p == "/api/region":
                return self.ok(self.region_payload(conn))
            if p == "/api/plants":
                rows = conn.execute(
                    "SELECT * FROM plant_individuals WHERE is_current=1 ORDER BY accession").fetchall()
                return self.ok([dict(r) for r in rows])
            m = re.fullmatch(r"/api/plants/(\d+)", p)
            if m:
                pid = int(m.group(1))
                plant = conn.execute(
                    "SELECT * FROM plant_individuals WHERE id=?", (pid,)).fetchone()
                if not plant:
                    return self.err(404, "not_found")
                events = conn.execute(
                    "SELECT * FROM plant_events WHERE plant_id=? ORDER BY event_date,id", (pid,)).fetchall()
                return self.ok({"plant": dict(plant), "events": [dict(e) for e in events]})
            if p == "/api/observations":
                return self.query_observations(req, conn)
            if p == "/api/environments":
                rows = conn.execute("SELECT * FROM environments ORDER BY id").fetchall()
                return self.ok([dict(r) for r in rows])
            if p == "/api/articles":
                rows = conn.execute(
                    "SELECT * FROM articles WHERE status='published' ORDER BY published_at DESC").fetchall()
                return self.ok([dict(r) for r in rows])
            if p == "/api/stats/environments":
                return self.ok(svc.environment_stats(
                    conn, season=req.query.get("season", [None])[0],
                    as_of=req.query.get("as_of", [None])[0]))
            if p == "/api/index/status":
                n = conn.execute("SELECT COUNT(*) c FROM observation_index").fetchone()["c"]
                raw = conn.execute("SELECT COUNT(*) c FROM observations").fetchone()["c"]
                return self.ok({"indexed": n, "raw_observations": raw, "in_sync": n == raw})

        # everything below requires admin token
        self.require_admin(req, conn)
        data = {}
        if req.method in ("POST", "PUT", "PATCH") and req.raw and "application/json" in req.ctype:
            data = req.json()

        if p == "/api/admin/region" and req.method == "POST":
            return self.set_region(req, conn, data)
        if p == "/api/admin/season-rules" and req.method == "POST":
            return self.create_rule(req, conn, data)
        if p == "/api/admin/season-rules/activate" and req.method == "POST":
            rid = int(data["rule_id"])
            rule = conn.execute("SELECT * FROM season_rules WHERE id=?", (rid,)).fetchone()
            if not rule:
                return self.err(404, "rule not found")
            conn.execute("UPDATE season_rules SET is_active=0 WHERE region_id=?", (rule["region_id"],))
            conn.execute("UPDATE season_rules SET is_active=1 WHERE id=?", (rid,))
            return self.ok({"activated": rid, **self.region_payload(conn)})

        if p == "/api/admin/environments" and req.method == "POST":
            cur = conn.execute(
                """INSERT INTO environments(name, kind, light, active_from, note)
                   VALUES (?,?,?,?,?)""",
                (data["name"], data.get("kind", "indoor"), data.get("light", ""),
                 data["active_from"], data.get("note", ""))).lastrowid
            return self.ok({"id": cur})

        if p == "/api/admin/pots" and req.method == "POST":
            cur = conn.execute(
                "INSERT INTO pots(code, material, diameter_cm, created_at) VALUES (?,?,?,?)",
                (data["code"], data.get("material", ""), data.get("diameter_cm"),
                 svc.now_iso())).lastrowid
            return self.ok({"id": cur})

        if p == "/api/admin/plants" and req.method == "POST":
            pid, acc = svc.create_plant(
                conn, name=data["name"], acquired_date=data["acquired_date"],
                source_note=data.get("source_note", ""), pot_id=data.get("pot_id"),
                environment_id=data.get("environment_id"),
                position=data.get("position", ""),
                client_uid=data.get("client_uid"), device_id=req.device_id)
            return self.ok({"id": pid, "accession": acc})

        m = re.fullmatch(r"/api/admin/plants/(\d+)/events", p)
        if m and req.method == "POST":
            out = svc.add_identity_event(conn, int(m.group(1)), data, req.device_id)
            return self.ok(out)

        if p == "/api/admin/observations" and req.method == "POST":
            oid = svc.create_observation(conn, data, device_id=req.device_id)
            return self.ok({"id": oid})

        m = re.fullmatch(r"/api/admin/observations/(\d+)/revisions", p)
        if m and req.method == "POST":
            rid = svc.add_observation_revision(
                conn, int(m.group(1)), data["note"],
                device_id=req.device_id, client_uid=data.get("client_uid"))
            return self.ok({"id": rid})

        if p == "/api/admin/photos" and req.method == "POST":
            return self.upload_photo(req, conn)

        if p == "/api/admin/articles" and req.method == "POST":
            aid, ver = svc.create_article(
                conn, slug=data["slug"], title=data["title"], body=data["body"],
                change_summary=data.get("change_summary", "初次建稿"),
                status=data.get("status", "draft"), device_id=req.device_id,
                client_uid=data.get("client_uid"))
            return self.ok({"id": aid, "version": ver})

        m = re.fullmatch(r"/api/admin/articles/(\d+)/versions", p)
        if m and req.method == "POST":
            ver, err = svc.update_article(
                conn, int(m.group(1)), title=data["title"], body=data["body"],
                change_summary=data.get("change_summary", ""),
                expected_version=data.get("expected_version"),
                device_id=req.device_id, client_uid=data.get("client_uid"),
                force=bool(data.get("force")))
            if err:
                return self.err(409, err)
            return self.ok({"version": ver})

        m = re.fullmatch(r"/api/admin/articles/(\d+)/status", p)
        if m and req.method == "POST":
            svc.set_article_status(conn, int(m.group(1)), data["status"])
            return self.ok({"id": int(m.group(1)), "status": data["status"]})

        if p == "/api/admin/experiences" and req.method == "POST":
            eid, ver = svc.create_experience(
                conn, plant_id=data.get("plant_id"), scope_note=data.get("scope_note", ""),
                title=data["title"], body=data["body"],
                change_summary=data.get("change_summary", "初次总结"),
                device_id=req.device_id, client_uid=data.get("client_uid"))
            return self.ok({"id": eid, "version": ver})

        m = re.fullmatch(r"/api/admin/experiences/(\d+)/versions", p)
        if m and req.method == "POST":
            ver, err = svc.add_experience_version(
                conn, int(m.group(1)), title=data["title"], body=data["body"],
                change_summary=data.get("change_summary", ""),
                expected_version=data.get("expected_version"),
                device_id=req.device_id, client_uid=data.get("client_uid"),
                force=bool(data.get("force")))
            if err:
                return self.err(409, err)
            return self.ok({"version": ver})

        if p == "/api/admin/sync/push" and req.method == "POST":
            out = svc.sync_push(conn, data, req.device_id, upload_dir=UPLOAD_DIR)
            return self.ok(out)

        if p == "/api/admin/index/rebuild" and req.method == "POST":
            n = svc.rebuild_index(conn)
            return self.ok({"rebuilt": n})

        return self.err(404, f"no endpoint {req.method} {p}")

    # ------------------------------------------------------------ endpoint helpers

    def region_payload(self, conn):
        rid = get_config(conn, "active_region_id", "1")
        region = conn.execute("SELECT * FROM regions WHERE id=?", (rid,)).fetchone()
        rule = conn.execute(
            "SELECT * FROM season_rules WHERE region_id=? AND is_active=1", (rid,)).fetchone()
        return {
            "region": dict(region) if region else None,
            "rule": dict(rule) if rule else None,
            "today_season": season_for_date(
                parse_date(svc.now_iso()[:10]), rule_boundaries(rule)) if rule else None,
        }

    def set_region(self, req, conn, data):
        if "region_id" in data:
            r = conn.execute("SELECT id FROM regions WHERE id=?", (data["region_id"],)).fetchone()
            if not r:
                return self.err(404, "region not found")
            set_config(conn, "active_region_id", data["region_id"])
            return self.ok(self.region_payload(conn))
        # declare a new region (owner statement)
        cur = conn.execute(
            "INSERT INTO regions(code, name, climate_note) VALUES (?,?,?)",
            (data["code"], data["name"], data.get("climate_note", ""))).lastrowid
        set_config(conn, "active_region_id", cur)
        return self.ok({"id": cur, **self.region_payload(conn)})

    def create_rule(self, req, conn, data):
        b = {k: int(data[k]) for k in ("spring_doy", "summer_doy", "autumn_doy", "winter_doy")}
        validate_boundaries(b)
        region_id = data.get("region_id") or get_config(conn, "active_region_id", "1")
        cur = conn.execute(
            """INSERT INTO season_rules(region_id, label, is_active, created_at,
                  spring_doy, summer_doy, autumn_doy, winter_doy)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (region_id, data["label"], 1 if data.get("activate", True) else 0,
             svc.now_iso(), b["spring_doy"], b["summer_doy"], b["autumn_doy"], b["winter_doy"]),
        ).lastrowid
        if data.get("activate", True):
            conn.execute("UPDATE season_rules SET is_active=0 WHERE region_id=? AND id<>?",
                         (region_id, cur))
        return self.ok({"id": cur})

    def query_observations(self, req, conn):
        sql = """SELECT o.* FROM observations o WHERE 1=1"""
        args = []
        for key, col in (("season", "o.season"), ("environment", "o.environment_id"),
                         ("plant", "o.plant_id"), ("date", "o.observed_date")):
            v = req.query.get(key, [None])[0]
            if v:
                sql += f" AND {col}=?"; args.append(v)
        sql += " ORDER BY o.observed_date DESC, o.id DESC"
        rows = conn.execute(sql, args).fetchall()
        return self.ok([dict(r) for r in rows])

    def upload_photo(self, req, conn):
        fields, files = req.form()
        if "file" not in files:
            return self.err(400, "missing file part")
        filename, ctype, blob = files["file"]
        pid = int(fields["plant_id"])
        oid = fields.get("observation_id")
        pid_photo, privacy = svc.save_photo(
            conn, blob=blob, content_type=ctype.split(";")[0].strip(),
            filename=filename, plant_id=pid, caption=fields.get("caption", ""),
            observation_id=int(oid) if oid else None,
            device_id=req.device_id, client_uid=fields.get("client_uid"),
            upload_dir=UPLOAD_DIR)
        return self.ok({"id": pid_photo, "privacy": privacy})

    def ok(self, obj):
        return ("200 OK", json.dumps(obj, ensure_ascii=False, indent=1).encode("utf-8"),
                [("Content-Type", "application/json; charset=utf-8")])

    def err(self, code, payload):
        status = {400: "400 Bad Request", 401: "401 Unauthorized", 404: "404 Not Found",
                  409: "409 Conflict", 422: "422 Unprocessable Entity"}.get(code, "400 Bad Request")
        body = json.dumps(payload if isinstance(payload, dict) else {"error": payload},
                          ensure_ascii=False).encode()
        return status, body, [("Content-Type", "application/json; charset=utf-8")]


def main():
    from wsgiref.simple_server import make_server
    app = GardenApp()
    httpd = make_server("0.0.0.0", int(os.environ.get("PORT", "8000")), app)
    print("Serving on http://0.0.0.0:8000  (admin token: devtoken)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
