/**
 * BrainBank — Search Factory
 *
 * Constructs a fully-wired SearchAPI from initialized plugins.
 * Builds vector strategies, keyword search, and context builder,
 * then returns a ready-to-use SearchAPI instance.
 */

import type { Database } from '@/db/database.ts';
import type { EmbeddingProvider, ResolvedConfig } from '@/types.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { PluginRegistry } from '@/services/plugin-registry.ts';
import type { KVService } from '@/services/kv-service.ts';
import { isHnswPlugin, isCoEditPlugin, isSearchable } from '@/plugin.ts';
import { PLUGIN } from '@/constants.ts';
import { CodeVectorSearch } from '@/search/vector/code-vector-search.ts';
import { GitVectorSearch } from '@/search/vector/git-vector-search.ts';
import { PatternVectorSearch } from '@/search/vector/pattern-vector-search.ts';
import { CompositeVectorSearch } from '@/search/vector/composite-vector-search.ts';
import { KeywordSearch } from '@/search/keyword/keyword-search.ts';
import { ContextBuilder } from '@/search/context-builder.ts';
import { SqlCodeGraphProvider } from '@/search/context/sql-code-graph.ts';
import { SearchAPI } from './search-api.ts';

/** Build a fully-wired SearchAPI from registry state. Always returns an instance — handles docs-only setups internally. */
export function createSearchAPI(
    db: Database,
    embedding: EmbeddingProvider,
    config: ResolvedConfig,
    registry: PluginRegistry,
    kvService: KVService,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
): SearchAPI {
    const codeMod = sharedHnsw.get(PLUGIN.CODE);
    const gitMod  = sharedHnsw.get(PLUGIN.GIT);
    const memPlugin = registry.firstByType(PLUGIN.MEMORY);
    const memMod    = memPlugin && isHnswPlugin(memPlugin) ? memPlugin : undefined;

    const code = codeMod
        ? new CodeVectorSearch({ db, hnsw: codeMod.hnsw, vecs: codeMod.vecCache })
        : undefined;
    const git = gitMod
        ? new GitVectorSearch({ db, hnsw: gitMod.hnsw })
        : undefined;
    const patterns = memMod
        ? new PatternVectorSearch({ db, hnsw: memMod.hnsw, vecs: memMod.vecCache })
        : undefined;

    const hasAnyStrategy = codeMod || gitMod || memMod;
    const search = hasAnyStrategy
        ? new CompositeVectorSearch({ code, git, patterns, embedding })
        : undefined;

    const bm25 = new KeywordSearch(db);

    // Context builder
    const gitPlugin = registry.firstByType(PLUGIN.GIT);
    const coEdits   = gitPlugin && isCoEditPlugin(gitPlugin) ? gitPlugin.coEdits : undefined;
    const codeGraph = new SqlCodeGraphProvider(db);

    const docsSearch = async (query: string, options?: { k?: number }) => {
        const d = registry.firstByType(PLUGIN.DOCS);
        if (!d || !isSearchable(d)) return [];
        return d.search(query, options);
    };

    const contextBuilder = new ContextBuilder(search, coEdits, codeGraph, docsSearch);

    return new SearchAPI({
        search, bm25, registry, config,
        kvService, contextBuilder,
    });
}
