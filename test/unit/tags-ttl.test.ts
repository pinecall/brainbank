/**
 * BrainBank — Tags, TTL & Migrations Tests
 */

import { BrainBank, Database, mockEmbedding, tmpDb } from '../helpers.ts';

export const name = 'Tags, TTL & Migrations';

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

        // Add item with 0-second TTL (already expired)
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
        // expiresAt should be ~1 hour from now
        const now = Math.floor(Date.now() / 1000);
        assert(item!.expiresAt! > now + 3500, 'expires_at should be ~1h from now');
        assert(item!.expiresAt! < now + 3700, 'expires_at should be ~1h from now');

        brain.close();
    },

    // ── Migrations ───────────────────────────────────

    async 'migration adds tags_json and expires_at to existing DB'(assert: any) {
        const dbPath = tmpDb('migration-v5');

        // Simulate a v4 database (no tags_json, no expires_at)
        const BetterSqlite3 = (await import('better-sqlite3')).default;
        const rawDb = new BetterSqlite3(dbPath);
        rawDb.exec(`
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            INSERT OR IGNORE INTO schema_version (version) VALUES (4);

            CREATE TABLE IF NOT EXISTS kv_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection TEXT NOT NULL,
                content TEXT NOT NULL,
                meta_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
        `);
        // Insert test data before migration
        rawDb.prepare("INSERT INTO kv_data (collection, content) VALUES (?, ?)").run('test', 'old data');
        rawDb.close();

        // Open with BrainBank Database wrapper (should auto-migrate)
        const db = new Database(dbPath);
        const cols = db.prepare("PRAGMA table_info(kv_data)").all() as any[];
        const colNames = cols.map((c: any) => c.name);

        assert(colNames.includes('tags_json'), 'should have tags_json column after migration');
        assert(colNames.includes('expires_at'), 'should have expires_at column after migration');

        // Old data should still be accessible
        const row = db.prepare("SELECT * FROM kv_data WHERE content = 'old data'").get() as any;
        assert(row, 'old data should survive migration');
        assert.equal(row.tags_json, '[]');

        db.close();
    },

    async 'schema version is 5 for new databases'(assert: any) {
        const db = new Database(tmpDb('migration-new'));
        const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as any;
        assert.equal(row.v, 5);
        db.close();
    },
};
