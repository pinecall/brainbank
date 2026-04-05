/**
 * Unit Tests — Pruner (LLM Noise Filter)
 *
 * Tests the optional pruner integration with mock pruners.
 * Validates:
 *   - Pruner interface accepted in config
 *   - ContextBuilder filters noise via pruner
 *   - No pruner = all results pass through
 *   - Pruner receives full content (capped by char limit)
 */

import type { SearchResult, PrunerItem } from '../../../src/types.ts';
import { ContextBuilder } from '../../../src/search/context-builder.ts';
import type { SearchStrategy } from '../../../src/search/types.ts';
import type { ContextFormatterPlugin } from '../../../src/plugin.ts';
import { PluginRegistry } from '../../../src/services/plugin-registry.ts';
import { pruneResults } from '../../../src/lib/prune.ts';
import { BrainBank, mockEmbedding, tmpDb } from '../../helpers.ts';

export const name = 'Pruner';

function makeCodeResult(filePath: string, score: number, content?: string): SearchResult {
    return {
        type: 'code',
        score,
        filePath,
        content: content ?? `content of ${filePath}`,
        metadata: { chunkType: 'file', startLine: 1, endLine: 10, language: 'typescript' },
    };
}

function mockSearch(results: SearchResult[]): SearchStrategy {
    return {
        async search(): Promise<SearchResult[]> { return results; },
    };
}

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
    async 'Pruner interface accepted in config'(assert: any) {
        const mockPruner = {
            async prune(_query: string, items: PrunerItem[]) {
                return items.map(i => i.id);
            },
        };

        const brain = new BrainBank({
            dbPath: tmpDb('pruner-config'),
            embeddingProvider: mockEmbedding(),
            pruner: mockPruner,
        });

        await brain.initialize();
        assert(true, 'should accept pruner in config');
        brain.close();
    },

    async 'Pruner filters noise in ContextBuilder'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const results = [
            makeCodeResult('src/auth.ts', 0.9),
            makeCodeResult('src/noise.ts', 0.8),
            makeCodeResult('src/notifications.ts', 0.7),
        ];

        // Pruner that keeps only items with even IDs (auth.ts=0, notifications.ts=2)
        const mockPruner = {
            async prune(_query: string, items: PrunerItem[]) {
                return items.filter(i => i.id % 2 === 0).map(i => i.id);
            },
        };

        const formatter = createCapturingFormatter();
        const registry = new PluginRegistry();
        registry.register(formatter);

        const builder = new ContextBuilder(mockSearch(results), registry, mockPruner);
        const ctx = await builder.build('test auth');

        assert.equal(formatter.captured.length, 2, 'pruner should remove 1 result');
        assert.ok(ctx.includes('src/auth.ts'), 'auth.ts should be kept');
        assert.ok(!ctx.includes('src/noise.ts'), 'noise.ts should be pruned');
        assert.ok(ctx.includes('src/notifications.ts'), 'notifications.ts should be kept');
    },

    async 'No pruner means all results pass through'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const results = [
            makeCodeResult('src/a.ts', 0.9),
            makeCodeResult('src/b.ts', 0.8),
            makeCodeResult('src/c.ts', 0.7),
        ];

        const formatter = createCapturingFormatter();
        const registry = new PluginRegistry();
        registry.register(formatter);

        // No pruner → all results pass
        const builder = new ContextBuilder(mockSearch(results), registry);
        await builder.build('test');
        assert.equal(formatter.captured.length, 3, 'without pruner, all results should pass');
    },

    async 'pruneResults sends full content under char cap'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        let receivedItems: PrunerItem[] = [];
        const mockPruner = {
            async prune(_query: string, items: PrunerItem[]) {
                receivedItems = items;
                return items.map(i => i.id);
            },
        };

        // 50 lines is well under 8K chars — should pass through fully
        const longContent = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
        const results = [
            makeCodeResult('src/long.ts', 0.9, longContent),
            makeCodeResult('src/short.ts', 0.8, 'line 0\nline 1'),
        ];

        await pruneResults('test', results, mockPruner);

        assert.equal(receivedItems.length, 2, 'should pass 2 items');
        assert.equal(receivedItems[0].preview, longContent, 'content under char cap should pass through fully');
        assert.equal(receivedItems[1].preview, 'line 0\nline 1', 'short content should pass through fully');
    },

    async 'pruneResults truncates oversized content with marker'(assert: { ok: (v: unknown, msg?: string) => void }) {
        let receivedItems: PrunerItem[] = [];
        const mockPruner = {
            async prune(_query: string, items: PrunerItem[]) {
                receivedItems = items;
                return items.map(i => i.id);
            },
        };

        // Generate content that exceeds 8K chars (~10K chars)
        const hugeContent = Array.from({ length: 500 }, (_, i) => `// line ${i}: ${'x'.repeat(15)}`).join('\n');
        const results = [
            makeCodeResult('src/huge.ts', 0.9, hugeContent),
            makeCodeResult('src/small.ts', 0.8, 'tiny'),
        ];

        await pruneResults('test', results, mockPruner);

        assert.ok(receivedItems[0].preview.includes('[...'), 'oversized content should have omission marker');
        assert.ok(receivedItems[0].preview.includes('lines omitted'), 'marker should mention lines omitted');
        assert.ok(receivedItems[0].preview.length < hugeContent.length, 'preview should be shorter than original');
        assert.ok(!receivedItems[1].preview.includes('[...'), 'small content should not be truncated');
    },

    async 'pruneResults with single result skips pruner'(assert: { ok: (v: unknown, msg?: string) => void }) {
        let prunerCalled = false;
        const mockPruner = {
            async prune(_query: string, items: PrunerItem[]) {
                prunerCalled = true;
                return items.map(i => i.id);
            },
        };

        const results = [makeCodeResult('src/only.ts', 0.9)];
        const filtered = await pruneResults('test', results, mockPruner);

        assert.ok(!prunerCalled, 'pruner should not be called for single result');
        assert.ok(filtered.length === 1, 'single result should pass through');
    },

    async 'Pruner with close() is called properly'(assert: any) {
        const mockPruner = {
            async prune(_query: string, items: PrunerItem[]) {
                return items.map(i => i.id);
            },
            closeCalled: false,
            async close() {
                this.closeCalled = true;
            },
        };

        assert(typeof mockPruner.prune === 'function', 'prune should be a function');
        assert(typeof mockPruner.close === 'function', 'close should be optional function');

        await mockPruner.close();
        assert(mockPruner.closeCalled, 'close should be callable');
    },
};
