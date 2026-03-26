/**
 * BrainBank — Math Utilities
 * 
 * Pure vector math functions for similarity calculations.
 * No dependencies — works on Float32Array directly.
 */

/**
 * Cosine similarity between two vectors.
 * Assumes vectors are already normalized (unit length).
 * Returns value between -1.0 and 1.0.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    if (a.length === 0) return 0;

    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}

/**
 * Full cosine similarity (normalizes first).
 * Use this when vectors may not be pre-normalized.
 */
export function cosineSimilarityFull(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    if (a.length === 0) return 0;

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * L2-normalize a vector to unit length.
 * Returns a new Float32Array.
 */
export function normalize(vec: Float32Array): Float32Array {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
        norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return new Float32Array(vec.length);

    const result = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
        result[i] = vec[i] / norm;
    }
    return result;
}

/**
 * Euclidean distance between two vectors.
 */
export function euclideanDistance(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return Math.sqrt(sum);
}

/**
 * Convert a Float32Array to a Buffer for SQLite storage.
 * Handles views with non-zero byteOffset (e.g. from batched embedding output).
 * Using Buffer.from(vec.buffer) directly is WRONG for views — it copies the entire parent buffer.
 */
export function vecToBuffer(vec: Float32Array): Buffer {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
