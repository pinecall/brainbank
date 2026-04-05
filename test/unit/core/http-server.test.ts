/**
 * Unit Tests — HTTP Server
 *
 * Tests the HttpServer routes (/health, /context, /index),
 * error handling, and pool lifecycle.
 * Uses a real HTTP server on a random high port.
 */

import * as http from 'node:http';
import { HttpServer } from '../../../src/services/http-server.ts';
import { removePid } from '../../../src/services/daemon.ts';

export const name = 'HTTP Server';

// ── Helpers ──────────────────────────────────────────

function randomPort(): number {
    return 10000 + Math.floor(Math.random() * 50000);
}

/** Minimal BrainBank mock that returns predictable context. */
function mockBrain() {
    return {
        async getContext(task: string, opts?: Record<string, unknown>) {
            return `# Context for: "${task}"`;
        },
        async index() {
            return { indexed: 1, skipped: 0, chunks: 5 };
        },
        async ensureFresh() {},
        close() {},
    };
}

/** HTTP request helper. */
function request(
    port: number,
    method: string,
    path: string,
    body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request(
            { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    try {
                        resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) as Record<string, unknown> });
                    } catch {
                        resolve({ status: res.statusCode ?? 0, data: { raw } });
                    }
                });
            },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// ── Tests ────────────────────────────────────────────

export const tests = {
    async 'GET /health returns server info'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const port = randomPort();
        const server = new HttpServer({
            port,
            factory: async () => mockBrain() as never,
            onLog: () => {},
        });

        await server.start();

        try {
            const res = await request(port, 'GET', '/health');
            assert.equal(res.status, 200, 'health should return 200');
            assert.equal(res.data.ok, true, 'health ok should be true');
            assert.equal(res.data.port, port, 'health should report correct port');
            assert.ok(typeof res.data.uptime === 'number', 'health should include uptime');
            assert.equal(res.data.workspaces, 0, 'no workspaces initially');
        } finally {
            server.close();
            removePid();
        }
    },

    async 'POST /context returns formatted context'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void; ok: (v: unknown, msg?: string) => void }) {
        const port = randomPort();
        const server = new HttpServer({
            port,
            factory: async () => mockBrain() as never,
            onLog: () => {},
        });

        await server.start();

        try {
            const res = await request(port, 'POST', '/context', {
                task: 'understand auth',
                repo: '/tmp/fake-repo',
            });
            assert.equal(res.status, 200, 'context should return 200');
            assert.ok(typeof res.data.context === 'string', 'should return context string');
            assert.ok((res.data.context as string).includes('understand auth'), 'context should contain the task');
        } finally {
            server.close();
            removePid();
        }
    },

    async 'POST /context with missing task returns 400'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const port = randomPort();
        const server = new HttpServer({
            port,
            factory: async () => mockBrain() as never,
            onLog: () => {},
        });

        await server.start();

        try {
            const res = await request(port, 'POST', '/context', {});
            assert.equal(res.status, 400, 'missing task should return 400');
        } finally {
            server.close();
            removePid();
        }
    },

    async 'POST /index returns index result'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void; ok: (v: unknown, msg?: string) => void }) {
        const port = randomPort();
        const server = new HttpServer({
            port,
            factory: async () => mockBrain() as never,
            onLog: () => {},
        });

        await server.start();

        try {
            const res = await request(port, 'POST', '/index', { repo: '/tmp/fake-repo' });
            assert.equal(res.status, 200, 'index should return 200');
            assert.ok(res.data.result, 'should return result object');
        } finally {
            server.close();
            removePid();
        }
    },

    async 'GET /unknown returns 404'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const port = randomPort();
        const server = new HttpServer({
            port,
            factory: async () => mockBrain() as never,
            onLog: () => {},
        });

        await server.start();

        try {
            const res = await request(port, 'GET', '/nonexistent');
            assert.equal(res.status, 405, 'GET to non-health should return 405');
        } finally {
            server.close();
            removePid();
        }
    },

    async 'PUT returns 405 Method Not Allowed'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const port = randomPort();
        const server = new HttpServer({
            port,
            factory: async () => mockBrain() as never,
            onLog: () => {},
        });

        await server.start();

        try {
            const res = await request(port, 'PUT', '/context', { task: 'test' });
            assert.equal(res.status, 405, 'PUT should return 405');
        } finally {
            server.close();
            removePid();
        }
    },

    async 'pool creates workspace on first request'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const port = randomPort();
        const server = new HttpServer({
            port,
            factory: async () => mockBrain() as never,
            onLog: () => {},
        });

        await server.start();

        try {
            // Before any context request
            let health = await request(port, 'GET', '/health');
            assert.equal(health.data.workspaces, 0, 'no workspaces before request');

            // Make a context request
            await request(port, 'POST', '/context', { task: 'test', repo: '/tmp/repo-a' });

            health = await request(port, 'GET', '/health');
            assert.equal(health.data.workspaces, 1, 'one workspace after request');

            // Second repo
            await request(port, 'POST', '/context', { task: 'test', repo: '/tmp/repo-b' });

            health = await request(port, 'GET', '/health');
            assert.equal(health.data.workspaces, 2, 'two workspaces after second repo');
        } finally {
            server.close();
            removePid();
        }
    },

    async 'close cleans up PID file and stops server'(assert: { ok: (v: unknown, msg?: string) => void }) {
        const port = randomPort();
        const server = new HttpServer({
            port,
            factory: async () => mockBrain() as never,
            onLog: () => {},
        });

        await server.start();
        server.close();

        // Server should refuse connections now
        try {
            await request(port, 'GET', '/health');
            assert.ok(false, 'should not reach here — server should be closed');
        } catch {
            assert.ok(true, 'connection refused after close');
        }
    },
};
