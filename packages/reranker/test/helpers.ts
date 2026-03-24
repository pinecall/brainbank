/**
 * @brainbank/reranker — Test Helpers
 * Re-exports from brainbank and provides test utilities.
 */
import { BrainBank } from '../../../src/app/brain.ts';
import { code } from '../../../src/indexers/code/plugin.ts';

// Simple hash-based embedding for testing (no real model needed)
export function hashEmbedding(dims = 384) {
    return {
        dims,
        async embed(text: string): Promise<Float32Array> {
            const vec = new Float32Array(dims);
            for (let i = 0; i < text.length && i < dims; i++) {
                vec[i % dims] += text.charCodeAt(i) / 1000;
            }
            let norm = 0;
            for (const v of vec) norm += v * v;
            norm = Math.sqrt(norm) || 1;
            return vec.map(v => v / norm);
        },
        async embedBatch(texts: string[]): Promise<Float32Array[]> {
            const results: Float32Array[] = [];
            for (const text of texts) {
                results.push(await this.embed(text));
            }
            return results;
        },
        async close() {},
    };
}

export { BrainBank, code };
