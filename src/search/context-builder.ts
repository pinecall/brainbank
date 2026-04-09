/**
 * BrainBank — Context Builder
 *
 * Orchestrates the context-building pipeline:
 *   1. Vector search (primary)
 *   2. Path scoping (filter)
 *   3. LLM noise pruning (optional)
 *   4. Session dedup (filter)
 *   5. Plugin formatters (output)
 *
 * All search post-processing lives in `bm25-boost.ts`.
 * Plugin-agnostic — discovers formatters from ContextFormatterPlugin.
 */

import type { ContextOptions, EmbeddingProvider, Pruner, SearchResult } from '@/types.ts';
import type { SearchStrategy } from './types.ts';
import type { PluginRegistry } from '@/services/plugin-registry.ts';

import { isContextFormatterPlugin, isSearchable } from '@/plugin.ts';
import { filterByPath } from './bm25-boost.ts';
import { pruneResults } from '@/lib/prune.ts';
import { logQuery } from '@/lib/logger.ts';
import type { QueryLogResult } from '@/lib/logger.ts';
import { providerKey } from '@/lib/provider-key.ts';

export class ContextBuilder {
    constructor(
        private _search: SearchStrategy | undefined,
        private _registry: PluginRegistry,
        private _pruner?: Pruner,
        private _embedding?: EmbeddingProvider,
        private _rerankerName?: string,
    ) {}

    /** Build a full context block for a task. Returns markdown for system prompt. */
    async build(task: string, options: ContextOptions = {}): Promise<string> {
        const t0 = Date.now();
        const src = options.sources ?? {};
        const { minScore = 0.25, useMMR = true, mmrLambda = 0.7 } = options;

        // 1. Primary: vector search (includes per-repo BM25 fusion internally)
        let results: SearchResult[] = this._search
            ? await this._search.search(task, {
                sources: src,
                minScore, useMMR, mmrLambda,
            })
            : [];

        // 2. Path scoping
        results = filterByPath(results, options.pathPrefix);

        // 3. LLM noise pruning (optional — per-request override or construction-time)
        const pruner = options.pruner ?? this._pruner;
        const beforePrune = results;
        if (pruner && results.length > 1) {
            results = await pruneResults(task, results, pruner);
        }

        // 4. Exclude already-returned files (session dedup)
        if (options.excludeFiles && options.excludeFiles.size > 0) {
            results = results.filter(r => !r.filePath || !options.excludeFiles!.has(r.filePath));
        }

        // 5. Format output
        const parts: string[] = [`# Context for: "${task}"\n`];
        this._appendFormatterResults(results, parts, options);
        await this._appendSearchableResults(task, src, minScore, parts);

        // ── Log ──
        const prunedResults = pruner
            ? beforePrune.filter(r => !results.includes(r))
            : [];
        logQuery({
            source: options.source ?? 'api',
            method: 'getContext',
            query: task,
            embedding: this._embedding ? providerKey(this._embedding) : 'unknown',
            pruner: pruner ? _prunerName(pruner) : null,
            reranker: this._rerankerName ?? null,
            options: {
                sources: src,
                pathPrefix: options.pathPrefix,
                minScore,
                affectedFiles: options.affectedFiles,
            },
            results: results.map(_toLogResult),
            pruned: prunedResults.length > 0 ? prunedResults.map(_toLogResult) : undefined,
            durationMs: Date.now() - t0,
        });

        return parts.join('\n');
    }

    /** Invoke ContextFormatterPlugins, deduplicating by base type for multi-repo. */
    private _appendFormatterResults(
        results: SearchResult[],
        parts: string[],
        options: ContextOptions,
    ): void {
        const seenFormatters = new Set<string>();
        for (const mod of this._registry.all) {
            if (isContextFormatterPlugin(mod)) {
                const baseType = mod.name.split(':')[0];
                if (seenFormatters.has(baseType)) continue;
                seenFormatters.add(baseType);
                mod.formatContext(results, parts, options as Record<string, unknown>);
            }
        }
    }

    /** Collect results from SearchablePlugins that don't have their own formatter. */
    private async _appendSearchableResults(
        task: string,
        sources: Record<string, number>,
        minScore: number,
        parts: string[],
    ): Promise<void> {
        for (const mod of this._registry.all) {
            if (isContextFormatterPlugin(mod)) continue;
            if (!isSearchable(mod)) continue;
            const hits = await mod.search(task, { k: sources[mod.name.split(':')[0]] ?? 6, minScore });
            if (hits.length > 0) {
                parts.push(`## ${mod.name}\n`);
                for (const r of hits) {
                    parts.push(`- [${Math.round(r.score * 100)}%] ${r.content.slice(0, 200)}`);
                }
                parts.push('');
            }
        }
    }
}

// ── Helpers ──────────────────────────────────────────

function _toLogResult(r: SearchResult): QueryLogResult {
    const meta = r.metadata as Record<string, unknown> | undefined;
    return {
        filePath: r.filePath ?? 'unknown',
        score: r.score,
        type: r.type,
        name: (meta?.name as string | undefined) ?? undefined,
    };
}

function _prunerName(pruner: Pruner): string {
    return pruner.constructor?.name ?? 'custom';
}
