/**
 * BrainBank — Local Embedding Provider
 * 
 * Uses @xenova/transformers with all-MiniLM-L6-v2 (384 dims, WASM).
 * Downloads ~23MB on first use, cached locally.
 * No external API calls — runs entirely in-process.
 */

import type { EmbeddingProvider } from '@/types.ts';

/** Minimal interface for @xenova/transformers pipeline results. */
interface XenovaPipelineOutput {
    data: Float32Array;
}

/** Callable pipeline returned by @xenova/transformers. */
interface XenovaPipeline {
    (texts: string | string[], options: { pooling: string; normalize: boolean }): Promise<XenovaPipelineOutput>;
}

/** Configuration environment of @xenova/transformers. */
interface XenovaEnv {
    cacheDir: string;
    allowLocalModels: boolean;
}

/** Shape of the @xenova/transformers module used here. */
interface XenovaModule {
    pipeline(task: string, model: string, options?: { quantized?: boolean }): Promise<XenovaPipeline>;
    env: XenovaEnv;
}

export class LocalEmbedding implements EmbeddingProvider {
    readonly dims: number = 384;

    private _pipeline: XenovaPipeline | null = null;
    private _modelName: string;
    private _cacheDir: string;

    constructor(options: { model?: string; cacheDir?: string } = {}) {
        this._modelName = options.model ?? 'Xenova/all-MiniLM-L6-v2';
        this._cacheDir = options.cacheDir ?? '.model-cache';
    }

    private _pipelinePromise: Promise<XenovaPipeline> | null = null;

    /**
     * Lazy-load the transformer pipeline.
     * Singleton — created once and reused.
     * Promise-deduped to prevent concurrent downloads.
     */
    private async _getPipeline(): Promise<XenovaPipeline> {
        if (this._pipeline) return this._pipeline;
        if (this._pipelinePromise) return this._pipelinePromise;

        this._pipelinePromise = (async () => {
            const mod = await import(/* webpackIgnore: true */ '@xenova/transformers' as string) as XenovaModule;
            const { pipeline, env } = mod;
            env.cacheDir = this._cacheDir;
            env.allowLocalModels = true;

            this._pipeline = await pipeline('feature-extraction', this._modelName, {
                quantized: true,
            });

            return this._pipeline!;
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
     * Embed multiple texts using real batch processing.
     * Chunks into groups of BATCH_SIZE to balance throughput vs memory.
     */
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        if (texts.length === 0) return [];

        const BATCH_SIZE = 32;
        const pipe = await this._getPipeline();
        const results: Float32Array[] = [];

        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const batch = texts.slice(i, i + BATCH_SIZE);
            const output = await pipe(batch, { pooling: 'mean', normalize: true });

            // output.data is a flat Float32Array — must copy, not view,
            // because the pipeline may reuse the underlying buffer
            for (let j = 0; j < batch.length; j++) {
                const start = j * this.dims;
                results.push(output.data.slice(start, start + this.dims) as Float32Array);
            }
        }

        return results;
    }

    async close(): Promise<void> {
        this._pipeline = null;
    }
}
