/**
 * BrainBank — Database Adapter Interface
 *
 * Abstract contract for database operations. All consumers depend on
 * this interface — never on a concrete driver. The `SQLiteAdapter`
 * is the built-in implementation; future adapters (LibSQL, Turso,
 * PostgreSQL) implement the same contract.
 *
 * Phase 1: sync-first API matching the existing `better-sqlite3` usage.
 * Async variants will be added when needed by async-native adapters.
 */


/** Result from mutating queries (INSERT / UPDATE / DELETE). */
export interface ExecuteResult {
    /** Row ID of the last inserted row. */
    lastInsertRowid: number | bigint;
    /** Number of rows changed by the statement. */
    changes: number;
}

/** A prepared statement with typed query methods. */
export interface PreparedStatement<T = unknown> {
    /** Execute a query and return the first matching row, or `undefined`. */
    get(...params: unknown[]): T | undefined;
    /** Execute a query and return all matching rows. */
    all(...params: unknown[]): T[];
    /** Execute a mutating statement and return the result. */
    run(...params: unknown[]): ExecuteResult;
    /** Iterate over matching rows without loading them all into memory. */
    iterate(...params: unknown[]): IterableIterator<T>;
}

/** Adapter capability flags — describes what the underlying engine supports. */
export interface AdapterCapabilities {
    /** Full-text search engine. */
    fts: 'fts5' | 'tsvector' | 'none';
    /** Upsert syntax dialect. */
    upsert: 'or-replace' | 'on-conflict';
    /** Native JSON column support. */
    json: boolean;
    /** Native vector column support (e.g. pgvector). */
    vectors: boolean;
}

/**
 * Database adapter interface.
 *
 * All BrainBank components depend on this contract instead of a
 * concrete database driver. Keeps the door open for LibSQL, Turso,
 * PostgreSQL, etc. without touching consumer code.
 */
export interface DatabaseAdapter {
    /** Prepare a reusable statement. */
    prepare<T = unknown>(sql: string): PreparedStatement<T>;

    /** Execute raw DDL / multi-statement SQL (no results). */
    exec(sql: string): void;

    /** Run `fn` inside a transaction. Auto-commits on success, auto-rollbacks on error. */
    transaction<T>(fn: () => T): T;

    /** Run a prepared statement on multiple rows inside a single transaction. */
    batch<T extends unknown[]>(sql: string, rows: T[]): void;

    /** Close the database and release resources. */
    close(): void;

    /** Engine capabilities (FTS, upsert dialect, etc.). */
    readonly capabilities: AdapterCapabilities;

    /**
     * Escape hatch: access the underlying raw driver.
     * Returns `undefined` for adapters that don't support raw access.
     *
     * @deprecated Use `DatabaseAdapter` methods instead. This exists
     * only for gradual migration of plugins that depend on driver internals.
     */
    raw<T = unknown>(): T | undefined;
}

// ── Row Types ────────────────────────────────────────────────────────
// Typed interfaces for rows returned by core SQLite queries.
// Domain-specific row types live in their respective packages.

export interface KvDataRow {
    id: number;
    collection: string;
    content: string;
    meta_json: string;
    tags_json: string;
    expires_at: number | null;
    created_at: number;
}

export interface KvVectorRow {
    data_id: number;
    embedding: Buffer;
}

export interface EmbeddingMetaRow {
    value: string;
}

export interface VectorRow {
    id: number;
    embedding: Buffer;
}

export interface CountRow {
    c: number;
}
