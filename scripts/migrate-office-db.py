#!/usr/bin/env python
"""把恢复出来的旧库 (office.db) 里的语义记忆迁移到重建核心用的新库 (core.db)。

背景：
  - 2026-10-23 的 DSH 更新删掉了 D:\\a\\dsh\\team，插件随安装目录一起丢；
  - 旧库 office.db 里表名是单数 (turn / note / advice)，project 记作 `dsh-team`；
  - 重建的 secretary-core 硬编码读 core.db，表名复数 (turns / notes / advice)，
    project 由 projectForCwd(cwd) 推导（D:\\a\\dsh\\team → "team"）。
  - turn 已由 index.js 的 backfillHistory 从会话日志重建，所以这里**只迁 turn 之外**的语义记忆，
    避免重复；project 保留原值 `dsh-team`，便于在控制台里区分"迁移来的历史"。

用法：
    python migrate-office-db.py [--dry-run] [--map dsh-team=team]

项目名归一（重要）：
    旧库的 project 取自 `<workspace>/.dsh/office.json`（例如 `dsh-team`），
    重建核心用 `projectForCwd()` 取目录名（`D:\\a\\dsh\\team` → `team`）。
    两者是**同一个工作区的两代命名**，不归一就会在控制台里变成两个项目，
    而 `dsh-team` 因为没有 turn 根本不出现在项目列表里（迁移的 note/advice 就看不见）。
"""
from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "core"))
try:
    from secretary_core import db as core_db
except ImportError:  # 允许脚本独立运行
    core_db = None

DATA_DIR = os.path.join(os.environ.get("USERPROFILE", ""), ".secretary-office")
OLD = os.path.join(DATA_DIR, "office.db")
NEW = os.path.join(DATA_DIR, "core.db")


def columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in conn.execute(f'pragma table_info("{table}")')]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只报告将迁移什么，不写库")
    parser.add_argument(
        "--map",
        action="append",
        default=[],
        metavar="OLD=NEW",
        help="项目名归一，可重复：--map dsh-team=team",
    )
    args = parser.parse_args()

    project_map: dict[str, str] = {}
    for pair in args.map:
        if "=" not in pair:
            print(f"--map 需要 OLD=NEW 形式：{pair}", file=sys.stderr)
            return 2
        old_name, new_name = pair.split("=", 1)
        project_map[old_name.strip()] = new_name.strip()

    def resolve_project(value: str) -> str:
        return project_map.get(value, value)

    if not os.path.exists(OLD) or not os.path.exists(NEW):
        print(f"缺数据库：old={os.path.exists(OLD)} new={os.path.exists(NEW)}", file=sys.stderr)
        return 2

    if not args.dry_run:
        backup = f"{NEW}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(NEW, backup)
        print(f"已备份新库 → {backup}")

    old = sqlite3.connect(OLD)
    new = sqlite3.connect(NEW)
    new.execute("pragma journal_mode=WAL")

    report: list[str] = []

    # ---- notes：只保留新表有的列，tags/importance/status 等旧字段丢弃 ----
    new_cols = set(columns(new, "notes"))
    migrated_notes = 0
    for row in old.execute("select id, project_id, kind, text, source_turn, created_at from note"):
        note_id, project, kind, text, source_turn, created_at = row
        values = {
            "id": note_id,
            "project": resolve_project(project),
            "kind": kind,
            "text": text,
            "source_turn_id": source_turn,
            "created_at": created_at,
            "deleted": 0,
        }
        use = {k: v for k, v in values.items() if k in new_cols}
        cols = ", ".join(f'"{k}"' for k in use)
        marks = ", ".join("?" for _ in use)
        if not args.dry_run:
            cur = new.execute(f'insert or ignore into notes ({cols}) values ({marks})', tuple(use.values()))
            migrated_notes += cur.rowcount
        else:
            migrated_notes += 1
    report.append(f"notes: 旧库 {old.execute('select count(*) from note').fetchone()[0]} 行 → 迁移 {migrated_notes} 行")

    # ---- advice ----
    new_advice_cols = set(columns(new, "advice"))
    migrated_advice = 0
    for row in old.execute("select id, project_id, subject, recommendation, evidence, status, created_at, decided_at from advice"):
        advice_id, project, subject, recommendation, evidence, status, created_at, decided_at = row
        values = {
            "id": advice_id,
            "project": resolve_project(project),
            "subject": subject,
            "recommendation": recommendation,
            "evidence": evidence,
            "status": status,
            "created_at": created_at,
            "decided_at": decided_at,
        }
        use = {k: v for k, v in values.items() if k in new_advice_cols}
        cols = ", ".join(f'"{k}"' for k in use)
        marks = ", ".join("?" for _ in use)
        if not args.dry_run:
            cur = new.execute(f'insert or ignore into advice ({cols}) values ({marks})', tuple(use.values()))
            migrated_advice += cur.rowcount
        else:
            migrated_advice += 1
    report.append(f"advice: 旧库 {old.execute('select count(*) from advice').fetchone()[0]} 行 → 迁移 {migrated_advice} 行")

    # ---- audit：旧库结构与新表一致，直接迁移 ----
    migrated_audit = 0
    try:
        for row in old.execute("select at, actor, action, ref_type, ref_id, detail from audit"):
            at, actor, action, ref_type, ref_id, detail = row
            if not args.dry_run:
                cur = new.execute(
                    "insert into audit (at, actor, action, ref_type, ref_id, detail) values (?,?,?,?,?,?)",
                    (at, actor, action, ref_type, ref_id, detail),
                )
                migrated_audit += cur.rowcount
            else:
                migrated_audit += 1
        total = old.execute("select count(*) from audit").fetchone()[0]
        report.append(f"audit: 旧库 {total} 行 → 迁移 {migrated_audit} 行")
    except sqlite3.OperationalError:
        report.append("audit: 旧库无此表，跳过")

    # ---- 旧库里有、重建核心没有对应表的：如实报告而不是静默丢弃 ----
    old_tables = {row[0] for row in old.execute("select name from sqlite_master where type='table'")}
    skipped = []
    for table, count_sql in [
        ("taskboard", "select count(*) from taskboard"),
        ("summary", "select count(*) from summary"),
        ("convention", "select count(*) from convention"),
        ("project", "select count(*) from project"),
        ("session", "select count(*) from session"),
        ("message", "select count(*) from message"),
    ]:
        if table in old_tables:
            try:
                n = old.execute(count_sql).fetchone()[0]
            except Exception:
                n = "?"
            if n:
                skipped.append(f"{table}={n}")
    if skipped:
        report.append("未迁移（新 schema 无对应表或语义不同）：" + ", ".join(skipped))
    if any(t in old_tables for t in ("project", "session", "message")):
        report.append("project/session/message：新 schema 用 turns.project 字符串 + 会话日志回填表达，无需迁移")

    # turn 不迁移：backfillHistory 已从会话日志重建，避免重复
    report.append(f"turns: 未迁移（新库现有 {new.execute('select count(*) from turns').fetchone()[0]} 行，由会话日志回填）")

    if not args.dry_run:
        if core_db is not None:
            core_db._reindex_all(new)
        new.commit()

    print("\n".join(report))
    if args.dry_run:
        print("（dry-run：未写入）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
