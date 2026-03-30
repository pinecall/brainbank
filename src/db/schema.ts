/**
 * BrainBank — SQLite Schema
 * 
 * Idempotent schema creation for the knowledge database.
 * Uses better-sqlite3 directly.
 */

import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 6;

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

        -- ── Code Graph ─────────────────────────────────
        CREATE TABLE IF NOT EXISTS code_imports (
            file_path    TEXT NOT NULL,
            imports_path TEXT NOT NULL,
            PRIMARY KEY (file_path, imports_path)
        );

        CREATE TABLE IF NOT EXISTS code_symbols (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT    NOT NULL,
            name      TEXT    NOT NULL,
            kind      TEXT    NOT NULL,
            line      INTEGER NOT NULL,
            chunk_id  INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS code_refs (
            chunk_id    INTEGER NOT NULL REFERENCES code_chunks(id) ON DELETE CASCADE,
            symbol_name TEXT    NOT NULL
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
        CREATE INDEX IF NOT EXISTS idx_ci_imports   ON code_imports(imports_path);
        CREATE INDEX IF NOT EXISTS idx_cs_name      ON code_symbols(name);
        CREATE INDEX IF NOT EXISTS idx_cs_file      ON code_symbols(file_path);
        CREATE INDEX IF NOT EXISTS idx_cr_symbol    ON code_refs(symbol_name);
        CREATE INDEX IF NOT EXISTS idx_cr_chunk     ON code_refs(chunk_id);
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


        -- ── Document Collections ──────────────────────
        CREATE TABLE IF NOT EXISTS collections (
            name        TEXT PRIMARY KEY,
            path        TEXT    NOT NULL,
            pattern     TEXT    NOT NULL DEFAULT '**/*.md',
            ignore_json TEXT    NOT NULL DEFAULT '[]',
            context     TEXT,
            created_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS doc_chunks (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            collection   TEXT    NOT NULL REFERENCES collections(name) ON DELETE CASCADE,
            file_path    TEXT    NOT NULL,
            title        TEXT    NOT NULL,
            content      TEXT    NOT NULL,
            seq          INTEGER NOT NULL DEFAULT 0,
            pos          INTEGER NOT NULL DEFAULT 0,
            content_hash TEXT    NOT NULL,
            indexed_at   INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS doc_vectors (
            chunk_id    INTEGER PRIMARY KEY REFERENCES doc_chunks(id) ON DELETE CASCADE,
            embedding   BLOB    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_dc_collection ON doc_chunks(collection);
        CREATE INDEX IF NOT EXISTS idx_dc_file       ON doc_chunks(file_path);
        CREATE INDEX IF NOT EXISTS idx_dc_hash       ON doc_chunks(content_hash);

        CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs USING fts5(
            title,
            content,
            file_path,
            collection,
            content='doc_chunks',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS trg_fts_docs_insert AFTER INSERT ON doc_chunks BEGIN
            INSERT INTO fts_docs(rowid, title, content, file_path, collection)
            VALUES (new.id, new.title, new.content, new.file_path, new.collection);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_fts_docs_delete AFTER DELETE ON doc_chunks BEGIN
            INSERT INTO fts_docs(fts_docs, rowid, title, content, file_path, collection)
            VALUES ('delete', old.id, old.title, old.content, old.file_path, old.collection);
        END;

        -- ── Path Contexts ─────────────────────────────
        CREATE TABLE IF NOT EXISTS path_contexts (
            collection  TEXT    NOT NULL,
            path        TEXT    NOT NULL,
            context     TEXT    NOT NULL,
            PRIMARY KEY (collection, path)
        );

        -- ── Dynamic Collections (KV Store) ───────────
        CREATE TABLE IF NOT EXISTS kv_data (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            collection  TEXT    NOT NULL,
            content     TEXT    NOT NULL,
            meta_json   TEXT    NOT NULL DEFAULT '{}',
            tags_json   TEXT    NOT NULL DEFAULT '[]',
            expires_at  INTEGER,
            created_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS kv_vectors (
            data_id   INTEGER PRIMARY KEY REFERENCES kv_data(id) ON DELETE CASCADE,
            embedding BLOB    NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS fts_kv USING fts5(
            content,
            collection,
            content='kv_data',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS trg_fts_kv_insert AFTER INSERT ON kv_data BEGIN
            INSERT INTO fts_kv(rowid, content, collection)
            VALUES (new.id, new.content, new.collection);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_fts_kv_delete AFTER DELETE ON kv_data BEGIN
            INSERT INTO fts_kv(fts_kv, rowid, content, collection)
            VALUES ('delete', old.id, old.content, old.collection);
        END;

        CREATE INDEX IF NOT EXISTS idx_kv_collection ON kv_data(collection);
        CREATE INDEX IF NOT EXISTS idx_kv_created    ON kv_data(created_at DESC);

        -- ── Embedding Metadata ───────────────────────
        CREATE TABLE IF NOT EXISTS embedding_meta (
            key     TEXT PRIMARY KEY,
            value   TEXT NOT NULL
        );
    `);
}

/**
 * Get the current schema version from the database.
 */
export function getSchemaVersion(db: Database.Database): number {
    try {
        const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number } | undefined;
        return row?.v ?? 0;
    } catch {
        return 0;
    }
}
