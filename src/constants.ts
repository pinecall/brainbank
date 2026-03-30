/**
 * BrainBank — Constants
 *
 * Single source of truth for plugin type names and HNSW index keys.
 * Use these instead of raw strings to get compile-time safety.
 */

/** Built-in plugin type identifiers. */
export const PLUGIN = {
    CODE:   'code',
    GIT:    'git',
    DOCS:   'docs',
    MEMORY: 'memory',
} as const;

export type PluginType = typeof PLUGIN[keyof typeof PLUGIN];

/** HNSW index keys (superset of plugin types — includes 'kv'). */
export const HNSW = {
    CODE:   'code',
    GIT:    'git',
    MEMORY: 'memory',
    KV:     'kv',
    DOCS:   'docs',
} as const;

export type HnswKey = typeof HNSW[keyof typeof HNSW];
