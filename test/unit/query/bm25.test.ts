/**
 * BrainBank — BM25 + FTS5 Tests
 */

import { Database, KeywordSearch, SCHEMA_VERSION, tmpDb } from '../../helpers.ts';

export const name = 'BM25 Full-Text Search';

export const tests = {
    async 'FTS5 tables are created with schema v6'(assert: any) {
        const db = new Database(tmpDb('bm25-test'));

        assert.equal(SCHEMA_VERSION, 6);

        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts_%'"
        ).all() as any[];
        const names = tables.map((t: any) => t.name);

        assert(names.includes('fts_code'), 'fts_code table should exist');
        assert(names.includes('fts_commits'), 'fts_commits table should exist');
        assert(names.includes('fts_docs'), 'fts_docs table should exist');

        db.close();
    },

    async 'FTS5 triggers auto-sync on insert'(assert: any) {
        const db = new Database(tmpDb('bm25-sync'));

        db.prepare(`
            INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
            VALUES ('src/auth.ts', 'function', 'validateToken', 1, 20, 'async function validateToken(jwt: string) { return verify(jwt); }', 'typescript', 'abc123')
        `).run();

        const results = db.prepare(
            "SELECT rowid, bm25(fts_code) AS score FROM fts_code WHERE fts_code MATCH '\"validateToken\"'"
        ).all() as any[];

        assert(results.length > 0, 'FTS should find inserted code chunk');
        assert.equal(results[0].rowid, 1);

        db.close();
    },

    async 'KeywordSearch finds code by keyword'(assert: any) {
        const db = new Database(tmpDb('bm25-search'));

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

        const bm25 = new KeywordSearch(db);
        const results = await bm25.search('authenticate password');

        assert(results.length > 0, 'should find results for authenticate');
        assert.equal(results[0].type, 'code');
        assert.equal(results[0].filePath, 'src/auth.ts');

        db.close();
    },

    async 'KeywordSearch finds git commits'(assert: any) {
        const db = new Database(tmpDb('bm25-git'));

        db.prepare(`
            INSERT INTO git_commits (hash, short_hash, message, author, date, timestamp, files_json, diff, is_merge)
            VALUES ('abc123full', 'abc123', 'fix: resolve authentication bypass vulnerability', 'dev', '2024-01-15', 1705305600, '["src/auth.ts"]', 'diff here', 0)
        `).run();

        const bm25 = new KeywordSearch(db);
        const results = await bm25.search('authentication vulnerability');

        assert(results.length > 0, 'should find commit');
        assert.equal(results[0].type, 'commit');
        assert.includes(results[0].content, 'authentication');

        db.close();
    },



    async 'BM25 returns empty for no matches'(assert: any) {
        const db = new Database(tmpDb('bm25-empty'));
        const bm25 = new KeywordSearch(db);
        const results = await bm25.search('xyznonexistentterm');

        assert.equal(results.length, 0);
        db.close();
    },

    async 'BM25 sanitizes dangerous queries'(assert: any) {
        const db = new Database(tmpDb('bm25-sanitize'));
        const bm25 = new KeywordSearch(db);

        await bm25.search('test AND OR NOT');
        await bm25.search('test {brackets} [square]');
        await bm25.search('test^power ~fuzzy');
        const empty = await bm25.search('');

        assert.equal(empty.length, 0);
        db.close();
    },
};
