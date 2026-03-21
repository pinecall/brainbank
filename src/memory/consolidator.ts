/**
 * BrainBank — Consolidator
 * 
 * Maintenance operations for the agent memory:
 *   - prune: remove old failed patterns
 *   - dedup: merge near-duplicate patterns (cosine > 0.95)
 *   - consolidate: run both
 */

import type { Database } from '../storage/database.ts';
import { cosineSimilarity } from '../embeddings/math.ts';

export class Consolidator {
    constructor(
        private _db: Database,
        private _vectorCache: Map<number, Float32Array>,
    ) {}

    /**
     * Remove old failed patterns.
     * Criteria: success_rate < 0.3 AND created > 90 days ago.
     */
    prune(maxAgeDays: number = 90, minSuccess: number = 0.3): number {
        const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
        const result = this._db.prepare(
            'DELETE FROM memory_patterns WHERE success_rate < ? AND created_at < ?'
        ).run(minSuccess, cutoff);
        return result.changes;
    }

    /**
     * Merge near-duplicate patterns.
     * Keeps the one with higher success_rate.
     * Threshold: cosine similarity > 0.95.
     */
    dedup(threshold: number = 0.95): number {
        const entries = Array.from(this._vectorCache.entries());
        const toDelete = new Set<number>();

        for (let i = 0; i < entries.length; i++) {
            if (toDelete.has(entries[i][0])) continue;

            for (let j = i + 1; j < entries.length; j++) {
                if (toDelete.has(entries[j][0])) continue;

                const sim = cosineSimilarity(entries[i][1], entries[j][1]);
                if (sim > threshold) {
                    // Keep the one with higher success rate
                    const pi = this._db.prepare(
                        'SELECT success_rate FROM memory_patterns WHERE id = ?'
                    ).get(entries[i][0]) as any;
                    const pj = this._db.prepare(
                        'SELECT success_rate FROM memory_patterns WHERE id = ?'
                    ).get(entries[j][0]) as any;

                    if (pi && pj) {
                        const deleteId = pi.success_rate >= pj.success_rate
                            ? entries[j][0]
                            : entries[i][0];
                        toDelete.add(deleteId);
                    }
                }
            }
        }

        if (toDelete.size > 0) {
            const ids = Array.from(toDelete);
            const placeholders = ids.map(() => '?').join(',');
            this._db.prepare(
                `DELETE FROM memory_patterns WHERE id IN (${placeholders})`
            ).run(...ids);

            // Clean vector cache
            for (const id of ids) {
                this._vectorCache.delete(id);
            }
        }

        return toDelete.size;
    }

    /**
     * Run full consolidation: prune + dedup.
     */
    consolidate(): { pruned: number; deduped: number } {
        const pruned = this.prune();
        const deduped = this.dedup();
        return { pruned, deduped };
    }
}
