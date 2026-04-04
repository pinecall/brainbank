/**
 * BrainBank — Index API
 *
 * Orchestrates indexing across all registered plugins.
 * Plugin-agnostic — uses capability interfaces to discover what can be indexed.
 *
 * After each plugin finishes indexing, bumps the version in `index_state`
 * and saves HNSW indices to disk (with cross-process file locking).
 */

import type { DatabaseAdapter } from '@/db/adapter.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { PluginRegistry } from '@/services/plugin-registry.ts';
import type { IndexResult, StageProgressCallback } from '@/types.ts';

import { bumpVersion } from '@/db/metadata.ts';
import { isIndexable } from '@/plugin.ts';
import { saveAllHnsw } from '@/providers/vector/hnsw-loader.ts';

/** Deps injected by BrainBank at init time. */
export interface IndexDeps {
    db: DatabaseAdapter;
    dbPath: string;
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>;
    kvHnsw: HNSWIndex;
    registry: PluginRegistry;
    emit: (event: string, data: unknown) => void;
}

/** Merge two `IndexResult` values, accumulating counts. */
function mergeResult(acc: IndexResult | undefined, r: IndexResult): IndexResult {
    if (!acc) return { ...r };
    return {
        indexed: acc.indexed + r.indexed,
        skipped: acc.skipped + r.skipped,
        chunks: (acc.chunks ?? 0) + (r.chunks ?? 0),
    };
}

/** Run indexing across all indexable plugins. Filter with `modules` (base types). */
export async function runIndex(deps: IndexDeps, options: {
    modules?: string[];
    forceReindex?: boolean;
    onProgress?: StageProgressCallback;
    /** Plugin-specific options forwarded to `IndexablePlugin.index()`. */
    pluginOptions?: Record<string, unknown>;
} = {}): Promise<Record<string, unknown>> {
    const want = options.modules ? new Set(options.modules) : null;
    const results: Record<string, unknown> = {};

    for (const mod of deps.registry.all) {
        const baseType = mod.name.split(':')[0];

        if (want && !want.has(baseType)) continue;
        if (!isIndexable(mod)) continue;

        const label = mod.name;
        options.onProgress?.(label, 'Starting...');

        const r = await mod.index({
            forceReindex: options.forceReindex,
            onProgress: (msg: string, cur: number, total: number) =>
                options.onProgress?.(label, `[${cur}/${total}] ${msg}`),
            ...options.pluginOptions,
        });

        results[baseType] = mergeResult(results[baseType] as IndexResult | undefined, r);

        // Bump version per plugin name (= HNSW key) so hot-reload resolves correctly.
        // In multi-repo setups the HNSW key is the full name (e.g. 'code:backend'),
        // not the base type ('code'). ensureFresh() matches against HNSW map keys.
        bumpVersion(deps.db, mod.name);
    }

    // Save HNSW indices with file locking after all plugins complete
    await saveAllHnsw(
        deps.dbPath,
        deps.kvHnsw,
        deps.sharedHnsw,
        new Map(),
    );

    deps.emit('indexed', results);
    return results;
}
