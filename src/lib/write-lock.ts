/**
 * BrainBank — Write Lock
 *
 * Advisory file lock for cross-process HNSW write exclusion.
 * Uses `O_CREAT | O_EXCL` for atomic lock creation — works on all OS.
 * Stale locks (dead PID) are detected and stolen automatically.
 */

import { openSync, closeSync, unlinkSync, readFileSync, writeFileSync, existsSync, mkdirSync, constants } from 'node:fs';
import { join } from 'node:path';

/** Max wait time before giving up on acquiring a lock (ms). */
const MAX_WAIT_MS = 30_000;

/** Initial retry delay (ms), doubled on each retry. */
const INITIAL_DELAY_MS = 50;

/** Check if a process is alive by sending signal 0. */
function isProcessAlive(pid: number): boolean {
    if (isNaN(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Resolve the lock file path. */
function lockPath(lockDir: string, name: string): string {
    return join(lockDir, `${name}.lock`);
}

/** Try to create the lock file atomically. Returns true on success. */
function tryCreateLock(filePath: string): boolean {
    try {
        const fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        return true;
    } catch {
        return false;
    }
}

/**
 * Acquire an advisory lock. Blocks with exponential backoff if another
 * process holds the lock. Steals stale locks from dead processes.
 *
 * @throws After MAX_WAIT_MS if the lock cannot be acquired.
 */
export async function acquireLock(lockDir: string, name: string): Promise<void> {
    if (!existsSync(lockDir)) {
        mkdirSync(lockDir, { recursive: true });
    }

    const fp = lockPath(lockDir, name);
    let delay = INITIAL_DELAY_MS;
    let elapsed = 0;

    while (true) {
        if (tryCreateLock(fp)) return;

        // Lock exists — check if holder is alive
        try {
            const content = readFileSync(fp, 'utf-8').trim();
            const pid = parseInt(content, 10);
            if (isNaN(pid) || !isProcessAlive(pid)) {
                // Stale lock (dead or invalid PID) — steal it
                try { unlinkSync(fp); } catch { /* race: another process stole it first */ }
                if (tryCreateLock(fp)) return;
            }
        } catch {
            // File gone between check and read — retry
            if (tryCreateLock(fp)) return;
        }

        if (elapsed >= MAX_WAIT_MS) {
            throw new Error(`BrainBank: Could not acquire write lock '${name}' after ${MAX_WAIT_MS}ms. Another process may be indexing.`);
        }

        await new Promise<void>(r => setTimeout(r, delay));
        elapsed += delay;
        delay = Math.min(delay * 2, 2000);
    }
}

/** Release an advisory lock. Safe to call even if not held. */
export function releaseLock(lockDir: string, name: string): void {
    try {
        unlinkSync(lockPath(lockDir, name));
    } catch {
        // Already released or never acquired — safe to ignore
    }
}

/**
 * Execute a function while holding an advisory lock.
 * Lock is always released, even on error.
 */
export async function withLock<T>(lockDir: string, name: string, fn: () => T | Promise<T>): Promise<T> {
    await acquireLock(lockDir, name);
    try {
        return await fn();
    } finally {
        releaseLock(lockDir, name);
    }
}
