/**
 * ServerClient — Lightweight HTTP client for the BrainBank daemon.
 *
 * Used by CLI commands to delegate to a running HTTP server
 * instead of loading models locally. Falls back gracefully
 * (returns null) if the server is unreachable.
 */

import * as http from 'node:http';

import { isServerRunning } from '@/services/daemon.ts';

interface ContextOptions {
    task: string;
    repo?: string;
    sources?: Record<string, number>;
    pathPrefix?: string;
    affectedFiles?: string[];
}

/**
 * Try to get context from the running HTTP server.
 * Returns the context string if successful, null if server is unreachable.
 */
export async function tryServerContext(options: ContextOptions): Promise<string | null> {
    const info = isServerRunning();
    if (!info) return null;

    try {
        const body = JSON.stringify({
            task: options.task,
            repo: options.repo,
            sources: options.sources,
            pathPrefix: options.pathPrefix,
            affectedFiles: options.affectedFiles,
        });

        const response = await httpPost(info.port, '/context', body);
        const data = JSON.parse(response) as { context?: string; error?: string };

        if (data.error) return null;
        return data.context ?? null;
    } catch {
        // Server unreachable or error — fall back to local
        return null;
    }
}

/**
 * Try to trigger indexing on the running HTTP server.
 * Returns the result if successful, null if server is unreachable.
 */
export async function tryServerIndex(repo?: string, forceReindex?: boolean): Promise<Record<string, unknown> | null> {
    const info = isServerRunning();
    if (!info) return null;

    try {
        const body = JSON.stringify({ repo, forceReindex });
        const response = await httpPost(info.port, '/index', body);
        const data = JSON.parse(response) as { result?: Record<string, unknown>; error?: string };

        if (data.error) return null;
        return data.result ?? null;
    } catch {
        return null;
    }
}

/**
 * Check server health. Returns health info or null.
 */
export async function serverHealth(): Promise<{
    ok: boolean;
    pid: number;
    port: number;
    uptime: number;
    workspaces: number;
} | null> {
    const info = isServerRunning();
    if (!info) return null;

    try {
        const response = await httpGet(info.port, '/health');
        return JSON.parse(response) as { ok: boolean; pid: number; port: number; uptime: number; workspaces: number };
    } catch {
        return null;
    }
}

// ── HTTP helpers ────────────────────────────────────

function httpPost(port: number, path: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 120_000, // 2 minutes — context queries can be slow on first load
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.write(body);
        req.end();
    });
}

function httpGet(port: number, path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'GET',
            timeout: 5_000,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.end();
    });
}
