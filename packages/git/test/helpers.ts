/**
 * @brainbank/git — Test Helpers
 */

import { BrainBank } from '../../../src/brainbank.ts';
import { git } from '../src/index.js';
import { code } from '@brainbank/code';
import type { EmbeddingProvider } from '../../../src/types.ts';

/** Creates a deterministic hash-based embedding provider. */
export function hashEmbedding(dims = 384): EmbeddingProvider {
    function embed(text: string): Float32Array {
        const vec = new Float32Array(dims);
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        for (let i = 0; i < dims; i++) {
            h ^= (h >>> 13);
            h = Math.imul(h, 0x5bd1e995) >>> 0;
            vec[i] = (h / 0xFFFFFFFF) * 2 - 1;
        }
        let norm = 0;
        for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm);
        for (let i = 0; i < dims; i++) vec[i] /= norm;
        return vec;
    }
    return {
        dims,
        embed: async (t: string) => embed(t),
        embedBatch: async (ts: string[]) => ts.map(t => embed(t)),
        close: async () => {},
    };
}

export function tmpDb(label: string): string {
    return `/tmp/brainbank-${label}-${Date.now()}.db`;
}

export { BrainBank, git, code };
export type { EmbeddingProvider };
