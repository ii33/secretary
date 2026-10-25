-- secretary-core SQLite schema (reconstructed + compression state machine)

CREATE TABLE IF NOT EXISTS turns (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project        TEXT NOT NULL,
    session        TEXT,
    seq            INTEGER,
    role           TEXT,
    preset         TEXT,
    user_text      TEXT,
    assistant_text TEXT,
    source         TEXT,
    source_version TEXT,
    event_type     TEXT,
    occurred_at    INTEGER,
    created_at     INTEGER,
    deleted        INTEGER NOT NULL DEFAULT 0,
    -- 压缩状态机：hot_raw（自动收录、未压缩）/ processed（已压缩梳理）/ cold（已归档）
    state          TEXT NOT NULL DEFAULT 'hot_raw',
    processed_at   INTEGER,
    summary_id     TEXT,
    importance     INTEGER NOT NULL DEFAULT 0,
    tags           TEXT,
    cold_ref       TEXT,
    UNIQUE (session, seq, project)
);

CREATE INDEX IF NOT EXISTS idx_turns_project ON turns (project, deleted);
CREATE INDEX IF NOT EXISTS idx_turns_created ON turns (created_at);
-- idx_turns_state 依赖 state 列，老库要先 ALTER 补列，故在 db._migrate() 里创建。

CREATE TABLE IF NOT EXISTS notes (
    id             TEXT PRIMARY KEY,
    project        TEXT NOT NULL,
    kind           TEXT,
    text           TEXT,
    tags           TEXT,
    importance     REAL NOT NULL DEFAULT 0.5,
    status         TEXT NOT NULL DEFAULT 'active',
    superseded_by  TEXT,
    source_turn_id INTEGER,
    created_at     INTEGER,
    deleted        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notes_project ON notes (project, deleted);

CREATE TABLE IF NOT EXISTS taskboard (
    id         TEXT PRIMARY KEY,
    project    TEXT NOT NULL,
    section    TEXT,
    title      TEXT,
    detail     TEXT,
    status     TEXT NOT NULL DEFAULT 'open',
    actor      TEXT,
    created_at INTEGER,
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_taskboard_project ON taskboard (project);

CREATE TABLE IF NOT EXISTS conventions (
    id         TEXT PRIMARY KEY,
    project    TEXT NOT NULL,
    kind       TEXT,
    title      TEXT,
    detail     TEXT,
    status     TEXT NOT NULL DEFAULT 'active',
    actor      TEXT,
    created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_conventions_project ON conventions (project);

CREATE TABLE IF NOT EXISTS advice (
    id             TEXT PRIMARY KEY,
    project        TEXT NOT NULL,
    subject        TEXT,
    recommendation TEXT,
    evidence       TEXT,
    status         TEXT NOT NULL DEFAULT 'pending',
    created_at     INTEGER,
    decided_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_advice_project ON advice (project, status);

CREATE TABLE IF NOT EXISTS summaries (
    id         TEXT PRIMARY KEY,
    project    TEXT NOT NULL,
    batch      INTEGER,
    content    TEXT,
    created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries (project);

-- 项目简报：压缩产物，每个项目一份，被 system prompt 每轮注入。
CREATE TABLE IF NOT EXISTS brief (
    project    TEXT PRIMARY KEY,
    text       TEXT NOT NULL,
    summary_id TEXT,
    version    INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER
);

-- 人员架构：会话的自定义名字（默认是「预设名+序号」）。
CREATE TABLE IF NOT EXISTS agent_name (
    project    TEXT NOT NULL,
    session_id TEXT NOT NULL,
    name       TEXT NOT NULL,
    updated_at INTEGER,
    PRIMARY KEY (project, session_id)
);

-- 项目预设：项目本地的自定义预设，默认不进全局；可从全局导入、也可导出。
CREATE TABLE IF NOT EXISTS project_preset (
    project    TEXT NOT NULL,
    preset_id  TEXT NOT NULL,
    name       TEXT,
    content    TEXT,
    source     TEXT,
    created_at INTEGER,
    PRIMARY KEY (project, preset_id)
);

-- 冷层索引：原文写到 cold/<project>/T<id>.json.gz，这里记录文件/长度/校验。
CREATE TABLE IF NOT EXISTS cold_index (
    project    TEXT NOT NULL,
    turn_id    INTEGER NOT NULL,
    file       TEXT NOT NULL,
    length     INTEGER,
    sha256     TEXT,
    created_at INTEGER,
    PRIMARY KEY (project, turn_id)
);

-- bigram FTS（contentless）：body 为 bigram token 串，rowid 映射 turn/note/summary。
-- 中文 bigram、英文小写词；检索命中后回表取原文做 snippet。
CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(
    body, content='', contentless_delete=1, tokenize='unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
    body, content='', contentless_delete=1, tokenize='unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS summary_fts USING fts5(
    body, content='', contentless_delete=1, tokenize='unicode61'
);

-- 原始事件仓：适配器先落这里，再归一化成 turn；失败可重放。
CREATE TABLE IF NOT EXISTS raw_event (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source             TEXT,
    source_version     TEXT,
    event_type         TEXT,
    external_session   TEXT,
    external_seq       INTEGER,
    payload            TEXT,
    received_at        INTEGER,
    normalizer_version TEXT,
    normalized_at      INTEGER,
    error              TEXT,
    UNIQUE (source, external_session, external_seq, event_type)
);

CREATE INDEX IF NOT EXISTS idx_raw_event_session ON raw_event (external_session, external_seq);

-- 审计：删/还原/purge/归档 等关键操作。
CREATE TABLE IF NOT EXISTS audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       INTEGER,
    actor    TEXT,
    action   TEXT,
    ref_type TEXT,
    ref_id   TEXT,
    detail   TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit (at);

-- 交付物索引（文件/产物登记）
CREATE TABLE IF NOT EXISTS artifact (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL,
    title       TEXT,
    path        TEXT,
    kind        TEXT,
    summary     TEXT,
    source_turn INTEGER,
    created_at  INTEGER,
    deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_artifact_project ON artifact (project, deleted);

-- 角色/模型策略（控制台只读）
CREATE TABLE IF NOT EXISTS role_policy (
    project     TEXT NOT NULL,
    role        TEXT NOT NULL,
    preset      TEXT,
    provider    TEXT,
    model       TEXT,
    effort      TEXT,
    sandbox     TEXT,
    limits_json TEXT,
    revision    INTEGER,
    PRIMARY KEY (project, role)
);
