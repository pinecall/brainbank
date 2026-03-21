/**
 * BrainBank — Module System
 * 
 * Modules are the building blocks of BrainBank. Each module
 * adds a specific capability (code indexing, docs, memory, etc.).
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from 'brainbank/code';
 *   import { docs } from 'brainbank/docs';
 *   
 *   const brain = new BrainBank()
 *     .use(code({ repoPath: '.' }))
 *     .use(docs());
 */

import type { Database } from '../storage/database.ts';
import type { EmbeddingProvider } from '../types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import type { ResolvedConfig } from '../types.ts';

// ── Module Context ─────────────────────────────────
// Provided to each module during initialization.

export interface ModuleContext {
    /** SQLite database (shared across all modules). */
    db: Database;
    /** Embedding provider (shared). */
    embedding: EmbeddingProvider;
    /** Resolved BrainBank config. */
    config: ResolvedConfig;
    /** Create and initialize an HNSW index. */
    createHnsw(maxElements?: number): Promise<HNSWIndex>;
    /** Load existing vectors from a SQLite vectors table into an HNSW index + cache. */
    loadVectors(table: string, idCol: string, hnsw: HNSWIndex, cache: Map<number, Float32Array>): void;
}

// ── Module Interface ───────────────────────────────

export interface BrainBankModule {
    /** Unique module name (e.g. 'code', 'git', 'docs'). */
    readonly name: string;

    /** Initialize the module (create HNSW, load vectors, etc.). */
    initialize(ctx: ModuleContext): Promise<void>;

    /** Return stats for this module. */
    stats?(): Record<string, any>;

    /** Clean up resources. */
    close?(): void;
}
