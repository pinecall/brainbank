/**
 * BrainBank — Provider Key
 *
 * Infers a stable key from an existing EmbeddingProvider instance.
 * Lives in lib/ (Layer 0) to avoid db/ → providers/ dependency.
 */

import type { EmbeddingProvider } from '@/types.ts';

/** Known embedding provider keys. */
export type EmbeddingKey = 'local' | 'openai' | 'perplexity' | 'perplexity-context';

/** Infer a stable key from an existing provider instance. */
export function providerKey(p: EmbeddingProvider): EmbeddingKey {
    const name = p.constructor?.name ?? '';
    if (name === 'OpenAIEmbedding') return 'openai';
    if (name === 'PerplexityEmbedding') return 'perplexity';
    if (name === 'PerplexityContextEmbedding') return 'perplexity-context';
    return 'local';
}
