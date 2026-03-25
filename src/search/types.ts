/**
 * BrainBank — Search Types
 * 
 * Shared interface for all search strategies.
 * Implement SearchStrategy to add a new search backend.
 */

import type { SearchResult } from '../types.ts';

/** Any search implementation follows this shape. */
export interface SearchStrategy {
    search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
    /** Rebuild internal indices (e.g. FTS5). Optional. */
    rebuild?(): void;
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
