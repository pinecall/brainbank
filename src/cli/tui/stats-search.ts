/**
 * BrainBank — Stats TUI Search Session
 *
 * Wraps a BrainBank instance to provide staged search pipeline results
 * for the interactive TUI. Captures each stage (raw → pruned → expanded)
 * separately so the UI can display them side-by-side.
 *
 * Lazy initialization: the brain is created on first search.
 */

import type { SearchResult, Pruner, Expander, ExpanderManifestItem } from '@/types.ts';
import type { BrainBank } from '@/brainbank.ts';

import { createBrain } from '@/cli/factory/index.ts';
import { pruneResults } from '@/lib/prune.ts';
import { isExpandablePlugin } from '@/plugin.ts';

// ── Types ─────────────────────────────────────────

/** Timings for each pipeline stage (ms). */
export interface PipelineTimings {
    init: number;
    search: number;
    prune: number;
    expand: number;
    total: number;
}

/** Full result of a staged search pipeline run. */
export interface SearchPipelineResult {
    /** All results from vector search (before pruning). */
    raw: SearchResult[];
    /** Results after LLM pruner filtered noise. Same order as pruner returned. */
    pruned: SearchResult[];
    /** Results dropped by pruner (raw minus pruned). */
    dropped: SearchResult[];
    /** Additional results discovered by LLM expander. */
    expanded: SearchResult[];
    /** Pipeline stage timings. */
    timings: PipelineTimings;
    /** Name of the active pruner (or null if none). */
    prunerName: string | null;
    /** Name of the active expander (or null if none). */
    expanderName: string | null;
}

/** Source filter option — discovered from registered plugins. */
export interface SourceOption {
    /** Source key: 'code', 'git', 'docs', etc. */
    key: string;
    /** Display label. */
    label: string;
    /** Whether this source is enabled for the current search. */
    enabled: boolean;
}

// ── Session ───────────────────────────────────────

export class BrainSearchSession {
    private _brain: BrainBank | null = null;
    private _repoPath: string;
    private _initPromise: Promise<void> | null = null;
    private _sources: SourceOption[] = [];

    constructor(repoPath: string) {
        this._repoPath = repoPath;
    }

    /** Whether the brain has been initialized. */
    get initialized(): boolean {
        return this._brain !== null;
    }

    /** Available source filters (populated after init). */
    get sources(): readonly SourceOption[] {
        return this._sources;
    }

    /** Pruner name (or null). */
    get prunerName(): string | null {
        return this._brain?.config.pruner?.constructor?.name ?? null;
    }

    /** Expander name (or null). */
    get expanderName(): string | null {
        return this._brain?.config.expander?.constructor?.name ?? null;
    }

    /**
     * Initialize the BrainBank instance (lazy, idempotent).
     * Creates the brain, loads HNSW + FTS indices.
     */
    async init(): Promise<void> {
        if (this._brain) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._doInit();
        return this._initPromise;
    }

    private async _doInit(): Promise<void> {
        this._brain = await createBrain(this._repoPath);
        await this._brain.initialize();

        // Discover installed sources from plugin names
        this._sources = [{ key: 'all', label: 'All', enabled: true }];
        const seen = new Set<string>();
        for (const name of this._brain.plugins) {
            // Plugin names are like 'code:repo-name', 'git:repo-name'
            const base = name.split(':')[0];
            if (seen.has(base)) continue;
            seen.add(base);
            this._sources.push({
                key: base,
                label: base.charAt(0).toUpperCase() + base.slice(1),
                enabled: true,
            });
        }
    }

    /**
     * Run the full search pipeline and return staged results.
     *
     * @param query  - Search query
     * @param activeSourceKeys - Set of active source keys (e.g. {'code', 'git'})
     */
    async search(query: string, activeSourceKeys?: Set<string>): Promise<SearchPipelineResult> {
        if (!this._brain) throw new Error('BrainSearchSession not initialized');

        const tTotal = Date.now();
        const pruner = this._brain.config.pruner as Pruner | undefined;
        const expander = this._brain.config.expander as Expander | undefined;

        // Build sources filter
        const sources: Record<string, number> = {};
        if (activeSourceKeys && !activeSourceKeys.has('all')) {
            for (const src of this._sources) {
                if (src.key === 'all') continue;
                sources[src.key] = activeSourceKeys.has(src.key) ? 20 : 0;
            }
        }

        // Stage 1: Vector search
        const tSearch0 = Date.now();
        const raw = await this._brain.search(query, {
            sources: Object.keys(sources).length > 0 ? sources : undefined,
            source: 'cli',
        });
        const tSearch = Date.now() - tSearch0;

        // Stage 2: Prune
        let pruned = raw;
        let dropped: SearchResult[] = [];
        let tPrune = 0;
        if (pruner && raw.length > 1) {
            const pt0 = Date.now();
            pruned = await pruneResults(query, raw, pruner);
            tPrune = Date.now() - pt0;
            // Dropped = items in raw but not in pruned
            const prunedSet = new Set(pruned);
            dropped = raw.filter(r => !prunedSet.has(r));
        }

        // Stage 3: Expand
        let expanded: SearchResult[] = [];
        let tExpand = 0;
        if (expander && pruned.length > 0) {
            const et0 = Date.now();
            expanded = await this._runExpansion(query, pruned, expander);
            tExpand = Date.now() - et0;
        }

        return {
            raw,
            pruned,
            dropped,
            expanded,
            timings: {
                init: 0,
                search: tSearch,
                prune: tPrune,
                expand: tExpand,
                total: Date.now() - tTotal,
            },
            prunerName: pruner?.constructor?.name ?? null,
            expanderName: expander?.constructor?.name ?? null,
        };
    }

    /** Run LLM expansion — mirrors ContextBuilder._expand logic. */
    private async _runExpansion(
        query: string,
        results: SearchResult[],
        expander: Expander,
    ): Promise<SearchResult[]> {
        if (!this._brain) return [];

        // Collect file paths and IDs already in results
        const excludeFilePaths = [...new Set(
            results.filter(r => r.filePath).map(r => r.filePath as string),
        )];
        const excludeIds: number[] = [];
        for (const r of results) {
            const meta = r.metadata as Record<string, unknown> | undefined;
            const id = meta?.id as number | undefined;
            if (id !== undefined) excludeIds.push(id);
        }

        // Build manifest from ExpandablePlugins
        const manifest: ExpanderManifestItem[] = [];
        let resolver: ((ids: number[]) => SearchResult[]) | undefined;

        // Access plugins via the brain's plugin list
        // We need the registry... which is private. Use a workaround:
        // BrainBank exposes `plugins` (names) but not instances.
        // However, we can access it through the search functionality.
        // The cleanest approach: use the brain's internal registry via
        // a property we know exists on the class.
        const registry = (this._brain as unknown as { _registry: { all: unknown[] } })._registry;
        if (registry) {
            for (const mod of registry.all) {
                if (!isExpandablePlugin(mod as never)) continue;
                const plugin = mod as { buildManifest: (fp: string[], ids: number[], rfp?: string[]) => ExpanderManifestItem[]; resolveChunks: (ids: number[]) => SearchResult[] };
                manifest.push(...plugin.buildManifest(excludeFilePaths, excludeIds, excludeFilePaths));
                if (!resolver) {
                    resolver = (ids: number[]) => plugin.resolveChunks(ids);
                }
            }
        }

        if (manifest.length === 0 || !resolver) return [];

        try {
            const expandResult = await expander.expand(query, excludeIds, manifest);
            if (expandResult.ids.length === 0) return [];
            return resolver(expandResult.ids);
        } catch {
            // Fail-open: expansion errors are non-fatal
            return [];
        }
    }

    /** Cleanup. */
    close(): void {
        if (this._brain) {
            this._brain.close();
            this._brain = null;
        }
        this._initPromise = null;
    }
}
