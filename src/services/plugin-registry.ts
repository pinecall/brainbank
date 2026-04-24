/**
 * BrainBank — Plugin Registry
 *
 * Manages registration and lookup of plugins.
 * Extracted from BrainBank so the facade stays focused on orchestration.
 *
 * Responsibilities:
 *   - Store plugins by name
 *   - Alias resolution      (currently none; add here if needed)
 *   - Consistent error messages on missing plugins
 */

import type { Plugin } from '@/plugin.ts';

/** Shorthand aliases that map public names to canonical plugin names. */
const ALIASES: Readonly<Record<string, string>> = {
};

export class PluginRegistry {
    private _map = new Map<string, Plugin>();


    /** Store a plugin. Duplicate names silently overwrite. */
    register(plugin: Plugin): void {
        this._map.set(plugin.name, plugin);
    }


    /** Check whether a plugin is registered (exact match). */
    has(name: string): boolean {
        return this._map.has(name);
    }

    /**
     * Get a plugin by name.  Throws a descriptive error if not found.
     *
     * Resolution order:
     *   1. Alias map   (currently empty)
     *   2. Exact match
     */
    get<T extends Plugin = Plugin>(name: string): T {
        const resolved = ALIASES[name] ?? name;

        const exact = this._map.get(resolved);
        if (exact) return exact as T;

        throw new Error(
            `BrainBank: Plugin '${name}' is not loaded. ` +
            `Add .use(${name}()) to your BrainBank instance.`,
        );
    }


    /** All registered plugin names (insertion order). */
    get names(): string[] {
        return [...this._map.keys()];
    }

    /** All registered plugin instances (insertion order). */
    get all(): Plugin[] {
        return [...this._map.values()];
    }

    /**
     * Underlying Map.
     * Prefer `all` everywhere else.
     */
    get raw(): Map<string, Plugin> {
        return this._map;
    }


    /** Remove all registered plugins. Called by BrainBank.close(). */
    clear(): void {
        this._map.clear();
    }
}
