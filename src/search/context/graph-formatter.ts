/**
 * BrainBank — Graph Formatter
 *
 * Formats import graph expansion results: discovers related files
 * via 2-hop traversal and renders their best code chunks.
 */

import type { SearchResult } from '@/types.ts';
import type { Database } from '@/db/database.ts';
import { expandViaImportGraph, fetchBestChunks } from './import-graph.ts';

/** Format import graph expansion results with code chunks. */
export function formatCodeGraph(codeHits: SearchResult[], parts: string[], db?: Database): void {
    if (!db || codeHits.length === 0) return;

    const hitFiles = new Set(codeHits.map(r => r.filePath).filter(Boolean) as string[]);
    const graphFiles = expandViaImportGraph(db, hitFiles);

    if (graphFiles.size === 0) return;

    const hitDirs = new Set([...hitFiles].map(f => f.split('/').slice(0, -1).join('/')));
    const sorted = [...graphFiles].sort((a, b) => {
        const aDir = a.split('/').slice(0, -1).join('/');
        const bDir = b.split('/').slice(0, -1).join('/');
        const aLocal = hitDirs.has(aDir) ? 0 : 1;
        const bLocal = hitDirs.has(bDir) ? 0 : 1;
        return aLocal - bLocal;
    });

    const expanded = fetchBestChunks(db, sorted);
    if (expanded.length === 0) return;

    parts.push('## Related Code (Import Graph)\n');
    const byFile = new Map<string, typeof expanded>();
    for (const r of expanded) {
        if (!byFile.has(r.filePath)) byFile.set(r.filePath, []);
        byFile.get(r.filePath)!.push(r);
    }

    for (const [file, chunks] of byFile) {
        parts.push(`### ${file}`);
        for (const c of chunks) {
            const label = c.name
                ? `${c.chunkType} \`${c.name}\` (L${c.startLine}-${c.endLine})`
                : `L${c.startLine}-${c.endLine}`;
            parts.push(`**${label}**`);
            parts.push('```' + (c.language || ''));
            parts.push(c.content);
            parts.push('```\n');
        }
    }
}
