/**
 * Unit Tests — Context Builder Session Dedup
 *
 * Tests the excludeFiles filtering in ContextBuilder.build().
 * Since ContextBuilder needs formatter plugins to render results,
 * we test the filtering by using a mock ContextFormatterPlugin
 * that captures what results it receives.
 */

import type { SearchResult, ContextOptions } from '../../../src/types.ts';
import { ContextBuilder } from '../../../src/search/context-builder.ts';
import type { SearchStrategy } from '../../../src/search/types.ts';
import type { Plugin, ContextFormatterPlugin } from '../../../src/plugin.ts';
import { PluginRegistry } from '../../../src/services/plugin-registry.ts';

export const name = 'Context Builder — Session Dedup';

function makeCodeResult(filePath: string, score: number): SearchResult {
    return {
        type: 'code',
        score,
        filePath,
        content: `content of ${filePath}`,
        metadata: { chunkType: 'file', startLine: 1, endLine: 10, language: 'typescript' },
    };
}

/** Mock search that returns predefined results. */
function mockSearch(results: SearchResult[]): SearchStrategy {
    return {
        async search(): Promise<SearchResult[]> { return results; },
    };
}

/** Create a formatter plugin that captures what results it receives. */
function createCapturingFormatter(): ContextFormatterPlugin & { captured: SearchResult[] } {
    return {
        name: 'test-formatter',
        captured: [] as SearchResult[],
        async initialize() {},
        formatContext(results: SearchResult[], parts: string[]) {
            this.captured = [...results];
            for (const r of results) {
                parts.push(`### ${r.filePath ?? 'unknown'}`);
                parts.push(r.content);
                parts.push('');
            }
        },
    };
}

export const tests = {
    async 'excludeFiles filters out specified files before formatting'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const results = [
            makeCodeResult('src/auth.ts', 0.9),
            makeCodeResult('src/users.ts', 0.8),
            makeCodeResult('src/notifications.ts', 0.7),
        ];
        const search = mockSearch(results);
        const formatter = createCapturingFormatter();
        const registry = new PluginRegistry();
        registry.register(formatter);

        const builder = new ContextBuilder(search, registry);

        // First call: no exclusions
        const ctx1 = await builder.build('test task');
        assert.equal(formatter.captured.length, 3, 'first call should pass 3 results to formatter');
        assert.ok(ctx1.includes('src/auth.ts'), 'first call should include auth.ts');
        assert.ok(ctx1.includes('src/users.ts'), 'first call should include users.ts');

        // Second call: exclude files from first call
        const ctx2 = await builder.build('another task', {
            excludeFiles: new Set(['src/auth.ts', 'src/users.ts']),
        });
        assert.equal(formatter.captured.length, 1, 'second call should pass 1 result to formatter');
        assert.equal(formatter.captured[0].filePath, 'src/notifications.ts', 'only notifications.ts should remain');
        assert.ok(!ctx2.includes('content of src/auth.ts'), 'second call should not include auth.ts content');
        assert.ok(ctx2.includes('src/notifications.ts'), 'second call should include notifications.ts');
    },

    async 'empty excludeFiles set returns all results'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const results = [
            makeCodeResult('src/a.ts', 0.9),
            makeCodeResult('src/b.ts', 0.8),
        ];
        const formatter = createCapturingFormatter();
        const registry = new PluginRegistry();
        registry.register(formatter);
        const builder = new ContextBuilder(mockSearch(results), registry);

        await builder.build('test', { excludeFiles: new Set() });
        assert.equal(formatter.captured.length, 2, 'all results should pass through');
    },

    async 'results without filePath are never excluded'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const results: SearchResult[] = [
            makeCodeResult('src/keep.ts', 0.9),
            {
                type: 'collection',
                score: 0.8,
                content: 'important note',
                metadata: {},
            },
        ];
        const formatter = createCapturingFormatter();
        const registry = new PluginRegistry();
        registry.register(formatter);
        const builder = new ContextBuilder(mockSearch(results), registry);

        await builder.build('test', {
            excludeFiles: new Set(['src/keep.ts']),
        });
        // Collection result has no filePath → should NOT be excluded
        assert.equal(formatter.captured.length, 1, 'collection result without filePath should not be excluded');
    },
};
