/**
 * @brainbank/code — Schema Definitions
 *
 * Tables, FTS5 indices, triggers, and indices for code indexing.
 * Called during plugin initialize() via runPluginMigrations().
 */

import type { PluginContext } from 'brainbank';

type DbAdapter = PluginContext['db'];

export const CODE_SCHEMA_VERSION = 4;

export const CODE_MIGRATIONS = [
    {
        version: 1,
        up(adapter: DbAdapter): void {
            adapter.exec(`
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
    {
        version: 2,
        up(adapter: DbAdapter): void {
            adapter.exec(`
                -- ── Dependency Graph v2 ───────────────────────
                -- Recreate code_imports with import_kind + resolved columns.
                -- Drop old table data (will be rebuilt on next index --force).
                DROP TABLE IF EXISTS code_imports;

                CREATE TABLE code_imports (
                    file_path    TEXT    NOT NULL,
                    imports_path TEXT    NOT NULL,
                    import_kind  TEXT    NOT NULL DEFAULT 'static',
                    resolved     INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (file_path, imports_path)
                );

                -- Forward lookup (existing)
                CREATE INDEX IF NOT EXISTS idx_ci_imports ON code_imports(imports_path);
                -- Reverse lookup (new — who imports a given file?)
                CREATE INDEX IF NOT EXISTS idx_ci_reverse ON code_imports(imports_path, file_path);
            `);
        },
    },
    {
        version: 3,
        up(adapter: DbAdapter): void {
            adapter.exec(`
                -- ── Chunk-Level Call Graph v3 ─────────────────
                -- Links caller chunks to callee chunks via symbol_name.
                -- Built as a linking pass after all files are indexed.
                CREATE TABLE IF NOT EXISTS code_call_edges (
                    caller_chunk_id INTEGER NOT NULL,
                    callee_chunk_id INTEGER NOT NULL,
                    symbol_name     TEXT    NOT NULL,
                    PRIMARY KEY (caller_chunk_id, callee_chunk_id, symbol_name),
                    FOREIGN KEY (caller_chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE,
                    FOREIGN KEY (callee_chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_cce_caller ON code_call_edges(caller_chunk_id);
                CREATE INDEX IF NOT EXISTS idx_cce_callee ON code_call_edges(callee_chunk_id);
            `);
        },
    },
    {
        version: 4,
        up(adapter: DbAdapter): void {
            adapter.exec(`
                -- ── File-Level Vectors v4 ─────────────────────
                -- Replace chunk-level code_vectors with file-level.
                -- HNSW labels now use indexed_files.rowid.
                -- Requires re-index (brainbank index --force).
                DROP TABLE IF EXISTS code_vectors;

                CREATE TABLE code_vectors (
                    file_path   TEXT PRIMARY KEY,
                    embedding   BLOB NOT NULL
                );
            `);
        },
    },
];

