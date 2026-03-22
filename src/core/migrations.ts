/**
 * BrainBank — Schema Migrations
 * 
 * Automatically upgrades existing databases when BrainBank is updated.
 * Runs on initialize() — transparent to the user.
 * 
 * Each migration has a version number and SQL statements.
 * Only pending migrations (version > current) are applied.
 * 
 * Adding a new migration:
 *   1. Add entry to MIGRATIONS array with next version number
 *   2. Bump SCHEMA_VERSION in schema.ts to match
 *   3. Add test in migrations.test.ts
 */

import type Database from 'better-sqlite3';
import { getSchemaVersion } from './schema.ts';

// ── Migration Definitions ───────────────────────────

interface Migration {
    /** Schema version this migration upgrades TO */
    version: number;
    /** Human-readable description */
    description: string;
    /** SQL statements to execute */
    up: string;
}

/**
 * All schema migrations, ordered by version.
 * 
 * IMPORTANT: Never modify existing migrations.
 * Always append new ones with the next version number.
 */
export const MIGRATIONS: Migration[] = [
    {
        version: 5,
        description: 'Add tags and TTL support to kv_data',
        up: `
            ALTER TABLE kv_data ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
            ALTER TABLE kv_data ADD COLUMN expires_at INTEGER;
        `,
    },
];

// ── Migration Runner ────────────────────────────────

export interface MigrationResult {
    /** Starting schema version before migrations */
    from: number;
    /** Final schema version after migrations */
    to: number;
    /** List of applied migrations */
    applied: { version: number; description: string }[];
}

/**
 * Apply all pending migrations.
 * Safe to call multiple times — only runs migrations newer than current version.
 * Runs each migration in a transaction for atomicity.
 * 
 * @returns Summary of applied migrations (empty if already up-to-date)
 */
export function runMigrations(db: Database.Database): MigrationResult {
    const currentVersion = getSchemaVersion(db);
    const pending = MIGRATIONS.filter(m => m.version > currentVersion);

    const result: MigrationResult = {
        from: currentVersion,
        to: currentVersion,
        applied: [],
    };

    if (pending.length === 0) return result;

    for (const migration of pending) {
        // Run each migration in its own transaction
        const tx = db.transaction(() => {
            db.exec(migration.up);
            db.prepare(
                'INSERT OR REPLACE INTO schema_version (version) VALUES (?)'
            ).run(migration.version);
        });
        tx();

        result.applied.push({
            version: migration.version,
            description: migration.description,
        });
        result.to = migration.version;
    }

    return result;
}
