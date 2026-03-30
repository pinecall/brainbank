/**
 * BrainBank — Initializer
 *
 * Two-phase initialization as free functions:
 *   Phase 1 (earlyInit)  — db, embedding, kvHnsw.  Must complete before
 *            phase 2 so that collection() works when plugins call
 *            ctx.collection() during initialize().
 *   Phase 2 (lateInit)   — loads vectors, runs plugins, builds search.
 */

import { Database } from '@/db/database.ts';
import { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import { hnswPath, countRows, saveAllHnsw, loadVectors, loadVecCache } from '@/providers/vector/hnsw-loader.ts';
import { resolveEmbedding } from '@/providers/embeddings/resolve.ts';
import { setEmbeddingMeta, getEmbeddingMeta, detectProviderMismatch } from '@/db/embedding-meta.ts';
import { createSearchAPI } from '@/engine/search-factory.ts';
import type { SearchAPI } from '@/engine/search-api.ts';
import type { PluginRegistry } from '@/services/plugin-registry.ts';
import type { KVService } from '@/services/kv-service.ts';
import type { ResolvedConfig, EmbeddingProvider } from '@/types.ts';
import type { PluginContext } from '@/plugin.ts';

// ── Result types ─────────────────────────────────────

/** Available after phase 1 — before indexers run. */
export interface EarlyInit {
    db: Database;
    embedding: EmbeddingProvider;
    kvHnsw: HNSWIndex;
    /** True when force-init with mismatched dims — vectors skipped until reembed. */
    skipVectorLoad: boolean;
}



// ── Phase 1: earlyInit ──────────────────────────────

/** Database, embedding provider, KV HNSW index. */
export async function earlyInit(
    config: ResolvedConfig,
    emit: (event: string, data: unknown) => void,
    options: { force?: boolean } = {},
): Promise<EarlyInit> {
    const db = new Database(config.dbPath);
    const embedding = await resolveStartupEmbedding(config, emit, db);

    const mismatch = detectProviderMismatch(db, embedding);

    if (mismatch?.mismatch && !options.force) {
        db.close();
        throw new Error(
            `BrainBank: Embedding dimension mismatch (stored: ${mismatch.stored}, current: ${mismatch.current}). ` +
            `Run brain.reembed() to re-index with the new provider, or switch back to the original provider.`
        );
    }

    setEmbeddingMeta(db, embedding);

    // Sync dims from the resolved provider — config.embeddingDims is just the default (384).
    // Without this, passing an OpenAI provider (1536 dims) without explicit embeddingDims
    // would create a 384-dim HNSW index, causing silent dimension mismatches.
    const dims = embedding.dims ?? config.embeddingDims;

    const kvHnsw = new HNSWIndex(
        dims,
        config.maxElements ?? 500_000,
        config.hnswM,
        config.hnswEfConstruction,
        config.hnswEfSearch,
    );
    await kvHnsw.init();

    const skipVectorLoad = !!(options.force && mismatch?.mismatch);

    return { db, embedding, kvHnsw, skipVectorLoad };
}

// ── Phase 2: lateInit ───────────────────────────────

/** Load vectors, run plugin initializers, build the search API. */
export async function lateInit(
    config: ResolvedConfig,
    earlyResult: EarlyInit,
    registry: PluginRegistry,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
    kvService: KVService,
): Promise<SearchAPI | undefined> {
    const { db, embedding, kvHnsw, skipVectorLoad } = earlyResult;

    if (!skipVectorLoad) {
        const kvIndexPath = hnswPath(config.dbPath, 'kv');
        const kvCount = countRows(db, 'kv_vectors');
        if (kvHnsw.tryLoad(kvIndexPath, kvCount)) {
            loadVecCache(db, 'kv_vectors', 'data_id', kvService.vecs);
        } else {
            loadVectors(db, 'kv_vectors', 'data_id', kvHnsw, kvService.vecs);
        }
    }

    const privateHnsw = new Map<string, HNSWIndex>();
    const ctx = buildPluginContext(config, db, embedding, sharedHnsw, skipVectorLoad, kvService, privateHnsw);

    for (const mod of registry.all) {
        await mod.initialize(ctx);
    }

    saveAllHnsw(config.dbPath, kvHnsw, sharedHnsw, privateHnsw);

    return createSearchAPI(db, embedding, config, registry, kvService, sharedHnsw);
}

// ── Plugin context builder ──────────────────────────

/** Build the PluginContext passed to each plugin's initialize(). */
function buildPluginContext(
    config: ResolvedConfig,
    db: Database,
    embedding: EmbeddingProvider,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
    skipVectorLoad: boolean,
    kvService: KVService,
    privateHnsw: Map<string, HNSWIndex>,
): PluginContext {
    let _autoId = 0;
    return {
        db,
        embedding,
        config,

        createHnsw: async (maxElements?: number, dims?: number, name?: string) => {
            const hnsw = await new HNSWIndex(
                dims ?? config.embeddingDims,
                maxElements ?? config.maxElements,
                config.hnswM,
                config.hnswEfConstruction,
                config.hnswEfSearch,
            ).init();
            const key = name ?? `private-${_autoId++}`;
            privateHnsw.set(key, hnsw);
            return hnsw;
        },

        loadVectors: (table, idCol, hnsw, cache) => {
            if (skipVectorLoad) return;
            const indexName = table.replace('_vectors', '').replace('_chunks', '');
            const indexPath = hnswPath(config.dbPath, indexName);
            const rowCount = countRows(db, table);
            if (hnsw.tryLoad(indexPath, rowCount)) {
                loadVecCache(db, table, idCol, cache);
            } else {
                loadVectors(db, table, idCol, hnsw, cache);
            }
        },

        getOrCreateSharedHnsw: async (type, maxElements, dims) => {
            const existing = sharedHnsw.get(type);
            if (existing) return { ...existing, isNew: false };

            const hnswDims = dims ?? config.embeddingDims;
            const hnsw = await new HNSWIndex(
                hnswDims,
                maxElements ?? config.maxElements,
                config.hnswM,
                config.hnswEfConstruction,
                config.hnswEfSearch,
            ).init();

            const vecCache = new Map<number, Float32Array>();
            sharedHnsw.set(type, { hnsw, vecCache });
            return { hnsw, vecCache, isNew: true };
        },

        collection: (name) => kvService.collection(name),
    };
}

// ── Embedding resolution ────────────────────────────

/** Resolve embedding: explicit config > stored DB key > local default. */
async function resolveStartupEmbedding(
    config: ResolvedConfig,
    emit: (event: string, data: unknown) => void,
    db: Database,
): Promise<EmbeddingProvider> {
    if (config.embeddingProvider) return config.embeddingProvider;
    const meta = getEmbeddingMeta(db);
    if (meta?.providerKey && meta.providerKey !== 'local') {
        emit('progress', `Embedding: auto-resolved '${meta.providerKey}' from DB`);
        return resolveEmbedding(meta.providerKey);
    }
    return resolveEmbedding('local');
}

