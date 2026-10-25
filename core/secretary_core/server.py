"""Local HTTP server exposing the secretary-core REST API."""

from __future__ import annotations

import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from urllib.parse import parse_qs, urlparse

from . import compress, db


def setup_logging(data_dir: str) -> logging.Logger:
    logger = logging.getLogger("secretary_core")
    if logger.handlers:
        return logger
    try:
        log_dir = os.path.join(data_dir, "logs")
        os.makedirs(log_dir, exist_ok=True)
        handler = RotatingFileHandler(
            os.path.join(log_dir, "core.log"),
            maxBytes=2 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    except OSError:
        pass
    return logger


def _limit_text(payload, limit: int = 1200):
    """服务端强制限长（memory_get ≤1200 字）。"""
    if not isinstance(payload, dict):
        return payload
    for key in ("text", "content", "user_text", "assistant_text", "recommendation"):
        value = payload.get(key)
        if isinstance(value, str) and len(value) > limit:
            payload[key] = value[: limit - 1] + "…"
    return payload


class CoreServer:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.logger = setup_logging(data_dir)
        self.conn = db.connect(data_dir)
        self.httpd: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    def start(self) -> int:
        handler = self._make_handler()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.httpd.daemon_threads = True
        port = self.httpd.server_address[1]
        self._write_core_info(port)
        self.logger.info("core listening on 127.0.0.1:%d data_dir=%s", port, self.data_dir)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return port

    def _write_core_info(self, port: int) -> None:
        run_dir = os.path.join(self.data_dir, ".run")
        os.makedirs(run_dir, exist_ok=True)
        info = {"port": port, "pid": os.getpid(), "dataDir": self.data_dir}
        tmp = os.path.join(run_dir, "core.json.tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(info, handle)
        os.replace(tmp, os.path.join(run_dir, "core.json"))

    def stop(self) -> None:
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        try:
            self.conn.close()
        except Exception:
            pass

    def _make_handler(self):
        conn = self.conn
        data_dir = self.data_dir
        logger = self.logger

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # silence default logging
                pass

            def _send(self, status: int, payload) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except Exception:
                    pass

            def _read_json(self) -> dict:
                length = int(self.headers.get("content-length") or 0)
                if not length:
                    return {}
                raw = self.rfile.read(length)
                try:
                    parsed = json.loads(raw)
                    return parsed if isinstance(parsed, dict) else {}
                except Exception:
                    return {}

            def do_GET(self):
                self._route("GET")

            def do_POST(self):
                self._route("POST")

            def do_DELETE(self):
                self._route("DELETE")

            def _route(self, method: str):
                parsed = urlparse(self.path)
                query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
                body = self._read_json() if method in ("POST", "PUT") else {}
                try:
                    status, payload = self._dispatch(method, parsed.path, query, body)
                except Exception as exc:  # keep the server alive on handler errors
                    logger.exception("dispatch failed: %s %s", method, parsed.path)
                    status, payload = 500, {"error": str(exc)}
                self._send(status, payload)

            def _dispatch(self, method: str, path: str, query: dict, body: dict):
                if method == "POST" and path == "/v1/events":
                    if body.get("cold"):
                        return 200, db.insert_cold_turn(conn, data_dir, body)
                    return 200, db.insert_turn(conn, body)

                if method == "POST" and path == "/v1/raw-events":
                    return 200, db.ingest_raw_event(conn, data_dir, body)

                if method == "POST" and path == "/v1/raw-events/replay":
                    return 200, {
                        "replayed": db.replay_raw_events(
                            conn, data_dir, bool(body.get("only_failed", True))
                        )
                    }

                if method == "GET" and path == "/v1/search":
                    project = query.get("project", "default")
                    limit = int(query.get("limit", 5))
                    scope = query.get("scope", "hot")
                    results = db.search(
                        conn, project, query.get("q", ""), limit,
                        data_dir=data_dir, include_cold=(scope == "all"),
                    )
                    return 200, {"results": results}

                if method == "GET" and path == "/v1/projects":
                    return 200, {"projects": db.list_projects(conn)}

                if method == "GET" and path in ("/v1/summarize/preview", "/v1/compress/preview"):
                    return 200, compress.preview(
                        conn, query.get("project", "default"), int(query.get("batch", 20))
                    )

                if method == "POST" and path in ("/v1/summarize", "/v1/compress"):
                    project = body.get("project", "default")
                    batch = int(body.get("batch", 20))
                    # /v1/compress 不带 confirm 时只做 dry-run；/v1/summarize 为兼容旧契约直接落库。
                    if path == "/v1/compress" and not body.get("confirm"):
                        return 200, compress.preview(conn, project, batch)
                    return 200, compress.apply(conn, project, batch)

                if path == "/v1/taskboard":
                    if method == "GET":
                        return 200, {"items": db.list_taskboard(conn, query.get("project", "default"))}
                    if method == "POST":
                        if body.get("remove"):
                            ok = db.remove_task(conn, body.get("id"))
                            return (200, {"status": "removed"}) if ok else (404, {"error": "not found"})
                        if body.get("id"):
                            row = db.update_task(
                                conn, body["id"], body.get("status"),
                                body.get("title"), body.get("detail"), body.get("actor"),
                            )
                            return (200, row) if row else (404, {"error": "not found"})
                        return 200, db.add_task(
                            conn,
                            body.get("project", "default"),
                            body.get("section", "current"),
                            body.get("title", ""),
                            body.get("detail", ""),
                            body.get("actor", "user"),
                        )

                if method == "DELETE" and path.startswith("/v1/taskboard/"):
                    task_id = path[len("/v1/taskboard/"):]
                    ok = db.remove_task(conn, task_id)
                    return (200, {"status": "removed"}) if ok else (404, {"error": "not found"})

                if path == "/v1/conventions":
                    if method == "GET":
                        return 200, {"items": db.list_conventions(conn, query.get("project", "default"))}
                    if method == "POST":
                        if body.get("remove"):
                            ok = db.remove_convention(conn, body.get("id"))
                            return (200, {"status": "removed"}) if ok else (404, {"error": "not found"})
                        if body.get("id"):
                            row = db.update_convention(
                                conn, body["id"], body.get("status"),
                                body.get("title"), body.get("detail"), body.get("kind"),
                            )
                            return (200, row) if row else (404, {"error": "not found"})
                        return 200, db.add_convention(
                            conn,
                            body.get("project", "default"),
                            body.get("kind", "avoid"),
                            body.get("title", ""),
                            body.get("actor", "user"),
                            body.get("detail", ""),
                        )

                if method == "DELETE" and path.startswith("/v1/conventions/"):
                    conv_id = path[len("/v1/conventions/"):]
                    ok = db.remove_convention(conn, conv_id)
                    return (200, {"status": "removed"}) if ok else (404, {"error": "not found"})

                if method == "POST" and path == "/v1/archive":
                    archived = db.archive_project(
                        conn, data_dir, body.get("project", "default"), bool(body.get("now"))
                    )
                    return 200, {"status": "ok", "archived": archived}

                if method == "GET" and path == "/v1/cold":
                    return 200, {"items": db.list_cold(conn, query.get("project", "default"))}

                if path == "/v1/recycle":
                    if method == "GET":
                        return 200, {"items": db.list_recycle(conn, query.get("project", "default"))}
                    if method == "POST":
                        ok = db.recycle_turn(
                            conn, body.get("project", "default"), int(body.get("id", 0))
                        )
                        return (200, {"status": "recycled"}) if ok else (404, {"error": "not found"})

                if method == "POST" and path == "/v1/restore":
                    ok = db.restore_turn(
                        conn, body.get("project", "default"), int(body.get("id", 0))
                    )
                    return (200, {"status": "restored"}) if ok else (404, {"error": "not found"})

                if method == "GET" and path == "/v1/stats":
                    return 200, db.stats(conn, query.get("project", "default"))

                if method == "GET" and path == "/v1/audit":
                    return 200, {"items": db.list_audit(conn, int(query.get("limit", 50)))}

                if path == "/v1/artifacts":
                    if method == "GET":
                        return 200, {"items": db.list_artifacts(conn, query.get("project", "default"))}
                    if method == "POST":
                        return 200, db.add_artifact(
                            conn,
                            body.get("project", "default"),
                            body.get("title", ""),
                            body.get("path", ""),
                            body.get("kind", "file"),
                            body.get("summary", ""),
                            body.get("source_turn"),
                        )

                if method == "GET" and path == "/v1/roles":
                    return 200, {"items": db.list_role_policies(conn, query.get("project", "default"))}

                if method == "POST" and path == "/v1/purge":
                    return 200, db.purge(
                        conn, data_dir, body.get("project", "default"), bool(body.get("cold"))
                    )

                if method == "GET" and path == "/v1/advice":
                    return 200, {
                        "items": db.list_advice(
                            conn,
                            query.get("project", "default"),
                            query.get("status") or None,
                        )
                    }

                if method == "POST" and path == "/v1/advice":
                    return 200, db.add_advice(
                        conn,
                        body.get("project", "default"),
                        body.get("subject", ""),
                        body.get("recommendation", ""),
                        body.get("evidence", ""),
                    )

                if method == "POST" and path.startswith("/v1/advice/"):
                    if path.endswith("/delivered"):
                        advice_id = path[len("/v1/advice/"):-len("/delivered")]
                        row = db.set_advice_status(conn, advice_id, "delivered")
                        return (200, row) if row else (404, {"error": "not found"})
                    if path.endswith("/decision"):
                        advice_id = path[len("/v1/advice/"):-len("/decision")]
                        row = db.set_advice_status(conn, advice_id, body.get("decision", "accepted"))
                        return (200, row) if row else (404, {"error": "not found"})

                if method == "GET" and path.startswith("/v1/notes/"):
                    note = db.get_note(conn, path[len("/v1/notes/"):])
                    return (200, note) if note else (404, {"error": "not found"})

                if method == "GET" and path.startswith("/v1/get/"):
                    ident = path[len("/v1/get/"):]
                    payload = None
                    note = db.get_note(conn, ident)
                    if note:
                        payload = note
                    else:
                        summary = db.get_summary(conn, ident)
                        if summary:
                            payload = summary
                        else:
                            advice = db.get_advice(conn, ident)
                            if advice:
                                payload = advice
                            elif ident.isdigit():
                                # 数字 id 视为 turn：冷层从 cold 文件读回
                                turn_id = int(ident)
                                payload = db.read_cold_turn(conn, data_dir, turn_id)
                                if not payload:
                                    row = conn.execute(
                                        "SELECT * FROM turns WHERE id=?", (turn_id,)
                                    ).fetchone()
                                    if row:
                                        payload = dict(row)
                    if payload is None:
                        return 404, {"error": "not found"}
                    return 200, _limit_text(payload, 1200)

                if method == "POST" and path == "/v1/notes":
                    return 200, db.add_note(
                        conn,
                        body.get("project", "default"),
                        body.get("kind", "note"),
                        body.get("text", ""),
                        body.get("source_turn_id"),
                        body.get("tags"),
                        float(body.get("importance", 0.5)),
                    )

                if method == "POST" and path.startswith("/v1/notes/") and path.endswith("/status"):
                    note_id = path[len("/v1/notes/"):-len("/status")]
                    row = db.set_note_status(
                        conn, note_id, body.get("status", "active"), body.get("superseded_by")
                    )
                    return (200, row) if row else (404, {"error": "not found"})

                if method == "GET" and path == "/v1/recent":
                    limit = int(query.get("n", 10))
                    return 200, {"results": db.recent_turns(conn, query.get("project", "default"), limit)}

                if method == "GET" and path == "/v1/brief":
                    return 200, {"text": db.build_brief(conn, query.get("project", "default"))}

                if method == "GET" and path == "/v1/agent-names":
                    return 200, {"names": db.list_agent_names(conn, query.get("project", "default"))}

                if method == "POST" and path == "/v1/agent-names":
                    return 200, db.set_agent_name(
                        conn,
                        body.get("project", "default"),
                        body.get("session_id", ""),
                        body.get("name", ""),
                    )

                if path == "/v1/project-presets":
                    if method == "GET":
                        return 200, {"items": db.list_project_presets(conn, query.get("project", "default"))}
                    if method == "POST":
                        return 200, db.upsert_project_preset(
                            conn,
                            body.get("project", "default"),
                            body.get("id", ""),
                            body.get("name", ""),
                            body.get("content", ""),
                            body.get("source", "custom"),
                        )

                if method == "DELETE" and path.startswith("/v1/project-presets/"):
                    preset_id = path[len("/v1/project-presets/"):]
                    ok = db.remove_project_preset(conn, query.get("project", "default"), preset_id)
                    return (200, {"status": "removed"}) if ok else (404, {"error": "not found"})

                if method == "GET" and path == "/v1/health":
                    return 200, {"status": "ok"}

                return 404, {"error": "not found"}

        return Handler
