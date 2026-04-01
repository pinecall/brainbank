/**
 * BrainBank — Webhook Server
 *
 * Optional shared HTTP server for push-based watch plugins (e.g. Jira, GitHub).
 * Opt-in: only created when `new BrainBank({ webhookPort: 4242 })` is configured.
 *
 * Plugins register routes during `watch()`:
 *   ctx.webhookServer?.register('jira', '/jira/webhook', handler);
 *
 * Each plugin gets its own path namespace. Unregistering cleans up the route.
 */

import * as http from 'node:http';


/** Handler for incoming webhook payloads. */
export type WebhookHandler = (body: unknown) => void;

interface Route {
    pluginName: string;
    path: string;
    handler: WebhookHandler;
}


/** Shared HTTP server for push-based watch plugins. */
export class WebhookServer {
    private _server: http.Server | null = null;
    private _routes: Route[] = [];
    private _listening = false;

    /** Start listening on the specified port. */
    listen(port: number): void {
        if (this._listening) return;

        this._server = http.createServer((req, res) => {
            this._handleRequest(req, res);
        });

        this._server.listen(port);
        this._listening = true;
    }

    /** Register a webhook route for a plugin. */
    register(pluginName: string, path: string, handler: WebhookHandler): void {
        // Normalize path to start with /
        const normalizedPath = path.startsWith('/') ? path : `/${path}`;
        this._routes.push({ pluginName, path: normalizedPath, handler });
    }

    /** Remove all routes for a plugin. */
    unregister(pluginName: string): void {
        this._routes = this._routes.filter(r => r.pluginName !== pluginName);
    }

    /** Stop the server and clear all routes. */
    close(): void {
        this._server?.close();
        this._server = null;
        this._routes = [];
        this._listening = false;
    }

    /** Whether the server is currently listening. */
    get active(): boolean {
        return this._listening;
    }

    /** Route incoming POST requests to the matching handler. */
    private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        const route = this._routes.find(r => req.url === r.path);
        if (!route) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                const body = raw ? JSON.parse(raw) as unknown : {};
                route.handler(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch {
                // Malformed JSON — still acknowledge receipt
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    }
}
