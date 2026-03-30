/**
 * BrainBank CLI — Provider Setup
 *
 * Resolves embedding providers and rerankers from config/CLI flags.
 */

import type { EmbeddingProvider } from '@/types.ts';
import type { ProjectConfig } from './config-loader.ts';
import { getFlag } from '../utils.ts';

/** Resolve an embedding key string to an EmbeddingProvider instance. */
export async function resolveEmbeddingKey(key: string): Promise<EmbeddingProvider> {
    const { resolveEmbedding } = await import('@/providers/embeddings/resolve.ts');
    return resolveEmbedding(key);
}

/** Configure reranker and global embedding provider on brainOpts. */
export async function setupProviders(brainOpts: Record<string, unknown>, config: ProjectConfig | null): Promise<void> {
    const rerankerFlag = getFlag('reranker') ?? config?.reranker;
    if (rerankerFlag === 'qwen3') {
        const { Qwen3Reranker } = await import('@/providers/rerankers/qwen3-reranker.ts');
        brainOpts.reranker = new Qwen3Reranker();
    }

    const embFlag = getFlag('embedding') ?? config?.embedding ?? process.env.BRAINBANK_EMBEDDING;
    if (embFlag) {
        const provider = await resolveEmbeddingKey(embFlag);
        brainOpts.embeddingProvider = provider;
        brainOpts.embeddingDims = provider.dims;
    }
}
