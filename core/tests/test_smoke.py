"""secretary-core 冒烟测试（只用标准库）。

目的：`core/` 此前 **0 个 Python 测试**，44 KB 的 `db.py` 状态机（hot_raw → processed → cold、
回收站 → restore → purge、FTS bigram 检索）只靠 Node 契约测试和手工 HTTP 矩阵兜着。
这个文件把那套手工验证固定下来，改成可重复执行的门槛测试。

运行：
    python tests/test_smoke.py            # 直接跑
    python -m unittest discover -s tests  # 或走 unittest 发现

它会：
  1. 用临时数据目录另起一个 secretary-core 子进程（不碰 %USERPROFILE%\\.secretary-office）；
  2. 覆盖 events/检索/简报/压缩/归档/回收站/恢复/purge/任务板/约定/笔记 的主链路；
  3. 结束时杀掉子进程并清理临时目录。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

CORE_ROOT = Path(__file__).resolve().parents[1]
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))


def wait_for_core(data_dir: Path, timeout: float = 30.0) -> dict:
    info_path = data_dir / ".run" / "core.json"
    deadline = time.time() + timeout
    while time.time() < deadline:
        if info_path.exists():
            try:
                info = json.loads(info_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                info = None
            if info and info.get("port"):
                return info
        time.sleep(0.05)
    raise RuntimeError(f"core 未在 {timeout}s 内就绪：{info_path}")


class CoreSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data_dir = Path(tempfile.mkdtemp(prefix="secretary-smoke-"))
        env = dict(os.environ)
        env["PYTHONPATH"] = str(CORE_ROOT)
        env["PYTHONUNBUFFERED"] = "1"
        cls.child = subprocess.Popen(
            [sys.executable, "-m", "secretary_core.cli", "serve", "--data-dir", str(cls.data_dir)],
            cwd=str(CORE_ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            info = wait_for_core(cls.data_dir)
        except RuntimeError:
            cls.child.terminate()
            raise
        cls.base = f"http://127.0.0.1:{info['port']}"

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls.child.terminate()
            cls.child.wait(timeout=10)
        except Exception:  # noqa: BLE001 - 清理失败不应让测试报错
            cls.child.kill()
        shutil.rmtree(cls.data_dir, ignore_errors=True)

    # --- 工具 -------------------------------------------------------------
    def request(self, method: str, path: str, body: dict | None = None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                payload = response.read().decode("utf-8")
                return response.status, (json.loads(payload) if payload else None)
        except urllib.error.HTTPError as problem:
            payload = problem.read().decode("utf-8")
            return problem.code, (json.loads(payload) if payload else None)

    def ingest(self, project: str, seq: int, user: str, assistant: str) -> int:
        status, body = self.request(
            "POST",
            "/v1/events",
            {
                "source": "smoke",
                "source_version": "test",
                "event_type": "turn.completed",
                "external_session": f"smoke-{project}",
                "external_seq": seq,
                "project": project,
                "occurred_at": int(time.time() * 1000),
                "payload": {
                    "role": "secretary",
                    "preset": "secretary",
                    "user_text": user,
                    "assistant_text": assistant,
                },
            },
        )
        self.assertEqual(status, 200, body)
        self.assertEqual(body.get("status"), "ok")
        return int(body["id"])

    def stats(self, project: str) -> dict:
        status, body = self.request("GET", f"/v1/stats?project={project}")
        self.assertEqual(status, 200, body)
        return body

    # --- 用例 -------------------------------------------------------------
    def test_01_health(self) -> None:
        status, body = self.request("GET", "/v1/health")
        self.assertEqual(status, 200)
        self.assertIn("status", body or {})

    def test_02_ingest_and_states(self) -> None:
        first = self.ingest("smoke-a", 1, "链路测试：请确认下发链路", "确认：链路正常。")
        self.ingest("smoke-a", 2, "第二个问题", "第二个回答")
        board = self.stats("smoke-a")
        self.assertEqual(board["turns"], 2)
        self.assertEqual(board["hot_raw"], 2)

        # 压缩：预览 → 确认 → 状态迁移 hot_raw → processed
        status, preview = self.request("GET", "/v1/compress/preview?project=smoke-a")
        self.assertEqual(status, 200, preview)
        self.assertEqual(preview["status"], "preview")
        self.assertIn(first, preview["turn_ids"])

        status, applied = self.request("POST", "/v1/compress", {"project": "smoke-a", "confirm": True})
        self.assertEqual(status, 200, applied)
        self.assertEqual(applied["status"], "ok")
        self.assertTrue(str(applied.get("summary_id", "")).startswith("S-"), applied)
        after = self.stats("smoke-a")
        self.assertEqual(after["processed"], 2)
        self.assertEqual(after["hot_raw"], 0)

        # 摘要可被 get 回读
        status, summary = self.request("GET", f"/v1/get/{applied['summary_id']}")
        self.assertEqual(status, 200, summary)
        self.assertEqual(summary["id"], applied["summary_id"])

    def test_03_search_uses_fts(self) -> None:
        """中文 bigram 检索：应当命中，且不应"命中一切"。"""
        self.ingest("smoke-b", 1, "链路测试：ES 下发与回报链路正常", "结论：链路正常，工具面为只读。")
        status, hit = self.request("GET", "/v1/search?project=smoke-b&q=%E9%93%BE%E8%B7%AF")
        self.assertEqual(status, 200, hit)
        self.assertGreaterEqual(len(hit["results"]), 1, "中文查询『链路』应命中")
        status, miss = self.request("GET", "/v1/search?project=smoke-b&q=%E6%B1%87%E6%8A%A5")
        self.assertEqual(status, 200)
        self.assertEqual(len(miss["results"]), 0, "『汇报』不在文本中（原文是回报），不应误命中")
        # 空查询不应报错
        status, empty = self.request("GET", "/v1/search?project=smoke-b&q=")
        self.assertEqual(status, 200)
        self.assertEqual(len(empty["results"]), 0)

    def test_04_brief_and_metric(self) -> None:
        self.ingest("smoke-c", 1, "请给出项目状态", "状态：待办 0 项。")
        status, brief = self.request("GET", "/v1/brief?project=smoke-c")
        self.assertEqual(status, 200, brief)
        self.assertIn("smoke-c", brief["text"])
        # stats.brief_chars 必须与 /brief 文本长度一致（此前恒为 0 是 bug）
        board = self.stats("smoke-c")
        self.assertEqual(board["brief_chars"], len(brief["text"]), "brief_chars 应反映实际简报长度")

    def test_05_archive_recycle_restore_purge(self) -> None:
        turn = self.ingest("smoke-d", 1, "回收站链路测试", "响应")
        status, recycled = self.request("POST", "/v1/recycle", {"project": "smoke-d", "id": turn})
        self.assertEqual(status, 200, recycled)
        self.assertEqual(recycled["status"], "recycled")
        board = self.stats("smoke-d")
        self.assertEqual(board["recycle"], 1)
        status, items = self.request("GET", "/v1/recycle?project=smoke-d")
        self.assertEqual([item["id"] for item in items["items"]], [turn])

        # 恢复（无损）
        status, restored = self.request("POST", "/v1/restore", {"project": "smoke-d", "id": turn})
        self.assertEqual(status, 200, restored)
        self.assertEqual(self.stats("smoke-d")["recycle"], 0)
        self.assertEqual(self.stats("smoke-d")["turns"], 1)

        # 归档 → 冷层
        status, archived = self.request("POST", "/v1/archive", {"project": "smoke-d", "now": True})
        self.assertEqual(status, 200, archived)
        self.assertGreaterEqual(archived["archived"], 1)
        self.assertGreaterEqual(self.stats("smoke-d")["cold"], 1)

        # 冷层数据仍可进回收站并被 purge 真删
        status, _ = self.request("POST", "/v1/recycle", {"project": "smoke-d", "id": turn})
        self.assertEqual(status, 200)
        status, purged = self.request("POST", "/v1/purge", {"project": "smoke-d", "now": True})
        self.assertEqual(status, 200, purged)
        self.assertEqual(purged["purged"], 1)
        board = self.stats("smoke-d")
        self.assertEqual(board["cold"], 0)
        self.assertEqual(board["turns"], 0)

    def test_06_taskboard_and_conventions(self) -> None:
        status, task = self.request(
            "POST", "/v1/taskboard", {"project": "smoke-e", "title": "冒烟任务", "status": "open"}
        )
        self.assertEqual(status, 200, task)
        self.assertTrue(task["id"].startswith("T-"))
        status, listed = self.request("GET", "/v1/taskboard?project=smoke-e")
        self.assertEqual([item["id"] for item in listed["items"]], [task["id"]])
        status, removed = self.request("DELETE", f"/v1/taskboard/{task['id']}")
        self.assertEqual(status, 200, removed)
        self.assertEqual(self.request("GET", "/v1/taskboard?project=smoke-e")[1]["items"], [])

        status, rule = self.request(
            "POST", "/v1/conventions", {"project": "smoke-e", "title": "冒烟约定"}
        )
        self.assertEqual(status, 200, rule)
        self.assertTrue(rule["id"].startswith("C-"))
        status, removed = self.request("DELETE", f"/v1/conventions/{rule['id']}")
        self.assertEqual(status, 200, removed)
        self.assertEqual(self.request("GET", "/v1/conventions?project=smoke-e")[1]["items"], [])

    def test_07_notes_and_get(self) -> None:
        status, note = self.request(
            "POST", "/v1/notes", {"project": "smoke-f", "text": "冒烟笔记：压缩后写入", "kind": "note"}
        )
        self.assertEqual(status, 200, note)
        self.assertTrue(note["id"].startswith("N-"))
        status, fetched = self.request("GET", f"/v1/notes/{note['id']}")
        self.assertEqual(status, 200, fetched)
        self.assertEqual(fetched["id"], note["id"])
        self.assertEqual(self.stats("smoke-f")["notes"], 1)

    def test_08_unknown_route_is_404(self) -> None:
        status, _ = self.request("GET", "/v1/definitely-not-a-route")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
