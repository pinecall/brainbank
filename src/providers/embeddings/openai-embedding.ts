/**
 * BrainBank — OpenAI Embedding Provider
 * 
 * Uses OpenAI's embedding API via fetch (no SDK dependency).
 * Supports text-embedding-3-small, text-embedding-3-large, and ada-002.
 * 
 * Usage:
 *   const brain = new BrainBank({
 *     embeddingProvider: new OpenAIEmbedding({ model: 'text-embedding-3-small' }),
 *   });
 */

import type { EmbeddingProvider } from '@/types.ts';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMS: Record<string, number> = {
    'text-embedding-3-small': 1536,
    'text-embedding-3-large': 3072,
    'text-embedding-ada-002': 1536,
};
const API_URL = 'https://api.openai.com/v1/embeddings';
const MAX_BATCH = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const BATCH_DELAY_MS = 100;

export interface OpenAIEmbeddingOptions {
    /** OpenAI API key. Falls back to OPENAI_API_KEY env var. */
    apiKey?: string;
    /** Model name. Default: 'text-embedding-3-small' */
    model?: string;
    /** Vector dimensions. If omitted, uses model default. text-embedding-3-* supports custom dims. */
    dims?: number;
    /** Base URL override (for Azure, proxies, etc.) */
    baseUrl?: string;
    /** Request timeout in ms. Default: 30000 */
    timeout?: number;
}

export class OpenAIEmbedding implements EmbeddingProvider {
    readonly dims: number;

    private _apiKey: string;
    private _model: string;
    private _baseUrl: string;
    private _requestDims: number | undefined;
    private _timeout: number;

    constructor(options: OpenAIEmbeddingOptions = {}) {
        this._apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
        this._model = options.model ?? DEFAULT_MODEL;
        this._baseUrl = options.baseUrl ?? API_URL;
        this._timeout = options.timeout ?? REQUEST_TIMEOUT_MS;

        // Custom dims only supported by text-embedding-3-*
        if (options.dims && this._model.startsWith('text-embedding-3')) {
            this._requestDims = options.dims;
            this.dims = options.dims;
        } else {
            this.dims = options.dims ?? DEFAULT_DIMS[this._model] ?? 1536;
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

    private _isTokenLimitError(errText: string): boolean {
        return errText.includes('maximum input length') ||
               errText.includes('maximum context length') ||
               errText.includes('too many tokens');
    }

    private async _request(input: string[], retryDepth: number = 0): Promise<Float32Array[]> {
        if (!this._apiKey) {
            throw new Error('OpenAI API key required. Set OPENAI_API_KEY env var or pass apiKey option.');
        }

        const MAX_CHARS = 24_000;
        const safeInput = input.map(t => t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t);

        const body: Record<string, any> = { model: this._model, input: safeInput };
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
        } catch (err: any) {
            clearTimeout(timer);
            if (err.name === 'AbortError') {
                throw new Error(`OpenAI embedding request timed out after ${this._timeout}ms.`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) {
            return this._handleApiError(res, safeInput, retryDepth);
        }

        const json = await res.json() as {
            data: Array<{ embedding: number[]; index: number }>;
        };
        return json.data.sort((a, b) => a.index - b.index).map(d => new Float32Array(d.embedding));
    }

    /** Handle API errors with token-limit retry logic. */
    private async _handleApiError(
        res: Response, safeInput: string[], retryDepth: number,
    ): Promise<Float32Array[]> {
        const err = await res.text();
        const isTokenLimit = res.status === 400 && this._isTokenLimitError(err);

        // Batch token limit → retry each item individually with aggressive truncation
        if (isTokenLimit && safeInput.length > 1) {
            const results: Float32Array[] = [];
            for (const text of safeInput) {
                const r = await this._request([text.slice(0, 8_000)]);
                results.push(r[0]);
            }
            return results;
        }
        // Single item still failing → truncate to ~2k tokens (max 1 retry)
        if (isTokenLimit && safeInput.length === 1 && retryDepth < 1) {
            return this._request([safeInput[0].slice(0, 6_000)], retryDepth + 1);
        }
        throw new Error(`OpenAI embedding API error (${res.status}): ${err}`);
    }
}

/** Simple delay helper. */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
