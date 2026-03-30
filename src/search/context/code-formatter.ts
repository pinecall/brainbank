/**
 * BrainBank — Code Formatter
 *
 * Formats code search results grouped by file, with call graph annotations.
 */

import type { SearchResult } from '@/types.ts';
import type { Database } from '@/db/database.ts';

/** Format code search results grouped by file with call graph info. */
export function formatCodeResults(codeHits: SearchResult[], parts: string[], db?: Database): void {
    if (codeHits.length === 0) return;

    parts.push('## Relevant Code\n');

    const byFile = new Map<string, typeof codeHits>();
    for (const r of codeHits) {
        const key = r.filePath ?? 'unknown';
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key)!.push(r);
    }

    for (const [file, chunks] of byFile) {
        parts.push(`### ${file}`);
        for (const c of chunks) {
            const m = c.metadata as Record<string, any>;
            const label = m.name
                ? `${m.chunkType} \`${m.name}\` (L${m.startLine}-${m.endLine})`
                : `L${m.startLine}-${m.endLine}`;

            const callInfo = db ? getCallInfo(c, db) : null;
            const annotation = callInfo ? ` ${callInfo}` : '';

            parts.push(`**${label}** — ${Math.round(c.score * 100)}% match${annotation}`);
            parts.push('```' + (m.language || ''));
            parts.push(c.content);
            parts.push('```\n');
        }
    }
}

/** Get call graph info for a single search result. */
function getCallInfo(result: SearchResult, db: Database): string | null {
    const chunkId = (result.metadata as Record<string, any>)?.id;
    if (!chunkId) return null;

    try {
        const calls = db.prepare(
            'SELECT DISTINCT symbol_name FROM code_refs WHERE chunk_id = ? LIMIT 5'
        ).all(chunkId) as { symbol_name: string }[];

        const name = (result.metadata as Record<string, any>)?.name;
        const callers = name ? db.prepare(
            `SELECT DISTINCT cc.file_path, cc.name FROM code_refs cr
             JOIN code_chunks cc ON cc.id = cr.chunk_id
             WHERE cr.symbol_name = ? LIMIT 5`
        ).all(name) as { file_path: string; name: string }[] : [];

        const infoParts: string[] = [];
        if (calls.length > 0) infoParts.push(`calls: ${calls.map(c => c.symbol_name).join(', ')}`);
        if (callers.length > 0) infoParts.push(`called by: ${callers.map(c => c.name || c.file_path).join(', ')}`);

        return infoParts.length > 0 ? `*(${infoParts.join(' | ')})*` : null;
    } catch {
        return null;
    }
}
