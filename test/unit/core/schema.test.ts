/**
 * Unit Tests — SQLite Schema & Database
 */

import * as fs from 'node:fs';
import { Database } from '../../../src/storage/database.ts';
import { getSchemaVersion, SCHEMA_VERSION } from '../../../src/core/schema.ts';

export const name = 'Schema & Database';

const TEST_DB = '/tmp/brainbank-test-schema.db';

function freshDb(): Database {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
    return new Database(TEST_DB);
}

export const tests = {
    'creates all tables'(assert: any) {
        const db = freshDb();
        const tables = db.db.prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
        ).all().map((r: any) => r.name);

        assert.includes(tables, 'code_chunks');
        assert.includes(tables, 'code_vectors');
        assert.includes(tables, 'indexed_files');
        assert.includes(tables, 'git_commits');
        assert.includes(tables, 'commit_files');
        assert.includes(tables, 'co_edits');
        assert.includes(tables, 'git_vectors');
        assert.includes(tables, 'memory_patterns');
        assert.includes(tables, 'memory_vectors');
        assert.includes(tables, 'distilled_strategies');
        assert.includes(tables, 'schema_version');
        assert.includes(tables, 'collections');
        assert.includes(tables, 'doc_chunks');
        assert.includes(tables, 'doc_vectors');
        assert.includes(tables, 'path_contexts');
        assert.includes(tables, 'note_memories');
        db.close();
    },

    'schema is idempotent (run twice no error)'(assert: any) {
        const db = freshDb();
        // Constructor already runs createSchema; try instantiating with same DB
        db.close();
        const db2 = new Database(TEST_DB);
        assert.ok(true, 'second init did not throw');
        db2.close();
    },

    'schema version is correct'(assert: any) {
        const db = freshDb();
        const version = getSchemaVersion(db.db);
        assert.equal(version, SCHEMA_VERSION);
        db.close();
    },

    'WAL mode is active'(assert: any) {
        const db = freshDb();
        const mode = db.db.pragma('journal_mode') as any[];
        assert.equal(mode[0].journal_mode, 'wal');
        db.close();
    },

    'insert and query roundtrip'(assert: any) {
        const db = freshDb();
        db.prepare(`INSERT INTO code_chunks (file_path, chunk_type, start_line, end_line, content, language)
                     VALUES (?, ?, ?, ?, ?, ?)`).run('test.ts', 'file', 1, 10, 'hello', 'typescript');

        const row = db.prepare('SELECT * FROM code_chunks WHERE file_path = ?').get('test.ts') as any;
        assert.ok(row, 'row should exist');
        assert.equal(row.file_path, 'test.ts');
        assert.equal(row.chunk_type, 'file');
        assert.equal(row.content, 'hello');
        db.close();
    },

    'transaction commits on success'(assert: any) {
        const db = freshDb();
        db.transaction(() => {
            db.prepare(`INSERT INTO code_chunks (file_path, chunk_type, start_line, end_line, content, language)
                         VALUES (?, ?, ?, ?, ?, ?)`).run('tx.ts', 'file', 1, 1, 'tx', 'typescript');
        });
        const row = db.prepare('SELECT * FROM code_chunks WHERE file_path = ?').get('tx.ts');
        assert.ok(row, 'transaction should have committed');
        db.close();
    },

    'transaction rolls back on error'(assert: any) {
        const db = freshDb();
        try {
            db.transaction(() => {
                db.prepare(`INSERT INTO code_chunks (file_path, chunk_type, start_line, end_line, content, language)
                             VALUES (?, ?, ?, ?, ?, ?)`).run('rollback.ts', 'file', 1, 1, 'rb', 'typescript');
                throw new Error('Intentional');
            });
        } catch {}
        const row = db.prepare('SELECT * FROM code_chunks WHERE file_path = ?').get('rollback.ts');
        assert.ok(!row, 'transaction should have rolled back');
        db.close();
    },

    'batch inserts multiple rows'(assert: any) {
        const db = freshDb();
        db.batch(
            `INSERT INTO code_chunks (file_path, chunk_type, start_line, end_line, content, language)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                ['b1.ts', 'file', 1, 1, 'batch1', 'typescript'],
                ['b2.ts', 'file', 1, 1, 'batch2', 'typescript'],
                ['b3.ts', 'file', 1, 1, 'batch3', 'typescript'],
            ]
        );
        const count = (db.prepare('SELECT COUNT(*) as c FROM code_chunks WHERE file_path LIKE ?').get('b%.ts') as any).c;
        assert.equal(count, 3);
        db.close();
    },

    'auto-creates parent directory'(assert: any) {
        const nested = '/tmp/brainbank-test-nested/sub/dir/test.db';
        try { fs.rmSync('/tmp/brainbank-test-nested', { recursive: true }); } catch {}
        const db = new Database(nested);
        assert.ok(fs.existsSync(nested));
        db.close();
        try { fs.rmSync('/tmp/brainbank-test-nested', { recursive: true }); } catch {}
    },
};
