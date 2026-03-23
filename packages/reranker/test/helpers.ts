/**
 * @brainbank/reranker — Test Helpers
 * Re-exports from brainbank and provides test utilities.
 */
import { BrainBank } from 'brainbank';
import { code } from 'brainbank/code';

// Simple hash-based embedding for testing (no real model needed)
export function hashEmbedding(dims = 384) {
    return {
        dims,
        async embed(texts: string[]) {
            return texts.map(text => {
                const vec = new Float32Array(dims);
                for (let i = 0; i < text.length && i < dims; i++) {
                    vec[i % dims] += text.charCodeAt(i) / 1000;
                }
                let norm = 0;
                for (const v of vec) norm += v * v;
                norm = Math.sqrt(norm) || 1;
                return Array.from(vec.map(v => v / norm));
            });
        },
        async embedBatch(texts: string[], _batchSize?: number) {
            return this.embed(texts);
        },
        async close() {},
    };
}

export { BrainBank, code };
