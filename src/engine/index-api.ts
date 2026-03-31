/**
 * BrainBank — Index API
 *
 * Orchestrates indexing across code, git, and document indexers.
 * BrainBank delegates here after auto-initialization.
 */

import type { PluginRegistry } from '@/services/plugin-registry.ts';
import type { IndexResult, StageProgressCallback, ProgressCallback } from '@/types.ts';
import type { IndexAPIDeps } from './types.ts';
import { isIndexable, isDocsPlugin } from '@/plugin.ts';



export class IndexAPI {
    constructor(private _d: IndexAPIDeps) {}

    async index(options: {
        modules?: ('code' | 'git' | 'docs')[];
        gitDepth?: number;
        forceReindex?: boolean;
        onProgress?: StageProgressCallback;
    } = {}): Promise<{ code?: IndexResult; git?: IndexResult; docs?: Record<string, { indexed: number; skipped: number; chunks: number }>; [plugin: string]: unknown }> {
        const want   = new Set(options.modules ?? ['code', 'git', 'docs']);
        const extras: Record<string, unknown> = {};
        let codeAcc: IndexResult | undefined;
        let gitAcc: IndexResult | undefined;
        let docsResult: Record<string, { indexed: number; skipped: number; chunks: number }> | undefined;

        if (want.has('code')) {
            for (const mod of this._d.registry.allByType('code')) {
                if (!isIndexable(mod)) continue;
                const label = mod.name === 'code' ? 'code' : mod.name;
                options.onProgress?.(label, 'Starting...');
                const r = await mod.index({
                    forceReindex: options.forceReindex,
                    onProgress: (f: string, i: number, t: number) => options.onProgress?.(label, `[${i}/${t}] ${f}`),
                });
                if (codeAcc) {
                    codeAcc.indexed += r.indexed;
                    codeAcc.skipped += r.skipped;
                    codeAcc.chunks = (codeAcc.chunks ?? 0) + (r.chunks ?? 0);
                } else {
                    codeAcc = r;
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
                if (gitAcc) {
                    gitAcc.indexed += r.indexed;
                    gitAcc.skipped += r.skipped;
                } else {
                    gitAcc = r;
                }
            }
        }

        if (want.has('docs') && this._d.registry.has('docs')) {
            const docsPlugin = this._d.registry.get('docs');
            if (isDocsPlugin(docsPlugin)) {
                options.onProgress?.('docs', 'Starting...');
                docsResult = await docsPlugin.indexDocs({
                    onProgress: (coll: string, file: string, cur: number, total: number) =>
                        options.onProgress?.('docs', `[${coll}] ${cur}/${total}: ${file}`),
                });
            }
        }

        // Index custom plugins (any IndexablePlugin that isn't code/git/docs)
        const builtinTypes = new Set(['code', 'git', 'docs']);
        for (const mod of this._d.registry.all) {
            const baseType = mod.name.split(':')[0];
            if (builtinTypes.has(baseType)) continue;
            if (!isIndexable(mod)) continue;

            options.onProgress?.(mod.name, 'Starting...');
            const r = await mod.index({
                onProgress: (msg: string) => options.onProgress?.(mod.name, msg),
            });
            extras[mod.name] = r;
        }

        const result = { ...extras, code: codeAcc, git: gitAcc, docs: docsResult };
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
