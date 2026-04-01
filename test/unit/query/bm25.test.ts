/**
 * BrainBank — BM25 + FTS5 Tests
 *
 * Tests use createDomainSchema() to set up domain tables since
 * code/git/docs schemas are no longer in core.
 * BM25 keyword search is validated via raw FTS5 SQL queries
 * (the actual search path uses CompositeBM25Search + BM25SearchPlugin).
 */

import { Database, SCHEMA_VERSION, tmpDb, createDomainSchema } from '../../helpers.ts';
import { sanitizeFTS, normalizeBM25 } from '../../../src/lib/fts.ts';

export const name = 'BM25 Full-Text Search';

function freshDb(label: string) {
    const db = new Database(tmpDb(label));
    createDomainSchema(db);
    return db;
}

export const tests = {
    async 'FTS5 tables are created with schema v7'(assert: any) {
        const db = freshDb('bm25-test');

        assert.equal(SCHEMA_VERSION, 7);

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
        const db = freshDb('bm25-sync');

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

    async 'FTS5 BM25 finds code by keyword'(assert: any) {
        const db = freshDb('bm25-search');

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

        const ftsQuery = sanitizeFTS('authenticate password');
        const rows = db.prepare(`
            SELECT c.file_path, bm25(fts_code, 5.0, 3.0, 1.0) AS score
            FROM fts_code f
            JOIN code_chunks c ON c.id = f.rowid
            WHERE fts_code MATCH ?
            ORDER BY score ASC
            LIMIT 5
        `).all(ftsQuery) as { file_path: string; score: number }[];

        assert(rows.length > 0, 'should find results for authenticate');
        assert.equal(rows[0].file_path, 'src/auth.ts');
        assert(normalizeBM25(rows[0].score) > 0, 'normalized score should be positive');

        db.close();
    },

    async 'FTS5 BM25 finds git commits'(assert: any) {
        const db = freshDb('bm25-git');

        db.prepare(`
            INSERT INTO git_commits (hash, short_hash, message, author, date, timestamp, files_json, diff, is_merge)
            VALUES ('abc123full', 'abc123', 'fix: resolve authentication bypass vulnerability', 'dev', '2024-01-15', 1705305600, '["src/auth.ts"]', 'diff here', 0)
        `).run();

        const ftsQuery = sanitizeFTS('authentication vulnerability');
        const rows = db.prepare(`
            SELECT c.message, bm25(fts_commits, 5.0, 2.0, 1.0) AS score
            FROM fts_commits f
            JOIN git_commits c ON c.id = f.rowid
            WHERE fts_commits MATCH ?
            ORDER BY score ASC
            LIMIT 5
        `).all(ftsQuery) as { message: string; score: number }[];

        assert(rows.length > 0, 'should find commit');
        assert.includes(rows[0].message, 'authentication');

        db.close();
    },

    async 'BM25 returns empty for no matches'(assert: any) {
        const db = freshDb('bm25-empty');

        const ftsQuery = sanitizeFTS('xyznonexistentterm');
        const rows = db.prepare(`
            SELECT rowid FROM fts_code WHERE fts_code MATCH ?
        `).all(ftsQuery) as any[];

        assert.equal(rows.length, 0);
        db.close();
    },

    async 'sanitizeFTS handles dangerous queries'(assert: any) {
        const db = freshDb('bm25-sanitize');

        // These should not throw
        const q1 = sanitizeFTS('test AND OR NOT');
        if (q1) db.prepare("SELECT rowid FROM fts_code WHERE fts_code MATCH ?").all(q1);

        const q2 = sanitizeFTS('test {brackets} [square]');
        if (q2) db.prepare("SELECT rowid FROM fts_code WHERE fts_code MATCH ?").all(q2);

        const q3 = sanitizeFTS('test^power ~fuzzy');
        if (q3) db.prepare("SELECT rowid FROM fts_code WHERE fts_code MATCH ?").all(q3);

        const empty = sanitizeFTS('');
        assert.equal(empty, '');

        db.close();
    },
};
