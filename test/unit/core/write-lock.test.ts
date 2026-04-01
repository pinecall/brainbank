/**
 * Unit Tests — Write Lock (Cross-Process File Lock)
 *
 * Tests advisory file locking used for HNSW write exclusion.
 * Covers acquire/release, withLock, stale lock detection,
 * and concurrent lock contention.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireLock, releaseLock, withLock } from '../../../src/lib/write-lock.ts';

export const name = 'Write Lock';

function freshLockDir(): string {
    const dir = `/tmp/brainbank-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanup(dir: string): void {
    try { fs.rmSync(dir, { recursive: true }); } catch {}
}

export const tests = {
    async 'acquireLock creates lock file'(assert: { (c: unknown, msg?: string): void; ok: (v: unknown, msg?: string) => void }) {
        const dir = freshLockDir();
        await acquireLock(dir, 'test');

        const lockFile = path.join(dir, 'test.lock');
        assert.ok(fs.existsSync(lockFile), 'lock file should exist');

        const content = fs.readFileSync(lockFile, 'utf-8').trim();
        assert.ok(content === String(process.pid), 'lock file should contain current PID');

        releaseLock(dir, 'test');
        cleanup(dir);
    },

    async 'releaseLock removes lock file'(assert: { (c: unknown, msg?: string): void; ok: (v: unknown, msg?: string) => void }) {
        const dir = freshLockDir();
        await acquireLock(dir, 'test');
        releaseLock(dir, 'test');

        const lockFile = path.join(dir, 'test.lock');
        assert.ok(!fs.existsSync(lockFile), 'lock file should be removed after release');
        cleanup(dir);
    },

    async 'releaseLock is safe when not held'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const dir = freshLockDir();
        // Should not throw
        releaseLock(dir, 'nonexistent');
        assert.ok(true, 'releaseLock on non-existent lock should not throw');
        cleanup(dir);
    },

    async 'withLock executes function and releases'(assert: { (c: unknown, msg?: string): void; ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const dir = freshLockDir();
        const lockFile = path.join(dir, 'test.lock');

        const result = await withLock(dir, 'test', () => {
            // Lock should be held during execution
            assert.ok(fs.existsSync(lockFile), 'lock should exist during fn execution');
            return 42;
        });

        assert.equal(result, 42, 'withLock should return fn result');
        assert.ok(!fs.existsSync(lockFile), 'lock should be released after fn');
        cleanup(dir);
    },

    async 'withLock releases on exception'(assert: { (c: unknown, msg?: string): void; ok: (v: unknown, msg?: string) => void; includes: (h: unknown, n: unknown, msg?: string) => void }) {
        const dir = freshLockDir();
        const lockFile = path.join(dir, 'test.lock');

        let caught = false;
        try {
            await withLock(dir, 'test', () => {
                throw new Error('intentional test error');
            });
        } catch (err: unknown) {
            caught = true;
            if (err instanceof Error) {
                assert.includes(err.message, 'intentional', 'should propagate original error');
            }
        }

        assert.ok(caught, 'should throw from withLock');
        assert.ok(!fs.existsSync(lockFile), 'lock should be released even on error');
        cleanup(dir);
    },

    async 'withLock handles async function'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const dir = freshLockDir();

        const result = await withLock(dir, 'test', async () => {
            await new Promise<void>(r => setTimeout(r, 50));
            return 'async-result';
        });

        assert.equal(result, 'async-result', 'withLock should handle async functions');
        cleanup(dir);
    },

    async 'stale lock from dead PID is stolen'(assert: { (c: unknown, msg?: string): void; ok: (v: unknown, msg?: string) => void }) {
        const dir = freshLockDir();
        const lockFile = path.join(dir, 'test.lock');

        // Create a lock file with a definitely-dead PID
        fs.writeFileSync(lockFile, '999999999');

        // Should steal the stale lock
        const start = Date.now();
        await acquireLock(dir, 'test');
        const elapsed = Date.now() - start;

        assert.ok(elapsed < 1000, `should steal stale lock quickly (took ${elapsed}ms)`);

        const content = fs.readFileSync(lockFile, 'utf-8').trim();
        assert.ok(content === String(process.pid), 'lock should now contain our PID');

        releaseLock(dir, 'test');
        cleanup(dir);
    },

    async 'acquireLock creates parent directory'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const dir = `/tmp/brainbank-lock-nested-${Date.now()}/sub/dir`;

        await acquireLock(dir, 'test');
        assert.ok(fs.existsSync(dir), 'should create nested directory');

        releaseLock(dir, 'test');
        try { fs.rmSync(`/tmp/brainbank-lock-nested-${Date.now()}`, { recursive: true }); } catch {}
        cleanup(dir);
    },

    async 'multiple named locks are independent'(assert: { (c: unknown, msg?: string): void; ok: (v: unknown, msg?: string) => void }) {
        const dir = freshLockDir();

        await acquireLock(dir, 'lock-a');
        await acquireLock(dir, 'lock-b');

        assert.ok(fs.existsSync(path.join(dir, 'lock-a.lock')), 'lock-a should exist');
        assert.ok(fs.existsSync(path.join(dir, 'lock-b.lock')), 'lock-b should exist');

        releaseLock(dir, 'lock-a');
        assert.ok(!fs.existsSync(path.join(dir, 'lock-a.lock')), 'lock-a should be released');
        assert.ok(fs.existsSync(path.join(dir, 'lock-b.lock')), 'lock-b should still exist');

        releaseLock(dir, 'lock-b');
        cleanup(dir);
    },

    async 'lock file with invalid PID is treated as stale'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const dir = freshLockDir();
        const lockFile = path.join(dir, 'test.lock');

        // Write invalid content
        fs.writeFileSync(lockFile, 'not-a-pid');

        await acquireLock(dir, 'test');
        assert.ok(true, 'should acquire lock despite invalid PID content');

        releaseLock(dir, 'test');
        cleanup(dir);
    },

    async 'withLock serializes concurrent calls'(assert: { (c: unknown, msg?: string): void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const dir = freshLockDir();
        const order: number[] = [];

        // Two concurrent withLock calls — they should serialize
        const p1 = withLock(dir, 'serial', async () => {
            order.push(1);
            await new Promise<void>(r => setTimeout(r, 100));
            order.push(2);
            return 'first';
        });

        // Small delay to ensure p1 acquires first
        await new Promise<void>(r => setTimeout(r, 10));

        const p2 = withLock(dir, 'serial', async () => {
            order.push(3);
            return 'second';
        });

        const [r1, r2] = await Promise.all([p1, p2]);

        assert.equal(r1, 'first');
        assert.equal(r2, 'second');
        // p1 should complete (1,2) before p2 starts (3)
        assert.equal(order[0], 1, 'first lock should start first');
        assert.equal(order[1], 2, 'first lock should complete before second starts');
        assert.equal(order[2], 3, 'second lock should start after first completes');

        cleanup(dir);
    },
};
