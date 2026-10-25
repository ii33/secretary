"""SQLite persistence layer for secretary-core."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import sqlite3
import time
import unicodedata
import uuid

SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")

# ---------------------------------------------------------------------------
# 中文 bigram 分词（配合 FTS5 unicode61；不引入 jieba）
# ---------------------------------------------------------------------------

_CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")
_WORD_RUN = re.compile(r"[a-z0-9_]+")


def normalize_text(text: str) -> str:
    if not text:
        return ""
    return unicodedata.normalize("NFKC", text).lower()


def bigram_tokens(text: str) -> list:
    normalized = normalize_text(text)
    tokens = [match.group(0) for match in _WORD_RUN.finditer(normalized)]
    for run in _CJK_RUN.findall(normalized):
        if len(run) == 1:
            tokens.append(run)
        else:
            for index in range(len(run) - 1):
                tokens.append(run[index:index + 2])
    return tokens


def bigram_body(text: str) -> str:
    return " ".join(bigram_tokens(text))


def _index_row(conn: sqlite3.Connection, table: str, rowid: int, text: str) -> None:
    body = bigram_body(text)
    conn.execute("DELETE FROM %s WHERE rowid=?" % table, (rowid,))
    if body:
        conn.execute("INSERT INTO %s(rowid, body) VALUES (?, ?)" % table, (rowid, body))


def _unindex_row(conn: sqlite3.Connection, table: str, rowid: int) -> None:
    conn.execute("DELETE FROM %s WHERE rowid=?" % table, (rowid,))


def truncate_text(text: str | None, limit: int) -> str:
    if not text:
        return ""
    value = str(text)
    return value if len(value) <= limit else value[: limit - 1] + "…"


def make_snippet(text: str | None, tokens: list, limit: int = 160) -> str:
    """围绕首个命中 token 截取片段。"""
    if not text:
        return ""
    value = str(text)
    if len(value) <= limit:
        return value
    lowered = normalize_text(value)
    position = -1
    for token in tokens:
        found = lowered.find(token)
        if found >= 0 and (position < 0 or found < position):
            position = found
    if position < 0:
        return value[: limit - 1] + "…"
    start = max(0, position - limit // 3)
    end = min(len(value), start + limit)
    snippet = value[start:end]
    if start > 0:
        snippet = "…" + snippet
    if end < len(value):
        snippet = snippet + "…"
    return snippet[:limit]

# 老库升级：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，这里显式 ALTER。
TURN_EXTRA_COLUMNS = [
    ("state", "TEXT NOT NULL DEFAULT 'hot_raw'"),
    ("processed_at", "INTEGER"),
    ("summary_id", "TEXT"),
    ("importance", "INTEGER NOT NULL DEFAULT 0"),
    ("tags", "TEXT"),
    ("cold_ref", "TEXT"),
]


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return "%s-%s" % (prefix, uuid.uuid4().hex[:12])


def _audit(conn: sqlite3.Connection, actor: str, action: str,
           ref_type: str, ref_id, detail: str = "") -> None:
    try:
        conn.execute(
            "INSERT INTO audit (at, actor, action, ref_type, ref_id, detail) VALUES (?,?,?,?,?,?)",
            (now_ms(), actor, action, ref_type, str(ref_id) if ref_id is not None else None, detail),
        )
    except sqlite3.Error:
        pass


def list_audit(conn: sqlite3.Connection, limit: int = 50) -> list:
    rows = conn.execute("SELECT * FROM audit ORDER BY at DESC LIMIT ?", (limit,)).fetchall()
    return [dict(row) for row in rows]


def ingest_raw_event(conn: sqlite3.Connection, data_dir: str, event: dict) -> dict:
    """先落 raw_event，再归一化；失败记 error 供重放。"""
    payload = json.dumps(event, ensure_ascii=False)
    conn.execute(
        "INSERT OR IGNORE INTO raw_event"
        " (source, source_version, event_type, external_session, external_seq,"
        "  payload, received_at, normalizer_version)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (
            event.get("source"), event.get("source_version"), event.get("event_type"),
            event.get("external_session"), event.get("external_seq"), payload, now_ms(), "v1",
        ),
    )
    found = conn.execute(
        "SELECT id FROM raw_event WHERE source IS ? AND external_session IS ?"
        " AND external_seq IS ? AND event_type IS ?",
        (
            event.get("source"), event.get("external_session"),
            event.get("external_seq"), event.get("event_type"),
        ),
    ).fetchone()
    raw_id = found["id"] if found else None
    try:
        result = insert_cold_turn(conn, data_dir, event) if event.get("cold") else insert_turn(conn, event)
        if raw_id:
            conn.execute(
                "UPDATE raw_event SET normalized_at=?, error=NULL WHERE id=?", (now_ms(), raw_id)
            )
            conn.commit()
        return result
    except Exception as exc:  # noqa: BLE001 - 归一化失败要落 error 供重放
        if raw_id:
            conn.execute("UPDATE raw_event SET error=? WHERE id=?", (str(exc), raw_id))
            conn.commit()
        return {"status": "error", "error": str(exc)}


def replay_raw_events(conn: sqlite3.Connection, data_dir: str, only_failed: bool = True) -> int:
    sql = "SELECT * FROM raw_event"
    if only_failed:
        sql += " WHERE error IS NOT NULL OR normalized_at IS NULL"
    rows = conn.execute(sql).fetchall()
    count = 0
    for row in rows:
        try:
            event = json.loads(row["payload"])
        except (TypeError, ValueError):
            continue
        try:
            if event.get("cold"):
                insert_cold_turn(conn, data_dir, event)
            else:
                insert_turn(conn, event)
            conn.execute(
                "UPDATE raw_event SET normalized_at=?, error=NULL WHERE id=?", (now_ms(), row["id"])
            )
            count += 1
        except Exception as exc:  # noqa: BLE001
            conn.execute("UPDATE raw_event SET error=? WHERE id=?", (str(exc), row["id"]))
    conn.commit()
    return count


def _migrate(conn: sqlite3.Connection) -> None:
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(turns)")}
    for name, declaration in TURN_EXTRA_COLUMNS:
        if name not in existing:
            conn.execute("ALTER TABLE turns ADD COLUMN %s %s" % (name, declaration))
    # 补列之后再建依赖 state 的索引（老库执行 schema.sql 时还没有该列）。
    conn.execute("CREATE INDEX IF NOT EXISTS idx_turns_state ON turns (project, state, deleted)")
    # conventions 补 detail（约定也需要一段说明）
    conv_cols = {row["name"] for row in conn.execute("PRAGMA table_info(conventions)")}
    if "detail" not in conv_cols:
        conn.execute("ALTER TABLE conventions ADD COLUMN detail TEXT")
    # notes 补 tags/importance/status/superseded_by
    note_cols = {row["name"] for row in conn.execute("PRAGMA table_info(notes)")}
    for name, declaration in (
        ("tags", "TEXT"),
        ("importance", "REAL NOT NULL DEFAULT 0.5"),
        ("status", "TEXT NOT NULL DEFAULT 'active'"),
        ("superseded_by", "TEXT"),
    ):
        if name not in note_cols:
            conn.execute("ALTER TABLE notes ADD COLUMN %s %s" % (name, declaration))


def connect(data_dir: str) -> sqlite3.Connection:
    os.makedirs(data_dir, exist_ok=True)
    db_path = os.path.join(data_dir, "core.db")
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    with open(SCHEMA_PATH, "r", encoding="utf-8") as handle:
        conn.executescript(handle.read())
    _migrate(conn)
    ensure_fts(conn)
    conn.commit()
    return conn


def _reindex_all(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM turn_fts")
    conn.execute("DELETE FROM note_fts")
    conn.execute("DELETE FROM summary_fts")
    for row in conn.execute(
        "SELECT id, user_text, assistant_text FROM turns WHERE state != 'cold' AND deleted=0"
    ):
        _index_row(
            conn, "turn_fts", row["id"],
            "%s\n%s" % (row["user_text"] or "", row["assistant_text"] or ""),
        )
    for row in conn.execute("SELECT rowid, text FROM notes WHERE deleted=0"):
        _index_row(conn, "note_fts", row["rowid"], row["text"] or "")
    for row in conn.execute("SELECT rowid, content FROM summaries"):
        _index_row(conn, "summary_fts", row["rowid"], row["content"] or "")
    conn.commit()


def ensure_fts(conn: sqlite3.Connection) -> None:
    """老库升级后 FTS 为空但 turn 有数据时，补建索引。"""
    turn_count = conn.execute(
        "SELECT COUNT(*) FROM turns WHERE state != 'cold' AND deleted=0"
    ).fetchone()[0]
    fts_count = conn.execute("SELECT COUNT(*) FROM turn_fts").fetchone()[0]
    if turn_count > 0 and fts_count == 0:
        _reindex_all(conn)


# ---------------------------------------------------------------------------
# turns
# ---------------------------------------------------------------------------

def insert_turn(conn: sqlite3.Connection, event: dict) -> dict:
    payload = event.get("payload") or {}
    project = event.get("project") or payload.get("project") or "default"
    session = event.get("external_session")
    seq = event.get("external_seq")
    row = (
        project,
        session,
        seq,
        payload.get("role"),
        payload.get("preset"),
        payload.get("user_text"),
        payload.get("assistant_text"),
        event.get("source"),
        event.get("source_version"),
        event.get("event_type") or "turn.completed",
        event.get("occurred_at") or now_ms(),
        now_ms(),
    )
    cur = conn.execute(
        """INSERT INTO turns
               (project, session, seq, role, preset, user_text, assistant_text,
                source, source_version, event_type, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session, seq, project) DO UPDATE SET
               role=excluded.role,
               preset=excluded.preset,
               user_text=excluded.user_text,
               assistant_text=excluded.assistant_text,
               occurred_at=excluded.occurred_at""",
        row,
    )
    turn_id = cur.lastrowid
    if not turn_id:
        found = conn.execute(
            "SELECT id FROM turns WHERE session=? AND seq=? AND project=?",
            (session, seq, project),
        ).fetchone()
        turn_id = found["id"] if found else None
    if turn_id:
        _index_row(
            conn, "turn_fts", turn_id,
            "%s\n%s" % (payload.get("user_text") or "", payload.get("assistant_text") or ""),
        )
    conn.commit()
    return {"status": "ok", "id": turn_id}


def _turn_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "project": row["project"],
        "session": row["session"],
        "seq": row["seq"],
        "role": row["role"],
        "preset": row["preset"],
        "user": row["user_text"],
        "assistant": row["assistant_text"],
        "occurred_at": row["occurred_at"],
    }


def _fts_query(tokens: list) -> str:
    seen = set()
    parts = []
    for token in tokens:
        if token in seen:
            continue
        seen.add(token)
        parts.append('"%s"' % token.replace('"', ""))
    return " OR ".join(parts)


def _like_fallback(conn, project: str, query: str, limit: int) -> list:
    keyword = (query or "").strip()
    if not keyword:
        return []
    like = "%" + keyword + "%"
    rows = conn.execute(
        "SELECT * FROM turns WHERE project=? AND deleted=0 AND state != 'cold'"
        " AND (user_text LIKE ? OR assistant_text LIKE ?)"
        " ORDER BY occurred_at DESC LIMIT ?",
        (project, like, like, limit),
    ).fetchall()
    results = []
    for row in rows:
        item = _turn_dict(row)
        item["kind"] = "turn"
        item["score"] = 1.0
        item["snippet"] = truncate_text(
            "%s\n%s" % (row["user_text"] or "", row["assistant_text"] or ""), 160
        )
        item["user"] = truncate_text(row["user_text"], 160)
        item["assistant"] = truncate_text(row["assistant_text"], 160)
        results.append(item)
    return results


def search_turns(conn, project: str, query: str, limit: int = 5) -> list:
    normalized = normalize_text(query).strip()
    tokens = bigram_tokens(query)
    # 真正的 1 字查询（或无有效 token）才走 LIKE 回退；2 字词应走 FTS
    if not tokens or len(normalized) <= 1:
        return _like_fallback(conn, project, query, limit)

    fts = _fts_query(tokens)
    try:
        rows = conn.execute(
            "SELECT rowid FROM turn_fts WHERE turn_fts MATCH ? ORDER BY rank LIMIT 50",
            (fts,),
        ).fetchall()
    except sqlite3.OperationalError:
        return _like_fallback(conn, project, query, limit)
    if not rows:
        return _like_fallback(conn, project, query, limit)

    token_set = set(tokens)
    stamp = now_ms()
    scored = []
    for row in rows:
        turn = conn.execute("SELECT * FROM turns WHERE id=?", (row["rowid"],)).fetchone()
        if not turn:
            continue
        if turn["project"] != project or turn["deleted"] or turn["state"] == "cold":
            continue
        body = set(bigram_tokens("%s %s" % (turn["user_text"] or "", turn["assistant_text"] or "")))
        coverage = len(token_set & body) / len(token_set) if token_set else 0.0
        age_days = max(0.0, (stamp - (turn["occurred_at"] or stamp)) / 86400000.0)
        recency = 1.0 / (1.0 + age_days / 30.0)
        importance = min(1.0, float(turn["importance"] or 0) / 3.0)
        score = 0.62 * coverage + 0.20 * recency + 0.10 * importance + 0.08
        item = _turn_dict(turn)
        item["kind"] = "turn"
        item["score"] = round(score, 4)
        item["snippet"] = make_snippet(
            "%s\n%s" % (turn["user_text"] or "", turn["assistant_text"] or ""), tokens
        )
        item["user"] = truncate_text(turn["user_text"], 160)
        item["assistant"] = truncate_text(turn["assistant_text"], 160)
        scored.append(item)
    scored.sort(key=lambda entry: entry["score"], reverse=True)
    return scored[:limit]


def search_notes(conn, project: str, query: str, limit: int = 5) -> list:
    normalized = normalize_text(query).strip()
    tokens = bigram_tokens(query)
    if not tokens or len(normalized) <= 1:
        return []
    fts = _fts_query(tokens)
    try:
        rows = conn.execute(
            "SELECT rowid FROM note_fts WHERE note_fts MATCH ? ORDER BY rank LIMIT 30",
            (fts,),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    token_set = set(tokens)
    scored = []
    for row in rows:
        note = conn.execute("SELECT rowid, * FROM notes WHERE rowid=?", (row["rowid"],)).fetchone()
        if not note or note["project"] != project or note["deleted"]:
            continue
        if "status" in note.keys() and note["status"] == "superseded":
            continue
        body = set(bigram_tokens(note["text"] or ""))
        coverage = len(token_set & body) / len(token_set) if token_set else 0.0
        scored.append({
            "id": note["id"], "project": note["project"], "kind": "note",
            "note_kind": note["kind"],
            "text": truncate_text(note["text"], 160),
            "snippet": make_snippet(note["text"], tokens),
            "score": round(0.78 * coverage + 0.22, 4),
            "created_at": note["created_at"],
        })
    scored.sort(key=lambda entry: entry["score"], reverse=True)
    return scored[:limit]


def search(conn, project: str, query: str, limit: int = 5, data_dir: str | None = None,
           include_cold: bool = False) -> list:
    merged = search_turns(conn, project, query, limit) + search_notes(conn, project, query, limit)
    if include_cold and data_dir:
        merged += search_cold(conn, data_dir, project, query, limit)
    merged.sort(key=lambda entry: entry.get("score", 0), reverse=True)
    return merged[:limit]


def recent_turns(conn: sqlite3.Connection, project: str, limit: int = 10) -> list:
    rows = conn.execute(
        "SELECT * FROM turns WHERE project=? AND deleted=0 AND state != 'cold'"
        " ORDER BY occurred_at DESC LIMIT ?",
        (project, limit),
    ).fetchall()
    result = []
    for row in rows:
        item = _turn_dict(row)
        item["user"] = truncate_text(row["user_text"], 120)
        item["assistant"] = truncate_text(row["assistant_text"], 120)
        result.append(item)
    return result


def list_projects(conn: sqlite3.Connection) -> list:
    rows = conn.execute(
        "SELECT project, COUNT(*) AS n FROM turns WHERE deleted=0 GROUP BY project ORDER BY n DESC"
    ).fetchall()
    return [{"id": row["project"], "turns": row["n"]} for row in rows]


def archive_project(conn: sqlite3.Connection, data_dir: str, project: str,
                    everything: bool = False) -> int:
    """把 turn 原文写冷并清空正文。everything=True 时归档全部未冷 turn。"""
    sql = "SELECT * FROM turns WHERE project=? AND deleted=0 AND state != 'cold'"
    params = [project]
    if not everything:
        # 只归档已压缩、且超过 30 天的
        sql += " AND state='processed' AND occurred_at < ?"
        params.append(now_ms() - 30 * 24 * 3600 * 1000)
    rows = conn.execute(sql, params).fetchall()
    count = 0
    for row in rows:
        rel = _write_cold(conn, data_dir, row)
        conn.execute(
            "UPDATE turns SET state='cold', cold_ref=?, user_text=NULL, assistant_text=NULL WHERE id=?",
            (rel, row["id"]),
        )
        count += 1
    if count:
        _audit(conn, "system", "archive", "project", project, "archived=%d" % count)
    conn.commit()
    return count


# ---------------------------------------------------------------------------
# notes
# ---------------------------------------------------------------------------

def add_note(conn: sqlite3.Connection, project: str, kind: str, text: str,
             source_turn_id: int | None = None, tags: str | None = None,
             importance: float = 0.5) -> dict:
    note_id = new_id("N")
    cur = conn.execute(
        "INSERT INTO notes (id, project, kind, text, tags, importance, status, source_turn_id, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (note_id, project, kind, text, tags, importance, "active", source_turn_id, now_ms()),
    )
    if cur.lastrowid:
        _index_row(conn, "note_fts", cur.lastrowid, text or "")
    conn.commit()
    return {"id": note_id, "project": project, "kind": kind, "text": text,
            "tags": tags, "importance": importance, "status": "active"}


def get_note(conn: sqlite3.Connection, note_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM notes WHERE id=? AND deleted=0", (note_id,)).fetchone()
    if not row:
        return None
    keys = row.keys()
    return {
        "id": row["id"], "project": row["project"], "kind": row["kind"], "text": row["text"],
        "tags": row["tags"] if "tags" in keys else None,
        "importance": row["importance"] if "importance" in keys else None,
        "status": row["status"] if "status" in keys else "active",
        "superseded_by": row["superseded_by"] if "superseded_by" in keys else None,
        "created_at": row["created_at"],
    }


def set_note_status(conn: sqlite3.Connection, note_id: str, status: str,
                    superseded_by: str | None = None) -> dict | None:
    conn.execute(
        "UPDATE notes SET status=?, superseded_by=? WHERE id=?", (status, superseded_by, note_id)
    )
    conn.commit()
    return get_note(conn, note_id)


def recent_notes(conn: sqlite3.Connection, project: str, limit: int = 10) -> list:
    rows = conn.execute(
        "SELECT * FROM notes WHERE project=? AND deleted=0 ORDER BY created_at DESC LIMIT ?",
        (project, limit),
    ).fetchall()
    return [{"id": r["id"], "kind": r["kind"], "text": r["text"], "created_at": r["created_at"]}
            for r in rows]


def build_brief(conn: sqlite3.Connection, project: str) -> str:
    # 优先返回压缩产物（brief 表）；没有时退化为实时拼装。
    stored = conn.execute("SELECT text FROM brief WHERE project=?", (project,)).fetchone()
    if stored and stored["text"]:
        return stored["text"]
    lines = ["## 项目简报", ""]
    lines.append("项目：%s" % project)
    open_tasks = conn.execute(
        "SELECT * FROM taskboard WHERE project=? AND status!='done' ORDER BY created_at DESC LIMIT 5",
        (project,),
    ).fetchall()
    if open_tasks:
        lines.append("")
        lines.append("未完成任务：")
        for task in open_tasks:
            lines.append("- [%s] %s" % (task["status"], task["title"]))
    notes = recent_notes(conn, project, 5)
    if notes:
        lines.append("")
        lines.append("最近记忆：")
        for note in notes:
            lines.append("- (%s) %s" % (note["kind"], note["text"]))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# taskboard
# ---------------------------------------------------------------------------

def list_taskboard(conn: sqlite3.Connection, project: str) -> list:
    rows = conn.execute(
        "SELECT * FROM taskboard WHERE project=? ORDER BY created_at ASC", (project,)
    ).fetchall()
    return [_task_dict(r) for r in rows]


def _task_dict(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "project": row["project"], "section": row["section"],
            "title": row["title"], "detail": row["detail"], "status": row["status"],
            "actor": row["actor"], "created_at": row["created_at"],
            "updated_at": row["updated_at"]}


def add_task(conn: sqlite3.Connection, project: str, section: str, title: str,
             detail: str = "", actor: str = "user") -> dict:
    task_id = new_id("T")
    ts = now_ms()
    conn.execute(
        "INSERT INTO taskboard (id, project, section, title, detail, status, actor, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (task_id, project, section, title, detail, "open", actor, ts, ts),
    )
    conn.commit()
    return {"id": task_id, "project": project, "section": section, "title": title,
            "detail": detail, "status": "open", "actor": actor}


def update_task(conn: sqlite3.Connection, task_id: str, status: str | None = None,
                title: str | None = None, detail: str | None = None,
                actor: str | None = None) -> dict | None:
    sets = []
    params = []
    if status is not None:
        sets.append("status=?")
        params.append(status)
    if title is not None:
        sets.append("title=?")
        params.append(title)
    if detail is not None:
        sets.append("detail=?")
        params.append(detail)
    if not sets:
        row = conn.execute("SELECT * FROM taskboard WHERE id=?", (task_id,)).fetchone()
        return _task_dict(row) if row else None
    sets.append("updated_at=?")
    params.append(now_ms())
    params.append(task_id)
    conn.execute("UPDATE taskboard SET %s WHERE id=?" % ",".join(sets), params)
    conn.commit()
    row = conn.execute("SELECT * FROM taskboard WHERE id=?", (task_id,)).fetchone()
    return _task_dict(row) if row else None


def remove_task(conn: sqlite3.Connection, task_id: str) -> bool:
    cur = conn.execute("DELETE FROM taskboard WHERE id=?", (task_id,))
    conn.commit()
    return (cur.rowcount or 0) > 0


# ---------------------------------------------------------------------------
# conventions
# ---------------------------------------------------------------------------

def _conv_dict(row: sqlite3.Row) -> dict:
    keys = row.keys()
    return {"id": row["id"], "project": row["project"], "kind": row["kind"],
            "title": row["title"],
            "detail": row["detail"] if "detail" in keys else None,
            "status": row["status"], "actor": row["actor"],
            "created_at": row["created_at"]}


def list_conventions(conn: sqlite3.Connection, project: str) -> list:
    rows = conn.execute(
        "SELECT * FROM conventions WHERE project=? ORDER BY created_at ASC", (project,)
    ).fetchall()
    return [_conv_dict(r) for r in rows]


def add_convention(conn: sqlite3.Connection, project: str, kind: str, title: str,
                   actor: str = "user", detail: str = "") -> dict:
    conv_id = new_id("C")
    conn.execute(
        "INSERT INTO conventions (id, project, kind, title, detail, status, actor, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (conv_id, project, kind, title, detail, "active", actor, now_ms()),
    )
    conn.commit()
    return {"id": conv_id, "project": project, "kind": kind, "title": title,
            "detail": detail, "status": "active", "actor": actor}


def update_convention(conn: sqlite3.Connection, conv_id: str, status: str | None = None,
                      title: str | None = None, detail: str | None = None,
                      kind: str | None = None) -> dict | None:
    sets = []
    params = []
    if status is not None:
        sets.append("status=?")
        params.append(status)
    if title is not None:
        sets.append("title=?")
        params.append(title)
    if detail is not None:
        sets.append("detail=?")
        params.append(detail)
    if kind is not None:
        sets.append("kind=?")
        params.append(kind)
    if not sets:
        row = conn.execute("SELECT * FROM conventions WHERE id=?", (conv_id,)).fetchone()
        return _conv_dict(row) if row else None
    params.append(conv_id)
    conn.execute("UPDATE conventions SET %s WHERE id=?" % ",".join(sets), params)
    conn.commit()
    row = conn.execute("SELECT * FROM conventions WHERE id=?", (conv_id,)).fetchone()
    return _conv_dict(row) if row else None


def remove_convention(conn: sqlite3.Connection, conv_id: str) -> bool:
    cur = conn.execute("DELETE FROM conventions WHERE id=?", (conv_id,))
    conn.commit()
    return (cur.rowcount or 0) > 0


# ---------------------------------------------------------------------------
# advice
# ---------------------------------------------------------------------------

def _advice_dict(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "project": row["project"], "subject": row["subject"],
            "recommendation": row["recommendation"], "evidence": row["evidence"],
            "status": row["status"], "created_at": row["created_at"],
            "decided_at": row["decided_at"]}


def add_advice(conn: sqlite3.Connection, project: str, subject: str,
               recommendation: str, evidence: str = "") -> dict:
    advice_id = new_id("A")
    conn.execute(
        "INSERT INTO advice (id, project, subject, recommendation, evidence, status, created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (advice_id, project, subject, recommendation, evidence, "pending", now_ms()),
    )
    conn.commit()
    return {"id": advice_id, "project": project, "subject": subject,
            "recommendation": recommendation, "evidence": evidence, "status": "pending"}


def set_advice_status(conn: sqlite3.Connection, advice_id: str, status: str) -> dict | None:
    row = conn.execute("SELECT * FROM advice WHERE id=?", (advice_id,)).fetchone()
    if not row:
        return None
    decided = now_ms() if status in ("accepted", "rejected") else None
    conn.execute(
        "UPDATE advice SET status=?, decided_at=COALESCE(?, decided_at) WHERE id=?",
        (status, decided, advice_id),
    )
    if status == "accepted":
        # An accepted recommendation becomes a durable turn so it shows up in
        # recent memory and search, mirroring the original behaviour.
        ts = now_ms()
        conn.execute(
            "INSERT INTO turns (project, session, seq, role, preset, user_text,"
            " assistant_text, source, source_version, event_type, occurred_at, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                row["project"], "advice", ts, "secretary", "secretary",
                "采纳顾问建议：" + (row["subject"] or ""), row["recommendation"] or "",
                "advisor", "advisor", "advice.accepted", ts, ts,
            ),
        )
    conn.commit()
    updated = conn.execute("SELECT * FROM advice WHERE id=?", (advice_id,)).fetchone()
    return _advice_dict(updated) if updated else None


def pending_advice(conn: sqlite3.Connection, project: str) -> list:
    rows = conn.execute(
        "SELECT * FROM advice WHERE project=? AND status='pending' ORDER BY created_at DESC",
        (project,),
    ).fetchall()
    return [_advice_dict(r) for r in rows]


def list_advice(conn: sqlite3.Connection, project: str, status: str | None = None) -> list:
    sql = "SELECT * FROM advice WHERE project=?"
    params = [project]
    if status:
        sql += " AND status=?"
        params.append(status)
    sql += " ORDER BY created_at DESC"
    return [_advice_dict(row) for row in conn.execute(sql, params).fetchall()]


# ---------------------------------------------------------------------------
# recycle bin (soft-deleted turns)
# ---------------------------------------------------------------------------

def list_recycle(conn: sqlite3.Connection, project: str, limit: int = 200) -> list:
    rows = conn.execute(
        "SELECT * FROM turns WHERE project=? AND deleted=1 ORDER BY occurred_at DESC LIMIT ?",
        (project, limit),
    ).fetchall()
    return [_turn_dict(row) for row in rows]


def purge(conn: sqlite3.Connection, data_dir: str, project: str, include_cold: bool = False) -> dict:
    """彻底删除：软删的 turn（deleted=1）及其冷文件；include_cold 时连冷层一起清。"""
    condition = "deleted=1 OR state='cold'" if include_cold else "deleted=1"
    rows = conn.execute(
        "SELECT id, cold_ref FROM turns WHERE project=? AND (%s)" % condition, (project,)
    ).fetchall()
    count = 0
    for row in rows:
        if row["cold_ref"]:
            path = os.path.join(data_dir, row["cold_ref"])
            try:
                os.remove(path)
            except OSError:
                pass
            conn.execute(
                "DELETE FROM cold_index WHERE project=? AND turn_id=?", (project, row["id"])
            )
        _unindex_row(conn, "turn_fts", row["id"])
        conn.execute("DELETE FROM turns WHERE id=?", (row["id"],))
        count += 1
    if count:
        _audit(conn, "user", "purge", "project", project, "purged=%d cold=%s" % (count, include_cold))
    conn.commit()
    return {"status": "ok", "project": project, "purged": count}


def recycle_turn(conn: sqlite3.Connection, project: str, turn_id: int) -> bool:
    cur = conn.execute(
        "UPDATE turns SET deleted=1 WHERE project=? AND id=? AND deleted=0", (project, turn_id)
    )
    changed = (cur.rowcount or 0) > 0
    if changed:
        _audit(conn, "user", "recycle", "turn", turn_id)
    conn.commit()
    return changed


def restore_turn(conn: sqlite3.Connection, project: str, turn_id: int) -> bool:
    cur = conn.execute(
        "UPDATE turns SET deleted=0 WHERE project=? AND id=?", (project, turn_id)
    )
    changed = (cur.rowcount or 0) > 0
    if changed:
        _audit(conn, "user", "restore", "turn", turn_id)
    conn.commit()
    return changed


def stats(conn: sqlite3.Connection, project: str) -> dict:
    def one(sql: str, params=()) -> int:
        row = conn.execute(sql, params).fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    return {
        "project": project,
        "turns": one("SELECT COUNT(*) FROM turns WHERE project=? AND deleted=0 AND state != 'cold'", (project,)),
        "hot_raw": one("SELECT COUNT(*) FROM turns WHERE project=? AND deleted=0 AND state='hot_raw'", (project,)),
        "processed": one("SELECT COUNT(*) FROM turns WHERE project=? AND deleted=0 AND state='processed'", (project,)),
        "cold": one("SELECT COUNT(*) FROM turns WHERE project=? AND state='cold'", (project,)),
        "recycle": one("SELECT COUNT(*) FROM turns WHERE project=? AND deleted=1", (project,)),
        "notes": one("SELECT COUNT(*) FROM notes WHERE project=? AND deleted=0", (project,)),
        "advice_pending": one("SELECT COUNT(*) FROM advice WHERE project=? AND status='pending'", (project,)),
        "taskboard": one("SELECT COUNT(*) FROM taskboard WHERE project=?", (project,)),
        "conventions": one("SELECT COUNT(*) FROM conventions WHERE project=?", (project,)),
        # 简报可能没有落库（build_brief 会实时拼装），所以这里取**实际会被 /v1/brief 返回的长度**，
        # 而不是只看 brief 表 —— 否则指标恒为 0，排障时会误判"没有简报"。
        "brief_chars": len(build_brief(conn, project) or ""),
    }


# ---------------------------------------------------------------------------
# summaries
# ---------------------------------------------------------------------------

def add_summary(conn: sqlite3.Connection, project: str, batch: int) -> dict:
    rows = conn.execute(
        "SELECT * FROM turns WHERE project=? AND deleted=0 ORDER BY occurred_at DESC LIMIT ?",
        (project, batch),
    ).fetchall()
    summary_id = new_id("S")
    content = "\n".join(
        "- %s -> %s" % (r["user_text"] or "", r["assistant_text"] or "") for r in rows
    )
    cur = conn.execute(
        "INSERT INTO summaries (id, project, batch, content, created_at) VALUES (?,?,?,?,?)",
        (summary_id, project, batch, content, now_ms()),
    )
    if cur.lastrowid:
        _index_row(conn, "summary_fts", cur.lastrowid, content or "")
    conn.commit()
    return {"status": "ok", "summary_id": summary_id, "turns": len(rows)}


def preview_summary(conn: sqlite3.Connection, project: str, batch: int) -> dict:
    rows = conn.execute(
        "SELECT COUNT(*) AS n FROM turns WHERE project=? AND deleted=0", (project,)
    ).fetchone()
    return {"status": "preview", "project": project, "batch": batch,
            "available": rows["n"] if rows else 0}


def get_summary(conn: sqlite3.Connection, summary_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM summaries WHERE id=?", (summary_id,)).fetchone()
    if not row:
        return None
    return {"id": row["id"], "project": row["project"], "batch": row["batch"],
            "content": row["content"], "created_at": row["created_at"]}


def get_advice(conn: sqlite3.Connection, advice_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM advice WHERE id=?", (advice_id,)).fetchone()
    return _advice_dict(row) if row else None


# ---------------------------------------------------------------------------
# agent names（人员架构里每个会话的自定义名字）
# ---------------------------------------------------------------------------

def list_agent_names(conn: sqlite3.Connection, project: str) -> dict:
    rows = conn.execute(
        "SELECT session_id, name FROM agent_name WHERE project=?", (project,)
    ).fetchall()
    return {row["session_id"]: row["name"] for row in rows}


def set_agent_name(conn: sqlite3.Connection, project: str, session_id: str, name: str) -> dict:
    conn.execute(
        "INSERT INTO agent_name (project, session_id, name, updated_at) VALUES (?,?,?,?)"
        " ON CONFLICT(project, session_id) DO UPDATE SET"
        "   name=excluded.name, updated_at=excluded.updated_at",
        (project, session_id, name, now_ms()),
    )
    conn.commit()
    return {"project": project, "session_id": session_id, "name": name}


# ---------------------------------------------------------------------------
# project presets（项目本地预设，默认不进全局）
# ---------------------------------------------------------------------------

def list_project_presets(conn: sqlite3.Connection, project: str) -> list:
    rows = conn.execute(
        "SELECT * FROM project_preset WHERE project=? ORDER BY created_at ASC", (project,)
    ).fetchall()
    return [
        {"id": row["preset_id"], "name": row["name"], "content": row["content"],
         "source": row["source"], "created_at": row["created_at"]}
        for row in rows
    ]


def upsert_project_preset(conn: sqlite3.Connection, project: str, preset_id: str,
                          name: str, content: str, source: str = "custom") -> dict:
    conn.execute(
        "INSERT INTO project_preset (project, preset_id, name, content, source, created_at)"
        " VALUES (?,?,?,?,?,?)"
        " ON CONFLICT(project, preset_id) DO UPDATE SET"
        "   name=excluded.name, content=excluded.content, source=excluded.source",
        (project, preset_id, name, content, source, now_ms()),
    )
    conn.commit()
    return {"id": preset_id, "name": name, "content": content, "source": source}


def remove_project_preset(conn: sqlite3.Connection, project: str, preset_id: str) -> bool:
    cur = conn.execute(
        "DELETE FROM project_preset WHERE project=? AND preset_id=?", (project, preset_id)
    )
    conn.commit()
    return (cur.rowcount or 0) > 0


# ---------------------------------------------------------------------------
# cold layer（原文写到 cold/<project>/T<id>.json.gz，热表只留元数据）
# ---------------------------------------------------------------------------

def _cold_path(data_dir: str, project: str, turn_id: int) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", project or "default")
    return os.path.join(data_dir, "cold", safe, "T%s.json.gz" % turn_id)


def _write_cold(conn: sqlite3.Connection, data_dir: str, row: sqlite3.Row) -> str:
    full = dict(row)
    path = _cold_path(data_dir, full["project"], full["id"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = json.dumps(full, ensure_ascii=False).encode("utf-8")
    with gzip.open(path, "wb") as handle:
        handle.write(payload)
    rel = os.path.relpath(path, data_dir).replace("\\", "/")
    conn.execute(
        "INSERT OR REPLACE INTO cold_index (project, turn_id, file, length, sha256, created_at)"
        " VALUES (?,?,?,?,?,?)",
        (full["project"], full["id"], rel, len(payload),
         hashlib.sha256(payload).hexdigest(), now_ms()),
    )
    return rel


def insert_cold_turn(conn: sqlite3.Connection, data_dir: str, event: dict) -> dict:
    """直接落冷：写 cold 文件 + cold_index，turn 只留元数据（清空正文）。"""
    result = insert_turn(conn, event)
    turn_id = result.get("id")
    if not turn_id:
        return result
    row = conn.execute("SELECT * FROM turns WHERE id=?", (turn_id,)).fetchone()
    if not row:
        return result
    rel = _write_cold(conn, data_dir, row)
    conn.execute(
        "UPDATE turns SET state='cold', cold_ref=?, user_text=NULL, assistant_text=NULL WHERE id=?",
        (rel, turn_id),
    )
    # 冷层不参与热检索
    _unindex_row(conn, "turn_fts", turn_id)
    conn.commit()
    return {"status": "ok", "id": turn_id, "cold": True}


def read_cold_turn(conn: sqlite3.Connection, data_dir: str, turn_id: int) -> dict | None:
    row = conn.execute("SELECT cold_ref FROM turns WHERE id=?", (turn_id,)).fetchone()
    if not row or not row["cold_ref"]:
        return None
    path = os.path.join(data_dir, row["cold_ref"])
    if not os.path.exists(path):
        return None
    with gzip.open(path, "rb") as handle:
        return json.loads(handle.read().decode("utf-8"))


def list_cold(conn: sqlite3.Connection, project: str, limit: int = 200) -> list:
    rows = conn.execute(
        "SELECT t.id, t.project, t.session, t.seq, t.role, t.preset, t.occurred_at,"
        " t.cold_ref, c.length"
        " FROM turns t LEFT JOIN cold_index c ON c.project=t.project AND c.turn_id=t.id"
        " WHERE t.project=? AND t.state='cold' AND t.deleted=0"
        " ORDER BY t.occurred_at DESC LIMIT ?",
        (project, limit),
    ).fetchall()
    return [
        {"id": row["id"], "project": row["project"], "session": row["session"],
         "seq": row["seq"], "role": row["role"], "preset": row["preset"],
         "occurred_at": row["occurred_at"], "cold_ref": row["cold_ref"],
         "length": row["length"]}
        for row in rows
    ]


def search_cold(conn: sqlite3.Connection, data_dir: str, project: str, query: str,
                limit: int = 5) -> list:
    """冷层慢搜：解压冷文件后按 bigram 覆盖度匹配（scope=all 时用）。"""
    tokens = bigram_tokens(query)
    normalized = normalize_text(query).strip()
    if not tokens or len(normalized) <= 1:
        return []
    token_set = set(tokens)
    rows = conn.execute(
        "SELECT id FROM turns WHERE project=? AND state='cold' AND deleted=0", (project,)
    ).fetchall()
    scored = []
    for row in rows:
        full = read_cold_turn(conn, data_dir, row["id"])
        if not full:
            continue
        text = "%s\n%s" % (full.get("user_text") or "", full.get("assistant_text") or "")
        body = set(bigram_tokens(text))
        coverage = len(token_set & body) / len(token_set) if token_set else 0.0
        if coverage <= 0:
            continue
        scored.append({
            "id": row["id"], "project": project, "kind": "cold",
            "user": truncate_text(full.get("user_text"), 160),
            "assistant": truncate_text(full.get("assistant_text"), 160),
            "snippet": make_snippet(text, tokens),
            "score": round(0.7 * coverage + 0.3, 4),
            "cold": True,
        })
    scored.sort(key=lambda entry: entry["score"], reverse=True)
    return scored[:limit]


# ---------------------------------------------------------------------------
# artifacts
# ---------------------------------------------------------------------------

def add_artifact(conn: sqlite3.Connection, project: str, title: str, path: str,
                 kind: str = "file", summary: str = "", source_turn=None) -> dict:
    artifact_id = new_id("F")
    conn.execute(
        "INSERT INTO artifact (id, project, title, path, kind, summary, source_turn, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (artifact_id, project, title, path, kind, summary, source_turn, now_ms()),
    )
    conn.commit()
    return {"id": artifact_id, "project": project, "title": title, "path": path,
            "kind": kind, "summary": summary, "source_turn": source_turn}


def list_artifacts(conn: sqlite3.Connection, project: str, limit: int = 100) -> list:
    rows = conn.execute(
        "SELECT * FROM artifact WHERE project=? AND deleted=0 ORDER BY created_at DESC LIMIT ?",
        (project, limit),
    ).fetchall()
    return [dict(row) for row in rows]


def get_artifact(conn: sqlite3.Connection, artifact_id: str):
    row = conn.execute("SELECT * FROM artifact WHERE id=? AND deleted=0", (artifact_id,)).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# role policies（控制台只读）
# ---------------------------------------------------------------------------

def list_role_policies(conn: sqlite3.Connection, project: str) -> list:
    rows = conn.execute(
        "SELECT * FROM role_policy WHERE project=? ORDER BY role", (project,)
    ).fetchall()
    return [dict(row) for row in rows]


def upsert_role_policy(conn: sqlite3.Connection, project: str, role: str, **fields) -> dict | None:
    existing = conn.execute(
        "SELECT * FROM role_policy WHERE project=? AND role=?", (project, role)
    ).fetchone()
    columns = ("preset", "provider", "model", "effort", "sandbox", "limits_json")
    if existing:
        sets = []
        params = []
        for key in columns:
            if key in fields:
                sets.append("%s=?" % key)
                params.append(fields[key])
        if sets:
            params.extend([project, role])
            conn.execute(
                "UPDATE role_policy SET %s WHERE project=? AND role=?" % ",".join(sets), params
            )
    else:
        conn.execute(
            "INSERT INTO role_policy"
            " (project, role, preset, provider, model, effort, sandbox, limits_json, revision)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (project, role, fields.get("preset"), fields.get("provider"), fields.get("model"),
             fields.get("effort"), fields.get("sandbox"), fields.get("limits_json"), 1),
        )
    conn.commit()
    row = conn.execute("SELECT * FROM role_policy WHERE project=? AND role=?", (project, role)).fetchone()
    return dict(row) if row else None
