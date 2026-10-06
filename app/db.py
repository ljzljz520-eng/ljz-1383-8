"""SQLite connection management and schema initialisation."""
import os
import sqlite3

SCHEMA_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "schema.sql")


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = connect(db_path)
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        conn.executescript(f.read())
    conn.commit()
    return conn


def get_config(conn, key, default=None):
    row = conn.execute("SELECT value FROM site_config WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_config(conn, key, value):
    conn.execute(
        "INSERT INTO site_config(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )
