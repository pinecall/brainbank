/**
 * BrainBank — Tags & TTL Tests
 */

import { BrainBank, Database, mockEmbedding, tmpDb } from '../../helpers.ts';

export const name = 'Tags & TTL';

export const tests = {
    // ── Tags ─────────────────────────────────────────

    async 'add with tags stores tags_json'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('tags-add'), embeddingProvider: mockEmbedding() });
        await brain.initialize();
        const col = brain.collection('test');

        const id = await col.add('Auth error in login', { tags: ['critical', 'auth'] });
        const items = col.list();
        const item = items.find(i => i.id === id);

        assert(item, 'item should exist');
        assert.equal(item!.tags.length, 2);
        assert(item!.tags.includes('critical'), 'should have critical tag');
        assert(item!.tags.includes('auth'), 'should have auth tag');

        brain.close();
    },

    async 'search filters by tags'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('tags-search'), embeddingProvider: mockEmbedding() });
        await brain.initialize();
        const col = brain.collection('test');

        await col.add('Critical auth failure', { tags: ['critical', 'auth'] });
        await col.add('Warning: slow query', { tags: ['warning', 'db'] });
        await col.add('Critical DB deadlock', { tags: ['critical', 'db'] });

        // Filter by single tag
        const critical = await col.search('error', { tags: ['critical'], mode: 'keyword', minScore: 0 });
        assert(critical.every(i => i.tags.includes('critical')), 'all results should have critical tag');

        // Filter by multiple tags (AND logic)
        const criticalDb = await col.search('error', { tags: ['critical', 'db'], mode: 'keyword', minScore: 0 });
        assert(criticalDb.every(i =>
            i.tags.includes('critical') && i.tags.includes('db')
        ), 'all results should have both tags');

        brain.close();
    },

    async 'list filters by tags'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('tags-list'), embeddingProvider: mockEmbedding() });
        await brain.initialize();
        const col = brain.collection('test');

        await col.add('Item A', { tags: ['foo'] });
        await col.add('Item B', { tags: ['bar'] });
        await col.add('Item C', { tags: ['foo', 'bar'] });

        const fooItems = col.list({ tags: ['foo'] });
        assert.equal(fooItems.length, 2);

        const fooBarItems = col.list({ tags: ['foo', 'bar'] });
        assert.equal(fooBarItems.length, 1);
        assert.equal(fooBarItems[0].content, 'Item C');

        brain.close();
    },

    async 'backward compat: add(content, metadata) still works'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('tags-compat'), embeddingProvider: mockEmbedding() });
        await brain.initialize();
        const col = brain.collection('test');

        // Old-style call: add(content, { key: value })
        const id = await col.add('test item', { type: 'error' });
        const items = col.list();
        const item = items.find(i => i.id === id);

        assert(item, 'item should exist');
        assert.equal(item!.metadata.type, 'error');
        assert.equal(item!.tags.length, 0);

        brain.close();
    },

    // ── TTL ──────────────────────────────────────────

    async 'TTL: expired items are pruned on list'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('ttl-prune'), embeddingProvider: mockEmbedding() });
        await brain.initialize();
        const col = brain.collection('test');

        // Insert already-expired item directly in DB
        const db = new Database(brain.config.dbPath);
        const pastExpiry = Math.floor(Date.now() / 1000) - 10;
        db.prepare(
            "INSERT INTO kv_data (collection, content, meta_json, tags_json, expires_at) VALUES (?, ?, ?, ?, ?)"
        ).run('test', 'expired item', '{}', '[]', pastExpiry);
        db.close();

        // Non-expired item
        await col.add('fresh item');

        const items = col.list();
        assert.equal(items.length, 1);
        assert.equal(items[0].content, 'fresh item');

        brain.close();
    },

    async 'TTL: add with ttl sets expires_at'(assert: any) {
        const brain = new BrainBank({ dbPath: tmpDb('ttl-add'), embeddingProvider: mockEmbedding() });
        await brain.initialize();
        const col = brain.collection('test');

        const id = await col.add('temp item', { ttl: '1h' });
        const items = col.list();
        const item = items.find(i => i.id === id);

        assert(item, 'item should exist');
        assert(item!.expiresAt, 'should have expiresAt');
        const now = Math.floor(Date.now() / 1000);
        assert(item!.expiresAt! > now + 3500, 'expires_at should be ~1h from now');
        assert(item!.expiresAt! < now + 3700, 'expires_at should be ~1h from now');

        brain.close();
    },

    // ── Schema ───────────────────────────────────────

    async 'kv_data has tags_json and expires_at columns'(assert: any) {
        const db = new Database(tmpDb('schema-kv-cols'));
        const cols = db.prepare("PRAGMA table_info(kv_data)").all() as any[];
        const names = cols.map((c: any) => c.name);

        assert(names.includes('tags_json'), 'should have tags_json column');
        assert(names.includes('expires_at'), 'should have expires_at column');
        assert(names.includes('meta_json'), 'should have meta_json column');

        db.close();
    },
};
