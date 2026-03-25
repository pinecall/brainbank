/**
 * BrainBank — Database
 * 
 * Thin wrapper over better-sqlite3.
 * Handles WAL mode, directory creation, schema init, and transactions.
 */

import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSchema } from './schema.ts';

export class Database {
    readonly db: BetterSqlite3.Database;

    constructor(dbPath: string) {
        // Ensure parent directory exists
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new BetterSqlite3(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');

        // Initialize schema
        createSchema(this.db);
    }

    /**
     * Run a function inside a transaction.
     * Auto-commits on success, auto-rollbacks on error.
     */
    transaction<T>(fn: () => T): T {
        const tx = this.db.transaction(fn);
        return tx();
    }

    /**
     * Run a prepared statement on multiple rows.
     * Wraps in a single transaction for performance.
     */
    batch<T extends any[]>(sql: string, rows: T[]): void {
        const stmt = this.db.prepare(sql);
        const tx = this.db.transaction(() => {
            for (const row of rows) {
                stmt.run(...row);
            }
        });
        tx();
    }

    /** Prepare a reusable statement. */
    prepare(sql: string): BetterSqlite3.Statement {
        return this.db.prepare(sql);
    }

    /** Execute raw SQL (no results). */
    exec(sql: string): void {
        this.db.exec(sql);
    }

    /** Close the database. */
    close(): void {
        this.db.close();
    }
}
