/**
 * BrainBank — SQLite Adapter
 *
 * Implements `DatabaseAdapter` using `better-sqlite3`.
 * Drop-in replacement for the old `Database` class.
 * Handles WAL mode, directory creation, schema init, and transactions.
 */

import type { DatabaseAdapter, AdapterCapabilities, PreparedStatement, ExecuteResult } from './adapter.ts';

import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createSchema } from './schema.ts';

/** Wraps a `better-sqlite3` Statement into a `PreparedStatement<T>`. */
function wrapStatement<T>(stmt: BetterSqlite3.Statement): PreparedStatement<T> {
    return {
        get(...params: unknown[]): T | undefined {
            return stmt.get(...params) as T | undefined;
        },
        all(...params: unknown[]): T[] {
            return stmt.all(...params) as T[];
        },
        run(...params: unknown[]): ExecuteResult {
            const info = stmt.run(...params);
            return {
                lastInsertRowid: info.lastInsertRowid,
                changes: info.changes,
            };
        },
        iterate(...params: unknown[]): IterableIterator<T> {
            return stmt.iterate(...params) as IterableIterator<T>;
        },
    };
}


export class SQLiteAdapter implements DatabaseAdapter {
    private _db: BetterSqlite3.Database;

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

        this._db = new BetterSqlite3(dbPath);
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('busy_timeout = 5000');
        this._db.pragma('synchronous = NORMAL');
        this._db.pragma('foreign_keys = ON');

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
        const tx = this._db.transaction(fn);
        return tx();
    }

    /** Run a prepared statement on multiple rows. Wraps in a single transaction. */
    batch<T extends unknown[]>(sql: string, rows: T[]): void {
        const stmt = this._db.prepare(sql);
        const tx = this._db.transaction(() => {
            for (const row of rows) {
                stmt.run(...row);
            }
        });
        tx();
    }

    /** Close the database. */
    close(): void {
        this._db.close();
    }

    /**
     * Access the underlying `better-sqlite3` Database instance.
     *
     * @deprecated Use `DatabaseAdapter` methods instead. This exists
     * only for gradual migration of plugins that depend on driver internals.
     */
    raw<T = unknown>(): T {
        return this._db as unknown as T;
    }
}
