"""Command line entry point for secretary-core."""

from __future__ import annotations

import argparse
import json
import os
import platform
import signal
import socket
import sqlite3
import sys
import threading
import time

from . import __version__
from .server import CoreServer


def default_data_dir() -> str:
    override = os.environ.get("SECRETARY_OFFICE_HOME")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".secretary-office")


def _port_open(port) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            return sock.connect_ex(("127.0.0.1", int(port))) == 0
    except (OSError, TypeError, ValueError):
        return False


def _connect(data_dir: str):
    from . import db

    return db.connect(data_dir)


# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------

def serve(data_dir: str | None) -> int:
    resolved = data_dir or default_data_dir()
    info_path = os.path.join(resolved, ".run", "core.json")
    # 单实例：已有健康核心则复用
    if os.path.exists(info_path):
        try:
            with open(info_path, "r", encoding="utf-8") as handle:
                info = json.load(handle)
            port = info.get("port")
            if port and _port_open(port):
                print("already running on 127.0.0.1:%s" % port, flush=True)
                return 0
        except (OSError, ValueError):
            pass

    server = CoreServer(resolved)
    port = server.start()
    print("secretary-core listening on 127.0.0.1:%d" % port, flush=True)

    stop = threading.Event()

    def _handle(_signum, _frame):
        stop.set()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, _handle)
            except (OSError, ValueError):
                pass
    try:
        stop.wait()
    finally:
        server.stop()
    return 0


# ---------------------------------------------------------------------------
# memory commands
# ---------------------------------------------------------------------------

def doctor_cmd(data_dir: str) -> int:
    print("python:", platform.python_version())
    print("sqlite:", sqlite3.sqlite_version)
    try:
        probe = sqlite3.connect(":memory:")
        probe.execute("CREATE VIRTUAL TABLE t USING fts5(x)")
        probe.close()
        print("fts5: ok")
    except sqlite3.Error as exc:
        print("fts5: FAIL", exc)
    print("data_dir:", data_dir, "exists=", os.path.isdir(data_dir))
    try:
        os.makedirs(data_dir, exist_ok=True)
        probe_path = os.path.join(data_dir, ".doctor_probe")
        with open(probe_path, "w", encoding="utf-8") as handle:
            handle.write("ok")
        os.remove(probe_path)
        print("data_dir writable: yes")
    except OSError as exc:
        print("data_dir writable: no", exc)
    info_path = os.path.join(data_dir, ".run", "core.json")
    if os.path.exists(info_path):
        try:
            with open(info_path, "r", encoding="utf-8") as handle:
                info = json.load(handle)
            alive = _port_open(info.get("port")) if info.get("port") else False
            print("core: port=%s pid=%s alive=%s" % (info.get("port"), info.get("pid"), alive))
        except (OSError, ValueError):
            print("core: core.json unreadable")
    else:
        print("core: not running")
    db_path = os.path.join(data_dir, "core.db")
    print("core.db:", os.path.getsize(db_path) if os.path.exists(db_path) else "missing")
    return 0


def init_cmd(data_dir: str) -> int:
    conn = _connect(data_dir)
    conn.close()
    print("initialized:", data_dir)
    return 0


def ingest_cmd(data_dir: str, path: str) -> int:
    from . import db

    conn = _connect(data_dir)
    count = 0
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            db.ingest_raw_event(conn, data_dir, event)
            count += 1
    conn.close()
    print("ingested:", count)
    return 0


def search_cmd(data_dir: str, query: str, project: str, limit: int) -> int:
    from . import db

    conn = _connect(data_dir)
    results = db.search(conn, project, query, limit)
    print(json.dumps(results, ensure_ascii=False, indent=2))
    conn.close()
    return 0


def get_cmd(data_dir: str, ident: str) -> int:
    from . import db

    conn = _connect(data_dir)
    payload = db.get_note(conn, ident) or db.get_summary(conn, ident) or db.get_advice(conn, ident)
    if not payload and ident.isdigit():
        payload = db.read_cold_turn(conn, data_dir, int(ident))
        if not payload:
            row = conn.execute("SELECT * FROM turns WHERE id=?", (int(ident),)).fetchone()
            if row:
                payload = dict(row)
    print(json.dumps(payload, ensure_ascii=False, indent=2) if payload else "not found")
    conn.close()
    return 0 if payload else 1


def recent_cmd(data_dir: str, project: str, limit: int) -> int:
    from . import db

    conn = _connect(data_dir)
    print(json.dumps(db.recent_turns(conn, project, limit), ensure_ascii=False, indent=2))
    conn.close()
    return 0


def brief_cmd(data_dir: str, project: str) -> int:
    from . import db

    conn = _connect(data_dir)
    print(db.build_brief(conn, project))
    conn.close()
    return 0


def note_cmd(data_dir: str, project: str, kind: str, text: str, tags) -> int:
    from . import db

    conn = _connect(data_dir)
    print(json.dumps(db.add_note(conn, project, kind, text, tags=tags), ensure_ascii=False, indent=2))
    conn.close()
    return 0


def stats_cmd(data_dir: str, project: str) -> int:
    from . import db

    conn = _connect(data_dir)
    print(json.dumps(db.stats(conn, project), ensure_ascii=False, indent=2))
    conn.close()
    return 0


def export_cmd(data_dir: str, project: str, out: str) -> int:
    conn = _connect(data_dir)
    os.makedirs(out, exist_ok=True)
    rows = conn.execute(
        "SELECT * FROM turns WHERE project=? AND deleted=0 AND state != 'cold' ORDER BY occurred_at",
        (project,),
    ).fetchall()
    path = os.path.join(out, "turns-%s.jsonl" % project)
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(dict(row), ensure_ascii=False) + "\n")
    print("exported:", len(rows), "->", path)
    conn.close()
    return 0


def backup_cmd(data_dir: str, label: str) -> int:
    db_path = os.path.join(data_dir, "core.db")
    if not os.path.exists(db_path):
        print("core.db not found")
        return 1
    backup_dir = os.path.join(data_dir, "backups")
    os.makedirs(backup_dir, exist_ok=True)
    target = os.path.join(backup_dir, "core-%s-%s.db" % (label, time.strftime("%Y%m%d-%H%M%S")))
    source = sqlite3.connect(db_path)
    destination = sqlite3.connect(target)
    with destination:
        source.backup(destination)
    source.close()
    destination.close()
    print("backup:", target)
    return 0


# ---------------------------------------------------------------------------
# recycle / compress / archive
# ---------------------------------------------------------------------------

def recycle_cmd(data_dir: str, project: str, ref_id: int) -> int:
    from . import db

    conn = _connect(data_dir)
    ok = db.recycle_turn(conn, project, ref_id)
    conn.close()
    print("recycled" if ok else "not found")
    return 0 if ok else 1


def restore_cmd(data_dir: str, project: str, ref_id: int) -> int:
    from . import db

    conn = _connect(data_dir)
    ok = db.restore_turn(conn, project, ref_id)
    conn.close()
    print("restored" if ok else "not found")
    return 0 if ok else 1


def purge_cmd(data_dir: str, project: str, include_cold: bool) -> int:
    from . import db

    conn = _connect(data_dir)
    print(json.dumps(db.purge(conn, data_dir, project, include_cold), ensure_ascii=False))
    conn.close()
    return 0


def compress_cmd(data_dir: str, project: str, batch: int, confirm: bool) -> int:
    from . import compress, db

    conn = _connect(data_dir)
    try:
        result = compress.apply(conn, project, batch) if confirm else compress.preview(conn, project, batch)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    finally:
        conn.close()


def archive_cmd(data_dir: str, project: str, now: bool) -> int:
    from . import db

    conn = _connect(data_dir)
    try:
        archived = db.archive_project(conn, data_dir, project, now)
        print(json.dumps({"status": "ok", "project": project, "archived": archived}, ensure_ascii=False))
        return 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# parser
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="secretary-core")
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--data-dir", default=None)
    sub = parser.add_subparsers(dest="command")

    def add(name: str, help_text: str):
        node = sub.add_parser(name, help=help_text)
        node.add_argument("--data-dir", default=argparse.SUPPRESS)
        return node

    add("serve", "run the local core HTTP server")
    add("doctor", "check python/sqlite/fts5/data dir")
    add("init", "create the database")

    ingest_p = add("ingest", "ingest a JSONL file of events")
    ingest_p.add_argument("--file", required=True)

    search_p = add("search", "search memory")
    search_p.add_argument("query")
    search_p.add_argument("--project", required=True)
    search_p.add_argument("--limit", type=int, default=5)

    get_p = add("get", "get a turn/note/summary by id")
    get_p.add_argument("ident")

    recent_p = add("recent", "recent turns")
    recent_p.add_argument("--project", required=True)
    recent_p.add_argument("--limit", type=int, default=5)

    brief_p = add("brief", "read the project brief")
    brief_p.add_argument("--project", required=True)

    note_p = add("note", "write a note")
    note_p.add_argument("--project", required=True)
    note_p.add_argument("--kind", default="note")
    note_p.add_argument("--text", required=True)
    note_p.add_argument("--tags", default=None)

    stats_p = add("stats", "project counts")
    stats_p.add_argument("--project", required=True)

    export_p = add("export", "export turns to JSONL")
    export_p.add_argument("--project", required=True)
    export_p.add_argument("--out", default="exports")

    backup_p = add("backup", "sqlite online backup")
    backup_p.add_argument("--label", default="manual")

    compress_p = add("compress", "rule-based memory compression")
    compress_p.add_argument("--project", required=True)
    compress_p.add_argument("--batch", type=int, default=20)
    compress_p.add_argument("--confirm", action="store_true")

    archive_p = add("archive", "archive processed turns to the cold layer")
    archive_p.add_argument("--project", required=True)
    archive_p.add_argument("--now", action="store_true")

    recycle_p = add("recycle", "soft-delete a turn")
    recycle_p.add_argument("--project", required=True)
    recycle_p.add_argument("--id", type=int, required=True)

    restore_p = add("restore", "restore a soft-deleted turn")
    restore_p.add_argument("--project", required=True)
    restore_p.add_argument("--id", type=int, required=True)

    purge_p = add("purge", "purge soft-deleted turns")
    purge_p.add_argument("--project", required=True)
    purge_p.add_argument("--now", action="store_true")
    purge_p.add_argument("--cold", action="store_true")

    args = parser.parse_args(argv)
    data_dir = getattr(args, "data_dir", None) or default_data_dir()

    handlers = {
        "serve": lambda: serve(data_dir),
        "doctor": lambda: doctor_cmd(data_dir),
        "init": lambda: init_cmd(data_dir),
        "ingest": lambda: ingest_cmd(data_dir, args.file),
        "search": lambda: search_cmd(data_dir, args.query, args.project, args.limit),
        "get": lambda: get_cmd(data_dir, args.ident),
        "recent": lambda: recent_cmd(data_dir, args.project, args.limit),
        "brief": lambda: brief_cmd(data_dir, args.project),
        "note": lambda: note_cmd(data_dir, args.project, args.kind, args.text, args.tags),
        "stats": lambda: stats_cmd(data_dir, args.project),
        "export": lambda: export_cmd(data_dir, args.project, args.out),
        "backup": lambda: backup_cmd(data_dir, args.label),
        "compress": lambda: compress_cmd(data_dir, args.project, args.batch, args.confirm),
        "archive": lambda: archive_cmd(data_dir, args.project, args.now),
        "recycle": lambda: recycle_cmd(data_dir, args.project, args.id),
        "restore": lambda: restore_cmd(data_dir, args.project, args.id),
        "purge": lambda: purge_cmd(data_dir, args.project, args.cold or args.now),
    }

    if args.command in handlers:
        return handlers[args.command]()
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
