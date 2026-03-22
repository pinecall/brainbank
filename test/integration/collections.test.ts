/**
 * BrainBank Integration Test — KV Collections
 *
 * Full pipeline: add → hybrid/keyword/vector search →
 * tag filter → TTL → batch → trim → remove → clear.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrainBank, hashEmbedding } from '../helpers.ts';

export const name = 'KV Collections';

let tmpDir: string;
let brain: BrainBank;

export const tests: Record<string, () => Promise<void>> = {};

tests['setup'] = async () => {
    const assert = (await import('node:assert')).strict;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-coll-'));
    brain = new BrainBank({ repoPath: tmpDir, dbPath: path.join(tmpDir, 'test.db'), embeddingProvider: hashEmbedding() });
    await brain.initialize();
    assert.ok(brain);
};

tests['add: stores items with tags'] = async () => {
    const assert = (await import('node:assert')).strict;
    const c = brain.collection('errors');
    await c.add('TypeError: Cannot read property "name" of null', { tags: ['frontend', 'react'] });
    await c.add('ECONNREFUSED: postgres:5432', { tags: ['backend', 'database'] });
    await c.add('CORS policy blocked /api/users', { tags: ['frontend', 'network'] });
    await c.add('OutOfMemoryError: heap exceeded', { tags: ['backend', 'perf'] });
    await c.add('TimeoutError: 30s deadline', { tags: ['backend', 'network'] });
    const items = await c.list();
    assert.equal(items.length, 5, '5 items');
};

tests['search: vector returns ranked results'] = async () => {
    const assert = (await import('node:assert')).strict;
    const r = await brain.collection('errors').search('database connection');
    assert.ok(r.length > 0, `found ${r.length} results`);
    assert.ok(r[0].score > 0, 'has score');
};

tests['search: BM25 keyword matches'] = async () => {
    const assert = (await import('node:assert')).strict;
    const r = await brain.collection('errors').search('CORS policy', { mode: 'keyword' });
    assert.ok(r.length > 0 && r[0].content.includes('CORS'), 'keyword match');
};

tests['search: hybrid combines vector + BM25'] = async () => {
    const assert = (await import('node:assert')).strict;
    const r = await brain.collection('errors').search('memory heap', { mode: 'hybrid' });
    assert.ok(r.length > 0 && r[0].score > 0, 'hybrid works');
};

tests['search: tag filter narrows results'] = async () => {
    const assert = (await import('node:assert')).strict;
    const all = await brain.collection('errors').search('error');
    const fe = await brain.collection('errors').search('error', { tags: ['frontend'] });
    assert.ok(all.length >= fe.length, 'tag filter narrows');
    assert.ok(fe.length > 0, 'has frontend results');
};

tests['list: filters by tags'] = async () => {
    const assert = (await import('node:assert')).strict;
    const net = await brain.collection('errors').list({ tags: ['network'] });
    assert.ok(net.length >= 2, `${net.length} network items`);
};

tests['isolation: collections are independent'] = async () => {
    const assert = (await import('node:assert')).strict;
    const logs = brain.collection('logs');
    await logs.add('Server started on port 3000');
    await logs.add('GET /api/health');
    assert.equal((await brain.collection('errors').list()).length, 5, 'errors untouched');
    assert.equal((await logs.list()).length, 2, 'logs has 2');
};

tests['batch: addMany stores multiple items'] = async () => {
    const assert = (await import('node:assert')).strict;
    const m = brain.collection('metrics');
    await m.addMany([
        { content: 'p50=45ms p95=120ms', metadata: { tags: ['latency'] } },
        { content: 'query avg=12ms max=89ms', metadata: { tags: ['db'] } },
        { content: 'Memory: 256MB/512MB', metadata: { tags: ['mem'] } },
    ]);
    assert.equal((await m.list()).length, 3, 'batch added');
};

tests['ttl: expired items auto-pruned'] = async () => {
    const assert = (await import('node:assert')).strict;
    const t = brain.collection('temp');
    await t.add('expires soon', { ttl: '1s' });
    await t.add('stays forever');
    await new Promise(r => setTimeout(r, 1500));
    const items = await t.list();
    assert.ok(items.length <= 1, `${items.length} items after TTL`);
};

tests['trim: keeps only N most recent'] = async () => {
    const assert = (await import('node:assert')).strict;
    const c = brain.collection('trim_test');
    for (let i = 0; i < 5; i++) await c.add(`Item ${i}`);
    await c.trim({ keep: 2 });
    const items = await c.list();
    assert.ok(items.length <= 2, `trimmed to ${items.length}`);
};

tests['remove: deletes specific item'] = async () => {
    const assert = (await import('node:assert')).strict;
    const c = brain.collection('errors');
    const items = await c.list();
    await c.remove(items[0].id);
    assert.equal((await c.list()).length, items.length - 1, 'one removed');
};

tests['clear: removes all items'] = async () => {
    const assert = (await import('node:assert')).strict;
    const c = brain.collection('logs');
    await c.clear();
    assert.equal((await c.list()).length, 0, 'cleared');
};

tests['listCollectionNames'] = async () => {
    const assert = (await import('node:assert')).strict;
    const names = brain.listCollectionNames();
    assert.ok(names.includes('errors') && names.includes('metrics'), 'has collections');
};

tests['cleanup'] = async () => {
    brain.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};
