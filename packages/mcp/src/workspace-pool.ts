/**
 * WorkspacePool — BrainBank instance lifecycle manager.
 *
 * Manages cached BrainBank instances per workspace with:
 * - Memory-pressure eviction (oldest idle first)
 * - TTL eviction for inactive workspaces
 * - Active-operation tracking (prevents mid-query eviction)
 * - Hot-reload of stale HNSW indices
 */

import type { BrainBank } from 'brainbank';

/** Pool configuration. */
export interface PoolOptions {
    /** Max total estimated memory in MB. Default: 2048. */
    maxMemoryMB?: number;
    /** Minutes of inactivity before eviction. Default: 30. */
    ttlMinutes?: number;
    /** Factory function to create a BrainBank for a repo path. */
    factory: (repoPath: string) => Promise<BrainBank>;
    /** Called when a workspace is evicted. */
    onEvict?: (repoPath: string) => void;
    /** Called when an error occurs during pool operations. */
    onError?: (repoPath: string, err: unknown) => void;
}

/** Internal pool entry. */
interface PoolEntry {
    brain: BrainBank;
    repoPath: string;
    lastAccess: number;
    createdAt: number;
    activeOps: number;
}

/** Public pool statistics. */
export interface PoolStats {
    size: number;
    totalMemoryMB: number;
    entries: PoolEntryStats[];
}

/** Per-entry statistics. */
export interface PoolEntryStats {
    repoPath: string;
    lastAccessAgo: string;
    memoryMB: number;
    activeOps: number;
}

const DEFAULT_MAX_MEMORY_MB = 2048;
const DEFAULT_TTL_MINUTES = 30;
const EVICTION_INTERVAL_MS = 60_000;

/** Format milliseconds as a human-readable "ago" string. */
function formatAgo(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3_600_000)}h ago`;
}

export class WorkspacePool {
    private _pool = new Map<string, PoolEntry>();
    private _timer: ReturnType<typeof setInterval> | null = null;
    private _maxMemoryBytes: number;
    private _ttlMs: number;
    private _factory: (repoPath: string) => Promise<BrainBank>;
    private _onEvict?: (repoPath: string) => void;
    private _onError?: (repoPath: string, err: unknown) => void;

    constructor(options: PoolOptions) {
        this._maxMemoryBytes = (options.maxMemoryMB ?? DEFAULT_MAX_MEMORY_MB) * 1024 * 1024;
        this._ttlMs = (options.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60 * 1000;
        this._factory = options.factory;
        this._onEvict = options.onEvict;
        this._onError = options.onError;

        this._timer = setInterval(() => this._evictStale(), EVICTION_INTERVAL_MS);
        // Don't hold the process open for the timer
        if (this._timer.unref) this._timer.unref();
    }

    /** Number of cached workspaces. */
    get size(): number {
        return this._pool.size;
    }

    /**
     * Get a BrainBank for the given repo path.
     * Returns a cached instance (with hot-reload) or creates a new one.
     */
    async get(repoPath: string): Promise<BrainBank> {
        const key = repoPath.replace(/\/+$/, '');

        const existing = this._pool.get(key);
        if (existing) {
            existing.lastAccess = Date.now();
            try { await existing.brain.ensureFresh(); } catch { /* stale is better than nothing */ }
            return existing.brain;
        }

        this._evictByMemoryPressure();

        const brain = await this._factory(key);
        this._pool.set(key, {
            brain,
            repoPath: key,
            lastAccess: Date.now(),
            createdAt: Date.now(),
            activeOps: 0,
        });

        return brain;
    }

    /**
     * Execute an operation with active-op tracking.
     * Prevents the workspace from being evicted while the operation runs.
     */
    async withBrain<T>(repoPath: string, fn: (brain: BrainBank) => Promise<T>): Promise<T> {
        const brain = await this.get(repoPath);
        const key = repoPath.replace(/\/+$/, '');
        const entry = this._pool.get(key);
        if (entry) entry.activeOps++;

        try {
            return await fn(brain);
        } finally {
            if (entry) {
                entry.activeOps--;
                entry.lastAccess = Date.now();
            }
        }
    }

    /** Manually evict a specific workspace. */
    evict(repoPath: string): void {
        const key = repoPath.replace(/\/+$/, '');
        this._evictEntry(key);
    }

    /** Get pool statistics. */
    stats(): PoolStats {
        const now = Date.now();
        let totalMemory = 0;
        const entries: PoolEntryStats[] = [];

        for (const entry of this._pool.values()) {
            const memBytes = entry.brain.memoryHint();
            const memMB = Math.round(memBytes / 1024 / 1024 * 100) / 100;
            totalMemory += memBytes;

            entries.push({
                repoPath: entry.repoPath,
                lastAccessAgo: formatAgo(now - entry.lastAccess),
                memoryMB: memMB,
                activeOps: entry.activeOps,
            });
        }

        return {
            size: this._pool.size,
            totalMemoryMB: Math.round(totalMemory / 1024 / 1024 * 100) / 100,
            entries,
        };
    }

    /** Close all entries and stop the eviction timer. */
    close(): void {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        for (const key of [...this._pool.keys()]) {
            this._evictEntry(key);
        }
    }

    /** Evict workspaces that haven't been accessed within the TTL. */
    private _evictStale(): void {
        const cutoff = Date.now() - this._ttlMs;
        for (const [key, entry] of this._pool) {
            if (entry.lastAccess < cutoff && entry.activeOps === 0) {
                this._evictEntry(key);
            }
        }
    }

    /** Evict oldest idle entries until total memory is under the limit. */
    private _evictByMemoryPressure(): void {
        let totalMemory = 0;
        for (const entry of this._pool.values()) {
            totalMemory += entry.brain.memoryHint();
        }

        if (totalMemory < this._maxMemoryBytes) return;

        // Sort by lastAccess ascending (oldest first), filter idle
        const candidates = [...this._pool.entries()]
            .filter(([, e]) => e.activeOps === 0)
            .sort(([, a], [, b]) => a.lastAccess - b.lastAccess);

        for (const [key, entry] of candidates) {
            if (totalMemory < this._maxMemoryBytes) break;
            totalMemory -= entry.brain.memoryHint();
            this._evictEntry(key);
        }
    }

    /** Evict a single entry by key. */
    private _evictEntry(key: string): void {
        const entry = this._pool.get(key);
        if (!entry) return;

        try {
            entry.brain.close();
        } catch (err: unknown) {
            this._onError?.(key, err);
        }

        this._pool.delete(key);
        this._onEvict?.(key);
    }
}
