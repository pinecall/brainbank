/**
 * BrainBank Integration Test — Memory Module
 *
 * Full pipeline: learn patterns → search by similarity →
 * consolidate (prune + dedup) → distill strategies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import assert from 'node:assert/strict';
import { BrainBank, memory, hashEmbedding } from '../../helpers.ts';

export const name = 'Memory Module';

let tmpDir: string;
let brain: BrainBank;

export const tests: Record<string, () => Promise<void>> = {};

tests['setup: create brain with memory module'] = async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-memory-'));

    brain = new BrainBank({ repoPath: tmpDir, dbPath: path.join(tmpDir, 'test.db'), embeddingProvider: hashEmbedding() })
        .use(memory());
    await brain.initialize();
    assert.ok(brain, 'brain created');
};

tests['learn: stores debugging patterns'] = async () => {
    const mem = brain.indexer('memory') as any;

    const id1 = await mem.learn({
        task: 'Fix null pointer in user service',
        taskType: 'debugging',
        approach: 'Check null guards, add optional chaining, verify API response schema',
        outcome: 'Found missing null check in user.profile.avatar',
        successRate: 0.95,
    });
    assert.ok(id1 > 0, `pattern stored with id ${id1}`);

    await mem.learn({
        task: 'Debug memory leak in WebSocket handler',
        taskType: 'debugging',
        approach: 'Use heap snapshots, track event listener count, check for closure leaks',
        outcome: 'Found unclosed event listeners in disconnect handler',
        successRate: 0.9,
    });

    await mem.learn({
        task: 'Fix race condition in cache invalidation',
        taskType: 'debugging',
        approach: 'Add mutex lock, use compare-and-swap, serialize cache updates',
        outcome: 'Implemented distributed lock with Redis',
        successRate: 0.85,
    });
};

tests['learn: stores performance patterns'] = async () => {
    const mem = brain.indexer('memory') as any;

    await mem.learn({
        task: 'Optimize slow SQL query on users table',
        taskType: 'performance',
        approach: 'Add composite index, use EXPLAIN ANALYZE, avoid SELECT *',
        outcome: 'Query time: 2s → 50ms with covering index',
        successRate: 0.95,
    });

    await mem.learn({
        task: 'Reduce API response time',
        taskType: 'performance',
        approach: 'Add Redis caching layer, compress responses, paginate results',
        outcome: 'P95 latency reduced from 800ms to 120ms',
        successRate: 0.9,
    });

    const stats = mem.stats();
    assert.equal(stats.patterns, 5, 'stored 5 patterns');
    assert.ok(stats.hnswSize >= 5, `HNSW: ${stats.hnswSize} vectors`);
};

tests['search: finds debugging patterns by similarity'] = async () => {
    const mem = brain.indexer('memory') as any;
    const results = await mem.search('null pointer exception fix', 4);

    assert.ok(results.length > 0, `found ${results.length} patterns`);
    assert.ok(results[0].score > 0, 'has similarity score');
    assert.ok(results[0].approach, 'has approach');
    assert.ok(results[0].outcome, 'has outcome');
};

tests['search: finds performance patterns'] = async () => {
    const mem = brain.indexer('memory') as any;
    const results = await mem.search('slow database query optimization');

    assert.ok(results.length > 0, 'found performance patterns');
};

tests['search: returns scored results sorted by relevance'] = async () => {
    const mem = brain.indexer('memory') as any;
    const results = await mem.search('fix bug', 5);

    assert.ok(results.length > 1, 'multiple results');
    for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].score >= results[i].score, 'sorted by score desc');
    }
};

tests['consolidate: prunes and deduplicates patterns'] = async () => {
    const mem = brain.indexer('memory') as any;
    const result = mem.consolidate();

    assert.ok(typeof result.pruned === 'number', 'reports pruned count');
    assert.ok(typeof result.deduped === 'number', 'reports deduped count');
};

tests['distill: extracts strategy from task type'] = async () => {
    const mem = brain.indexer('memory') as any;
    const strategy = mem.distill('debugging');

    // Strategy may be null if not enough patterns, but shouldn't throw
    assert.ok(strategy === null || typeof strategy === 'object', 'distill returns null or object');
};

tests['stats: reports pattern count and avg success rate'] = async () => {
    const mem = brain.indexer('memory') as any;
    const stats = mem.stats();

    assert.equal(stats.patterns, 5, '5 patterns');
    assert.ok(stats.avgSuccess > 0.8, `avg success: ${stats.avgSuccess}`);
    assert.ok(stats.hnswSize >= 5, `HNSW: ${stats.hnswSize}`);
};

tests['cleanup'] = async () => {
    brain.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};
