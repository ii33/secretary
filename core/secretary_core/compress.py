"""Rule-based compressor: turn raw conversation into durable notes + brief.

No LLM. Conservative extraction only:
  - 明确决策 (decision)
  - 偏好/约定 (preference)
  - 带数字的完成项 (completion)
  - 未决问题 (open_question)

The output feeds `notes` (durable memory) and `brief` (<=400 chars, injected into
the system prompt every turn). Applying also marks the source turns as
`state='processed'` so they are not compressed twice.
"""

from __future__ import annotations

import re

from . import db

MAX_BRIEF_CHARS = 400
MAX_ITEM_CHARS = 120

_SENTENCE_SPLIT = re.compile(r"[。！？!?\n\r]+")

# 优先级：决策 > 完成 > 偏好 > 未决
_DECISION = re.compile(r"决定|就按|采用|改为|改成|定为|确定|结论|方案是|定下来|拍板|确认了")
_PREFERENCE = re.compile(r"喜欢|偏好|习惯|希望|不要|避免|倾向|更愿意|最好|宁可|要求")
_COMPLETION_VERB = re.compile(r"完成|通过|修复|修好|搞定|跑通|上线|绿了|已解决|done")
_HAS_DIGIT = re.compile(r"\d")
_OPEN_QUESTION = re.compile(r"[?？]|待定|还没|未完成|未定|需要确认|不确定|TODO|待确认|遗留|阻塞")

_KIND_IMPORTANCE = {
    "decision": 3,
    "completion": 3,
    "preference": 2,
    "open_question": 2,
}


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _sentences(text: str):
    for raw in _SENTENCE_SPLIT.split(text or ""):
        sentence = _clean(raw)
        if sentence:
            yield sentence


def classify(sentence: str) -> str | None:
    if _DECISION.search(sentence):
        return "decision"
    if _COMPLETION_VERB.search(sentence) and _HAS_DIGIT.search(sentence):
        return "completion"
    if _PREFERENCE.search(sentence):
        return "preference"
    if _OPEN_QUESTION.search(sentence):
        return "open_question"
    return None


def extract(turns) -> list:
    """从 turn 列表提取候选记忆条目（按出现顺序，文本去重）。"""
    candidates = []
    seen = set()
    for turn in turns:
        for field in ("user_text", "assistant_text"):
            for sentence in _sentences(turn[field] if not isinstance(turn, dict) else turn.get(field, "")):
                kind = classify(sentence)
                if kind is None:
                    continue
                text = sentence[:MAX_ITEM_CHARS]
                key = re.sub(r"[\s，。！？、,.!?；;：:]+", "", text)
                if key in seen:
                    continue
                seen.add(key)
                candidates.append({
                    "kind": kind,
                    "text": text,
                    "source_turn_id": turn["id"] if not isinstance(turn, dict) else turn.get("id"),
                    "importance": _KIND_IMPORTANCE.get(kind, 1),
                    "tags": kind,
                })
    return candidates


def build_brief(project: str, candidates: list) -> str:
    """把候选条目拼成 <=400 字的项目简报。"""
    buckets = {"decision": [], "preference": [], "completion": [], "open_question": []}
    for item in candidates:
        bucket = buckets.get(item["kind"])
        if bucket is not None and len(bucket) < 4:
            bucket.append(item["text"])

    lines = ["项目简报（%s）" % project]
    labels = [
        ("decision", "决策"),
        ("preference", "偏好"),
        ("completion", "完成"),
        ("open_question", "未决"),
    ]
    for kind, label in labels:
        if buckets[kind]:
            lines.append("%s：%s" % (label, "；".join(buckets[kind])))

    text = "\n".join(lines)
    if len(text) > MAX_BRIEF_CHARS:
        text = text[: MAX_BRIEF_CHARS - 1] + "…"
    return text


def _hot_turns(conn, project: str, batch: int) -> list:
    rows = conn.execute(
        "SELECT * FROM turns WHERE project=? AND deleted=0 AND state='hot_raw'"
        " ORDER BY occurred_at ASC, id ASC LIMIT ?",
        (project, batch),
    ).fetchall()
    return [dict(row) for row in rows]


def _upsert_brief(conn, project: str, text: str, summary_id: str) -> None:
    conn.execute(
        "INSERT INTO brief (project, text, summary_id, version, updated_at)"
        " VALUES (?,?,?,1,?)"
        " ON CONFLICT(project) DO UPDATE SET"
        "   text=excluded.text,"
        "   summary_id=excluded.summary_id,"
        "   version=brief.version+1,"
        "   updated_at=excluded.updated_at",
        (project, text, summary_id, db.now_ms()),
    )


def preview(conn, project: str, batch: int) -> dict:
    turns = _hot_turns(conn, project, batch)
    candidates = extract(turns)
    return {
        "status": "preview",
        "project": project,
        "batch": batch,
        "turn_ids": [turn["id"] for turn in turns],
        "notes": candidates,
        "brief": build_brief(project, candidates),
    }


def apply(conn, project: str, batch: int) -> dict:
    turns = _hot_turns(conn, project, batch)
    if not turns:
        # 没有待压缩的 turn：不动简报，也不产生空 summary。
        return {
            "status": "ok",
            "summary_id": None,
            "notes_written": 0,
            "brief_updated": False,
            "processed": 0,
            "brief": db.build_brief(conn, project),
        }
    candidates = extract(turns)
    brief_text = build_brief(project, candidates)
    summary_id = db.new_id("S")
    stamp = db.now_ms()

    summary_row = conn.execute(
        "INSERT INTO summaries (id, project, batch, content, created_at) VALUES (?,?,?,?,?)",
        (summary_id, project, batch, brief_text, stamp),
    )
    if summary_row.lastrowid:
        db._index_row(conn, "summary_fts", summary_row.lastrowid, brief_text or "")

    written = 0
    for item in candidates:
        duplicate = conn.execute(
            "SELECT 1 FROM notes WHERE project=? AND text=? AND deleted=0",
            (project, item["text"]),
        ).fetchone()
        if duplicate:
            continue
        conn.execute(
            "INSERT INTO notes (id, project, kind, text, source_turn_id, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (db.new_id("N"), project, item["kind"], item["text"], item["source_turn_id"], stamp),
        )
        written += 1

    # 没有可提取条目时不覆盖已有简报（否则会把上一轮的成果清空）。
    brief_updated = bool(candidates)
    if brief_updated:
        _upsert_brief(conn, project, brief_text, summary_id)

    turn_ids = [turn["id"] for turn in turns]
    if turn_ids:
        placeholders = ",".join("?" for _ in turn_ids)
        conn.execute(
            "UPDATE turns SET state='processed', processed_at=?, summary_id=?"
            " WHERE id IN (%s)" % placeholders,
            [stamp, summary_id] + turn_ids,
        )
    conn.commit()

    return {
        "status": "ok",
        "summary_id": summary_id,
        "notes_written": written,
        "brief_updated": brief_updated,
        "processed": len(turn_ids),
        "brief": db.build_brief(conn, project),
    }
