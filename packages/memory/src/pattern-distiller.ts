/**
 * @brainbank/memory — Pattern Distiller
 *
 * Aggregates top patterns for a task type into a single strategy text.
 * Analogous to SONA's Deep Loop — periodic knowledge distillation.
 */

import type { Database, DistilledStrategy } from 'brainbank';

export class PatternDistiller {
    constructor(private _db: Database) {}

    /** Distill top patterns for a task type into a strategy. Updates distilled_strategies table. */
    distill(taskType: string, topK: number = 10): DistilledStrategy | null {
        const patterns = this._db.prepare(`
            SELECT task, approach, outcome, critique, success_rate
            FROM memory_patterns
            WHERE task_type = ? AND success_rate >= 0.7
            ORDER BY success_rate DESC, created_at DESC
            LIMIT ?
        `).all(taskType, topK) as any[];

        if (patterns.length === 0) return null;

        const lines: string[] = [];
        const avgSuccess = patterns.reduce((sum: number, p: any) => sum + p.success_rate, 0) / patterns.length;

        lines.push(`Strategy for "${taskType}" (${patterns.length} patterns, avg success ${Math.round(avgSuccess * 100)}%):`);
        lines.push('');

        for (const p of patterns) {
            lines.push(`• ${p.approach} (${Math.round(p.success_rate * 100)}%)`);
            if (p.critique) lines.push(`  └ ${p.critique}`);
        }

        const strategy = lines.join('\n');
        const confidence = avgSuccess;
        const now = Math.floor(Date.now() / 1000);

        this._db.prepare(`
            INSERT INTO distilled_strategies (task_type, strategy, confidence, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(task_type) DO UPDATE SET
                strategy = excluded.strategy,
                confidence = excluded.confidence,
                updated_at = excluded.updated_at
        `).run(taskType, strategy, confidence, now);

        return { taskType, strategy, confidence, updatedAt: now };
    }

    /** Get a distilled strategy for a task type. */
    get(taskType: string): DistilledStrategy | null {
        const row = this._db.prepare(
            'SELECT * FROM distilled_strategies WHERE task_type = ?'
        ).get(taskType) as any;

        if (!row) return null;
        return {
            taskType: row.task_type,
            strategy: row.strategy,
            confidence: row.confidence,
            updatedAt: row.updated_at,
        };
    }

    /** List all distilled strategies. */
    list(): DistilledStrategy[] {
        const rows = this._db.prepare(
            'SELECT * FROM distilled_strategies ORDER BY confidence DESC'
        ).all() as any[];

        return rows.map(r => ({
            taskType: r.task_type,
            strategy: r.strategy,
            confidence: r.confidence,
            updatedAt: r.updated_at,
        }));
    }
}
