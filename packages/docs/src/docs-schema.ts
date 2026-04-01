/**
 * @brainbank/docs — Schema Definitions
 *
 * Tables, FTS5 indices, triggers, and indices for document collections.
 * Called during plugin initialize() via runPluginMigrations().
 */

import type { PluginContext } from 'brainbank';

type DbAdapter = PluginContext['db'];

export const DOCS_SCHEMA_VERSION = 1;

export const DOCS_MIGRATIONS = [
    {
        version: 1,
        up(adapter: DbAdapter): void {
            adapter.exec(`
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

                -- ── Path Contexts ─────────────────────────────
                CREATE TABLE IF NOT EXISTS path_contexts (
                    collection  TEXT    NOT NULL,
                    path        TEXT    NOT NULL,
                    context     TEXT    NOT NULL,
                    PRIMARY KEY (collection, path)
                );

                -- ── Indices ────────────────────────────────────
                CREATE INDEX IF NOT EXISTS idx_dc_collection ON doc_chunks(collection);
                CREATE INDEX IF NOT EXISTS idx_dc_file       ON doc_chunks(file_path);
                CREATE INDEX IF NOT EXISTS idx_dc_hash       ON doc_chunks(content_hash);

                -- ── FTS5 Full-Text Search ─────────────────────
                CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs USING fts5(
                    title,
                    content,
                    file_path,
                    collection,
                    content='doc_chunks',
                    content_rowid='id',
                    tokenize='porter unicode61'
                );

                -- ── FTS5 Sync Triggers ────────────────────────
                CREATE TRIGGER IF NOT EXISTS trg_fts_docs_insert AFTER INSERT ON doc_chunks BEGIN
                    INSERT INTO fts_docs(rowid, title, content, file_path, collection)
                    VALUES (new.id, new.title, new.content, new.file_path, new.collection);
                END;
                CREATE TRIGGER IF NOT EXISTS trg_fts_docs_delete AFTER DELETE ON doc_chunks BEGIN
                    INSERT INTO fts_docs(fts_docs, rowid, title, content, file_path, collection)
                    VALUES ('delete', old.id, old.title, old.content, old.file_path, old.collection);
                END;
            `);
        },
    },
];
