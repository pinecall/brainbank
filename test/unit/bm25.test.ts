/**
 * BrainBank — BM25 + FTS5 Tests
 */

export const name = 'BM25 Full-Text Search';

export const tests = {
    async 'FTS5 tables are created with schema v2'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { SCHEMA_VERSION } = await import('../../src/core/schema.ts');
        const path = `/tmp/brainbank-bm25-test-${Date.now()}.db`;
        const db = new Database(path);

        assert.equal(SCHEMA_VERSION, 3);

        // Check FTS tables exist
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts_%'"
        ).all() as any[];
        const names = tables.map((t: any) => t.name);

        assert(names.includes('fts_code'), 'fts_code table should exist');
        assert(names.includes('fts_commits'), 'fts_commits table should exist');
        assert(names.includes('fts_patterns'), 'fts_patterns table should exist');

        db.close();
    },

    async 'FTS5 triggers auto-sync on insert'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const path = `/tmp/brainbank-bm25-sync-${Date.now()}.db`;
        const db = new Database(path);

        // Insert a code chunk
        db.prepare(`
            INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
            VALUES ('src/auth.ts', 'function', 'validateToken', 1, 20, 'async function validateToken(jwt: string) { return verify(jwt); }', 'typescript', 'abc123')
        `).run();

        // Search FTS — should find it via trigger
        const results = db.prepare(
            "SELECT rowid, bm25(fts_code) AS score FROM fts_code WHERE fts_code MATCH '\"validateToken\"'"
        ).all() as any[];

        assert(results.length > 0, 'FTS should find inserted code chunk');
        assert.equal(results[0].rowid, 1);

        db.close();
    },

    async 'BM25Search finds code by keyword'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { BM25Search } = await import('../../src/query/bm25.ts');
        const path = `/tmp/brainbank-bm25-search-${Date.now()}.db`;
        const db = new Database(path);

        // Insert test data
        db.prepare(`
            INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
            VALUES ('src/auth.ts', 'function', 'authenticate', 1, 15,
                    'function authenticate(user: string, password: string) { return bcrypt.compare(password, user.hash); }',
                    'typescript', 'hash1')
        `).run();
        db.prepare(`
            INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
            VALUES ('src/logger.ts', 'function', 'log', 1, 5,
                    'function log(message: string) { console.log(message); }',
                    'typescript', 'hash2')
        `).run();

        const bm25 = new BM25Search(db);
        const results = bm25.search('authenticate password');

        assert(results.length > 0, 'should find results for authenticate');
        assert.equal(results[0].type, 'code');
        assert.equal(results[0].filePath, 'src/auth.ts');

        db.close();
    },

    async 'BM25Search finds git commits'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { BM25Search } = await import('../../src/query/bm25.ts');
        const path = `/tmp/brainbank-bm25-git-${Date.now()}.db`;
        const db = new Database(path);

        db.prepare(`
            INSERT INTO git_commits (hash, short_hash, message, author, date, timestamp, files_json, diff, is_merge)
            VALUES ('abc123full', 'abc123', 'fix: resolve authentication bypass vulnerability', 'dev', '2024-01-15', 1705305600, '["src/auth.ts"]', 'diff here', 0)
        `).run();

        const bm25 = new BM25Search(db);
        const results = bm25.search('authentication vulnerability');

        assert(results.length > 0, 'should find commit');
        assert.equal(results[0].type, 'commit');
        assert.includes(results[0].content, 'authentication');

        db.close();
    },

    async 'BM25Search finds memory patterns'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { BM25Search } = await import('../../src/query/bm25.ts');
        const path = `/tmp/brainbank-bm25-mem-${Date.now()}.db`;
        const db = new Database(path);

        db.prepare(`
            INSERT INTO memory_patterns (task_type, task, approach, outcome, success_rate)
            VALUES ('api', 'implement rate limiting middleware', 'used express-rate-limit with Redis store', 'working rate limiter', 0.9)
        `).run();

        const bm25 = new BM25Search(db);
        const results = bm25.search('rate limiting');

        assert(results.length > 0, 'should find pattern');
        assert.equal(results[0].type, 'pattern');

        db.close();
    },

    async 'BM25 returns empty for no matches'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { BM25Search } = await import('../../src/query/bm25.ts');
        const path = `/tmp/brainbank-bm25-empty-${Date.now()}.db`;
        const db = new Database(path);

        const bm25 = new BM25Search(db);
        const results = bm25.search('xyznonexistentterm');

        assert.equal(results.length, 0);

        db.close();
    },

    async 'BM25 sanitizes dangerous queries'(assert: any) {
        const { Database } = await import('../../src/storage/database.ts');
        const { BM25Search } = await import('../../src/query/bm25.ts');
        const path = `/tmp/brainbank-bm25-sanitize-${Date.now()}.db`;
        const db = new Database(path);

        const bm25 = new BM25Search(db);

        // These should not throw
        bm25.search('test AND OR NOT');
        bm25.search('test {brackets} [square]');
        bm25.search('test^power ~fuzzy');
        const empty = bm25.search('');

        assert.equal(empty.length, 0);

        db.close();
    },
};
