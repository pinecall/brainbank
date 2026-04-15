/**
 * BrainBank — SQLite Adapter
 *
 * Implements `DatabaseAdapter` using Node.js built-in `node:sqlite`.
 * Zero native addons — no ABI issues across Node versions.
 * Handles WAL mode, directory creation, schema init, and transactions.
 */

import type { DatabaseAdapter, AdapterCapabilities, PreparedStatement, ExecuteResult } from './adapter.ts';
import type { DatabaseSync as DatabaseSyncType, StatementSync as StatementSyncType } from 'node:sqlite';

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';


// ── Schema ──────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 9;

/**
 * Create core tables and indices.
 * Safe to call multiple times — uses IF NOT EXISTS.
 * Domain tables are created by plugins via runPluginMigrations().
 */
function createSchema(adapter: DatabaseAdapter): void {
    adapter.exec(`
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

        -- ── Index State (cross-process coordination) ─
        CREATE TABLE IF NOT EXISTS index_state (
            name       TEXT    PRIMARY KEY,
            version    INTEGER NOT NULL DEFAULT 0,
            writer_pid INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- ── Plugin Tracking (incremental indexing) ────
        CREATE TABLE IF NOT EXISTS plugin_tracking (
            plugin       TEXT NOT NULL,
            key          TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            indexed_at   INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (plugin, key)
        );
    `);
}

/** Get the current schema version from the database. */
export function getSchemaVersion(adapter: DatabaseAdapter): number {
    try {
        const row = adapter.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number } | undefined;
        return row?.v ?? 0;
    } catch {
        return 0;
    }
}


// ── Statement Wrapper ───────────────────────────────────────────────

/** SQLite parameter type accepted by node:sqlite. */
type SqlParam = string | number | bigint | null | Uint8Array;

/** Wraps a `node:sqlite` StatementSync into a `PreparedStatement<T>`. */
function wrapStatement<T>(stmt: StatementSyncType): PreparedStatement<T> {
    return {
        get(...params: unknown[]): T | undefined {
            return stmt.get(...(params as SqlParam[])) as T | undefined;
        },
        all(...params: unknown[]): T[] {
            return stmt.all(...(params as SqlParam[])) as T[];
        },
        run(...params: unknown[]): ExecuteResult {
            const info = stmt.run(...(params as SqlParam[]));
            return {
                lastInsertRowid: info.lastInsertRowid,
                changes: Number(info.changes),
            };
        },
        iterate(...params: unknown[]): IterableIterator<T> {
            return stmt.iterate(...(params as SqlParam[])) as IterableIterator<T>;
        },
    };
}


// ── SQLiteAdapter ───────────────────────────────────────────────────

export class SQLiteAdapter implements DatabaseAdapter {
    private _db: DatabaseSyncType;

    readonly capabilities: AdapterCapabilities = {
        fts: 'fts5',
        upsert: 'or-replace',
        json: true,
        vectors: false,
    };

    constructor(dbPath: string) {
        // Ensure parent directory exists
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this._db = new DatabaseSync(dbPath);
        this._db.exec('PRAGMA journal_mode = WAL');
        this._db.exec('PRAGMA busy_timeout = 5000');
        this._db.exec('PRAGMA synchronous = NORMAL');
        this._db.exec('PRAGMA foreign_keys = ON');

        // Initialize schema
        createSchema(this);
    }

    /** Prepare a reusable statement. */
    prepare<T = unknown>(sql: string): PreparedStatement<T> {
        return wrapStatement<T>(this._db.prepare(sql));
    }

    /** Execute raw SQL (no results). */
    exec(sql: string): void {
        this._db.exec(sql);
    }

    /** Run a function inside a transaction. Auto-commits on success, auto-rollbacks on error. */
    transaction<T>(fn: () => T): T {
        this._db.exec('BEGIN');
        try {
            const result = fn();
            this._db.exec('COMMIT');
            return result;
        } catch (err) {
            this._db.exec('ROLLBACK');
            throw err;
        }
    }

    /** Run a prepared statement on multiple rows. Wraps in a single transaction. */
    batch<T extends unknown[]>(sql: string, rows: T[]): void {
        const stmt = this._db.prepare(sql);
        this.transaction(() => {
            for (const row of rows) {
                stmt.run(...(row as SqlParam[]));
            }
        });
    }

    /** Close the database. */
    close(): void {
        this._db.close();
    }

    /**
     * Access the underlying `node:sqlite` DatabaseSync instance.
     *
     * @deprecated Use `DatabaseAdapter` methods instead. This exists
     * only for gradual migration of plugins that depend on driver internals.
     */
    raw<T = unknown>(): T {
        return this._db as unknown as T;
    }
}
