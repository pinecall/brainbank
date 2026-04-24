/**
 * BrainBank — Composite BM25 Search Strategy
 *
 * Generic BM25 coordinator that discovers BM25SearchPlugin instances
 * from the registry and delegates per-source keyword search.
 */

import type { SearchResult } from '@/types.ts';
import type { SearchStrategy, SearchOptions } from '@/search/types.ts';
import type { PluginRegistry } from '@/services/plugin-registry.ts';

import { isBM25SearchPlugin } from '@/plugin.ts';

const DEFAULT_K = 8;

export class CompositeBM25Search implements SearchStrategy {
    constructor(private _registry: PluginRegistry) {}

    /**
     * Run BM25 keyword search across all plugins that implement BM25SearchPlugin.
     * Each plugin searches its own FTS5 tables.
     */
    async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
        const src = options.sources ?? {};
        const results: SearchResult[] = [];

        for (const plugin of this._registry.all) {
            if (!isBM25SearchPlugin(plugin)) continue;

            const k = src[plugin.name] ?? DEFAULT_K;
            if (k <= 0) continue;

            const hits = plugin.searchBM25(query, k);
            results.push(...hits);
        }

        return results.sort((a, b) => b.score - a.score);
    }

    /** Rebuild FTS5 indices across all BM25 plugins. */
    rebuild(): void {
        for (const plugin of this._registry.all) {
            if (!isBM25SearchPlugin(plugin)) continue;
            plugin.rebuildFTS?.();
        }
    }
}
