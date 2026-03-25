/**
 * BrainBank — Co-Edit Analyzer
 * 
 * Suggests files that historically change together.
 * Based on git commit co-occurrence analysis.
 */

import type { Database } from '@/db/database.ts';
import type { CoEditSuggestion } from '@/types.ts';

export class CoEditAnalyzer {
    constructor(private _db: Database) {}

    /**
     * Get files that frequently change alongside the given file.
     * Returns sorted by co-edit count (highest first).
     */
    suggest(filePath: string, limit: number = 5): CoEditSuggestion[] {
        const rows = this._db.prepare(`
            SELECT
                CASE WHEN file_a = ? THEN file_b ELSE file_a END AS file,
                count
            FROM co_edits
            WHERE file_a = ? OR file_b = ?
            ORDER BY count DESC
            LIMIT ?
        `).all(filePath, filePath, filePath, limit) as any[];

        return rows.map(r => ({ file: r.file, count: r.count }));
    }
}
