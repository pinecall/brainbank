/**
 * BrainBank — Plugin System
 * 
 * Plugins are pluggable strategies that scan external data sources
 * and push content into BrainBank. Built-in plugins handle code,
 * git, and docs. Third-party frameworks (LangChain, etc.)
 * can implement custom plugins.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from 'brainbank/indexers/code';
 *   
 *   const brain = new BrainBank()
 *     .use(code({ repoPath: '.' }));
 */

import type { Database } from './db/database.ts';
import type { EmbeddingProvider, SearchResult } from './types.ts';
import type { HNSWIndex } from './providers/vector/hnsw-index.ts';
import type { ResolvedConfig, DocumentCollection, ICollection } from './types.ts';

// ── Plugin Context ────────────────────────────────
// Provided to each plugin during initialization.

export interface PluginContext {
    /** SQLite database (shared across all plugins). */
    db: Database;
    /** Embedding provider (shared). */
    embedding: EmbeddingProvider;
    /** Resolved BrainBank config. */
    config: ResolvedConfig;
    /**
     * Create and initialize an HNSW index.
     * Pass `name` to enable disk persistence (recommended).
     *
     * **Private vs shared:** Use `getOrCreateSharedHnsw()` for indexes that should be
     * part of the composite search (code, git) and persisted across restarts.
     * Use `createHnsw()` for plugin-local indexes that don't participate in the
     * main search pipeline (e.g. internal similarity lookups).
     */
    createHnsw(maxElements?: number, dims?: number, name?: string): Promise<HNSWIndex>;
    /** Load existing vectors from a SQLite vectors table into an HNSW index + cache. */
    loadVectors(table: string, idCol: string, hnsw: HNSWIndex, cache: Map<number, Float32Array>): void;
    /** Get or create a shared HNSW index by type (e.g. 'code', 'git'). Optionally override dims for per-plugin embeddings. */
    getOrCreateSharedHnsw(type: string, maxElements?: number, dims?: number): Promise<{ hnsw: HNSWIndex; vecCache: Map<number, Float32Array>; isNew: boolean }>;
    /** Get or create a dynamic collection. */
    collection(name: string): ICollection;
}

// ── Core Plugin Interface ─────────────────────────
// Minimal contract: name + initialize. All capabilities are expressed
// via composed interfaces below.

export interface Plugin {
    /** Unique plugin name (e.g. 'code', 'git', 'docs'). */
    readonly name: string;
    /** Initialize the plugin (create HNSW, load vectors, etc.). */
    initialize(ctx: PluginContext): Promise<void>;
    /** Return stats for this plugin. */
    stats?(): Record<string, any>;
    /** Clean up resources. */
    close?(): void;
}

// ── Capability Interfaces ──────────────────────────
// Implemented by plugins that support specific capabilities.
// Use type guards below to check at runtime.

/** Plugins that can scan and index content (code, git). */
export interface IndexablePlugin extends Plugin {
    index(options?: any): Promise<any>;
}

/** Plugins that can search indexed content (docs). */
export interface SearchablePlugin extends Plugin {
    search(query: string, options?: any): Promise<SearchResult[]>;
}

/** Plugins that support file watch mode. */
export interface WatchablePlugin extends Plugin {
    onFileChange(filePath: string, event: 'create' | 'update' | 'delete'): Promise<boolean>;
    watchPatterns(): string[];
}

// ── Type Guards ────────────────────────────────────

/** Check if a plugin can scan/index content. */
export function isIndexable(i: Plugin): i is IndexablePlugin {
    return typeof (i as IndexablePlugin).index === 'function';
}

/** Check if a plugin can search content. */
export function isSearchable(i: Plugin): i is SearchablePlugin {
    return typeof (i as SearchablePlugin).search === 'function';
}

/** Check if a plugin supports file watch mode. */
export function isWatchable(i: Plugin): i is WatchablePlugin {
    return typeof (i as WatchablePlugin).onFileChange === 'function'
        && typeof (i as WatchablePlugin).watchPatterns === 'function';
}

/** Path-specific context metadata for document collections. */
export interface PathContext {
    collection: string;
    path: string;
    context: string;
}

/** Plugins that manage document collections (docs). */
export interface DocsPlugin extends SearchablePlugin {
    addCollection(collection: DocumentCollection): void;
    removeCollection(name: string): void;
    listCollections(): DocumentCollection[];
    indexDocs(options?: { onProgress?: (collection: string, file: string, current: number, total: number) => void }): Promise<Record<string, { indexed: number; skipped: number; chunks: number }>>;
    addContext(collection: string, path: string, context: string): void;
    listContexts(): PathContext[];
}

/** Check if a plugin manages document collections. */
export function isDocsPlugin(i: Plugin): i is DocsPlugin {
    return typeof (i as DocsPlugin).addCollection === 'function'
        && typeof (i as DocsPlugin).listCollections === 'function';
}

// ── Structural Capability Interfaces ──────────────

/** Plugin that exposes a shared HNSW index and vector cache (e.g. memory). */
export interface HnswPlugin extends Plugin {
    hnsw: HNSWIndex;
    vecCache: Map<number, Float32Array>;
}

/** Plugin that provides co-edit suggestions (e.g. git). */
export interface CoEditPlugin extends Plugin {
    coEdits: {
        suggest(filePath: string, limit: number): { file: string; count: number }[];
    };
}

/** Check if a plugin exposes a shared HNSW index. */
export function isHnswPlugin(p: Plugin): p is HnswPlugin {
    return 'hnsw' in p && 'vecCache' in p;
}

/** Check if a plugin provides co-edit suggestions. */
export function isCoEditPlugin(p: Plugin): p is CoEditPlugin {
    return 'coEdits' in p && typeof (p as CoEditPlugin).coEdits?.suggest === 'function';
}

// ── Re-embed Support ──────────────────────────────

/** Table descriptor for re-embedding — maps text rows to vector BLOBs. */
export interface ReembedTable {
    /** Human-readable name (for progress). */
    name: string;
    /** Table with text content. */
    textTable: string;
    /** Table with vector BLOBs. */
    vectorTable: string;
    /** PK column in text table. */
    idColumn: string;
    /** FK column in vector table. */
    fkColumn: string;
    /** Build the embedding text from a DB row. */
    textBuilder: (row: Record<string, unknown>) => string;
}

/** Plugins that own vector tables and can rebuild embedding text from DB rows. */
export interface ReembeddablePlugin extends Plugin {
    /** Table descriptor for re-embedding. */
    reembedConfig(): ReembedTable;
}

/** Check if a plugin supports re-embedding. */
export function isReembeddable(p: Plugin): p is ReembeddablePlugin {
    return typeof (p as ReembeddablePlugin).reembedConfig === 'function';
}
