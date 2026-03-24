/**
 * BrainBank — Local Embedding Provider
 * 
 * Uses @xenova/transformers with all-MiniLM-L6-v2 (384 dims, WASM).
 * Downloads ~23MB on first use, cached locally.
 * No external API calls — runs entirely in-process.
 */

import type { EmbeddingProvider } from '../../types.ts';

export class LocalEmbedding implements EmbeddingProvider {
    readonly dims: number = 384;

    private _pipeline: any = null;
    private _modelName: string;
    private _cacheDir: string;

    constructor(options: { model?: string; cacheDir?: string } = {}) {
        this._modelName = options.model ?? 'Xenova/all-MiniLM-L6-v2';
        this._cacheDir = options.cacheDir ?? '.model-cache';
    }

    private _pipelinePromise: Promise<any> | null = null;

    /**
     * Lazy-load the transformer pipeline.
     * Singleton — created once and reused.
     * Promise-deduped to prevent concurrent downloads.
     */
    private async _getPipeline(): Promise<any> {
        if (this._pipeline) return this._pipeline;
        if (this._pipelinePromise) return this._pipelinePromise;

        this._pipelinePromise = (async () => {
            const { pipeline, env } = await import('@xenova/transformers' as any);
            env.cacheDir = this._cacheDir;
            env.allowLocalModels = true;

            this._pipeline = await pipeline('feature-extraction', this._modelName, {
                quantized: true,
            });

            return this._pipeline;
        })();

        try {
            return await this._pipelinePromise;
        } finally {
            this._pipelinePromise = null;
        }
    }

    /**
     * Embed a single text string.
     * Returns a normalized Float32Array of length 384.
     */
    async embed(text: string): Promise<Float32Array> {
        const pipe = await this._getPipeline();
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        return output.data as Float32Array;
    }

    /**
     * Embed multiple texts.
     * Processes sequentially to avoid OOM on large batches.
     */
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        const results: Float32Array[] = [];
        for (const text of texts) {
            results.push(await this.embed(text));
        }
        return results;
    }

    async close(): Promise<void> {
        this._pipeline = null;
    }
}
