/**
 * BrainBank — Indexer Registry
 *
 * Manages registration and lookup of indexers.
 * Extracted from BrainBank so the facade stays focused on orchestration.
 *
 * Responsibilities:
 *   - Store indexers by name
 *   - Type-prefix matching  ('code' finds 'code:frontend', 'code:backend')
 *   - Alias resolution      (currently none; add here if needed)
 *   - Consistent error messages on missing indexers
 */

import type { Indexer } from '../../indexers/base.ts';

/** Shorthand aliases that map public names to canonical indexer names. */
const ALIASES: Readonly<Record<string, string>> = {
};

export class IndexerRegistry {
    private _map = new Map<string, Indexer>();

    // ── Registration ────────────────────────────────

    /** Store an indexer. Duplicate names silently overwrite. */
    register(indexer: Indexer): void {
        this._map.set(indexer.name, indexer);
    }

    // ── Lookup ──────────────────────────────────────

    /**
     * Check whether an indexer is registered.
     * Supports type-prefix matching: `has('code')` returns true if
     * 'code', 'code:frontend', or 'code:backend' is registered.
     */
    has(name: string): boolean {
        if (this._map.has(name)) return true;
        for (const key of this._map.keys()) {
            if (key.startsWith(name + ':')) return true;
        }
        return false;
    }

    /**
     * Get an indexer by name.  Throws a descriptive error if not found.
     *
     * Resolution order:
     *   1. Alias map   (currently empty)
     *   2. Exact match
     *   3. First type-prefix match  ('code' → 'code:frontend')
     */
    get<T extends Indexer = Indexer>(name: string): T {
        const resolved = ALIASES[name] ?? name;

        const exact = this._map.get(resolved);
        if (exact) return exact as T;

        const prefixed = this.firstByType(name);
        if (prefixed) return prefixed as T;

        throw new Error(
            `BrainBank: Indexer '${name}' is not loaded. ` +
            `Add .use(${name}()) to your BrainBank instance.`,
        );
    }

    /**
     * Return every indexer whose name equals `type` or starts with `type + ':'`.
     * Example: allByType('code') → [code, code:frontend, code:backend]
     */
    allByType(type: string): Indexer[] {
        return [...this._map.values()].filter(
            m => m.name === type || m.name.startsWith(type + ':'),
        );
    }

    /** Return the first indexer that matches the type prefix, or undefined. */
    firstByType(type: string): Indexer | undefined {
        for (const m of this._map.values()) {
            if (m.name === type || m.name.startsWith(type + ':')) return m;
        }
        return undefined;
    }

    // ── Accessors ───────────────────────────────────

    /** All registered indexer names (insertion order). */
    get names(): string[] {
        return [...this._map.keys()];
    }

    /** All registered indexer instances (insertion order). */
    get all(): Indexer[] {
        return [...this._map.values()];
    }

    /**
     * Underlying Map.
     * Prefer `all`, `allByType`, or `firstByType` everywhere else.
     */
    get raw(): Map<string, Indexer> {
        return this._map;
    }

    // ── Lifecycle ───────────────────────────────────

    /** Remove all registered indexers. Called by BrainBank.close(). */
    clear(): void {
        this._map.clear();
    }
}
