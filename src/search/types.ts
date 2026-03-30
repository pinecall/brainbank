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
    /** Max code results. Default: 6 */
    codeK?: number;
    /** Max git results. Default: 5 */
    gitK?: number;
    /** Max pattern results. Default: 4 */
    patternK?: number;
    /** Minimum similarity score. Default: 0.25 */
    minScore?: number;
    /** Use MMR for diversity. Default: true */
    useMMR?: boolean;
    /** MMR lambda. Default: 0.7 */
    mmrLambda?: number;
}
