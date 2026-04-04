/**
 * HttpServer — Lightweight JSON API for BrainBank.
 *
 * Exposes BrainBank operations over HTTP so CLI commands can delegate
 * to a running server instead of cold-loading models each time.
 *
 * Routes:
 *   POST /context  → brain.getContext()
 *   POST /index    → brain.index()
 *   GET  /health   → { ok, pid, uptime, port }
 *
 * Multi-repo: a single server handles all repos via WorkspacePool.
 * Each request includes a `repo` field to select the workspace.
 */

import type { BrainBank } from '@/brainbank.ts';

import * as http from 'node:http';

import { DEFAULT_PORT, writePid, removePid } from './daemon.ts';

// ── Types ─────────────────────────────────────────────

interface ContextRequest {
    task: string;
    repo?: string;
    sources?: Record<string, number>;
    pathPrefix?: string;
    affectedFiles?: string[];
    codeResults?: number;
    gitResults?: number;
    docsResults?: number;
}

interface IndexRequest {
    repo?: string;
    forceReindex?: boolean;
}

interface PoolOptions {
    /** Factory function to create a BrainBank for a repo path. */
    factory: (repoPath: string) => Promise<BrainBank>;
    /** Called when an error occurs. */
    onError?: (repo: string, err: unknown) => void;
}

// ── Simple Workspace Pool ─────────────────────────────

/**
 * Minimal in-memory pool for multi-repo support.
 * Creates BrainBank instances on demand and caches them.
 * Eviction by TTL (30 min inactivity).
 */
class SimplePool {
    private _pool = new Map<string, { brain: BrainBank; lastAccess: number }>();
    private _factory: (repoPath: string) => Promise<BrainBank>;
    private _onError?: (repo: string, err: unknown) => void;
    private _timer: ReturnType<typeof setInterval>;

    private static readonly TTL_MS = 30 * 60 * 1000; // 30 minutes
    private static readonly EVICT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    constructor(options: PoolOptions) {
        this._factory = options.factory;
        this._onError = options.onError;
        this._timer = setInterval(() => this._evictStale(), SimplePool.EVICT_INTERVAL_MS);
        if (this._timer.unref) this._timer.unref();
    }

    async get(repoPath: string): Promise<BrainBank> {
        const key = repoPath.replace(/\/+$/, '');
        const existing = this._pool.get(key);
        if (existing) {
            existing.lastAccess = Date.now();
            try { await existing.brain.ensureFresh(); } catch { /* stale is better than nothing */ }
            return existing.brain;
        }

        const brain = await this._factory(key);
        this._pool.set(key, { brain, lastAccess: Date.now() });
        return brain;
    }

    close(): void {
        clearInterval(this._timer);
        for (const [key, entry] of this._pool) {
            try { entry.brain.close(); } catch (err: unknown) {
                this._onError?.(key, err);
            }
        }
        this._pool.clear();
    }

    get size(): number {
        return this._pool.size;
    }

    private _evictStale(): void {
        const cutoff = Date.now() - SimplePool.TTL_MS;
        for (const [key, entry] of this._pool) {
            if (entry.lastAccess < cutoff) {
                try { entry.brain.close(); } catch (err: unknown) {
                    this._onError?.(key, err);
                }
                this._pool.delete(key);
            }
        }
    }
}

// ── HTTP Server ───────────────────────────────────────

export interface HttpServerOptions {
    port?: number;
    /** Factory to create a BrainBank instance for a given repo path. */
    factory: (repoPath: string) => Promise<BrainBank>;
    /** Default repo path when request doesn't specify one. */
    defaultRepo?: string;
    /** Called when an error occurs during pool operations. */
    onError?: (repo: string, err: unknown) => void;
    /** Called on server lifecycle events. */
    onLog?: (msg: string) => void;
}

export class HttpServer {
    private _server: http.Server | null = null;
    private _pool: SimplePool;
    private _port: number;
    private _defaultRepo: string;
    private _startTime = 0;
    private _log: (msg: string) => void;

    constructor(options: HttpServerOptions) {
        this._port = options.port ?? DEFAULT_PORT;
        this._defaultRepo = options.defaultRepo ?? process.cwd();
        this._log = options.onLog ?? console.log;
        this._pool = new SimplePool({
            factory: options.factory,
            onError: options.onError,
        });
    }

    /** Start listening. Writes PID file for daemon detection. */
    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this._server = http.createServer((req, res) => {
                this._handleRequest(req, res).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    this._log(`Request error: ${msg}`);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Internal server error' }));
                    }
                });
            });

            this._server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${this._port} already in use. Is another server running?`));
                } else {
                    reject(err);
                }
            });

            this._server.listen(this._port, '127.0.0.1', () => {
                this._startTime = Date.now();
                writePid(process.pid, this._port);
                this._log(`BrainBank HTTP server listening on http://localhost:${this._port}`);
                resolve();
            });
        });
    }

    /** Stop the server and clean up. */
    close(): void {
        this._pool.close();
        this._server?.close();
        this._server = null;
        removePid();
    }

    get port(): number {
        return this._port;
    }

    // ── Request Router ──────────────────────────────────

    private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // CORS + content type
        res.setHeader('Content-Type', 'application/json');

        // Health check — no body parsing needed
        if (req.method === 'GET' && req.url === '/health') {
            return this._handleHealth(res);
        }

        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        const body = await this._readBody(req);

        switch (req.url) {
            case '/context':
                return this._handleContext(body, res);
            case '/index':
                return this._handleIndex(body, res);
            default:
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Not found' }));
        }
    }

    // ── Handlers ────────────────────────────────────────

    private _handleHealth(res: http.ServerResponse): void {
        const uptime = Math.round((Date.now() - this._startTime) / 1000);
        res.writeHead(200);
        res.end(JSON.stringify({
            ok: true,
            pid: process.pid,
            port: this._port,
            uptime,
            workspaces: this._pool.size,
        }));
    }

    private async _handleContext(body: unknown, res: http.ServerResponse): Promise<void> {
        const req = body as ContextRequest;
        if (!req.task) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing required field: task' }));
            return;
        }

        const repoPath = req.repo ?? this._defaultRepo;
        const brain = await this._pool.get(repoPath);

        // Build sources from explicit params, then let `sources` override
        const base: Record<string, number> = {
            code: req.codeResults ?? 20,
            git: req.gitResults ?? 5,
        };
        if (req.docsResults !== undefined) base.docs = req.docsResults;
        const resolvedSources = req.sources ? { ...base, ...req.sources } : base;

        const context = await brain.getContext(req.task, {
            affectedFiles: req.affectedFiles,
            sources: resolvedSources,
            pathPrefix: req.pathPrefix,
        });

        res.writeHead(200);
        res.end(JSON.stringify({ context }));
    }

    private async _handleIndex(body: unknown, res: http.ServerResponse): Promise<void> {
        const req = body as IndexRequest;
        const repoPath = req.repo ?? this._defaultRepo;
        const brain = await this._pool.get(repoPath);

        const result = await brain.index({ forceReindex: req.forceReindex });

        res.writeHead(200);
        res.end(JSON.stringify({ result }));
    }

    // ── Helpers ─────────────────────────────────────────

    private _readBody(req: http.IncomingMessage): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('error', reject);
            req.on('end', () => {
                try {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    resolve(raw ? JSON.parse(raw) as unknown : {});
                } catch {
                    resolve({});
                }
            });
        });
    }
}
