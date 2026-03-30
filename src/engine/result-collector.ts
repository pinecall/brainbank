/**
 * BrainBank — Result Collector
 *
 * Gathers search results from non-core sources: docs plugin,
 * custom SearchablePlugins, and KV collections.
 * Extracted from SearchAPI to isolate source-gathering logic
 * from fusion/orchestration.
 */

import type { Collection } from '@/services/collection.ts';
import type { PluginRegistry } from '@/bootstrap/registry.ts';
import type { SearchablePlugin } from '@/plugin.ts';
import { isSearchable } from '@/plugin.ts';
import type { SearchResult } from '@/types.ts';

export interface ResultCollectorDeps {
    registry:       PluginRegistry;
    getDocsPlugin(): SearchablePlugin | undefined;
    collection(name: string): Collection;
}

/** Gathers search results from docs, custom plugins, and KV collections. */
export class ResultCollector {
    constructor(private _d: ResultCollectorDeps) {}

    /** Search docs via the docs plugin. */
    async collectDocs(
        query: string, options?: { collection?: string; k?: number; minScore?: number },
    ): Promise<SearchResult[]> {
        const plugin = this._d.getDocsPlugin();
        if (!plugin) return [];
        return plugin.search(query, options);
    }

    /** Search all custom SearchablePlugins (non-builtin). */
    async collectCustomPlugins(
        query: string, options?: Record<string, any>,
    ): Promise<SearchResult[][]> {
        const builtinTypes = new Set(['code', 'git', 'docs']);
        const lists: SearchResult[][] = [];
        for (const mod of this._d.registry.all) {
            const baseType = mod.name.split(':')[0];
            if (builtinTypes.has(baseType)) continue;
            if (!isSearchable(mod)) continue;
            const hits = await mod.search(query, options);
            if (hits.length > 0) lists.push(hits);
        }
        return lists;
    }

    /** Search named KV collections (skips reserved names: code, git, docs). */
    async collectKvCollections(
        query: string, cols: Record<string, number>,
    ): Promise<SearchResult[][]> {
        const reserved = new Set(['code', 'git', 'docs']);
        const lists: SearchResult[][] = [];
        for (const [name, k] of Object.entries(cols)) {
            if (reserved.has(name)) continue;
            const hits = await this._d.collection(name).search(query, { k });
            if (hits.length > 0) {
                lists.push(hits.map(h => ({
                    type: 'collection' as const,
                    score: h.score ?? 0,
                    content: h.content,
                    metadata: { collection: name, id: h.id, ...h.metadata },
                })));
            }
        }
        return lists;
    }
}
