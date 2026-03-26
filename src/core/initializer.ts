/**
 * BrainBank — Initializer
 *
 * Two-phase initialization keeps the dependency ordering correct:
 *   Phase 1 (earlyInit)  — db, embedding, kvHnsw.  Must be assigned to
 *            `this` on BrainBank before phase 2, so that collection()
 *            works when indexers call ctx.collection() during initialize().
 *   Phase 2 (lateInit)   — loads vectors, runs indexers, builds search.
 */

import { dirname, join } from 'node:path';
import { Database } from '@/db/database.ts';
import { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import { LocalEmbedding } from '@/providers/embeddings/local-embedding.ts';
import { VectorSearch } from '@/search/vector/vector-search.ts';
import { KeywordSearch } from '@/search/keyword/keyword-search.ts';
import { ContextBuilder } from './context-builder.ts';
import { setEmbeddingMeta, detectProviderMismatch } from '@/services/reembed.ts';
import type { IndexerRegistry } from './registry.ts';
import type { Collection } from './collection.ts';
import type { ResolvedConfig, EmbeddingProvider } from '@/types.ts';
import type { IndexerContext } from '@/indexers/base.ts';

// ── Result types ─────────────────────────────────────

/** Available after phase 1 — before indexers run. */
export interface EarlyInit {
    db: Database;
    embedding: EmbeddingProvider;
    kvHnsw: HNSWIndex;
    /** True when force-init with mismatched dims — vectors skipped until reembed. */
    skipVectorLoad: boolean;
}

/** Available after phase 2 — once indexers have initialized. */
export interface LateInit {
    search?: VectorSearch;
    bm25?: KeywordSearch;
    contextBuilder?: ContextBuilder;
}

// ── Phase 1 ──────────────────────────────────────────

export async function earlyInit(
    config: ResolvedConfig,
    emit: (event: string, data: any) => void,
    options: { force?: boolean } = {},
): Promise<EarlyInit> {
    const db = new Database(config.dbPath);
    const embedding: EmbeddingProvider = config.embeddingProvider ?? new LocalEmbedding();

    const mismatch = detectProviderMismatch(db, embedding);

    if (mismatch?.mismatch && !options.force) {
        db.close();
        throw new Error(
            `BrainBank: Embedding dimension mismatch (stored: ${mismatch.stored}, current: ${mismatch.current}). ` +
            `Run brain.reembed() to re-index with the new provider, or switch back to the original provider.`
        );
    }

    setEmbeddingMeta(db, embedding);

    const kvHnsw = new HNSWIndex(
        config.embeddingDims,
        config.maxElements ?? 500_000,
        config.hnswM,
        config.hnswEfConstruction,
        config.hnswEfSearch,
    );
    await kvHnsw.init();

    // When forced with a mismatch, skip loading old vectors (wrong dims)
    const skipVectorLoad = !!(options.force && mismatch?.mismatch);

    return { db, embedding, kvHnsw, skipVectorLoad };
}

// ── Phase 2 ──────────────────────────────────────────

export async function lateInit(
    early: EarlyInit,
    config: ResolvedConfig,
    registry: IndexerRegistry,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
    kvVecs: Map<number, Float32Array>,
    getCollection: (name: string) => Collection,
): Promise<LateInit> {
    const { db, embedding, kvHnsw, skipVectorLoad } = early;

    if (!skipVectorLoad) {
        const kvIndexPath = hnswPath(config.dbPath, 'kv');
        const kvCount = countRows(db, 'kv_vectors');
        if (kvHnsw.tryLoad(kvIndexPath, kvCount)) {
            loadVecCache(db, 'kv_vectors', 'data_id', kvVecs);
        } else {
            loadVectors(db, 'kv_vectors', 'data_id', kvHnsw, kvVecs);
        }
    }

    const ctx = buildIndexerContext(db, embedding, config, sharedHnsw, skipVectorLoad, getCollection);

    for (const mod of registry.all) {
        await mod.initialize(ctx);
    }

    // Save HNSW indexes to disk for faster next startup
    saveAllHnsw(config.dbPath, kvHnsw, sharedHnsw);

    return buildSearchLayer(db, embedding, config, registry, sharedHnsw);
}

/** Build the IndexerContext passed to each plugin's initialize(). */
function buildIndexerContext(
    db: Database,
    embedding: EmbeddingProvider,
    config: ResolvedConfig,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
    skipVectorLoad: boolean,
    getCollection: (name: string) => Collection,
): IndexerContext {
    return {
        db,
        embedding,
        config,

        createHnsw: (maxElements?: number) =>
            new HNSWIndex(
                config.embeddingDims,
                maxElements ?? config.maxElements,
                config.hnswM,
                config.hnswEfConstruction,
                config.hnswEfSearch,
            ).init(),

        loadVectors: (table, idCol, hnsw, cache) => {
            if (skipVectorLoad) return;
            const indexName = table.replace('_vectors', '').replace('_chunks', '');
            const indexPath = hnswPath(config.dbPath, indexName);
            const rowCount = countRows(db, table);
            if (hnsw.tryLoad(indexPath, rowCount)) {
                // HNSW loaded from file — still populate vecCache for MMR
                loadVecCache(db, table, idCol, cache);
            } else {
                loadVectors(db, table, idCol, hnsw, cache);
            }
        },

        getOrCreateSharedHnsw: async (type, maxElements) => {
            const existing = sharedHnsw.get(type);
            if (existing) return { ...existing, isNew: false };

            const hnsw = await new HNSWIndex(
                config.embeddingDims,
                maxElements ?? config.maxElements,
                config.hnswM,
                config.hnswEfConstruction,
                config.hnswEfSearch,
            ).init();

            const vecCache = new Map<number, Float32Array>();
            sharedHnsw.set(type, { hnsw, vecCache });
            return { hnsw, vecCache, isNew: true };
        },

        collection: getCollection,
    };
}

/** Build VectorSearch + KeywordSearch + ContextBuilder from initialized plugins. */
function buildSearchLayer(
    db: Database,
    embedding: EmbeddingProvider,
    config: ResolvedConfig,
    registry: IndexerRegistry,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
): LateInit {
    const codeMod = sharedHnsw.get('code');
    const gitMod  = sharedHnsw.get('git');
    const memMod  = registry.firstByType('memory') as any;

    if (!codeMod && !gitMod && !memMod) return {};

    const search = new VectorSearch({
        db,
        codeHnsw:    codeMod?.hnsw,
        gitHnsw:     gitMod?.hnsw,
        patternHnsw: memMod?.hnsw,
        codeVecs:    codeMod?.vecCache ?? new Map(),
        gitVecs:     gitMod?.vecCache  ?? new Map(),
        patternVecs: memMod?.vecCache  ?? new Map(),
        embedding,
        reranker: config.reranker,
    });
    const bm25 = new KeywordSearch(db);

    const firstGit = registry.firstByType('git') as any;
    const contextBuilder = new ContextBuilder(search, firstGit?.coEdits);

    return { search, bm25, contextBuilder };
}

// ── Shared helpers ────────────────────────────────────

/** Derive the HNSW index file path from the DB path. */
function hnswPath(dbPath: string, name: string): string {
    return join(dirname(dbPath), `hnsw-${name}.index`);
}

/** Count rows in a vector table (fast, no data transfer). */
function countRows(db: Database, table: string): number {
    const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any;
    return row?.c ?? 0;
}

/** Save all HNSW indexes to disk for fast startup next time. */
function saveAllHnsw(
    dbPath: string,
    kvHnsw: HNSWIndex,
    sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
): void {
    try {
        kvHnsw.save(hnswPath(dbPath, 'kv'));
        for (const [name, { hnsw }] of sharedHnsw) {
            hnsw.save(hnswPath(dbPath, name));
        }
    } catch {
        // Non-fatal: next startup will just rebuild from SQLite
    }
}

export function loadVectors(
    db: Database,
    table: string,
    idCol: string,
    hnsw: HNSWIndex,
    cache: Map<number, Float32Array>,
): void {
    const iter = db.prepare(`SELECT ${idCol}, embedding FROM ${table}`).iterate() as IterableIterator<any>;
    for (const row of iter) {
        const vec = new Float32Array(
            row.embedding.buffer.slice(
                row.embedding.byteOffset,
                row.embedding.byteOffset + row.embedding.byteLength,
            ),
        );
        hnsw.add(vec, row[idCol]);
        cache.set(row[idCol], vec);
    }
}

/** Populate only the vecCache from SQLite (HNSW already loaded from file). */
function loadVecCache(
    db: Database,
    table: string,
    idCol: string,
    cache: Map<number, Float32Array>,
): void {
    const iter = db.prepare(`SELECT ${idCol}, embedding FROM ${table}`).iterate() as IterableIterator<any>;
    for (const row of iter) {
        const vec = new Float32Array(
            row.embedding.buffer.slice(
                row.embedding.byteOffset,
                row.embedding.byteOffset + row.embedding.byteLength,
            ),
        );
        cache.set(row[idCol], vec);
    }
}
