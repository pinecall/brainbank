/**
 * BrainBank — Plugin Migration System
 *
 * Per-plugin versioned schema migrations.
 * Each plugin declares a schemaVersion + ordered migrations array.
 * Core stores applied versions in `plugin_versions` table.
 *
 * Plugins call `runPluginMigrations()` at the top of their `initialize()`.
 * Migrations use `IF NOT EXISTS` so first run on an existing DB is a no-op.
 */

import type { DatabaseAdapter } from './adapter.ts';

/** A single migration step. */
export interface Migration {
    /** Version this migration brings the schema to. */
    version: number;
    /** Apply the migration. Must be idempotent (use IF NOT EXISTS). */
    up(adapter: DatabaseAdapter): void;
}

/** Get the currently stored schema version for a plugin. Returns 0 if no record. */
export function getPluginVersion(adapter: DatabaseAdapter, pluginName: string): number {
    try {
        const row = adapter.prepare(
            'SELECT version FROM plugin_versions WHERE plugin_name = ?'
        ).get(pluginName) as { version: number } | undefined;
        return row?.version ?? 0;
    } catch {
        return 0;
    }
}

/** Set the schema version for a plugin. */
export function setPluginVersion(adapter: DatabaseAdapter, pluginName: string, version: number): void {
    adapter.prepare(`
        INSERT OR REPLACE INTO plugin_versions (plugin_name, version, applied_at)
        VALUES (?, ?, unixepoch())
    `).run(pluginName, version);
}

/**
 * Run pending migrations for a plugin.
 * Skips migrations whose version <= stored version.
 * Each migration runs in its own transaction.
 */
export function runPluginMigrations(
    adapter: DatabaseAdapter,
    pluginName: string,
    schemaVersion: number,
    migrations: Migration[],
): void {
    const current = getPluginVersion(adapter, pluginName);
    if (current >= schemaVersion) return;

    const sorted = [...migrations].sort((a, b) => a.version - b.version);

    for (const m of sorted) {
        if (m.version <= current) continue;

        adapter.transaction(() => {
            m.up(adapter);
            setPluginVersion(adapter, pluginName, m.version);
        });
    }
}
