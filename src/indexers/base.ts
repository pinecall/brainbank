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
import type { EmbeddingProvider, SearchResult } from '@/types.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import type { ResolvedConfig, DocumentCollection } from '@/types.ts';
import type { Collection } from '@/domain/collection.ts';

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

// ── Core Indexer Interface ─────────────────────────
// Minimal contract: name + initialize. All capabilities are expressed
// via composed interfaces below.

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

// ── Capability Interfaces ──────────────────────────
// Implemented by indexers that support specific capabilities.
// Use type guards below to check at runtime.

/** Indexers that can scan and index content (code, git). */
export interface IndexablePlugin extends Indexer {
    index(options?: any): Promise<any>;
}

/** Indexers that can search indexed content (docs). */
export interface SearchablePlugin extends Indexer {
    search(query: string, options?: any): Promise<SearchResult[]>;
}

/** Indexers that support file watch mode. */
export interface WatchablePlugin extends Indexer {
    onFileChange(filePath: string, event: 'create' | 'update' | 'delete'): Promise<boolean>;
    watchPatterns(): string[];
}

/** Indexers that manage document collections. */
export interface CollectionPlugin extends Indexer {
    addCollection(collection: DocumentCollection): void;
    removeCollection(name: string): void;
    listCollections(): DocumentCollection[];
    indexCollections(options?: any): Promise<any>;
    search(query: string, options?: any): Promise<SearchResult[]>;
    addContext?(collection: string, path: string, context: string): void;
    removeContext?(collection: string, path: string): void;
    listContexts?(): any[];
}

// ── Type Guards ────────────────────────────────────

/** Check if an indexer can scan/index content. */
export function isIndexable(i: Indexer): i is IndexablePlugin {
    return typeof (i as IndexablePlugin).index === 'function';
}

/** Check if an indexer can search content. */
export function isSearchable(i: Indexer): i is SearchablePlugin {
    return typeof (i as SearchablePlugin).search === 'function';
}

/** Check if an indexer supports file watch mode. */
export function isWatchable(i: Indexer): i is WatchablePlugin {
    return typeof (i as WatchablePlugin).onFileChange === 'function'
        && typeof (i as WatchablePlugin).watchPatterns === 'function';
}

/** Check if an indexer manages document collections. */
export function isCollectionPlugin(i: Indexer): i is CollectionPlugin {
    return typeof (i as CollectionPlugin).addCollection === 'function'
        && typeof (i as CollectionPlugin).listCollections === 'function';
}
