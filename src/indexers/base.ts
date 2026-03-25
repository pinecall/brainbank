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

import type { Database } from '@/db/database.ts';
import type { EmbeddingProvider } from '@/types.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { ResolvedConfig } from '@/types.ts';
import type { Collection } from '@/core/collection.ts';

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
    /** Get or create a shared HNSW index by type (e.g. 'code', 'git'). For multi-repo support. */
    getOrCreateSharedHnsw(type: string, maxElements?: number): Promise<{ hnsw: HNSWIndex; vecCache: Map<number, Float32Array>; isNew: boolean }>;
    /** Get or create a dynamic collection. */
    collection(name: string): Collection;
}

// ── Indexer Interface ──────────────────────────────────

export interface Indexer {
    /** Unique indexer name (e.g. 'code', 'git', 'docs'). */
    readonly name: string;

    /** Initialize the indexer (create HNSW, load vectors, etc.). */
    initialize(ctx: IndexerContext): Promise<void>;

    // Optional capabilities — use composed interfaces below for strict typing
    /** Index content (code, git plugins). */
    index?(options?: any): Promise<any>;
    /** Search indexed content (docs plugin). */
    search?(query: string, options?: any): Promise<any[]>;
    /** Register a document collection (docs plugin). */
    addCollection?(collection: any): void;
    /** Remove a collection (docs plugin). */
    removeCollection?(name: string): void;
    /** List registered collections (docs plugin). */
    listCollections?(): any[];
    /** Index collections (docs plugin). */
    indexCollections?(options?: any): Promise<any>;
    /** Add context for a collection path (docs plugin). */
    addContext?(collection: string, path: string, context: string): void;
    /** Remove context (docs plugin). */
    removeContext?(collection: string, path: string): void;
    /** List context entries (docs plugin). */
    listContexts?(): any[];
    /** Watch mode: handle file change (returns true if handled). */
    onFileChange?(filePath: string, event: 'create' | 'update' | 'delete'): Promise<boolean>;
    /** Glob patterns for watch mode. */
    watchPatterns?(): string[];

    /** Return stats for this indexer. */
    stats?(): Record<string, any>;
    /** Clean up resources. */
    close?(): void;
}

// ── Indexer Capabilities (composed via intersection) ──

/** Indexers that can scan and index content. */
export interface IndexablePlugin extends Indexer {
    index(options?: any): Promise<any>;
}

/** Indexers that can search indexed content. */
export interface SearchablePlugin extends Indexer {
    search(query: string, options?: any): Promise<any[]>;
}

/** Indexers that support file watch mode. */
export interface WatchablePlugin extends Indexer {
    onFileChange(filePath: string, event: 'create' | 'update' | 'delete'): Promise<boolean>;
    watchPatterns(): string[];
}

/** Indexers that manage document collections. */
export interface CollectionPlugin extends Indexer {
    addCollection(collection: any): void;
    removeCollection(name: string): void;
    listCollections(): any[];
    indexCollections(options?: any): Promise<any>;
    addContext?(collection: string, path: string, context: string): void;
    removeContext?(collection: string, path: string): void;
    listContexts?(): any[];
}
