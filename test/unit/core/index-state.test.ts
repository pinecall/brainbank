/**
 * Unit Tests — Index State (Cross-Process Version Tracking)
 *
 * Tests the index_state table and helper functions used
 * for multi-process HNSW staleness detection.
 */

import * as fs from 'node:fs';
import { SQLiteAdapter } from '../../../src/db/sqlite-adapter.ts';
import type { DatabaseAdapter } from '../../../src/db/adapter.ts';
import { bumpVersion, getVersions, getVersion } from '../../../src/db/metadata.ts';

export const name = 'Index State';

function freshDb(): DatabaseAdapter {
    const path = `/tmp/brainbank-index-state-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    return new SQLiteAdapter(path);
}

function cleanup(db: DatabaseAdapter): void {
    const path = (db.raw<{ name: string }>() as { name: string }).name;
    db.close();
    try { fs.unlinkSync(path); } catch {}
    try { fs.unlinkSync(path + '-wal'); } catch {}
    try { fs.unlinkSync(path + '-shm'); } catch {}
}

export const tests = {
    'index_state table exists in schema'(assert: (condition: unknown, msg?: string) => void) {
        const db = freshDb();
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='index_state'"
        ).all() as { name: string }[];
        assert(tables.length === 1, 'index_state table should exist');
        cleanup(db);
    },

    'bumpVersion creates row on first call'(assert: { (c: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const db = freshDb();
        const v = bumpVersion(db, 'code');
        assert.equal(v, 1, 'first bump should return version 1');

        const row = db.prepare('SELECT * FROM index_state WHERE name = ?').get('code') as { name: string; version: number; writer_pid: number };
        assert.equal(row.version, 1, 'DB should have version 1');
        assert.equal(row.writer_pid, process.pid, 'writer_pid should match current process');
        cleanup(db);
    },

    'bumpVersion increments monotonically'(assert: { (c: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const db = freshDb();
        const v1 = bumpVersion(db, 'code');
        const v2 = bumpVersion(db, 'code');
        const v3 = bumpVersion(db, 'code');
        assert.equal(v1, 1);
        assert.equal(v2, 2);
        assert.equal(v3, 3);
        cleanup(db);
    },

    'bumpVersion is scoped per index name'(assert: { (c: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const db = freshDb();
        bumpVersion(db, 'code');
        bumpVersion(db, 'code');
        bumpVersion(db, 'git');

        assert.equal(getVersion(db, 'code'), 2);
        assert.equal(getVersion(db, 'git'), 1);
        assert.equal(getVersion(db, 'docs'), 0, 'non-existent returns 0');
        cleanup(db);
    },

    'getVersions returns all versions as Map'(assert: { (c: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const db = freshDb();
        bumpVersion(db, 'code');
        bumpVersion(db, 'code');
        bumpVersion(db, 'git');
        bumpVersion(db, 'kv');

        const versions = getVersions(db);
        assert.equal(versions.size, 3, 'should have 3 entries');
        assert.equal(versions.get('code'), 2);
        assert.equal(versions.get('git'), 1);
        assert.equal(versions.get('kv'), 1);
        cleanup(db);
    },

    'getVersions returns empty Map for fresh DB'(assert: { (c: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const db = freshDb();
        const versions = getVersions(db);
        assert.equal(versions.size, 0);
        cleanup(db);
    },

    'getVersion returns 0 for unknown name'(assert: { (c: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const db = freshDb();
        assert.equal(getVersion(db, 'nonexistent'), 0);
        cleanup(db);
    },

    'bumpVersion updates timestamp'(assert: { (c: unknown, msg?: string): void; ok: (v: unknown, msg?: string) => void }) {
        const db = freshDb();
        bumpVersion(db, 'code');
        const row1 = db.prepare('SELECT updated_at FROM index_state WHERE name = ?').get('code') as { updated_at: number };

        // Small delay to ensure different timestamp
        const start = Date.now();
        while (Date.now() - start < 1100) { /* spin */ }

        bumpVersion(db, 'code');
        const row2 = db.prepare('SELECT updated_at FROM index_state WHERE name = ?').get('code') as { updated_at: number };

        assert.ok(row2.updated_at >= row1.updated_at, 'updated_at should increase');
        cleanup(db);
    },

    'concurrent bumps from same process produce sequential versions'(assert: { (c: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const db = freshDb();
        const results: number[] = [];
        for (let i = 0; i < 100; i++) {
            results.push(bumpVersion(db, 'stress'));
        }
        assert.equal(results[0], 1);
        assert.equal(results[99], 100);
        // Verify monotonicity
        for (let i = 1; i < results.length; i++) {
            assert(results[i] === results[i - 1] + 1, `version ${results[i]} should follow ${results[i - 1]}`);
        }
        cleanup(db);
    },
};
