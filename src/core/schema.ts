/**
 * BrainBank — SQLite Schema
 * 
 * Idempotent schema creation for the knowledge database.
 * Uses better-sqlite3 directly.
 */

import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 3;

/**
 * Create all tables and indices.
 * Safe to call multiple times — uses IF NOT EXISTS.
 */
export function createSchema(db: Database.Database): void {
    db.exec(`
        -- ── Schema versioning ──────────────────────────
        CREATE TABLE IF NOT EXISTS schema_version (
            version     INTEGER PRIMARY KEY,
            applied_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_VERSION});

        -- ── Code chunks ────────────────────────────────
        CREATE TABLE IF NOT EXISTS code_chunks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path   TEXT    NOT NULL,
            chunk_type  TEXT    NOT NULL,
            name        TEXT,
            start_line  INTEGER NOT NULL,
            end_line    INTEGER NOT NULL,
            content     TEXT    NOT NULL,
            language    TEXT    NOT NULL,
            file_hash   TEXT,
            indexed_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS code_vectors (
            chunk_id    INTEGER PRIMARY KEY REFERENCES code_chunks(id) ON DELETE CASCADE,
            embedding   BLOB    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS indexed_files (
            file_path   TEXT PRIMARY KEY,
            file_hash   TEXT    NOT NULL,
            indexed_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- ── Git history ────────────────────────────────
        CREATE TABLE IF NOT EXISTS git_commits (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            hash        TEXT    UNIQUE NOT NULL,
            short_hash  TEXT    NOT NULL,
            message     TEXT    NOT NULL,
            author      TEXT    NOT NULL,
            date        TEXT    NOT NULL,
            timestamp   INTEGER NOT NULL,
            files_json  TEXT    NOT NULL,
            diff        TEXT,
            additions   INTEGER DEFAULT 0,
            deletions   INTEGER DEFAULT 0,
            is_merge    INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS commit_files (
            commit_id   INTEGER NOT NULL REFERENCES git_commits(id),
            file_path   TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS co_edits (
            file_a      TEXT NOT NULL,
            file_b      TEXT NOT NULL,
            count       INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (file_a, file_b)
        );

        CREATE TABLE IF NOT EXISTS git_vectors (
            commit_id   INTEGER PRIMARY KEY REFERENCES git_commits(id) ON DELETE CASCADE,
            embedding   BLOB    NOT NULL
        );

        -- ── Agent memory ───────────────────────────────
        CREATE TABLE IF NOT EXISTS memory_patterns (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            task_type    TEXT    NOT NULL,
            task         TEXT    NOT NULL,
            approach     TEXT    NOT NULL,
            outcome      TEXT,
            success_rate REAL    NOT NULL DEFAULT 0.5,
            critique     TEXT,
            tokens_used  INTEGER,
            latency_ms   INTEGER,
            created_at   INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS memory_vectors (
            pattern_id  INTEGER PRIMARY KEY REFERENCES memory_patterns(id) ON DELETE CASCADE,
            embedding   BLOB    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS distilled_strategies (
            task_type   TEXT PRIMARY KEY,
            strategy    TEXT    NOT NULL,
            confidence  REAL    NOT NULL DEFAULT 0.8,
            updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- ── Indices ────────────────────────────────────
        CREATE INDEX IF NOT EXISTS idx_cc_file      ON code_chunks(file_path);
        CREATE INDEX IF NOT EXISTS idx_cf_path      ON commit_files(file_path);
        CREATE INDEX IF NOT EXISTS idx_gc_ts        ON git_commits(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_gc_hash      ON git_commits(hash);
        CREATE INDEX IF NOT EXISTS idx_mp_type      ON memory_patterns(task_type);
        CREATE INDEX IF NOT EXISTS idx_mp_success   ON memory_patterns(success_rate);
        CREATE INDEX IF NOT EXISTS idx_mp_created   ON memory_patterns(created_at);

        -- ── FTS5 Full-Text Search ─────────────────────
        -- Code chunks: search by file path, name, and content
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_code USING fts5(
            file_path,
            name,
            content,
            content='code_chunks',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        -- Git commits: search by message, author, and diff
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_commits USING fts5(
            message,
            author,
            diff,
            content='git_commits',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        -- Memory patterns: search by task type, task, approach, and critique
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_patterns USING fts5(
            task_type,
            task,
            approach,
            critique,
            content='memory_patterns',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        -- ── FTS5 Sync Triggers ────────────────────────
        -- Auto-sync FTS indices on INSERT/UPDATE/DELETE

        CREATE TRIGGER IF NOT EXISTS trg_fts_code_insert AFTER INSERT ON code_chunks BEGIN
            INSERT INTO fts_code(rowid, file_path, name, content)
            VALUES (new.id, new.file_path, COALESCE(new.name, ''), new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_fts_code_delete AFTER DELETE ON code_chunks BEGIN
            INSERT INTO fts_code(fts_code, rowid, file_path, name, content)
            VALUES ('delete', old.id, old.file_path, COALESCE(old.name, ''), old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_fts_commits_insert AFTER INSERT ON git_commits BEGIN
            INSERT INTO fts_commits(rowid, message, author, diff)
            VALUES (new.id, new.message, new.author, COALESCE(new.diff, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_fts_commits_delete AFTER DELETE ON git_commits BEGIN
            INSERT INTO fts_commits(fts_commits, rowid, message, author, diff)
            VALUES ('delete', old.id, old.message, old.author, COALESCE(old.diff, ''));
        END;

        CREATE TRIGGER IF NOT EXISTS trg_fts_patterns_insert AFTER INSERT ON memory_patterns BEGIN
            INSERT INTO fts_patterns(rowid, task_type, task, approach, critique)
            VALUES (new.id, new.task_type, new.task, new.approach, COALESCE(new.critique, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_fts_patterns_delete AFTER DELETE ON memory_patterns BEGIN
            INSERT INTO fts_patterns(fts_patterns, rowid, task_type, task, approach, critique)
            VALUES ('delete', old.id, old.task_type, old.task, old.approach, COALESCE(old.critique, ''));
        END;

        -- ── Conversation Memory ───────────────────────
        CREATE TABLE IF NOT EXISTS conversation_memories (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            title           TEXT    NOT NULL,
            summary         TEXT    NOT NULL,
            decisions_json  TEXT    NOT NULL DEFAULT '[]',
            files_json      TEXT    NOT NULL DEFAULT '[]',
            patterns_json   TEXT    NOT NULL DEFAULT '[]',
            open_json       TEXT    NOT NULL DEFAULT '[]',
            tags_json       TEXT    NOT NULL DEFAULT '[]',
            tier            TEXT    NOT NULL DEFAULT 'short',
            created_at      INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS conversation_vectors (
            memory_id   INTEGER PRIMARY KEY REFERENCES conversation_memories(id) ON DELETE CASCADE,
            embedding   BLOB    NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS fts_conversations USING fts5(
            title,
            summary,
            decisions,
            patterns,
            tags,
            content='conversation_memories',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS trg_fts_conv_insert AFTER INSERT ON conversation_memories BEGIN
            INSERT INTO fts_conversations(rowid, title, summary, decisions, patterns, tags)
            VALUES (new.id, new.title, new.summary, new.decisions_json, new.patterns_json, new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_fts_conv_delete AFTER DELETE ON conversation_memories BEGIN
            INSERT INTO fts_conversations(fts_conversations, rowid, title, summary, decisions, patterns, tags)
            VALUES ('delete', old.id, old.title, old.summary, old.decisions_json, old.patterns_json, old.tags_json);
        END;

        CREATE INDEX IF NOT EXISTS idx_cm_tier     ON conversation_memories(tier);
        CREATE INDEX IF NOT EXISTS idx_cm_created  ON conversation_memories(created_at DESC);
    `);
}

/**
 * Get the current schema version from the database.
 */
export function getSchemaVersion(db: Database.Database): number {
    try {
        const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as any;
        return row?.v ?? 0;
    } catch {
        return 0;
    }
}
