/**
 * BrainBank — Conversation Memory Tests
 */

export const name = 'Conversation Memory';

export const tests = {
    async 'conversation_memories table exists'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const path = `/tmp/brainbank-conv-schema-${Date.now()}.db`;
        const db = new Database(path);

        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%conversation%'"
        ).all() as any[];
        const names = tables.map((t: any) => t.name);

        assert(names.includes('conversation_memories'), 'conversation_memories should exist');
        assert(names.includes('conversation_vectors'), 'conversation_vectors should exist');

        // FTS table
        const fts = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = 'fts_conversations'"
        ).all() as any[];
        assert(fts.length > 0, 'fts_conversations should exist');

        db.close();
    },

    async 'remember stores a digest and returns id'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { ConversationStore } = await import('../../src/memory/conversation-store.ts');
        const { HNSWIndex } = await import('../../src/vector/hnsw.ts');

        const path = `/tmp/brainbank-conv-remember-${Date.now()}.db`;
        const db = new Database(path);
        const hnsw = await new HNSWIndex(384, 1000).init();
        const vecs = new Map<number, Float32Array>();

        // Mock embedding
        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const store = new ConversationStore(db, embedding, hnsw, vecs);

        const id = await store.remember({
            title: 'Added BM25 search',
            summary: 'Implemented FTS5 with Porter stemming for keyword search',
            decisions: ['Use FTS5 over Lunr', 'RRF with k=60'],
            filesChanged: ['query/bm25.ts', 'query/rrf.ts'],
            patterns: ['Triggers auto-sync FTS on insert/delete'],
            tags: ['search', 'bm25'],
        });

        assert(id > 0, 'should return positive id');

        // Verify stored in DB
        const row = db.prepare('SELECT * FROM conversation_memories WHERE id = ?').get(id) as any;
        assert.equal(row.title, 'Added BM25 search');
        assert.equal(row.tier, 'short');
        assert.includes(row.decisions_json, 'FTS5');

        // Verify vector stored
        const vec = db.prepare('SELECT * FROM conversation_vectors WHERE memory_id = ?').get(id) as any;
        assert(vec, 'vector should be stored');

        db.close();
    },

    async 'recall finds memories by keyword'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { ConversationStore } = await import('../../src/memory/conversation-store.ts');
        const { HNSWIndex } = await import('../../src/vector/hnsw.ts');

        const path = `/tmp/brainbank-conv-recall-${Date.now()}.db`;
        const db = new Database(path);
        const hnsw = await new HNSWIndex(384, 1000).init();
        const vecs = new Map<number, Float32Array>();

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const store = new ConversationStore(db, embedding, hnsw, vecs);

        await store.remember({
            title: 'Refactored authentication module',
            summary: 'Moved JWT validation to middleware pattern',
            decisions: ['Use middleware over inline checks'],
            tags: ['auth', 'refactor'],
        });

        await store.remember({
            title: 'Fixed database connection pooling',
            summary: 'Added pg-pool with max 20 connections',
            tags: ['database', 'performance'],
        });

        // Keyword search for auth
        const results = await store.recall('authentication middleware', { mode: 'keyword', minScore: 0 });
        assert(results.length > 0, 'should find auth-related memory');
        assert.equal(results[0].title, 'Refactored authentication module');

        db.close();
    },

    async 'list returns recent memories in order'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { ConversationStore } = await import('../../src/memory/conversation-store.ts');
        const { HNSWIndex } = await import('../../src/vector/hnsw.ts');

        const path = `/tmp/brainbank-conv-list-${Date.now()}.db`;
        const db = new Database(path);
        const hnsw = await new HNSWIndex(384, 1000).init();
        const vecs = new Map<number, Float32Array>();

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const store = new ConversationStore(db, embedding, hnsw, vecs);

        await store.remember({ title: 'First', summary: 'First conv' });
        await store.remember({ title: 'Second', summary: 'Second conv' });
        await store.remember({ title: 'Third', summary: 'Third conv' });

        const all = store.list(10);
        assert.equal(all.length, 3);
        // Most recent first
        assert.equal(all[0].title, 'Third');

        db.close();
    },

    async 'count returns correct totals'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { ConversationStore } = await import('../../src/memory/conversation-store.ts');
        const { HNSWIndex } = await import('../../src/vector/hnsw.ts');

        const path = `/tmp/brainbank-conv-count-${Date.now()}.db`;
        const db = new Database(path);
        const hnsw = await new HNSWIndex(384, 1000).init();
        const vecs = new Map<number, Float32Array>();

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const store = new ConversationStore(db, embedding, hnsw, vecs);

        const before = store.count();
        assert.equal(before.total, 0);
        assert.equal(before.short, 0);

        await store.remember({ title: 'Test', summary: 'Test conv' });

        const after = store.count();
        assert.equal(after.total, 1);
        assert.equal(after.short, 1);
        assert.equal(after.long, 0);

        db.close();
    },

    async 'consolidate promotes old memories to long tier'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { ConversationStore } = await import('../../src/memory/conversation-store.ts');
        const { HNSWIndex } = await import('../../src/vector/hnsw.ts');

        const path = `/tmp/brainbank-conv-consolidate-${Date.now()}.db`;
        const db = new Database(path);
        const hnsw = await new HNSWIndex(384, 1000).init();
        const vecs = new Map<number, Float32Array>();

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const store = new ConversationStore(db, embedding, hnsw, vecs);

        // Add 5 memories
        for (let i = 0; i < 5; i++) {
            await store.remember({
                title: `Conv ${i}`,
                summary: `Summary ${i}`,
                filesChanged: ['file.ts'],
                openQuestions: ['question?'],
            });
        }

        // Consolidate, keeping only 2 recent
        const result = store.consolidate(2);
        assert.equal(result.promoted, 3);

        const counts = store.count();
        assert.equal(counts.short, 2);
        assert.equal(counts.long, 3);

        // Long-tier memories should have fields cleared
        const longMems = store.list(10, 'long');
        assert.equal(longMems[0].filesChanged?.length, 0);
        assert.equal(longMems[0].openQuestions?.length, 0);

        db.close();
    },

    async 'FTS trigger auto-syncs on insert'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const path = `/tmp/brainbank-conv-fts-${Date.now()}.db`;
        const db = new Database(path);

        db.prepare(`
            INSERT INTO conversation_memories (title, summary, decisions_json, tags_json)
            VALUES ('Auth refactor', 'Moved to middleware pattern', '["jwt"]', '["auth"]')
        `).run();

        const results = db.prepare(
            "SELECT rowid FROM fts_conversations WHERE fts_conversations MATCH '\"auth\"'"
        ).all() as any[];

        assert(results.length > 0, 'FTS should find inserted conversation memory');

        db.close();
    },
};
