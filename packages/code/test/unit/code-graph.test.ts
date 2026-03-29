/**
 * Unit Tests — Code Graph Schema
 *
 * Tests the code_imports, code_symbols, and code_refs tables
 * and their foreign key constraints and indices.
 */

import { Database, tmpDb } from '../helpers.ts';

export const name = 'Code Graph Schema';

export const tests = {
    'code_imports stores and retrieves file relationships'(assert: any) {
        const db = new Database(tmpDb('graph-imports'));

        db.prepare('INSERT INTO code_imports (file_path, imports_path) VALUES (?, ?)').run('src/app.ts', 'utils');
        db.prepare('INSERT INTO code_imports (file_path, imports_path) VALUES (?, ?)').run('src/app.ts', 'config');
        db.prepare('INSERT INTO code_imports (file_path, imports_path) VALUES (?, ?)').run('src/utils.ts', 'config');

        const imports = db.prepare('SELECT imports_path FROM code_imports WHERE file_path = ?').all('src/app.ts') as any[];
        assert.equal(imports.length, 2);
        assert.includes(imports.map((r: any) => r.imports_path), 'utils');
        assert.includes(imports.map((r: any) => r.imports_path), 'config');

        // Reverse lookup: who imports 'config'?
        const importers = db.prepare('SELECT file_path FROM code_imports WHERE imports_path = ?').all('config') as any[];
        assert.equal(importers.length, 2);

        db.close();
    },

    'code_imports enforces primary key (dedup)'(assert: any) {
        const db = new Database(tmpDb('graph-imports-dup'));

        db.prepare('INSERT INTO code_imports (file_path, imports_path) VALUES (?, ?)').run('a.ts', 'b');
        // Duplicate should fail or be ignored with INSERT OR IGNORE
        try {
            db.prepare('INSERT OR IGNORE INTO code_imports (file_path, imports_path) VALUES (?, ?)').run('a.ts', 'b');
        } catch { /* expected */ }

        const count = (db.prepare('SELECT COUNT(*) as c FROM code_imports').get() as any).c;
        assert.equal(count, 1, 'should not have duplicate');

        db.close();
    },

    'code_symbols stores definitions linked to chunks'(assert: any) {
        const db = new Database(tmpDb('graph-symbols'));

        // Insert a code chunk first
        const chunkResult = db.prepare(
            `INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run('src/service.ts', 'function', 'process', 10, 25, 'function process() {}', 'typescript', 'abc');
        const chunkId = Number(chunkResult.lastInsertRowid);

        // Insert symbols
        db.prepare('INSERT INTO code_symbols (file_path, name, kind, line, chunk_id) VALUES (?, ?, ?, ?, ?)').run('src/service.ts', 'process', 'function', 10, chunkId);
        db.prepare('INSERT INTO code_symbols (file_path, name, kind, line, chunk_id) VALUES (?, ?, ?, ?, ?)').run('src/service.ts', 'UserService', 'class', 1, null);
        db.prepare('INSERT INTO code_symbols (file_path, name, kind, line, chunk_id) VALUES (?, ?, ?, ?, ?)').run('src/service.ts', 'UserService.findAll', 'method', 5, chunkId);

        // Query by name
        const byName = db.prepare('SELECT * FROM code_symbols WHERE name = ?').get('process') as any;
        assert.ok(byName, 'should find by name');
        assert.equal(byName.kind, 'function');
        assert.equal(byName.chunk_id, chunkId);

        // Query by file
        const byFile = db.prepare('SELECT * FROM code_symbols WHERE file_path = ?').all('src/service.ts') as any[];
        assert.equal(byFile.length, 3);

        db.close();
    },

    'code_refs stores call references linked to chunks'(assert: any) {
        const db = new Database(tmpDb('graph-refs'));

        const chunkResult = db.prepare(
            `INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run('src/handler.ts', 'function', 'handleRequest', 1, 20, 'function handleRequest() {}', 'typescript', 'xyz');
        const chunkId = Number(chunkResult.lastInsertRowid);

        // Insert call references
        db.prepare('INSERT INTO code_refs (chunk_id, symbol_name) VALUES (?, ?)').run(chunkId, 'validate');
        db.prepare('INSERT INTO code_refs (chunk_id, symbol_name) VALUES (?, ?)').run(chunkId, 'authorize');
        db.prepare('INSERT INTO code_refs (chunk_id, symbol_name) VALUES (?, ?)').run(chunkId, 'respond');

        // Query: what does this chunk call?
        const calls = db.prepare('SELECT symbol_name FROM code_refs WHERE chunk_id = ?').all(chunkId) as any[];
        assert.equal(calls.length, 3);
        assert.includes(calls.map((r: any) => r.symbol_name), 'validate');
        assert.includes(calls.map((r: any) => r.symbol_name), 'authorize');

        db.close();
    },

    'code_refs cascade-delete when chunk is deleted'(assert: any) {
        const db = new Database(tmpDb('graph-refs-cascade'));

        const chunkResult = db.prepare(
            `INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run('src/temp.ts', 'function', 'temp', 1, 5, 'function temp() {}', 'typescript', 'tmp');
        const chunkId = Number(chunkResult.lastInsertRowid);

        db.prepare('INSERT INTO code_refs (chunk_id, symbol_name) VALUES (?, ?)').run(chunkId, 'helper');
        db.prepare('INSERT INTO code_refs (chunk_id, symbol_name) VALUES (?, ?)').run(chunkId, 'util');

        // Delete the chunk
        db.prepare('DELETE FROM code_chunks WHERE id = ?').run(chunkId);

        // Refs should be cascade-deleted
        const refs = db.prepare('SELECT * FROM code_refs WHERE chunk_id = ?').all(chunkId);
        assert.equal(refs.length, 0, 'refs should be cascade-deleted');

        db.close();
    },

    'code_symbols cascade-delete when chunk is deleted'(assert: any) {
        const db = new Database(tmpDb('graph-sym-cascade'));

        const chunkResult = db.prepare(
            `INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run('src/temp2.ts', 'function', 'foo', 1, 5, 'function foo() {}', 'typescript', 'tmp2');
        const chunkId = Number(chunkResult.lastInsertRowid);

        db.prepare('INSERT INTO code_symbols (file_path, name, kind, line, chunk_id) VALUES (?, ?, ?, ?, ?)').run('src/temp2.ts', 'foo', 'function', 1, chunkId);

        db.prepare('DELETE FROM code_chunks WHERE id = ?').run(chunkId);

        const syms = db.prepare('SELECT * FROM code_symbols WHERE chunk_id = ?').all(chunkId);
        assert.equal(syms.length, 0, 'symbols should be cascade-deleted');

        db.close();
    },

    'cross-reference: find callers of a symbol'(assert: any) {
        const db = new Database(tmpDb('graph-crossref'));

        // Chunk A calls "validate"
        const chunkA = db.prepare(
            `INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run('src/handler.ts', 'function', 'handleRequest', 1, 10, 'code', 'typescript', 'h1');
        const idA = Number(chunkA.lastInsertRowid);

        // Chunk B also calls "validate"
        const chunkB = db.prepare(
            `INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run('src/api.ts', 'function', 'apiHandler', 1, 10, 'code', 'typescript', 'h2');
        const idB = Number(chunkB.lastInsertRowid);

        db.prepare('INSERT INTO code_refs (chunk_id, symbol_name) VALUES (?, ?)').run(idA, 'validate');
        db.prepare('INSERT INTO code_refs (chunk_id, symbol_name) VALUES (?, ?)').run(idB, 'validate');

        // Who calls "validate"?
        const callers = db.prepare(
            `SELECT cc.file_path, cc.name FROM code_refs cr
             JOIN code_chunks cc ON cc.id = cr.chunk_id
             WHERE cr.symbol_name = ?`
        ).all('validate') as any[];

        assert.equal(callers.length, 2);
        assert.includes(callers.map((c: any) => c.name), 'handleRequest');
        assert.includes(callers.map((c: any) => c.name), 'apiHandler');

        db.close();
    },
};
