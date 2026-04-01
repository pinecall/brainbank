/**
 * BrainBank — SQLite Schema
 * 
 * Core-only schema creation. Domain-specific tables (code, git, docs)
 * are created by their respective plugins via the migration system.
 * Uses better-sqlite3 directly.
 */

import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 7;

/**
 * Create core tables and indices.
 * Safe to call multiple times — uses IF NOT EXISTS.
 * Domain tables are created by plugins via runPluginMigrations().
 */
export function createSchema(db: Database.Database): void {
    db.exec(`
        -- ── Schema versioning ──────────────────────────
        CREATE TABLE IF NOT EXISTS schema_version (
            version     INTEGER PRIMARY KEY,
            applied_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_VERSION});

        -- ── Plugin Versions (migration tracking) ──────
        CREATE TABLE IF NOT EXISTS plugin_versions (
            plugin_name TEXT    PRIMARY KEY,
            version     INTEGER NOT NULL,
            applied_at  INTEGER NOT NULL DEFAULT (unixepoch())
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
