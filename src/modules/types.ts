/**
 * BrainBank — Indexer System
 * 
 * Indexers are pluggable strategies that scan external data sources
 * and push content into BrainBank. Built-in indexers handle code,
 * git, and docs. Third-party frameworks (LangChain, etc.)
 * can implement custom indexers.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from 'brainbank/indexers/code';
 *   
 *   const brain = new BrainBank()
 *     .use(code({ repoPath: '.' }));
 */

import type { Database } from '../storage/database.ts';
import type { EmbeddingProvider } from '../types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import type { ResolvedConfig } from '../types.ts';
import type { Collection } from '../core/collection.ts';

// ── Indexer Context ────────────────────────────────
// Provided to each indexer during initialization.

export interface IndexerContext {
    /** SQLite database (shared across all indexers). */
    db: Database;
    /** Embedding provider (shared). */
    embedding: EmbeddingProvider;
    /** Resolved BrainBank config. */
    config: ResolvedConfig;
    /** Create and initialize an HNSW index. */
    createHnsw(maxElements?: number): Promise<HNSWIndex>;
    /** Load existing vectors from a SQLite vectors table into an HNSW index + cache. */
    loadVectors(table: string, idCol: string, hnsw: HNSWIndex, cache: Map<number, Float32Array>): void;
    /** Get or create a dynamic collection. */
    collection(name: string): Collection;
}

// ── Indexer Interface ──────────────────────────────

export interface Indexer {
    /** Unique indexer name (e.g. 'code', 'git', 'docs'). */
    readonly name: string;

    /** Initialize the indexer (create HNSW, load vectors, etc.). */
    initialize(ctx: IndexerContext): Promise<void>;

    /** Return stats for this indexer. */
    stats?(): Record<string, any>;

    /** Clean up resources. */
    close?(): void;
}

// Backward compatibility aliases
export type BrainBankModule = Indexer;
export type ModuleContext = IndexerContext;
