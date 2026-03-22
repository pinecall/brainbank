/**
 * BrainBank — Collection Tests
 */

import { BrainBank, Database, mockEmbedding, tmpDb } from '../../helpers.ts';

export const name = 'Collections';

export const tests = {
    async 'kv tables exist'(assert: any) {
        const db = new Database(tmpDb('kv-schema'));

        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kv_%'"
        ).all() as any[];
        const names = tables.map((t: any) => t.name);

        assert(names.includes('kv_data'), 'kv_data should exist');
        assert(names.includes('kv_vectors'), 'kv_vectors should exist');

        const fts = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = 'fts_kv'"
        ).all() as any[];
        assert(fts.length > 0, 'fts_kv should exist');

        db.close();
    },

    async 'add stores item and returns id'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('coll-add'), embeddingProvider: mockEmbedding(), embeddingDims: 384 });
        await brain.initialize();

        const errors = brain.collection('errors');
        const id = await errors.add('Fixed null pointer in api handler', { file: 'api.ts', line: 42 });

        assert(id > 0, 'should return positive id');
        assert.equal(errors.count(), 1);

        const items = errors.list();
        assert.equal(items.length, 1);
        assert.equal(items[0].content, 'Fixed null pointer in api handler');
        assert.equal(items[0].metadata.file, 'api.ts');
        assert.equal(items[0].collection, 'errors');

        brain.close();
    },

    async 'search finds items by keyword'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('coll-search'), embeddingProvider: mockEmbedding(), embeddingDims: 384 });
        await brain.initialize();

        const kb = brain.collection('knowledge');
        await kb.add('Authentication uses JWT with 1h expiry', { topic: 'auth' });
        await kb.add('Database uses PostgreSQL with connection pooling', { topic: 'db' });

        const hits = await kb.search('authentication JWT', { mode: 'keyword', minScore: 0 });
        assert(hits.length > 0, 'should find auth item');
        assert.includes(hits[0].content, 'JWT');

        brain.close();
    },

    async 'collections are isolated'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('coll-isolated'), embeddingProvider: mockEmbedding(), embeddingDims: 384 });
        await brain.initialize();

        const errors = brain.collection('errors');
        const notes = brain.collection('notes');

        await errors.add('Error in auth module');
        await notes.add('Deployed v2 today');

        assert.equal(errors.count(), 1);
        assert.equal(notes.count(), 1);

        const names = brain.listCollectionNames();
        assert(names.includes('errors'), 'should list errors collection');
        assert(names.includes('notes'), 'should list notes collection');

        brain.close();
    },

    async 'trim keeps only N most recent'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('coll-trim'), embeddingProvider: mockEmbedding(), embeddingDims: 384 });
        await brain.initialize();

        const turns = brain.collection('turns');
        for (let i = 0; i < 10; i++) {
            await turns.add(`Turn ${i}`, { turn: i });
        }

        assert.equal(turns.count(), 10);

        const result = await turns.trim({ keep: 3 });
        assert.equal(result.removed, 7);
        assert.equal(turns.count(), 3);

        // Most recent should remain
        const remaining = turns.list();
        assert.equal(remaining[0].content, 'Turn 9');

        brain.close();
    },

    async 'clear removes all items'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('coll-clear'), embeddingProvider: mockEmbedding(), embeddingDims: 384 });
        await brain.initialize();

        const kb = brain.collection('kb');
        await kb.add('Item 1');
        await kb.add('Item 2');
        assert.equal(kb.count(), 2);

        kb.clear();
        assert.equal(kb.count(), 0);

        brain.close();
    },

    async 'remove deletes specific item'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('coll-remove'), embeddingProvider: mockEmbedding(), embeddingDims: 384 });
        await brain.initialize();

        const kb = brain.collection('kb');
        const id1 = await kb.add('Keep this');
        const id2 = await kb.add('Remove this');

        assert.equal(kb.count(), 2);
        kb.remove(id2);
        assert.equal(kb.count(), 1);
        assert.equal(kb.list()[0].content, 'Keep this');

        brain.close();
    },

    async 'addMany stores multiple items'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('coll-addmany'), embeddingProvider: mockEmbedding(), embeddingDims: 384 });
        await brain.initialize();

        const kb = brain.collection('kb');
        const ids = await kb.addMany([
            { content: 'First item', metadata: { n: 1 } },
            { content: 'Second item', metadata: { n: 2 } },
            { content: 'Third item' },
        ]);

        assert.equal(ids.length, 3);
        assert.equal(kb.count(), 3);

        brain.close();
    },

    async 'FTS trigger auto-syncs kv on insert'(assert: any) {
        const db = new Database(tmpDb('kv-fts'));

        db.prepare(`
            INSERT INTO kv_data (collection, content, meta_json)
            VALUES ('test', 'Authentication uses JWT tokens', '{}')
        `).run();

        const results = db.prepare(
            "SELECT rowid FROM fts_kv WHERE fts_kv MATCH '\"authentication\"'"
        ).all() as any[];

        assert(results.length > 0, 'FTS should find inserted kv item');

        db.close();
    },
};
