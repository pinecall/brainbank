/**
 * Unit tests for IncrementalTracker.
 */

import { SQLiteAdapter } from '../../../src/db/sqlite-adapter.ts';
import { createTracker } from '../../../src/db/tracker.ts';
import * as fs from 'node:fs';

export const name = 'Incremental Tracker';

function freshDb(): SQLiteAdapter {
    const p = `/tmp/brainbank-tracker-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    return new SQLiteAdapter(p);
}

function cleanup(db: SQLiteAdapter): void {
    const p = (db.raw<{ name: string }>() as { name: string }).name;
    db.close();
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + '-wal'); } catch {}
    try { fs.unlinkSync(p + '-shm'); } catch {}
}

function assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(`AssertionError: ${msg}`);
}

export const tests = {
    'isUnchanged returns false for unknown key': () => {
        const db = freshDb();
        const tracker = createTracker(db, 'test-plugin');
        assert(tracker.isUnchanged('file.ts', 'abc123') === false, 'should be false for unknown key');
        cleanup(db);
    },

    'markIndexed then isUnchanged returns true for same hash': () => {
        const db = freshDb();
        const tracker = createTracker(db, 'test-plugin');
        tracker.markIndexed('file.ts', 'abc123');
        assert(tracker.isUnchanged('file.ts', 'abc123') === true, 'should match after markIndexed');
        cleanup(db);
    },

    'isUnchanged returns false for different hash': () => {
        const db = freshDb();
        const tracker = createTracker(db, 'test-plugin');
        tracker.markIndexed('file.ts', 'abc123');
        assert(tracker.isUnchanged('file.ts', 'def456') === false, 'different hash should not match');
        cleanup(db);
    },

    'markIndexed updates existing entry': () => {
        const db = freshDb();
        const tracker = createTracker(db, 'test-plugin');
        tracker.markIndexed('file.ts', 'v1');
        tracker.markIndexed('file.ts', 'v2');
        assert(tracker.isUnchanged('file.ts', 'v1') === false, 'v1 should be stale');
        assert(tracker.isUnchanged('file.ts', 'v2') === true, 'v2 should match');
        cleanup(db);
    },

    'findOrphans detects removed keys': () => {
        const db = freshDb();
        const tracker = createTracker(db, 'test-plugin');
        tracker.markIndexed('a.ts', 'h1');
        tracker.markIndexed('b.ts', 'h2');
        tracker.markIndexed('c.ts', 'h3');
        const orphans = tracker.findOrphans(new Set(['a.ts', 'c.ts']));
        assert(orphans.length === 1, `expected 1 orphan, got ${orphans.length}`);
        assert(orphans[0] === 'b.ts', `expected b.ts, got ${orphans[0]}`);
        cleanup(db);
    },

    'findOrphans returns empty when all keys match': () => {
        const db = freshDb();
        const tracker = createTracker(db, 'test-plugin');
        tracker.markIndexed('a.ts', 'h1');
        assert(tracker.findOrphans(new Set(['a.ts'])).length === 0, 'should have no orphans');
        cleanup(db);
    },

    'remove deletes tracking entry': () => {
        const db = freshDb();
        const tracker = createTracker(db, 'test-plugin');
        tracker.markIndexed('file.ts', 'abc');
        tracker.remove('file.ts');
        assert(tracker.isUnchanged('file.ts', 'abc') === false, 'should be gone after remove');
        cleanup(db);
    },

    'clear removes all entries for plugin': () => {
        const db = freshDb();
        const tracker = createTracker(db, 'test-plugin');
        tracker.markIndexed('a.ts', 'h1');
        tracker.markIndexed('b.ts', 'h2');
        tracker.clear();
        assert(tracker.isUnchanged('a.ts', 'h1') === false, 'a.ts should be gone');
        assert(tracker.isUnchanged('b.ts', 'h2') === false, 'b.ts should be gone');
        cleanup(db);
    },

    'plugins are isolated — different names see different data': () => {
        const db = freshDb();
        const t1 = createTracker(db, 'plugin-a');
        const t2 = createTracker(db, 'plugin-b');
        t1.markIndexed('file.ts', 'hash-a');
        assert(t1.isUnchanged('file.ts', 'hash-a') === true, 'plugin-a should see it');
        assert(t2.isUnchanged('file.ts', 'hash-a') === false, 'plugin-b should NOT see it');
        cleanup(db);
    },

    'clear only affects own plugin': () => {
        const db = freshDb();
        const t1 = createTracker(db, 'plugin-a');
        const t2 = createTracker(db, 'plugin-b');
        t1.markIndexed('file.ts', 'h1');
        t2.markIndexed('file.ts', 'h2');
        t1.clear();
        assert(t1.isUnchanged('file.ts', 'h1') === false, 'plugin-a should be cleared');
        assert(t2.isUnchanged('file.ts', 'h2') === true, 'plugin-b should be intact');
        cleanup(db);
    },
};
