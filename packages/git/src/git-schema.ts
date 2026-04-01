/**
 * @brainbank/git — Schema Definitions
 *
 * Tables, FTS5 indices, triggers, and indices for git history.
 * Called during plugin initialize() via runPluginMigrations().
 */

import type { PluginContext } from 'brainbank';

type RawDb = PluginContext['db']['db'];

export const GIT_SCHEMA_VERSION = 1;

export const GIT_MIGRATIONS = [
    {
        version: 1,
        up(db: RawDb): void {
            db.exec(`
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

                -- ── Indices ────────────────────────────────────
                CREATE INDEX IF NOT EXISTS idx_cf_path      ON commit_files(file_path);
                CREATE INDEX IF NOT EXISTS idx_gc_ts        ON git_commits(timestamp DESC);
                CREATE INDEX IF NOT EXISTS idx_gc_hash      ON git_commits(hash);

                -- ── FTS5 Full-Text Search ─────────────────────
                CREATE VIRTUAL TABLE IF NOT EXISTS fts_commits USING fts5(
                    message,
                    author,
                    diff,
                    content='git_commits',
                    content_rowid='id',
                    tokenize='porter unicode61'
                );

                -- ── FTS5 Sync Triggers ────────────────────────
                CREATE TRIGGER IF NOT EXISTS trg_fts_commits_insert AFTER INSERT ON git_commits BEGIN
                    INSERT INTO fts_commits(rowid, message, author, diff)
                    VALUES (new.id, new.message, new.author, COALESCE(new.diff, ''));
                END;
                CREATE TRIGGER IF NOT EXISTS trg_fts_commits_delete AFTER DELETE ON git_commits BEGIN
                    INSERT INTO fts_commits(fts_commits, rowid, message, author, diff)
                    VALUES ('delete', old.id, old.message, old.author, COALESCE(old.diff, ''));
                END;
            `);
        },
    },
];
