/**
 * BrainBank — Memory Module
 * 
 * Agent learns from completed tasks — stores patterns,
 * consolidates failures, distills strategies.
 * 
 *   import { memory } from 'brainbank/memory';
 *   brain.use(memory());
 */

import type { BrainBankModule, ModuleContext } from './types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import type { Database } from '../storage/database.ts';
import { PatternStore } from '../memory/pattern-store.ts';
import { Consolidator } from '../memory/consolidator.ts';
import { StrategyDistiller } from '../memory/strategy-distiller.ts';
import type { MemoryPattern, DistilledStrategy } from '../types.ts';

export interface MemoryModuleOptions {}

class MemoryModuleImpl implements BrainBankModule {
    readonly name = 'memory';
    hnsw!: HNSWIndex;
    patternStore!: PatternStore;
    consolidator!: Consolidator;
    distiller!: StrategyDistiller;
    vecCache = new Map<number, Float32Array>();
    private _db!: Database;

    constructor(private opts: MemoryModuleOptions = {}) {}

    async initialize(ctx: ModuleContext): Promise<void> {
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
    async learn(pattern: MemoryPattern): Promise<number> {
        const id = await this.patternStore.learn(pattern);

        // Auto-consolidate every 50 patterns
        if (this.patternStore.count % 50 === 0) {
            this.consolidator.consolidate();
        }

        return id;
    }

    /** Search for similar patterns. */
    async search(query: string, k: number = 4): Promise<(MemoryPattern & { score: number })[]> {
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

/** Create an agent memory (learning) module. */
export function memory(opts?: MemoryModuleOptions): BrainBankModule {
    return new MemoryModuleImpl(opts);
}
