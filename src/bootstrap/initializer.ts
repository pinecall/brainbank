/**
 * BrainBank — Initializer
 *
 * Two-phase initialization keeps the dependency ordering correct:
 *   Phase 1 (early)  — db, embedding, kvHnsw.  Must be assigned to
 *            `this` on BrainBank before phase 2, so that collection()
 *            works when indexers call ctx.collection() during initialize().
 *   Phase 2 (late)   — loads vectors, runs indexers, builds search.
 */

import { dirname, join } from 'node:path';
import { Database } from '@/db/database.ts';
import { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import { resolveEmbedding } from '@/providers/embeddings/resolve.ts';
import { buildSearchLayer, type SearchLayer } from './search-layer-builder.ts';
import { setEmbeddingMeta, getEmbeddingMeta, detectProviderMismatch } from '@/db/embedding-meta.ts';
import type { PluginRegistry } from './registry.ts';
import type { Collection } from '@/services/collection.ts';
import type { ResolvedConfig, EmbeddingProvider } from '@/types.ts';
import type { PluginContext } from '@/plugin.ts';
import { isHnswPlugin, isCoEditPlugin } from '@/plugin.ts';
import { PLUGIN } from '@/constants.ts';

// ── Result types ─────────────────────────────────────

/** Available after phase 1 — before indexers run. */
export interface EarlyInit {
    db: Database;
    embedding: EmbeddingProvider;
    kvHnsw: HNSWIndex;
    /** True when force-init with mismatched dims — vectors skipped until reembed. */
    skipVectorLoad: boolean;
}

/** Available after phase 2 — once plugins have initialized. */
export type LateInit = SearchLayer;

// ── Initializer class ────────────────────────────────

/** Encapsulates BrainBank's two-phase initialization sequence. */
export class Initializer {
    private readonly _config: ResolvedConfig;
    private readonly _emit: (event: string, data: unknown) => void;

    constructor(config: ResolvedConfig, emit: (event: string, data: unknown) => void) {
        this._config = config;
        this._emit = emit;
    }

    /** Phase 1: database, embedding provider, KV HNSW index. */
    async early(options: { force?: boolean } = {}): Promise<EarlyInit> {
        const { _config: config } = this;
        const db = new Database(config.dbPath);
        const embedding = await this._resolveEmbedding(db);

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

        const skipVectorLoad = !!(options.force && mismatch?.mismatch);

        return { db, embedding, kvHnsw, skipVectorLoad };
    }

    /** Phase 2: load vectors, run indexers, build search layer. */
    async late(
        earlyResult: EarlyInit,
        registry: PluginRegistry,
        sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
        kvVecs: Map<number, Float32Array>,
        getCollection: (name: string) => Collection,
    ): Promise<LateInit> {
        const { _config: config } = this;
        const { db, embedding, kvHnsw, skipVectorLoad } = earlyResult;

        if (!skipVectorLoad) {
            const kvIndexPath = hnswPath(config.dbPath, 'kv');
            const kvCount = countRows(db, 'kv_vectors');
            if (kvHnsw.tryLoad(kvIndexPath, kvCount)) {
                loadVecCache(db, 'kv_vectors', 'data_id', kvVecs);
            } else {
                loadVectors(db, 'kv_vectors', 'data_id', kvHnsw, kvVecs);
            }
        }

        const privateHnsw = new Map<string, HNSWIndex>();
        const ctx = this._buildPluginContext(db, embedding, sharedHnsw, skipVectorLoad, getCollection, privateHnsw);

        for (const mod of registry.all) {
            await mod.initialize(ctx);
        }

        saveAllHnsw(config.dbPath, kvHnsw, sharedHnsw, privateHnsw);

        return this._buildSearchLayer(db, embedding, registry, sharedHnsw);
    }

    /** Build the PluginContext passed to each plugin's initialize(). */
    private _buildPluginContext(
        db: Database,
        embedding: EmbeddingProvider,
        sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
        skipVectorLoad: boolean,
        getCollection: (name: string) => Collection,
        privateHnsw: Map<string, HNSWIndex>,
    ): PluginContext {
        const { _config: config } = this;
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

            collection: getCollection,
        };
    }

    /** Build search layer from initialized plugins. */
    private _buildSearchLayer(
        db: Database,
        embedding: EmbeddingProvider,
        registry: PluginRegistry,
        sharedHnsw: Map<string, { hnsw: HNSWIndex; vecCache: Map<number, Float32Array> }>,
    ): SearchLayer {
        return buildSearchLayer(db, embedding, this._config, registry, sharedHnsw);
    }

    /** Resolve embedding: explicit config > stored DB key > local default. */
    private async _resolveEmbedding(db: Database): Promise<EmbeddingProvider> {
        if (this._config.embeddingProvider) return this._config.embeddingProvider;
        const meta = getEmbeddingMeta(db);
        if (meta?.providerKey && meta.providerKey !== 'local') {
            this._emit('progress', `Embedding: auto-resolved '${meta.providerKey}' from DB`);
            return resolveEmbedding(meta.providerKey);
        }
        return resolveEmbedding('local');
    }
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
    privateHnsw: Map<string, HNSWIndex>,
): void {
    try {
        kvHnsw.save(hnswPath(dbPath, 'kv'));
        for (const [name, { hnsw }] of sharedHnsw) {
            hnsw.save(hnswPath(dbPath, name));
        }
        for (const [name, hnsw] of privateHnsw) {
            hnsw.save(hnswPath(dbPath, name));
        }
    } catch {
        // Non-fatal: next startup will just rebuild from SQLite
    }
}

function loadVectors(
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
