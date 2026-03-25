/**
 * BrainBank — Perplexity Standard Embedding Provider
 *
 * Uses Perplexity's embedding API via fetch (no SDK dependency).
 * Models: pplx-embed-v1-0.6b (1024d) and pplx-embed-v1-4b (2560d).
 *
 * Perplexity returns base64-encoded signed int8 vectors by default.
 * This provider decodes them to Float32Array for HNSW compatibility.
 *
 * Usage:
 *   const brain = new BrainBank({
 *     embeddingProvider: new PerplexityEmbedding({ model: 'pplx-embed-v1-4b' }),
 *   });
 */

import type { EmbeddingProvider } from '@/types.ts';

const DEFAULT_MODEL = 'pplx-embed-v1-4b';
const DEFAULT_DIMS: Record<string, number> = {
    'pplx-embed-v1-0.6b': 1024,
    'pplx-embed-v1-4b': 2560,
};
const API_URL = 'https://api.perplexity.ai/v1/embeddings';
const MAX_BATCH = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const BATCH_DELAY_MS = 100;

export interface PerplexityEmbeddingOptions {
    /** Perplexity API key. Falls back to PERPLEXITY_API_KEY env var. */
    apiKey?: string;
    /** Model name. Default: 'pplx-embed-v1-4b' */
    model?: string;
    /** Vector dimensions (Matryoshka reduction). If omitted, uses model default. */
    dims?: number;
    /** Base URL override. */
    baseUrl?: string;
    /** Request timeout in ms. Default: 30000 */
    timeout?: number;
}

export class PerplexityEmbedding implements EmbeddingProvider {
    readonly dims: number;

    private _apiKey: string;
    private _model: string;
    private _baseUrl: string;
    private _requestDims: number | undefined;
    private _timeout: number;

    constructor(options: PerplexityEmbeddingOptions = {}) {
        this._apiKey = options.apiKey ?? process.env.PERPLEXITY_API_KEY ?? '';
        this._model = options.model ?? DEFAULT_MODEL;
        this._baseUrl = options.baseUrl ?? API_URL;
        this._timeout = options.timeout ?? REQUEST_TIMEOUT_MS;

        if (options.dims) {
            this._requestDims = options.dims;
            this.dims = options.dims;
        } else {
            this.dims = DEFAULT_DIMS[this._model] ?? 2560;
        }
    }

    async embed(text: string): Promise<Float32Array> {
        const results = await this._request([text]);
        return results[0];
    }

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        if (texts.length === 0) return [];

        const results: Float32Array[] = [];

        for (let i = 0; i < texts.length; i += MAX_BATCH) {
            if (i > 0) await sleep(BATCH_DELAY_MS);
            const batch = texts.slice(i, i + MAX_BATCH);
            const embeddings = await this._request(batch);
            results.push(...embeddings);
        }

        return results;
    }

    async close(): Promise<void> {
        // No resources to release
    }

    private async _request(input: string[]): Promise<Float32Array[]> {
        if (!this._apiKey) {
            throw new Error(
                'BrainBank: Perplexity API key required. Set PERPLEXITY_API_KEY env var or pass apiKey option.',
            );
        }

        const MAX_CHARS = 24_000;
        const safeInput = input.map(t => t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t);

        const body: Record<string, unknown> = { model: this._model, input: safeInput };
        if (this._requestDims) body.dimensions = this._requestDims;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeout);

        let res: Response;
        try {
            res = await fetch(this._baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._apiKey}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (err: unknown) {
            clearTimeout(timer);
            if (err instanceof Error && err.name === 'AbortError') {
                throw new Error(`BrainBank: Perplexity embedding request timed out after ${this._timeout}ms.`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`BrainBank: Perplexity embedding API error (${res.status}): ${errText}`);
        }

        const json = await res.json() as PerplexityStandardResponse;
        return json.data
            .sort((a, b) => a.index - b.index)
            .map(d => decodeBase64Int8(d.embedding, this.dims));
    }
}

// ── Response Types ──────────────────────────────────

interface PerplexityStandardResponse {
    data: Array<{ index: number; embedding: string }>;
}

// ── Base64 Int8 Decoding ────────────────────────────

/**
 * Decode a base64-encoded signed int8 embedding to Float32Array.
 * Perplexity returns embeddings as base64(int8[]) by default.
 */
export function decodeBase64Int8(b64: string, expectedDims: number): Float32Array {
    const binary = atob(b64);
    const bytes = new Int8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i) << 24 >> 24; // sign-extend to int8
    }

    const dims = Math.min(bytes.length, expectedDims);
    const result = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
        result[i] = bytes[i];
    }
    return result;
}

/** Simple delay helper. */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
