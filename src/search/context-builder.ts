/**
 * BrainBank — Context Builder
 *
 * Builds a formatted markdown context block from search results.
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
    ) {}

    /** Build a full context block for a task. Returns markdown for system prompt. */
    async build(task: string, options: ContextOptions = {}): Promise<string> {
        const src = options.sources ?? {};
        const { minScore = 0.25, useMMR = true, mmrLambda = 0.7 } = options;

        const results: SearchResult[] = this._search
            ? await this._search.search(task, {
                sources: src,
                minScore, useMMR, mmrLambda,
            })
            : [];

        const parts: string[] = [`# Context for: "${task}"\n`];

        for (const mod of this._registry.all) {
            if (isContextFormatterPlugin(mod)) {
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
