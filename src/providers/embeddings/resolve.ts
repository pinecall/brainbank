/**
 * BrainBank — Embedding Provider Resolver
 *
 * Resolves an EmbeddingProvider from a stored key string.
 * Used by the Initializer to auto-resolve from DB config.
 */

import type { EmbeddingProvider } from '@/types.ts';

/** Re-export providerKey from lib/ (canonical location). */
export { providerKey, type EmbeddingKey } from '@/lib/provider-key.ts';

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
