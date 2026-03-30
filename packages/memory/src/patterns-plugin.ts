/**
 * @brainbank/memory — Patterns Plugin
 *
 * Agent learns from completed tasks — stores patterns,
 * consolidates failures, distills strategies.
 *
 *   import { patterns } from '@brainbank/memory';
 *   brain.use(patterns());
 */

import type { Plugin, PluginContext, HNSWIndex, Database, LearningPattern, DistilledStrategy } from 'brainbank';
import { PatternStore } from './pattern-store.js';
import { Consolidator } from './consolidator.js';
import { PatternDistiller } from './pattern-distiller.js';

class PatternsPlugin implements Plugin {
    readonly name = 'memory';
    hnsw!: HNSWIndex;
    patternStore!: PatternStore;
    consolidator!: Consolidator;
    distiller!: PatternDistiller;
    vecCache = new Map<number, Float32Array>();
    private _db!: Database;

    async initialize(ctx: PluginContext): Promise<void> {
        this._db = ctx.db;
        this.hnsw = await ctx.createHnsw(100_000, undefined, 'memory');
        ctx.loadVectors('memory_vectors', 'pattern_id', this.hnsw, this.vecCache);

        this.patternStore = new PatternStore({
            db: ctx.db,
            hnsw: this.hnsw,
            vectorCache: this.vecCache,
            embedding: ctx.embedding,
        });

        this.consolidator = new Consolidator(ctx.db, this.vecCache);
        this.distiller = new PatternDistiller(ctx.db);
    }

    /** Store a learned pattern. */
    async learn(pattern: LearningPattern): Promise<number> {
        const id = await this.patternStore.learn(pattern);

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

/** Create a pattern learning plugin (registers as 'memory'). */
export function patterns(): Plugin {
    return new PatternsPlugin();
}

/**
 * @deprecated Use `patterns()` instead. Alias kept for backwards compatibility.
 */
export const memory = patterns;
