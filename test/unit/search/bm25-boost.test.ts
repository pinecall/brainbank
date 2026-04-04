/**
 * Unit Tests — BM25 Boost & Path Filtering
 *
 * Tests the pure functions extracted from ContextBuilder:
 * - boostWithBM25: intersection boost for vector results
 * - filterByPath: path prefix scoping
 * - resultKey: dedup key generation
 */

import type { SearchResult } from '../../../src/types.ts';
import { boostWithBM25, filterByPath, resultKey, BM25_BOOST } from '../../../src/search/bm25-boost.ts';

export const name = 'BM25 Boost & Path Filtering';

function makeResult(filePath: string, score: number, startLine = 1, endLine = 10): SearchResult {
    return {
        type: 'code',
        score,
        filePath,
        content: `content of ${filePath}`,
        metadata: { chunkType: 'file', startLine, endLine, language: 'typescript' },
    };
}

/** Mock SearchStrategy that returns predefined results. */
function mockBM25(results: SearchResult[]) {
    return {
        async search() { return results; },
    };
}

export const tests = {
    async 'boostWithBM25 increases score for matching results'(assert: { ok: (v: unknown, msg?: string) => void; gt: (a: number, b: number, msg?: string) => void }) {
        const vec = [
            makeResult('src/foo.ts', 0.8, 1, 20),
            makeResult('src/bar.ts', 0.6, 5, 15),
        ];
        const bm25 = mockBM25([ makeResult('src/foo.ts', 0.9, 1, 20) ]);

        const boosted = await boostWithBM25(vec, bm25, 'test query', {});

        // foo should be boosted
        const foo = boosted.find(r => r.filePath === 'src/foo.ts')!;
        assert.gt(foo.score, 0.8, 'foo score should be boosted above 0.8');
        assert.ok(Math.abs(foo.score - (0.8 + BM25_BOOST)) < 0.001, `foo score should be 0.8 + ${BM25_BOOST}`);

        // bar should be unchanged
        const bar = boosted.find(r => r.filePath === 'src/bar.ts')!;
        assert.ok(Math.abs(bar.score - 0.6) < 0.001, 'bar score should remain 0.6');
    },

    async 'boostWithBM25 re-sorts by boosted score'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const vec = [
            makeResult('src/high.ts', 0.9, 1, 10),
            makeResult('src/low.ts', 0.79, 1, 10),
        ];
        // Only low matches BM25 → it should get boosted above high
        const bm25 = mockBM25([ makeResult('src/low.ts', 0.5, 1, 10) ]);

        const boosted = await boostWithBM25(vec, bm25, 'test', {});

        assert.ok(boosted[0].filePath === 'src/low.ts', `first result should be low.ts (boosted to ${0.79 + BM25_BOOST}), got ${boosted[0].filePath}`);
    },

    async 'boostWithBM25 returns unchanged on empty vector results'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const bm25 = mockBM25([ makeResult('src/x.ts', 0.5) ]);
        const result = await boostWithBM25([], bm25, 'test', {});
        assert.equal(result.length, 0, 'should return empty array');
    },

    async 'boostWithBM25 returns unchanged when no BM25 matches'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const vec = [ makeResult('src/a.ts', 0.8) ];
        const bm25 = mockBM25([]);
        const result = await boostWithBM25(vec, bm25, 'test', {});
        assert.equal(result.length, 1, 'should have one result');
        assert.ok(Math.abs(result[0].score - 0.8) < 0.001, 'score should be unchanged');
    },

    'filterByPath keeps matching results'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const results = [
            makeResult('src/services/auth.ts', 0.9),
            makeResult('src/lib/utils.ts', 0.8),
            makeResult('packages/code/index.ts', 0.7),
        ];
        const filtered = filterByPath(results, 'src/');
        assert.equal(filtered.length, 2, 'should keep 2 src/ results');
        assert.ok(filtered.every(r => r.filePath!.startsWith('src/')), 'all should start with src/');
    },

    'filterByPath returns all when no prefix'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const results = [ makeResult('a.ts', 0.9), makeResult('b.ts', 0.8) ];
        const filtered = filterByPath(results, undefined);
        assert.equal(filtered.length, 2, 'should return all results');
    },

    'filterByPath returns empty when nothing matches'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const results = [ makeResult('src/a.ts', 0.9) ];
        const filtered = filterByPath(results, 'packages/');
        assert.equal(filtered.length, 0, 'should return empty');
    },

    'resultKey generates correct key'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const r = makeResult('src/foo.ts', 0.8, 10, 25);
        assert.equal(resultKey(r), 'src/foo.ts:10:25', 'should format filePath:startLine:endLine');
    },

    'resultKey handles missing metadata'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const r: SearchResult = {
            type: 'collection',
            score: 0.5,
            content: 'test',
            metadata: {},
        };
        assert.equal(resultKey(r), '::',  'should handle missing filePath and line info');
    },
};
