/**
 * BrainBank — Learning Plugin
 * 
 * Agent learns from completed tasks — stores patterns,
 * consolidates failures, distills strategies.
 * 
 *   import { learning } from 'brainbank/learning';
 *   brain.use(learning());
 */

import type { Indexer, IndexerContext } from '../base.ts';
import type { HNSWIndex } from '../../providers/vector/hnsw-index.ts';
import type { Database } from '../../db/database.ts';
import { PatternStore } from '../../memory/pattern-store.ts';
import { Consolidator } from '../../memory/consolidator.ts';
import { StrategyDistiller } from '../../memory/strategy-distiller.ts';
import type { LearningPattern, DistilledStrategy } from '../../types.ts';

class LearningPlugin implements Indexer {
    readonly name = 'learning';
    hnsw!: HNSWIndex;
    patternStore!: PatternStore;
    consolidator!: Consolidator;
    distiller!: StrategyDistiller;
    vecCache = new Map<number, Float32Array>();
    private _db!: Database;

    async initialize(ctx: IndexerContext): Promise<void> {
        this._db = ctx.db;
        this.hnsw = await ctx.createHnsw(100_000);
        ctx.loadVectors('memory_vectors', 'pattern_id', this.hnsw, this.vecCache);

        this.patternStore = new PatternStore({
            db: ctx.db,
            hnsw: this.hnsw,
            vectorCache: this.vecCache,
            embedding: ctx.embedding,
        });

        this.consolidator = new Consolidator(ctx.db, this.vecCache);
        this.distiller = new StrategyDistiller(ctx.db);
    }

    /** Store a learned pattern. */
    async learn(pattern: LearningPattern): Promise<number> {
        const id = await this.patternStore.learn(pattern);

        // Auto-consolidate every 50 patterns (guard against count=0)
        if (this.patternStore.count > 0 && this.patternStore.count % 50 === 0) {
            this.consolidator.consolidate();
        }

        return id;
    }

    /** Search for similar patterns. */
    async search(query: string, k: number = 4): Promise<(LearningPattern & { score: number })[]> {
        return this.patternStore.search(query, k);
    }

    /** Consolidate: prune old failures + deduplicate. */
    consolidate(): { pruned: number; deduped: number } {
        return this.consolidator.consolidate();
    }

    /** Distill patterns into a strategy. */
    distill(taskType: string): DistilledStrategy | null {
        return this.distiller.distill(taskType);
    }

    stats(): Record<string, any> {
        return {
            patterns: this.patternStore.count,
            avgSuccess: (this._db.prepare('SELECT AVG(success_rate) as a FROM memory_patterns').get() as any).a ?? 0,
            hnswSize: this.hnsw.size,
        };
    }
}

/** Create an agent learning plugin. */
export function learning(): Indexer {
    return new LearningPlugin();
}
