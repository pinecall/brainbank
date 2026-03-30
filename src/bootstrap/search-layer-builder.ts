/**
 * BrainBank — Search Layer Builder
 *
 * Constructs the search stack (vector + keyword + context builder)
 * from initialized plugins. Extracted from Initializer._buildSearchLayer()
 * so Initializer doesn't know about VectorSearch internals.
 */

import type { Database } from '@/db/database.ts';
import type { EmbeddingProvider } from '@/types.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { SearchStrategy } from '@/search/types.ts';
import type { PluginRegistry } from './registry.ts';
import { isHnswPlugin, isCoEditPlugin } from '@/plugin.ts';
import { PLUGIN } from '@/constants.ts';
import { CodeVectorSearch } from '@/search/vector/code-vector-search.ts';
import { GitVectorSearch } from '@/search/vector/git-vector-search.ts';
import { PatternVectorSearch } from '@/search/vector/pattern-vector-search.ts';
import { CompositeVectorSearch } from '@/search/vector/composite-vector-search.ts';
import { KeywordSearch } from '@/search/keyword/keyword-search.ts';
import { ContextBuilder } from '@/search/context-builder.ts';
import { SqlCodeGraphProvider } from '@/search/context/sql-code-graph.ts';
import type { ResolvedConfig } from '@/types.ts';

export interface SearchLayer {
    search?: SearchStrategy;
    bm25?: KeywordSearch;
    contextBuilder?: ContextBuilder;
}

/** Build the search layer from registry state. */
export function buildSearchLayer(
    db: Database,
    embedding: EmbeddingProvider,
    config: ResolvedConfig,
    registry: PluginRegistry,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
): SearchLayer {
    const codeMod = sharedHnsw.get(PLUGIN.CODE);
    const gitMod  = sharedHnsw.get(PLUGIN.GIT);
    const memPlugin = registry.firstByType(PLUGIN.MEMORY);
    const memMod    = memPlugin && isHnswPlugin(memPlugin) ? memPlugin : undefined;

    if (!codeMod && !gitMod && !memMod) return {};

    const code = codeMod
        ? new CodeVectorSearch({ db, hnsw: codeMod.hnsw, vecs: codeMod.vecCache })
        : undefined;
    const git = gitMod
        ? new GitVectorSearch({ db, hnsw: gitMod.hnsw })
        : undefined;
    const patterns = memMod
        ? new PatternVectorSearch({ db, hnsw: memMod.hnsw, vecs: memMod.vecCache })
        : undefined;

    const search = new CompositeVectorSearch({
        code, git, patterns, embedding,
        reranker: config.reranker,
    });

    const bm25 = new KeywordSearch(db);

    const gitPlugin = registry.firstByType(PLUGIN.GIT);
    const coEdits   = gitPlugin && isCoEditPlugin(gitPlugin) ? gitPlugin.coEdits : undefined;
    const codeGraph = new SqlCodeGraphProvider(db);
    const contextBuilder = new ContextBuilder(search, coEdits, codeGraph);

    return { search, bm25, contextBuilder };
}
