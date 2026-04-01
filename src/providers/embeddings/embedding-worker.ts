/**
 * BrainBank — Embedding Worker Proxy
 *
 * Drop-in replacement for any EmbeddingProvider that offloads
 * embedding computation to a dedicated worker thread.
 * The main thread's event loop stays free for serving searches.
 *
 * Usage:
 *   const proxy = new EmbeddingWorkerProxy('local', { model: '...' });
 *   await proxy.ready();
 *   const vec = await proxy.embed('hello');
 */

import type { EmbeddingProvider } from '@/types.ts';

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/** Message sent to the worker. */
interface WorkerRequest {
    id: number;
    type: 'embed' | 'embedBatch' | 'close';
    text?: string;
    texts?: string[];
}

/** Message received from the worker. */
interface WorkerResponse {
    id: number;
    type: 'result' | 'error';
    vector?: ArrayBuffer;
    vectors?: ArrayBuffer[];
    dims?: number;
    error?: string;
}

export class EmbeddingWorkerProxy implements EmbeddingProvider {
    private _worker: Worker;
    private _nextId = 1;
    private _pending = new Map<number, { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void }>();
    private _ready: Promise<void>;
    private _dims = 0;

    /** Embedding dimensions (available after `ready()` resolves). */
    get dims(): number { return this._dims; }

    constructor(
        providerType: string,
        providerOptions: Record<string, unknown> = {},
    ) {
        const workerPath = join(
            dirname(fileURLToPath(import.meta.url)),
            'embedding-worker-thread.ts',
        );

        this._worker = new Worker(workerPath, {
            workerData: { providerType, providerOptions },
            execArgv: ['--import', 'tsx'],
        });

        this._worker.on('message', (msg: WorkerResponse) => {
            // Initial ready signal (id === 0)
            if (msg.id === 0 && msg.dims) {
                this._dims = msg.dims;
                return;
            }

            const pending = this._pending.get(msg.id);
            if (!pending) return;
            this._pending.delete(msg.id);

            if (msg.type === 'error') {
                pending.reject(new Error(`BrainBank: Embedding worker error: ${msg.error}`));
            } else {
                pending.resolve(msg);
            }
        });

        this._worker.on('error', (err: Error) => {
            for (const pending of this._pending.values()) {
                pending.reject(err);
            }
            this._pending.clear();
        });

        // Wait for the worker to signal ready
        this._ready = new Promise<void>((resolve, reject) => {
            const onMsg = (msg: WorkerResponse) => {
                if (msg.id === 0 && msg.dims) {
                    this._dims = msg.dims;
                    this._worker.removeListener('message', onMsg);
                    resolve();
                }
            };
            this._worker.on('message', onMsg);
            this._worker.on('error', reject);
        });
    }

    /** Wait for the worker to be ready (provider loaded). */
    async ready(): Promise<void> {
        return this._ready;
    }

    /** Send a request to the worker and wait for the response. */
    private _send(req: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
        const id = this._nextId++;
        return new Promise<WorkerResponse>((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            this._worker.postMessage({ ...req, id } satisfies WorkerRequest);
        });
    }

    /** Embed a single text string. */
    async embed(text: string): Promise<Float32Array> {
        await this._ready;
        const resp = await this._send({ type: 'embed', text });
        if (!resp.vector) throw new Error('BrainBank: Worker returned no vector.');
        return new Float32Array(resp.vector);
    }

    /** Embed multiple texts in a batch. */
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        if (texts.length === 0) return [];
        await this._ready;
        const resp = await this._send({ type: 'embedBatch', texts });
        if (!resp.vectors) throw new Error('BrainBank: Worker returned no vectors.');
        return resp.vectors.map(buf => new Float32Array(buf));
    }

    /** Terminate the worker. */
    async close(): Promise<void> {
        try {
            await this._send({ type: 'close' });
        } catch {
            // Worker may already be terminated
        }
        await this._worker.terminate();
    }
}
