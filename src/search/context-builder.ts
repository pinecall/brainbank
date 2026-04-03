/**
 * BrainBank — Context Builder
 *
 * Builds a formatted markdown context block from search results.
 * Uses hybrid search: vector primary, BM25 as intersection boost.
 * Ready for injection into an LLM system prompt.
 * Plugin-agnostic — discovers formatters from ContextFormatterPlugin.
 */

import type { ContextOptions, SearchResult } from '@/types.ts';
import type { SearchStrategy } from './types.ts';
import type { PluginRegistry } from '@/services/plugin-registry.ts';

import { isContextFormatterPlugin, isSearchable } from '@/plugin.ts';

export class ContextBuilder {
    constructor(
        private _search: SearchStrategy | undefined,
        private _registry: PluginRegistry,
        private _bm25?: SearchStrategy,
    ) {}

    /** Build a full context block for a task. Returns markdown for system prompt. */
    async build(task: string, options: ContextOptions = {}): Promise<string> {
        const src = options.sources ?? {};
        const { minScore = 0.25, useMMR = true, mmrLambda = 0.7 } = options;

        // Primary: vector search (over-fetches 2x for diversity)
        const vectorResults: SearchResult[] = this._search
            ? await this._search.search(task, {
                sources: src,
                minScore, useMMR, mmrLambda,
            })
            : [];

        // BM25 intersection boost: re-score vector results that also match keywords.
        // Items matching both vector AND keyword get a score bump, improving rank
        // for keyword-relevant files that scored lower on vector similarity.
        let results = this._bm25
            ? await _boostWithBM25(vectorResults, this._bm25, task, src)
            : vectorResults;

        // Path scoping: keep only results whose filePath starts with the prefix
        if (options.pathPrefix) {
            const prefix = options.pathPrefix;
            results = results.filter(r => r.filePath?.startsWith(prefix));
        }

        const parts: string[] = [`# Context for: "${task}"\n`];

        // Deduplicate formatters by base type to avoid duplicate output
        // in multi-repo setups (e.g. code:backend + code:frontend share one HNSW)
        const seenFormatters = new Set<string>();
        for (const mod of this._registry.all) {
            if (isContextFormatterPlugin(mod)) {
                const baseType = mod.name.split(':')[0];
                if (seenFormatters.has(baseType)) continue;
                seenFormatters.add(baseType);
                mod.formatContext(results, parts, options as Record<string, unknown>);
            }
        }

        // Searchable plugins that aren't context formatters → append results
        for (const mod of this._registry.all) {
            if (isContextFormatterPlugin(mod)) continue;
            if (!isSearchable(mod)) continue;
            const hits = await mod.search(task, { k: src[mod.name.split(':')[0]] ?? 6, minScore });
            if (hits.length > 0) {
                parts.push(`## ${mod.name}\n`);
                for (const r of hits) {
                    parts.push(`- [${Math.round(r.score * 100)}%] ${r.content.slice(0, 200)}`);
                }
                parts.push('');
            }
        }

        return parts.join('\n');
    }
}

/** BM25 boost factor applied to vector results that also match keywords. */
const BM25_BOOST = 0.15;

/**
 * Boost vector results that also appear in BM25 keyword results.
 * Does NOT add new results — only re-scores and re-sorts existing vector hits.
 * This promotes keyword-relevant files without introducing BM25-only noise.
 */
async function _boostWithBM25(
    vectorResults: SearchResult[],
    bm25: SearchStrategy,
    query: string,
    sources: Record<string, number>,
): Promise<SearchResult[]> {
    if (vectorResults.length === 0) return vectorResults;

    const bm25Results = await bm25.search(query, { sources });
    if (bm25Results.length === 0) return vectorResults;

    // Build a set of BM25 hit keys for fast lookup
    const bm25Keys = new Set<string>();
    for (const r of bm25Results) {
        bm25Keys.add(_resultKey(r));
    }

    // Boost scores of vector results that also appear in BM25
    const boosted = vectorResults.map(r => {
        const k = _resultKey(r);
        if (bm25Keys.has(k)) {
            return { ...r, score: r.score + BM25_BOOST };
        }
        return r;
    });

    // Re-sort by boosted score
    boosted.sort((a, b) => b.score - a.score);
    return boosted;
}

/** Generate a dedup key for a search result. */
function _resultKey(r: SearchResult): string {
    const sl = 'startLine' in r.metadata ? r.metadata.startLine : '';
    const el = 'endLine' in r.metadata ? r.metadata.endLine : '';
    return `${r.filePath ?? ''}:${sl}:${el}`;
}
