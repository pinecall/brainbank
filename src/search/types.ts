/**
 * BrainBank — Search Types
 * 
 * Shared interface for all search strategies.
 * Implement SearchStrategy to add a new search backend.
 */

import type { SearchResult } from '@/types.ts';

/** Any search implementation follows this shape. */
export interface SearchStrategy {
    search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
    /** Rebuild internal indices (e.g. FTS5). Optional. */
    rebuild?(): void;
}

/** Pre-embedded vector search for a single domain (code, git, etc.). */
export interface DomainVectorSearch {
    /** Search using a pre-computed query vector. Optional queryText enables BM25 fusion. */
    search(queryVec: Float32Array, k: number, minScore: number, useMMR?: boolean, mmrLambda?: number, queryText?: string): SearchResult[];
}

export interface SearchOptions {
    /** Per-source result limits. Built-in: 'code', 'git', 'memory'. Any other key = custom plugin or KV collection. */
    sources?: Record<string, number>;
    /** Minimum similarity score. Default: 0.25 */
    minScore?: number;
    /** Use MMR for diversity. Default: true */
    useMMR?: boolean;
    /** MMR lambda. Default: 0.7 */
    mmrLambda?: number;
    /** Caller origin for debug logging. */
    source?: 'cli' | 'mcp' | 'daemon' | 'api';
    /** Filter results to files under these path prefixes. */
    pathPrefix?: string | string[];
}

