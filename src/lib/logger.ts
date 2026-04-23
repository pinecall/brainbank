/**
 * BrainBank — Query Debug Logger
 *
 * Appends structured, human-readable entries to /tmp/brainbank.log.
 * Covers all search operations: getContext, search, hybridSearch, searchBM25.
 * Truncates at 10 MB (keeps the newest half).
 *
 * Layer 0 — pure functions, no state.
 */

import * as fs from 'node:fs';

const LOG_PATH = '/tmp/brainbank.log';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// ── Public Types ─────────────────────────────────────

export type QuerySource = 'cli' | 'mcp' | 'daemon' | 'api';

export interface QueryLogEntry {
    source: QuerySource;
    method: 'getContext' | 'search' | 'hybridSearch' | 'searchBM25';
    query: string;
    embedding: string;
    pruner: string | null;
    expander?: string | null;
    expandedCount?: number;
    options: Record<string, unknown>;
    results: QueryLogResult[];
    pruned?: QueryLogResult[];
    durationMs: number;
}

export interface QueryLogResult {
    filePath: string;
    score: number;
    type: string;
    name?: string;
}

// ── Public API ───────────────────────────────────────

/** Append a query log entry to /tmp/brainbank.log. Never throws. */
export function logQuery(entry: QueryLogEntry): void {
    try {
        _truncateIfNeeded();
        fs.appendFileSync(LOG_PATH, _formatEntry(entry));
    } catch {
        // Logging must never break the app
    }
}

// ── Formatting ───────────────────────────────────────

function _formatEntry(e: QueryLogEntry): string {
    const divider = '═'.repeat(70);
    const lines: string[] = [
        '',
        divider,
        `[${new Date().toISOString()}] ${e.source.toUpperCase()} · ${e.method}`,
        `Query: "${e.query}"`,
        `Embedding: ${e.embedding} | Pruner: ${e.pruner ?? 'none'} | Expander: ${e.expander ?? 'off'}${e.expandedCount ? ` (+${e.expandedCount})` : ''}`,
    ];

    // Options (sources, path, etc.)
    const opts = Object.entries(e.options).filter(([, v]) => v !== undefined);
    if (opts.length > 0) {
        const parts = opts.map(([k, v]) =>
            `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`
        );
        lines.push(parts.join(' | '));
    }

    lines.push(`Duration: ${e.durationMs}ms`);
    lines.push('');

    // Results
    const resultCount = e.results.length;
    const prunedCount = e.pruned?.length ?? 0;
    const header = prunedCount > 0
        ? `Results (${resultCount + prunedCount} → ${resultCount} after pruning):`
        : `Results (${resultCount}):`;
    lines.push(header);

    for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        const pct = Math.round(r.score * 100);
        const name = r.name ? `[${r.name}]` : '';
        lines.push(`  #${String(i + 1).padStart(2)}  ${String(pct).padStart(3)}% ${r.filePath.padEnd(45)} ${name}`);
    }

    // Pruned items
    if (e.pruned && e.pruned.length > 0) {
        lines.push('');
        lines.push(`Pruned (${e.pruned.length} removed):`);
        for (const r of e.pruned) {
            const name = r.name ? `[${r.name}]` : '';
            lines.push(`  ✗ ${r.filePath.padEnd(45)} ${name}`);
        }
    }

    lines.push(divider);
    lines.push('');

    return lines.join('\n');
}

// ── Truncation ───────────────────────────────────────

function _truncateIfNeeded(): void {
    try {
        const stat = fs.statSync(LOG_PATH);
        if (stat.size < MAX_BYTES) return;

        // Keep the newest half
        const content = fs.readFileSync(LOG_PATH, 'utf-8');
        const half = Math.floor(content.length / 2);
        // Find the next entry boundary after the midpoint
        const nextEntry = content.indexOf('\n═', half);
        if (nextEntry > 0) {
            fs.writeFileSync(LOG_PATH, '[truncated]\n' + content.slice(nextEntry + 1));
        }
    } catch {
        // File doesn't exist yet — fine
    }
}
