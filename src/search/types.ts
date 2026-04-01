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
    /** Search using a pre-computed query vector. */
    search(queryVec: Float32Array, k: number, minScore: number, useMMR?: boolean, mmrLambda?: number): SearchResult[];
}

/** Summary of a code chunk for import graph expansion. */
export interface CodeChunkSummary {
    filePath: string;
    content: string;
    name: string;
    chunkType: string;
    startLine: number;
    endLine: number;
    language: string;
}

/** Abstracts call-graph and import-graph queries used by ContextBuilder. */
export interface CodeGraphProvider {
    /** Get call/called-by info for a code chunk. */
    getCallInfo(chunkId: number, symbolName?: string): { calls: string[]; calledBy: string[] } | null;
    /** 2-hop import graph expansion from seed files. */
    expandImportGraph(seedFiles: Set<string>): Set<string>;
    /** Fetch the most informative chunk per file. */
    fetchBestChunks(filePaths: string[]): CodeChunkSummary[];
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
}
