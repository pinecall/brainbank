/**
 * BrainBank — Qwen3 Local Reranker
 * 
 * Cross-encoder reranker using Qwen3-Reranker-0.6B via node-llama-cpp.
 * Auto-downloads the GGUF model from HuggingFace (~640MB, cached).
 * 
 * Based on QMD's reranker architecture:
 * - Lazy model loading (loads on first rank() call)
 * - Flash attention for 20× less VRAM
 * - Document deduplication (identical texts scored once)
 * - Tokenizer-based truncation for oversized documents
 */

import type { Reranker } from '../types.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

// Default model — Qwen3-Reranker-0.6B quantized to Q8_0 (~640MB)
const DEFAULT_MODEL_URI = 'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf';

// Context size for reranking (Qwen3 template ~200 tokens overhead + query + doc)
const CONTEXT_SIZE = 2048;

// Cache directory for downloaded models
const MODEL_CACHE_DIR = join(homedir(), '.cache', 'brainbank', 'models');

export interface Qwen3RerankerOptions {
    /** HuggingFace model URI. Default: Qwen3-Reranker-0.6B-Q8_0 */
    modelUri?: string;
    /** Model cache directory. Default: ~/.cache/brainbank/models/ */
    cacheDir?: string;
    /** Context size for ranking. Default: 2048 */
    contextSize?: number;
}

export class Qwen3Reranker implements Reranker {
    private readonly _modelUri: string;
    private readonly _cacheDir: string;
    private readonly _contextSize: number;

    private _model: any = null;
    private _context: any = null;
    private _loadPromise: Promise<void> | null = null;

    constructor(options: Qwen3RerankerOptions = {}) {
        this._modelUri = options.modelUri ?? DEFAULT_MODEL_URI;
        this._cacheDir = options.cacheDir ?? MODEL_CACHE_DIR;
        this._contextSize = options.contextSize ?? CONTEXT_SIZE;
    }

    /**
     * Lazy-load the reranker model and create a ranking context.
     * Model is auto-downloaded from HuggingFace on first use.
     */
    private async _ensureLoaded(): Promise<void> {
        if (this._context) return;
        if (this._loadPromise) {
            await this._loadPromise;
            return;
        }

        this._loadPromise = (async () => {
            try {
                // Dynamic import — node-llama-cpp is an optional dependency
                const { getLlama, resolveModelFile } = await import('node-llama-cpp');

                // Ensure cache directory exists
                if (!existsSync(this._cacheDir)) {
                    mkdirSync(this._cacheDir, { recursive: true });
                }

                // Download model if needed (resolveModelFile handles caching)
                const modelPath = await resolveModelFile(this._modelUri, this._cacheDir);

                // Initialize llama engine
                const llama = await getLlama();

                // Load model
                this._model = await llama.loadModel({ modelPath });

                // Create ranking context with flash attention for lower VRAM
                try {
                    this._context = await this._model.createRankingContext({
                        contextSize: this._contextSize,
                        flashAttention: true,
                    });
                } catch {
                    // Flash attention might not be supported — retry without it
                    this._context = await this._model.createRankingContext({
                        contextSize: this._contextSize,
                    });
                }
            } finally {
                this._loadPromise = null;
            }
        })();

        await this._loadPromise;
    }

    /**
     * Score each document's relevance to the query.
     * Returns scores (0.0 - 1.0) in same order as input documents.
     * 
     * Deduplicates identical documents to avoid redundant computation.
     */
    async rank(query: string, documents: string[]): Promise<number[]> {
        if (documents.length === 0) return [];

        await this._ensureLoaded();

        // Deduplicate — identical texts get scored once
        const uniqueTexts = [...new Set(documents)];
        const textToScore = new Map<string, number>();

        // Truncate documents that exceed context size
        const truncated = uniqueTexts.map(text => {
            if (this._model) {
                const tokens = this._model.tokenize(text);
                // Budget: contextSize - ~200 overhead - query tokens
                const queryTokens = this._model.tokenize(query).length;
                const maxDocTokens = this._contextSize - 200 - queryTokens;
                if (tokens.length > maxDocTokens && maxDocTokens > 0) {
                    return this._model.detokenize(tokens.slice(0, maxDocTokens));
                }
            }
            return text;
        });

        // Rank all unique documents at once
        const scores: number[] = await this._context.rankAll(query, truncated);

        // Map scores back
        for (let i = 0; i < uniqueTexts.length; i++) {
            textToScore.set(uniqueTexts[i], scores[i] ?? 0);
        }

        // Return scores in original document order
        return documents.map(doc => textToScore.get(doc) ?? 0);
    }

    /** Release model resources. */
    async close(): Promise<void> {
        if (this._context) {
            await this._context.dispose();
            this._context = null;
        }
        if (this._model) {
            await this._model.dispose?.();
            this._model = null;
        }
    }
}
