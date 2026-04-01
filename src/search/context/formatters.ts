/**
 * BrainBank — Code & Graph Formatters
 *
 * Formats code search results grouped by file with call graph annotations,
 * and import graph expansion results.
 */

import type { SearchResult } from '@/types.ts';
import type { CodeGraphProvider } from '../types.ts';

import { isCodeResult } from '@/types.ts';


/** Format code search results grouped by file with call graph info. */
export function formatCodeResults(codeHits: SearchResult[], parts: string[], codeGraph?: CodeGraphProvider): void {
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
            if (!isCodeResult(c)) continue;
            const m = c.metadata;
            const label = m.name
                ? `${m.chunkType} \`${m.name}\` (L${m.startLine}-${m.endLine})`
                : `L${m.startLine}-${m.endLine}`;

            const callInfo = codeGraph ? getCallAnnotation(c, codeGraph) : null;
            const annotation = callInfo ? ` ${callInfo}` : '';

            parts.push(`**${label}** — ${Math.round(c.score * 100)}% match${annotation}`);
            parts.push('```' + (m.language || ''));
            parts.push(c.content);
            parts.push('```\n');
        }
    }
}

/** Get call graph annotation string for a single search result. */
function getCallAnnotation(result: SearchResult, codeGraph: CodeGraphProvider): string | null {
    if (!isCodeResult(result)) return null;
    const chunkId = result.metadata.id;
    if (!chunkId) return null;

    const name = result.metadata.name;
    const info = codeGraph.getCallInfo(chunkId, name);
    if (!info) return null;

    const infoParts: string[] = [];
    if (info.calls.length > 0) infoParts.push(`calls: ${info.calls.join(', ')}`);
    if (info.calledBy.length > 0) infoParts.push(`called by: ${info.calledBy.join(', ')}`);

    return infoParts.length > 0 ? `*(${infoParts.join(' | ')})*` : null;
}


/** Format import graph expansion results with code chunks. */
export function formatCodeGraph(codeHits: SearchResult[], parts: string[], codeGraph?: CodeGraphProvider): void {
    if (!codeGraph || codeHits.length === 0) return;

    const hitFiles = new Set(codeHits.map(r => r.filePath).filter(Boolean) as string[]);
    const graphFiles = codeGraph.expandImportGraph(hitFiles);

    if (graphFiles.size === 0) return;

    const hitDirs = new Set([...hitFiles].map(f => f.split('/').slice(0, -1).join('/')));
    const sorted = [...graphFiles].sort((a, b) => {
        const aDir = a.split('/').slice(0, -1).join('/');
        const bDir = b.split('/').slice(0, -1).join('/');
        const aLocal = hitDirs.has(aDir) ? 0 : 1;
        const bLocal = hitDirs.has(bDir) ? 0 : 1;
        return aLocal - bLocal;
    });

    const expanded = codeGraph.fetchBestChunks(sorted);
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
