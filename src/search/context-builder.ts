/**
 * BrainBank — Context Builder
 *
 * Orchestrates the context-building pipeline:
 *   1. Vector search (primary)
 *   2. Path scoping (filter)
 *   3. LLM noise pruning (optional)
 *   4. Session dedup (filter)
 *   5. LLM context expansion (optional — expander field)
 *   6. Plugin formatters (output)
 *
 * All search post-processing lives in `bm25-boost.ts`.
 * Plugin-agnostic — discovers formatters from ContextFormatterPlugin.
 */

import type { ContextOptions, EmbeddingProvider, Expander, ExpanderManifestItem, Pruner, SearchResult } from '@/types.ts';
import type { SearchStrategy } from './types.ts';
import type { PluginRegistry } from '@/services/plugin-registry.ts';

import { isContextFormatterPlugin, isContextFieldPlugin, isExpandablePlugin, isSearchable } from '@/plugin.ts';
import { filterByPath, filterByIgnore } from './bm25-boost.ts';
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
        private _configFields: Record<string, unknown> = {},
        private _expander?: Expander,
    ) {}

    /** Set config-level context field defaults (from config.json "context" section). */
    set configFields(fields: Record<string, unknown>) {
        this._configFields = fields;
    }

    /** Set the expander instance. */
    set expander(expander: Expander | undefined) {
        this._expander = expander;
    }

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

        // 2. Path scoping + ignore filtering
        results = filterByPath(results, options.pathPrefix);
        results = filterByIgnore(results, options.ignorePaths);

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

        // 5. LLM context expansion (optional — only when expander field is enabled)
        const resolvedFields = this._resolveFields(options);
        let expanderNote: string | undefined;
        if (resolvedFields.expander === true && this._expander && results.length > 0) {
            const expansion = await this._expand(task, results);
            if (expansion.results.length > 0) {
                results = [...results, ...expansion.results];
            }
            expanderNote = expansion.note;
        }

        // 6. Format output
        const parts: string[] = [`# Context for: "${task}"\n`];
        this._appendFormatterResults(results, parts, options, resolvedFields);
        await this._appendSearchableResults(task, src, minScore, parts);

        // 7. Append expander note (last section)
        if (expanderNote) {
            parts.push(`\n## Expansion Notes\n\n${expanderNote}\n`);
        }

        // ── Log ──
        const prunedResults = pruner
            ? beforePrune.filter(r => !results.includes(r))
            : [];
        const expanderEnabled = resolvedFields.expander === true;
        const expandedResults = expanderNote !== undefined
            ? results.filter(r => !beforePrune.includes(r) && !prunedResults.includes(r))
            : [];
        logQuery({
            source: options.source ?? 'api',
            method: 'getContext',
            query: task,
            embedding: this._embedding ? providerKey(this._embedding) : 'unknown',
            pruner: pruner ? _prunerName(pruner) : null,
            expander: expanderEnabled ? (this._expander ? _expanderName(this._expander) : 'configured-no-instance') : null,
            expandedCount: expandedResults.length > 0 ? expandedResults.length : undefined,
            options: {
                sources: src,
                pathPrefix: options.pathPrefix,
                ignorePaths: options.ignorePaths,
                minScore,
                affectedFiles: options.affectedFiles,
            },
            results: results.map(_toLogResult),
            pruned: prunedResults.length > 0 ? prunedResults.map(_toLogResult) : undefined,
            durationMs: Date.now() - t0,
        });

        return parts.join('\n');
    }

    /** Invoke ContextFormatterPlugins. */
    private _appendFormatterResults(
        results: SearchResult[],
        parts: string[],
        options: ContextOptions,
        resolvedFields?: Record<string, unknown>,
    ): void {
        const fields = resolvedFields ?? this._resolveFields(options);
        const seenFormatters = new Set<string>();

        for (const mod of this._registry.all) {
            if (!isContextFormatterPlugin(mod)) continue;

            if (seenFormatters.has(mod.name)) continue;
            seenFormatters.add(mod.name);
            mod.formatContext(results, parts, fields);
        }
    }

    /**
     * Resolve context fields: plugin defaults ← config.json ← per-query.
     * Returns a flat Record with the final value for each field.
     */
    private _resolveFields(options: ContextOptions): Record<string, unknown> {
        // 1. Collect plugin defaults
        const defaults: Record<string, unknown> = {};
        for (const mod of this._registry.all) {
            if (isContextFieldPlugin(mod)) {
                for (const field of mod.contextFields()) {
                    defaults[field.name] = field.default;
                }
            }
        }

        // 2. Merge: defaults ← config ← per-query
        return { ...defaults, ...this._configFields, ...(options.fields ?? {}) };
    }

    /**
     * Run LLM expansion: build manifest of candidate chunks from files
     * NOT already in search results, call expander, resolve selected IDs.
     */
    private async _expand(task: string, results: SearchResult[]): Promise<{ results: SearchResult[]; note?: string }> {
        if (!this._expander) return { results: [] };

        // Collect unique file paths already in results
        const excludeFilePaths = [...new Set(
            results.filter(r => r.filePath).map(r => r.filePath as string),
        )];

        // Collect current chunk IDs (to exclude from manifest)
        const excludeIds: number[] = [];
        for (const r of results) {
            const meta = r.metadata as Record<string, unknown> | undefined;
            const id = meta?.id as number | undefined;
            if (id !== undefined) excludeIds.push(id);
        }

        // Build manifest + resolve from ExpandablePlugins
        const manifest: ExpanderManifestItem[] = [];
        let resolver: ((ids: number[]) => SearchResult[]) | undefined;
        for (const mod of this._registry.all) {
            if (!isExpandablePlugin(mod)) continue;

            manifest.push(...mod.buildManifest(excludeFilePaths, excludeIds));
            if (!resolver) {
                resolver = (ids: number[]) => mod.resolveChunks(ids);
            }
        }
        if (manifest.length === 0 || !resolver) return { results: [] };

        // Call expander
        try {
            const expandResult = await this._expander.expand(task, excludeIds, manifest);
            if (expandResult.ids.length === 0) return { results: [], note: expandResult.note };
            return { results: resolver(expandResult.ids), note: expandResult.note };
        } catch {
            // Fail-open: expansion errors are non-fatal
            return { results: [] };
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
            const hits = await mod.search(task, { k: sources[mod.name] ?? 6, minScore });
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

function _expanderName(expander: Expander): string {
    return expander.constructor?.name ?? 'custom';
}
