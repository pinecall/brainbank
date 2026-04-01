/**
 * BrainBank — Perplexity Contextualized Embedding Provider
 *
 * Uses Perplexity's contextualized embeddings API for document-aware vectors.
 * Chunks from the same document share context, improving retrieval quality.
 *
 * Models: pplx-embed-context-v1-0.6b (1024d), pplx-embed-context-v1-4b (2560d).
 *
 * Key difference from standard: input is string[][] (docs × chunks) and the
 * response has a nested structure. This provider adapts the flat BrainBank
 * EmbeddingProvider interface to the nested Perplexity API:
 *   - embed(text)       → wraps as [[text]]
 *   - embedBatch(texts) → wraps as [texts] (one "document" of related chunks)
 *
 * Usage:
 *   const brain = new BrainBank({
 *     embeddingProvider: new PerplexityContextEmbedding(),
 *   });
 */

import type { EmbeddingProvider } from '@/types.ts';
import { decodeBase64Int8 } from './perplexity-embedding.ts';

const DEFAULT_MODEL = 'pplx-embed-context-v1-4b';
const DEFAULT_DIMS: Record<string, number> = {
    'pplx-embed-context-v1-0.6b': 1024,
    'pplx-embed-context-v1-4b': 2560,
};
const API_URL = 'https://api.perplexity.ai/v1/contextualizedembeddings';
const MAX_BATCH = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const BATCH_DELAY_MS = 100;

export interface PerplexityContextEmbeddingOptions {
    /** Perplexity API key. Falls back to PERPLEXITY_API_KEY env var. */
    apiKey?: string;
    /** Model name. Default: 'pplx-embed-context-v1-4b' */
    model?: string;
    /** Vector dimensions (Matryoshka reduction). If omitted, uses model default. */
    dims?: number;
    /** Base URL override. */
    baseUrl?: string;
    /** Request timeout in ms. Default: 30000 */
    timeout?: number;
}

export class PerplexityContextEmbedding implements EmbeddingProvider {
    readonly dims: number;

    private _apiKey: string;
    private _model: string;
    private _baseUrl: string;
    private _requestDims: number | undefined;
    private _timeout: number;

    constructor(options: PerplexityContextEmbeddingOptions = {}) {
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

    /** Embed a single text. Wraps as [[text]] for the contextualized API. */
    async embed(text: string): Promise<Float32Array> {
        const results = await this._request([[text]]);
        return results[0];
    }

    /**
     * Embed multiple texts as chunks of contextualized documents.
     * Splits into sub-documents to stay under Perplexity's 32k token/doc limit.
     */
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        if (texts.length === 0) return [];

        const docs = splitIntoDocuments(texts);
        const results: Float32Array[] = [];

        for (let i = 0; i < docs.length; i++) {
            if (i > 0) await sleep(BATCH_DELAY_MS);
            const embeddings = await this._request([docs[i]]);
            results.push(...embeddings);
        }

        return results;
    }

    async close(): Promise<void> {
        // No resources to release
    }

    /** Send a contextualized request. Input is string[][] (docs × chunks). */
    private async _request(input: string[][]): Promise<Float32Array[]> {
        if (!this._apiKey) {
            throw new Error(
                'BrainBank: Perplexity API key required. Set PERPLEXITY_API_KEY env var or pass apiKey option.',
            );
        }

        const MAX_CHARS = 24_000;
        const safeInput = input.map(doc =>
            doc.map(chunk => chunk.length > MAX_CHARS ? chunk.slice(0, MAX_CHARS) : chunk),
        );

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
                throw new Error(`BrainBank: Perplexity contextualized embedding request timed out after ${this._timeout}ms.`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`BrainBank: Perplexity contextualized embedding API error (${res.status}): ${errText}`);
        }

        const json = await res.json() as PerplexityContextResponse;
        return flattenContextResponse(json, this.dims);
    }
}


interface PerplexityContextResponse {
    data: Array<{
        index: number;
        data: Array<{ index: number; embedding: string }>;
    }>;
}

/** Flatten nested doc → chunk response into a single flat array. */
function flattenContextResponse(json: PerplexityContextResponse, dims: number): Float32Array[] {
    return json.data
        .sort((a, b) => a.index - b.index)
        .flatMap(doc =>
            doc.data
                .sort((a, b) => a.index - b.index)
                .map(chunk => decodeBase64Int8(chunk.embedding, dims)),
        );
}

/**
 * Split chunks into sub-documents that each stay under the 32k token limit.
 * Uses ~4 chars/token estimate with safety margin (~80k chars ≈ ~20k tokens).
 */
function splitIntoDocuments(texts: string[]): string[][] {
    const MAX_CHARS_PER_DOC = 80_000;
    const docs: string[][] = [];
    let current: string[] = [];
    let currentChars = 0;

    for (const text of texts) {
        if (current.length > 0 && currentChars + text.length > MAX_CHARS_PER_DOC) {
            docs.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(text);
        currentChars += text.length;
    }

    if (current.length > 0) docs.push(current);
    return docs;
}

/** Simple delay helper. */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
