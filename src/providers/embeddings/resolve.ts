/**
 * BrainBank — Embedding Provider Resolver
 *
 * Resolves an EmbeddingProvider from a stored key string.
 * Used by the Initializer to auto-resolve from DB config.
 */

import type { EmbeddingProvider } from '@/types.ts';

/** Known embedding provider keys. */
export type EmbeddingKey = 'local' | 'openai' | 'perplexity' | 'perplexity-context';

/** Resolve an EmbeddingProvider from a key string. Lazy-loads the provider module. */
export async function resolveEmbedding(key: string): Promise<EmbeddingProvider> {
    switch (key) {
        case 'openai': {
            const { OpenAIEmbedding } = await import('./openai-embedding.ts');
            return new OpenAIEmbedding();
        }
        case 'perplexity': {
            const { PerplexityEmbedding } = await import('./perplexity-embedding.ts');
            return new PerplexityEmbedding();
        }
        case 'perplexity-context': {
            const { PerplexityContextEmbedding } = await import('./perplexity-context-embedding.ts');
            return new PerplexityContextEmbedding();
        }
        case 'local':
        default: {
            const { LocalEmbedding } = await import('./local-embedding.ts');
            return new LocalEmbedding();
        }
    }
}

/** Infer a stable key from an existing provider instance. */
export function providerKey(p: EmbeddingProvider): EmbeddingKey {
    const name = p.constructor?.name ?? '';
    if (name === 'OpenAIEmbedding') return 'openai';
    if (name === 'PerplexityEmbedding') return 'perplexity';
    if (name === 'PerplexityContextEmbedding') return 'perplexity-context';
    return 'local';
}
