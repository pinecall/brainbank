/**
 * BrainBank — Index API
 *
 * Orchestrates indexing across code, git, and document indexers.
 * BrainBank delegates here after auto-initialization.
 */

import type { IndexerRegistry } from '@/bootstrap/registry.ts';
import type { IndexResult, StageProgressCallback, ProgressCallback } from '@/types.ts';
import { isIndexable, isCollectionPlugin } from '@/indexers/base.ts';

export interface IndexAPIDeps {
    registry: IndexerRegistry;
    gitDepth: number;
    emit: (event: string, data: any) => void;
}

export class IndexAPI {
    constructor(private _d: IndexAPIDeps) {}

    async index(options: {
        modules?: ('code' | 'git' | 'docs')[];
        gitDepth?: number;
        forceReindex?: boolean;
        onProgress?: StageProgressCallback;
    } = {}): Promise<{ code?: IndexResult; git?: IndexResult; docs?: Record<string, { indexed: number; skipped: number; chunks: number }> }> {
        const want   = new Set(options.modules ?? ['code', 'git', 'docs']);
        const result: { code?: IndexResult; git?: IndexResult; docs?: Record<string, any> } = {};

        if (want.has('code')) {
            for (const mod of this._d.registry.allByType('code')) {
                if (!isIndexable(mod)) continue;
                const label = mod.name === 'code' ? 'code' : mod.name;
                options.onProgress?.(label, 'Starting...');
                const r = await mod.index({
                    forceReindex: options.forceReindex,
                    onProgress: (f: string, i: number, t: number) => options.onProgress?.(label, `[${i}/${t}] ${f}`),
                });
                if (result.code) {
                    result.code.indexed += r.indexed;
                    result.code.skipped += r.skipped;
                    result.code.chunks = (result.code.chunks ?? 0) + (r.chunks ?? 0);
                } else {
                    result.code = r;
                }
            }
        }

        if (want.has('git')) {
            for (const mod of this._d.registry.allByType('git')) {
                if (!isIndexable(mod)) continue;
                const label = mod.name === 'git' ? 'git' : mod.name;
                options.onProgress?.(label, 'Starting...');
                const r = await mod.index({
                    depth: options.gitDepth ?? this._d.gitDepth,
                    onProgress: (f: string, i: number, t: number) => options.onProgress?.(label, `[${i}/${t}] ${f}`),
                });
                if (result.git) {
                    result.git.indexed += r.indexed;
                    result.git.skipped += r.skipped;
                } else {
                    result.git = r;
                }
            }
        }

        if (want.has('docs') && this._d.registry.has('docs')) {
            const docsPlugin = this._d.registry.get('docs');
            if (isCollectionPlugin(docsPlugin)) {
                options.onProgress?.('docs', 'Starting...');
                result.docs = await docsPlugin.indexCollections({
                    onProgress: (coll: string, file: string, cur: number, total: number) =>
                        options.onProgress?.('docs', `[${coll}] ${cur}/${total}: ${file}`),
                });
            }
        }

        this._d.emit('indexed', result);
        return result;
    }

    async indexCode(options: { forceReindex?: boolean; onProgress?: ProgressCallback } = {}): Promise<IndexResult> {
        const mods = this._d.registry.allByType('code').filter(isIndexable);
        if (!mods.length) throw new Error("BrainBank: Indexer 'code' is not loaded. Add .use(code()) to your BrainBank instance.");

        const acc: IndexResult = { indexed: 0, skipped: 0, chunks: 0 };
        for (const mod of mods) {
            const r = await mod.index(options);
            acc.indexed += r.indexed;
            acc.skipped += r.skipped;
            acc.chunks  = (acc.chunks ?? 0) + (r.chunks ?? 0);
        }
        return acc;
    }

    async indexGit(options: { depth?: number; onProgress?: ProgressCallback } = {}): Promise<IndexResult> {
        const mods = this._d.registry.allByType('git').filter(isIndexable);
        if (!mods.length) throw new Error("BrainBank: Indexer 'git' is not loaded. Add .use(git()) to your BrainBank instance.");

        const acc: IndexResult = { indexed: 0, skipped: 0 };
        for (const mod of mods) {
            const r = await mod.index(options);
            acc.indexed += r.indexed;
            acc.skipped += r.skipped;
        }
        return acc;
    }
}
