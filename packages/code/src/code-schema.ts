/**
 * @brainbank/code — Schema Definitions
 *
 * Tables, FTS5 indices, triggers, and indices for code indexing.
 * Called during plugin initialize() via runPluginMigrations().
 */

import type { PluginContext } from 'brainbank';

type RawDb = PluginContext['db']['db'];

export const CODE_SCHEMA_VERSION = 1;

export const CODE_MIGRATIONS = [
    {
        version: 1,
        up(db: RawDb): void {
            db.exec(`
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

                -- ── Indices ────────────────────────────────────
                CREATE INDEX IF NOT EXISTS idx_cc_file      ON code_chunks(file_path);
                CREATE INDEX IF NOT EXISTS idx_ci_imports   ON code_imports(imports_path);
                CREATE INDEX IF NOT EXISTS idx_cs_name      ON code_symbols(name);
                CREATE INDEX IF NOT EXISTS idx_cs_file      ON code_symbols(file_path);
                CREATE INDEX IF NOT EXISTS idx_cr_symbol    ON code_refs(symbol_name);
                CREATE INDEX IF NOT EXISTS idx_cr_chunk     ON code_refs(chunk_id);

                -- ── FTS5 Full-Text Search ─────────────────────
                CREATE VIRTUAL TABLE IF NOT EXISTS fts_code USING fts5(
                    file_path,
                    name,
                    content,
                    content='code_chunks',
                    content_rowid='id',
                    tokenize='porter unicode61'
                );

                -- ── FTS5 Sync Triggers ────────────────────────
                CREATE TRIGGER IF NOT EXISTS trg_fts_code_insert AFTER INSERT ON code_chunks BEGIN
                    INSERT INTO fts_code(rowid, file_path, name, content)
                    VALUES (new.id, new.file_path, COALESCE(new.name, ''), new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS trg_fts_code_delete AFTER DELETE ON code_chunks BEGIN
                    INSERT INTO fts_code(fts_code, rowid, file_path, name, content)
                    VALUES ('delete', old.id, old.file_path, COALESCE(old.name, ''), old.content);
                END;
            `);
        },
    },
];
