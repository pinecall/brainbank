/**
 * BrainBank — Incremental Tracker
 *
 * Standardized helper for plugins to detect add/update/delete during indexing.
 * Uses a shared `plugin_tracking` table with per-plugin namespacing.
 *
 * Usage in a plugin:
 *   const tracker = ctx.createTracker();  // uses plugin name
 *   for (const file of files) {
 *       const hash = sha256(content);
 *       if (tracker.isUnchanged(file, hash)) { skipped++; continue; }
 *       indexFile(file, content);
 *       tracker.markIndexed(file, hash);
 *   }
 *   const orphans = tracker.findOrphans(new Set(files));
 *   for (const key of orphans) { removeData(key); tracker.remove(key); }
 */

import type { DatabaseAdapter } from './adapter.ts';

/** Incremental index tracker — detects add/update/delete for plugin files. */
export interface IncrementalTracker {
    /** Check if a key's content is unchanged. Returns true if the hash matches (skip indexing). */
    isUnchanged(key: string, contentHash: string): boolean;

    /** Mark a key as successfully indexed with the given hash. Call after indexing completes. */
    markIndexed(key: string, contentHash: string): void;

    /** Find tracked keys that are NOT in the current set. Returns keys to delete. */
    findOrphans(currentKeys: Set<string>): string[];

    /** Remove tracking for a key. Call after cleaning up the key's data. */
    remove(key: string): void;

    /** Remove all tracking entries for this plugin. */
    clear(): void;
}

/** Create tracking table. Called during core schema init. */
export function createTrackingTable(db: DatabaseAdapter): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_tracking (
            plugin       TEXT NOT NULL,
            key          TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            indexed_at   INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (plugin, key)
        );
    `);
}

/** Create an IncrementalTracker scoped to a plugin name. */
export function createTracker(db: DatabaseAdapter, pluginName: string): IncrementalTracker {
    return {
        isUnchanged(key: string, contentHash: string): boolean {
            const row = db.prepare(
                'SELECT content_hash FROM plugin_tracking WHERE plugin = ? AND key = ?'
            ).get(pluginName, key) as { content_hash: string } | undefined;
            return row?.content_hash === contentHash;
        },

        markIndexed(key: string, contentHash: string): void {
            db.prepare(`
                INSERT INTO plugin_tracking (plugin, key, content_hash)
                VALUES (?, ?, ?)
                ON CONFLICT(plugin, key) DO UPDATE SET
                    content_hash = excluded.content_hash,
                    indexed_at = unixepoch()
            `).run(pluginName, key, contentHash);
        },

        findOrphans(currentKeys: Set<string>): string[] {
            const rows = db.prepare(
                'SELECT key FROM plugin_tracking WHERE plugin = ?'
            ).all(pluginName) as { key: string }[];
            return rows.filter(r => !currentKeys.has(r.key)).map(r => r.key);
        },

        remove(key: string): void {
            db.prepare(
                'DELETE FROM plugin_tracking WHERE plugin = ? AND key = ?'
            ).run(pluginName, key);
        },

        clear(): void {
            db.prepare(
                'DELETE FROM plugin_tracking WHERE plugin = ?'
            ).run(pluginName);
        },
    };
}
