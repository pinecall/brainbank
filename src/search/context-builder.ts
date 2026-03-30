/**
 * BrainBank — Context Builder
 *
 * Builds a formatted markdown context block from search results.
 * Ready for injection into an LLM system prompt.
 * Delegates formatting to focused modules in context/.
 */

import type { ContextOptions } from '@/types.ts';
import type { SearchStrategy, CodeGraphProvider } from './types.ts';
import type { CoEditProvider } from './context/result-formatters.ts';
import { formatCodeResults } from './context/code-formatter.ts';
import { formatCodeGraph } from './context/graph-formatter.ts';
import { formatGitResults, formatCoEdits, formatPatternResults } from './context/result-formatters.ts';

export type { CoEditProvider };

export class ContextBuilder {
    constructor(
        private _search: SearchStrategy,
        private _coEdits?: CoEditProvider,
        private _codeGraph?: CodeGraphProvider,
    ) {}

    /** Build a full context block for a task. Returns markdown for system prompt. */
    async build(task: string, options: ContextOptions = {}): Promise<string> {
        const {
            codeResults = 6, gitResults = 5, patternResults = 4,
            affectedFiles = [], minScore = 0.25,
            useMMR = true, mmrLambda = 0.7,
        } = options;

        const results = await this._search.search(task, {
            codeK: codeResults, gitK: gitResults, patternK: patternResults,
            minScore, useMMR, mmrLambda,
        });

        const parts: string[] = [`# Context for: "${task}"\n`];

        const codeHits = results.filter(r => r.type === 'code').slice(0, codeResults);
        formatCodeResults(codeHits, parts, this._codeGraph);
        formatCodeGraph(codeHits, parts, this._codeGraph);
        formatGitResults(results, gitResults, parts);
        formatCoEdits(affectedFiles, parts, this._coEdits);
        formatPatternResults(results, patternResults, parts);

        return parts.join('\n');
    }
}
