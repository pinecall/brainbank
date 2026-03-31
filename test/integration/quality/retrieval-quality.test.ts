/**
 * BrainBank — Retrieval Quality Gate
 *
 * Self-contained integration test that catches regressions in search quality.
 * Uses hash-based embeddings (no model download) and a synthetic code corpus
 * with golden queries. Measures recall@k and MRR with threshold assertions.
 *
 * Run: npm test -- --integration --filter retrieval
 *
 * Key design: BM25 path is the primary retrieval mechanism since hashEmbedding
 * lacks semantic understanding. Tests validate the FULL hybrid pipeline:
 * chunking → indexing → BM25 + vector search → RRF fusion → scoring.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { BrainBank, code, git, hashEmbedding } from '../../helpers.ts';

export const name = 'Retrieval Quality Gate';

// ── Synthetic Corpus ────────────────────────────────────

const FILES: Record<string, string> = {
    'src/auth/middleware.ts': `
/**
 * Authentication middleware — validates JWT tokens on every request.
 * Extracts user from token payload and attaches to request context.
 */
import { verify } from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

export function authenticate(req: Request, res: Response, next: NextFunction) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ error: 'Missing authentication token' });
    }
    try {
        const payload = verify(token, process.env.JWT_SECRET!);
        req.user = payload;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

export function requireRole(role: string) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.user?.role !== role) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}
`.trim(),

    'src/db/connection-pool.ts': `
/**
 * Database connection pool — manages PostgreSQL connections with
 * automatic retry, health checks, and graceful shutdown.
 */
import { Pool, PoolConfig } from 'pg';

export class ConnectionPool {
    private pool: Pool;
    private healthCheckTimer?: NodeJS.Timeout;

    constructor(config: PoolConfig) {
        this.pool = new Pool({
            ...config,
            max: config.max ?? 10,
            idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
            connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
        });
        this.pool.on('error', (err) => {
            console.error('Pool connection error:', err.message);
        });
    }

    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const client = await this.pool.connect();
        try {
            const result = await client.query(sql, params);
            return result.rows as T[];
        } finally {
            client.release();
        }
    }

    startHealthCheck(intervalMs = 60000) {
        this.healthCheckTimer = setInterval(async () => {
            try {
                await this.pool.query('SELECT 1');
            } catch (err: any) {
                console.error('Health check failed:', err.message);
            }
        }, intervalMs);
    }

    async shutdown(): Promise<void> {
        if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
        await this.pool.end();
    }
}
`.trim(),

    'src/api/rate-limiter.ts': `
/**
 * Rate limiter — sliding window counter using Redis.
 * Limits requests per user/IP with configurable windows.
 */
import { Redis } from 'ioredis';
import type { Request, Response, NextFunction } from 'express';

interface RateLimitConfig {
    windowMs: number;
    maxRequests: number;
    keyPrefix?: string;
}

export function createRateLimiter(redis: Redis, config: RateLimitConfig) {
    const { windowMs, maxRequests, keyPrefix = 'rl:' } = config;

    return async (req: Request, res: Response, next: NextFunction) => {
        const key = keyPrefix + (req.user?.id ?? req.ip);
        const now = Date.now();
        const windowStart = now - windowMs;

        const pipeline = redis.pipeline();
        pipeline.zremrangebyscore(key, 0, windowStart);
        pipeline.zadd(key, now.toString(), \`\${now}:\${Math.random()}\`);
        pipeline.zcard(key);
        pipeline.pexpire(key, windowMs);

        const results = await pipeline.exec();
        const count = (results?.[2]?.[1] as number) ?? 0;

        if (count > maxRequests) {
            res.set('Retry-After', Math.ceil(windowMs / 1000).toString());
            return res.status(429).json({ error: 'Too many requests' });
        }

        res.set('X-RateLimit-Remaining', (maxRequests - count).toString());
        next();
    };
}
`.trim(),

    'src/websocket/event-handler.ts': `
/**
 * WebSocket event handler — manages real-time connections,
 * room-based broadcasting, and presence tracking.
 */
import { WebSocket, WebSocketServer } from 'ws';

interface Client {
    ws: WebSocket;
    userId: string;
    rooms: Set<string>;
}

export class EventHandler {
    private clients = new Map<string, Client>();
    private rooms = new Map<string, Set<string>>();

    constructor(private wss: WebSocketServer) {
        wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    }

    private handleConnection(ws: WebSocket, req: any) {
        const userId = req.headers['x-user-id'] as string;
        if (!userId) { ws.close(4001, 'Missing user ID'); return; }

        const client: Client = { ws, userId, rooms: new Set() };
        this.clients.set(userId, client);

        ws.on('message', (data) => this.handleMessage(client, data.toString()));
        ws.on('close', () => this.handleDisconnect(client));

        this.broadcast('system', { type: 'user_joined', userId });
    }

    private handleMessage(client: Client, raw: string) {
        const msg = JSON.parse(raw);
        switch (msg.type) {
            case 'join_room': this.joinRoom(client, msg.room); break;
            case 'leave_room': this.leaveRoom(client, msg.room); break;
            case 'broadcast': this.broadcastToRoom(msg.room, msg.payload, client.userId); break;
        }
    }

    joinRoom(client: Client, room: string) {
        client.rooms.add(room);
        if (!this.rooms.has(room)) this.rooms.set(room, new Set());
        this.rooms.get(room)!.add(client.userId);
    }

    leaveRoom(client: Client, room: string) {
        client.rooms.delete(room);
        this.rooms.get(room)?.delete(client.userId);
    }

    broadcast(room: string, payload: unknown) {
        const members = this.rooms.get(room);
        if (!members) return;
        const data = JSON.stringify(payload);
        for (const uid of members) {
            this.clients.get(uid)?.ws.send(data);
        }
    }

    broadcastToRoom(room: string, payload: unknown, exclude?: string) {
        const members = this.rooms.get(room);
        if (!members) return;
        const data = JSON.stringify(payload);
        for (const uid of members) {
            if (uid !== exclude) this.clients.get(uid)?.ws.send(data);
        }
    }

    private handleDisconnect(client: Client) {
        for (const room of client.rooms) {
            this.rooms.get(room)?.delete(client.userId);
        }
        this.clients.delete(client.userId);
        this.broadcast('system', { type: 'user_left', userId: client.userId });
    }

    getOnlineUsers(): string[] {
        return [...this.clients.keys()];
    }
}
`.trim(),

    'src/cache/redis-cache.ts': `
/**
 * Redis cache layer — get/set with TTL, cache-aside pattern,
 * batch operations, and cache invalidation by prefix.
 */
import { Redis } from 'ioredis';

export class RedisCache {
    constructor(private redis: Redis, private defaultTtl = 3600) {}

    async get<T>(key: string): Promise<T | null> {
        const raw = await this.redis.get(key);
        return raw ? JSON.parse(raw) as T : null;
    }

    async set(key: string, value: unknown, ttl?: number): Promise<void> {
        const serialized = JSON.stringify(value);
        await this.redis.set(key, serialized, 'EX', ttl ?? this.defaultTtl);
    }

    async getOrSet<T>(key: string, factory: () => Promise<T>, ttl?: number): Promise<T> {
        const cached = await this.get<T>(key);
        if (cached !== null) return cached;
        const value = await factory();
        await this.set(key, value, ttl);
        return value;
    }

    async invalidatePrefix(prefix: string): Promise<number> {
        const keys = await this.redis.keys(prefix + '*');
        if (keys.length === 0) return 0;
        return this.redis.del(...keys);
    }

    async mget<T>(keys: string[]): Promise<(T | null)[]> {
        const values = await this.redis.mget(...keys);
        return values.map(v => v ? JSON.parse(v) as T : null);
    }
}
`.trim(),
};

// ── Golden Queries ──────────────────────────────────────
// Each query has expected file substrings that MUST appear in top-k results.
// Categories help diagnose regressions by area.

interface GoldenQuery {
    query: string;
    expectedFiles: string[];
    category: 'exact' | 'cross-module';
}

const GOLDEN: GoldenQuery[] = [
    // Exact — strong keyword overlap
    {
        query: 'JWT token authentication middleware',
        expectedFiles: ['auth/middleware'],
        category: 'exact',
    },
    {
        query: 'database connection pool PostgreSQL',
        expectedFiles: ['db/connection-pool'],
        category: 'exact',
    },
    {
        query: 'rate limiter Redis sliding window',
        expectedFiles: ['api/rate-limiter'],
        category: 'exact',
    },
    {
        query: 'event handler broadcast rooms connection',
        expectedFiles: ['websocket/event-handler'],
        category: 'exact',
    },
    {
        query: 'Redis cache TTL invalidation',
        expectedFiles: ['cache/redis-cache'],
        category: 'exact',
    },
    // Cross-module — query touches multiple files
    {
        query: 'Redis import ioredis pipeline',
        expectedFiles: ['api/rate-limiter', 'cache/redis-cache'],
        category: 'cross-module',
    },
];

// ── Metrics ─────────────────────────────────────────────

interface MetricResult {
    query: string;
    category: string;
    recall5: number;
    mrr: number;
    hits: string[];
}

function computeRecallAtK(results: { filePath?: string }[], expectedFiles: string[], k: number): number {
    const topK = results.slice(0, k);
    let found = 0;
    for (const expected of expectedFiles) {
        if (topK.some(r => r.filePath?.includes(expected))) found++;
    }
    return found / expectedFiles.length;
}

function computeMRR(results: { filePath?: string }[], expectedFiles: string[]): number {
    for (let i = 0; i < results.length; i++) {
        if (expectedFiles.some(exp => results[i].filePath?.includes(exp))) {
            return 1 / (i + 1);
        }
    }
    return 0;
}

// ── Test Setup & Execution ──────────────────────────────

let tmpDir: string;
let brain: BrainBank;
let metrics: MetricResult[] = [];

async function setupCorpus() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-quality-'));
    const repoDir = path.join(tmpDir, 'repo');

    // Create directory structure + files
    for (const [filePath, content] of Object.entries(FILES)) {
        const absPath = path.join(repoDir, filePath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content);
    }

    // Init git (required by code plugin)
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "bench@test.dev"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Bench"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git add -A && git commit -m "initial corpus"', { cwd: repoDir, stdio: 'pipe' });

    // Create BrainBank with hash embeddings (no model download)
    brain = new BrainBank({
        repoPath: repoDir,
        dbPath: path.join(tmpDir, 'quality.db'),
        embeddingProvider: hashEmbedding(),
    }).use(code({ repoPath: repoDir }));

    await brain.initialize();
    await brain.index({ forceReindex: true });
}

export const tests: Record<string, (assert: any) => Promise<void>> = {};

tests['setup: index synthetic corpus'] = async (assert: any) => {
    await setupCorpus();
    const stats = brain.stats();
    assert.ok((stats.code?.chunks ?? 0) >= 5, `indexed ${stats.code?.chunks ?? 0} chunks`);
};

tests['golden queries: recall@5 and MRR'] = async (assert: any) => {
    metrics = [];

    for (const golden of GOLDEN) {
        const results = await brain.hybridSearch(golden.query, { sources: { code: 10 } });
        const codeResults = results.filter(r => r.type === 'code');

        const recall5 = computeRecallAtK(codeResults, golden.expectedFiles, 5);
        const mrr = computeMRR(codeResults, golden.expectedFiles);
        const hits = codeResults.slice(0, 5).map(r => r.filePath ?? '?');

        metrics.push({ query: golden.query, category: golden.category, recall5, mrr, hits });
    }

    // Print detailed results
    console.log('\n    ── Retrieval Quality Report ──');
    for (const m of metrics) {
        const icon = m.recall5 >= 1.0 ? '✓' : m.recall5 > 0 ? '~' : '✗';
        console.log(`    ${icon} [${m.category}] "${m.query.slice(0, 45)}"`);
        console.log(`      R@5=${m.recall5.toFixed(2)} MRR=${m.mrr.toFixed(2)} → [${m.hits.map(h => path.basename(h, '.ts')).join(', ')}]`);
    }
};

tests['threshold: exact queries recall@5 >= 0.8'] = async (assert: any) => {
    const exact = metrics.filter(m => m.category === 'exact');
    const avgRecall = exact.reduce((s, m) => s + m.recall5, 0) / exact.length;
    assert.gte(avgRecall, 0.8, `exact recall@5 avg=${avgRecall.toFixed(2)} >= 0.8`);
};

tests['threshold: overall MRR >= 0.4'] = async (assert: any) => {
    const avgMrr = metrics.reduce((s, m) => s + m.mrr, 0) / metrics.length;
    assert.gte(avgMrr, 0.4, `overall MRR avg=${avgMrr.toFixed(2)} >= 0.4`);
};

tests['threshold: no exact query with zero recall'] = async (assert: any) => {
    const exact = metrics.filter(m => m.category === 'exact');
    const zeroRecall = exact.filter(m => m.recall5 === 0);
    assert.equal(zeroRecall.length, 0,
        `${zeroRecall.length} exact queries got zero recall: ${zeroRecall.map(m => m.query).join(', ')}`);
};

tests['cleanup'] = async () => {
    brain?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
};
