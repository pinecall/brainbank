/**
 * BrainBank — Embedding Worker Thread
 *
 * Worker script that runs the embedding provider in a dedicated thread.
 * Receives text from the main thread, returns Float32Array vectors.
 * Keeps the main thread's event loop free for serving search requests.
 */

import { parentPort, workerData } from 'node:worker_threads';

/** Message types for main ↔ worker communication. */
interface EmbedRequest {
    id: number;
    type: 'embed' | 'embedBatch' | 'close';
    text?: string;
    texts?: string[];
}

interface EmbedResponse {
    id: number;
    type: 'result' | 'error';
    vector?: ArrayBuffer;
    vectors?: ArrayBuffer[];
    dims?: number;
    error?: string;
}

/** Minimal interface for the provider loaded in the worker. */
interface WorkerProvider {
    dims: number;
    embed(text: string): Promise<Float32Array>;
    embedBatch(texts: string[]): Promise<Float32Array[]>;
    close(): Promise<void>;
}

async function main(): Promise<void> {
    if (!parentPort) throw new Error('Must run as worker thread');

    const config = workerData as { providerType: string; providerOptions: Record<string, unknown> };
    let provider: WorkerProvider;

    // Dynamically instantiate the provider based on type
    if (config.providerType === 'local') {
        const { LocalEmbedding } = await import('./local-embedding.ts') as { LocalEmbedding: new (opts?: Record<string, unknown>) => WorkerProvider };
        provider = new LocalEmbedding(config.providerOptions);
    } else if (config.providerType === 'openai') {
        const { OpenAIEmbedding } = await import('./openai-embedding.ts') as { OpenAIEmbedding: new (opts?: Record<string, unknown>) => WorkerProvider };
        provider = new OpenAIEmbedding(config.providerOptions);
    } else {
        throw new Error(`BrainBank: Unknown embedding provider type '${config.providerType}' in worker.`);
    }

    parentPort.on('message', async (msg: EmbedRequest) => {
        if (msg.type === 'close') {
            await provider.close();
            parentPort!.postMessage({ id: msg.id, type: 'result' } satisfies EmbedResponse);
            process.exit(0);
        }

        try {
            if (msg.type === 'embed' && msg.text) {
                const vec = await provider.embed(msg.text);
                const buffer = vec.buffer as ArrayBuffer;
                parentPort!.postMessage(
                    { id: msg.id, type: 'result', vector: buffer, dims: provider.dims } satisfies EmbedResponse,
                    [buffer],
                );
            } else if (msg.type === 'embedBatch' && msg.texts) {
                const vecs = await provider.embedBatch(msg.texts);
                const buffers = vecs.map(v => v.buffer as ArrayBuffer);
                parentPort!.postMessage(
                    {
                        id: msg.id,
                        type: 'result',
                        vectors: buffers,
                        dims: provider.dims,
                    } satisfies EmbedResponse,
                    buffers,
                );
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            parentPort!.postMessage({ id: msg.id, type: 'error', error: message } satisfies EmbedResponse);
        }
    });

    // Signal ready
    parentPort.postMessage({ id: 0, type: 'result', dims: provider.dims } satisfies EmbedResponse);
}

main().catch(err => {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ id: -1, type: 'error', error: message });
    process.exit(1);
});
