/**
 * BrainBank — Note Memory Tests
 */

export const name = 'Note Memory';

export const tests = {
    async 'note_memories table exists'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const path = `/tmp/brainbank-note-schema-${Date.now()}.db`;
        const db = new Database(path);

        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%note%'"
        ).all() as any[];
        const names = tables.map((t: any) => t.name);

        assert(names.includes('note_memories'), 'note_memories should exist');
        assert(names.includes('note_vectors'), 'note_vectors should exist');

        // FTS table
        const fts = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = 'fts_notes'"
        ).all() as any[];
        assert(fts.length > 0, 'fts_notes should exist');

        db.close();
    },

    async 'remember stores a digest and returns id'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { NoteStore } = await import('../../src/memory/note-store.ts');
        const { HNSWIndex } = await import('../../src/vector/hnsw.ts');

        const path = `/tmp/brainbank-note-remember-${Date.now()}.db`;
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

        const store = new NoteStore(db, embedding, hnsw, vecs);

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
        const row = db.prepare('SELECT * FROM note_memories WHERE id = ?').get(id) as any;
        assert.equal(row.title, 'Added BM25 search');
        assert.equal(row.tier, 'short');
        assert.includes(row.decisions_json, 'FTS5');

        // Verify vector stored
        const vec = db.prepare('SELECT * FROM note_vectors WHERE note_id = ?').get(id) as any;
        assert(vec, 'vector should be stored');

        db.close();
    },

    async 'recall finds notes by keyword'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { NoteStore } = await import('../../src/memory/note-store.ts');
        const { HNSWIndex } = await import('../../src/vector/hnsw.ts');

        const path = `/tmp/brainbank-note-recall-${Date.now()}.db`;
        const db = new Database(path);
        const hnsw = await new HNSWIndex(384, 1000).init();
        const vecs = new Map<number, Float32Array>();

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const store = new NoteStore(db, embedding, hnsw, vecs);

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
        assert(results.length > 0, 'should find auth-related note');
        assert.equal(results[0].title, 'Refactored authentication module');

        db.close();
    },

    async 'list returns recent notes in order'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { NoteStore } = await import('../../src/memory/note-store.ts');
        const { HNSWIndex } = await import('../../src/vector/hnsw.ts');

        const path = `/tmp/brainbank-note-list-${Date.now()}.db`;
        const db = new Database(path);
        const hnsw = await new HNSWIndex(384, 1000).init();
        const vecs = new Map<number, Float32Array>();

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const store = new NoteStore(db, embedding, hnsw, vecs);

        await store.remember({ title: 'First', summary: 'First note' });
        await store.remember({ title: 'Second', summary: 'Second note' });
        await store.remember({ title: 'Third', summary: 'Third note' });

        const all = store.list(10);
        assert.equal(all.length, 3);
        // Most recent first
        assert.equal(all[0].title, 'Third');

        db.close();
    },

    async 'count returns correct totals'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { NoteStore } = await import('../../src/memory/note-store.ts');
        const { HNSWIndex } = await import('../../src/vector/hnsw.ts');

        const path = `/tmp/brainbank-note-count-${Date.now()}.db`;
        const db = new Database(path);
        const hnsw = await new HNSWIndex(384, 1000).init();
        const vecs = new Map<number, Float32Array>();

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const store = new NoteStore(db, embedding, hnsw, vecs);

        const before = store.count();
        assert.equal(before.total, 0);
        assert.equal(before.short, 0);

        await store.remember({ title: 'Test', summary: 'Test note' });

        const after = store.count();
        assert.equal(after.total, 1);
        assert.equal(after.short, 1);
        assert.equal(after.long, 0);

        db.close();
    },

    async 'consolidate promotes old notes to long tier'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { NoteStore } = await import('../../src/memory/note-store.ts');
        const { HNSWIndex } = await import('../../src/vector/hnsw.ts');

        const path = `/tmp/brainbank-note-consolidate-${Date.now()}.db`;
        const db = new Database(path);
        const hnsw = await new HNSWIndex(384, 1000).init();
        const vecs = new Map<number, Float32Array>();

        const embedding = {
            dims: 384,
            async embed(_: string) { return new Float32Array(384).fill(0.1); },
            async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(384).fill(0.1)); },
            async close() {},
        };

        const store = new NoteStore(db, embedding, hnsw, vecs);

        // Add 5 notes
        for (let i = 0; i < 5; i++) {
            await store.remember({
                title: `Note ${i}`,
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

        // Long-tier notes should have fields cleared
        const longNotes = store.list(10, 'long');
        assert.equal(longNotes[0].filesChanged?.length, 0);
        assert.equal(longNotes[0].openQuestions?.length, 0);

        db.close();
    },

    async 'FTS trigger auto-syncs on insert'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const path = `/tmp/brainbank-note-fts-${Date.now()}.db`;
        const db = new Database(path);

        db.prepare(`
            INSERT INTO note_memories (title, summary, decisions_json, tags_json)
            VALUES ('Auth refactor', 'Moved to middleware pattern', '["jwt"]', '["auth"]')
        `).run();

        const results = db.prepare(
            "SELECT rowid FROM fts_notes WHERE fts_notes MATCH '\"auth\"'"
        ).all() as any[];

        assert(results.length > 0, 'FTS should find inserted note');

        db.close();
    },
};
