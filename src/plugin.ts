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

import type { DatabaseAdapter } from './db/adapter.ts';
import type { Migration } from './db/migrations.ts';
import type { IncrementalTracker } from './db/tracker.ts';
import type { HNSWIndex } from './providers/vector/hnsw-index.ts';
import type { DomainVectorSearch } from './search/types.ts';
import type { WebhookServer } from './services/webhook-server.ts';
import type {
    EmbeddingProvider, SearchResult, IndexResult, ProgressCallback,
    ResolvedConfig, DocumentCollection, ICollection,
    WatchEventHandler, WatchHandle, WatchConfig,
} from './types.ts';

// Provided to each plugin during initialization.

export interface PluginContext {
    /** Database adapter (shared across all plugins). */
    db: DatabaseAdapter;
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
    /**
     * Create an incremental tracker scoped to this plugin.
     * Provides `isUnchanged`, `markIndexed`, `findOrphans`, `remove`, `clear`
     * for standardized add/update/delete detection during indexing.
     */
    createTracker(): IncrementalTracker;
    /** Optional webhook server for push-based watch plugins. undefined if not configured. */
    webhookServer?: WebhookServer;
}

// Minimal contract: name + initialize. All capabilities are expressed
// via composed interfaces below.

export interface Plugin {
    /** Unique plugin name (e.g. 'code', 'git', 'docs'). */
    readonly name: string;
    /** Initialize the plugin (create HNSW, load vectors, etc.). */
    initialize(ctx: PluginContext): Promise<void>;
    /** Return stats for this plugin. */
    stats?(): Record<string, number | string>;
    /** Clean up resources. */
    close?(): void;
}

// Implemented by plugins that support specific capabilities.
// Use type guards below to check at runtime.

/** Options accepted by IndexablePlugin.index(). */
export interface IndexOptions {
    forceReindex?: boolean;
    depth?: number;
    onProgress?: ProgressCallback;
}

/** Plugins that can scan and index content (code, git). */
export interface IndexablePlugin extends Plugin {
    index(options?: IndexOptions): Promise<IndexResult>;
    /** Incremental: re-index only specific items by ID. Falls back to index() if not implemented. */
    indexItems?(ids: string[]): Promise<IndexResult>;
}

/** Plugins that can search indexed content (docs). */
export interface SearchablePlugin extends Plugin {
    search(query: string, options?: Record<string, unknown>): Promise<SearchResult[]>;
}

/** Plugins that can watch their own data source for changes. */
export interface WatchablePlugin extends Plugin {
    /** Start watching. Plugin controls how (fs.watch, polling, webhook, etc.). */
    watch(onEvent: WatchEventHandler): WatchHandle;
    /** Optional hints for the core (debounce, batching, priority). */
    watchConfig?(): WatchConfig;
}


/** Check if a plugin can scan/index content. */
export function isIndexable(i: Plugin): i is IndexablePlugin {
    return typeof (i as IndexablePlugin).index === 'function';
}

/** Check if a plugin can search content. */
export function isSearchable(i: Plugin): i is SearchablePlugin {
    return typeof (i as SearchablePlugin).search === 'function';
}

/** Check if a plugin can watch its own data source. */
export function isWatchable(i: Plugin): i is WatchablePlugin {
    return typeof (i as WatchablePlugin).watch === 'function';
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
    indexDocs(options?: { onProgress?: (collection: string, file: string, current: number, total: number) => void }): Promise<Record<string, { indexed: number; skipped: number; removed: number; chunks: number }>>;
    addContext(collection: string, path: string, context: string): void;
    listContexts(): PathContext[];
}

/** Check if a plugin manages document collections. */
export function isDocsPlugin(i: Plugin): i is DocsPlugin {
    return typeof (i as DocsPlugin).addCollection === 'function'
        && typeof (i as DocsPlugin).listCollections === 'function';
}


/** Plugin that provides co-edit suggestions (e.g. git). */
export interface CoEditPlugin extends Plugin {
    coEdits: {
        suggest(filePath: string, limit: number): { file: string; count: number }[];
    };
}

/** Check if a plugin provides co-edit suggestions. */
export function isCoEditPlugin(p: Plugin): p is CoEditPlugin {
    return 'coEdits' in p && typeof (p as CoEditPlugin).coEdits?.suggest === 'function';
}


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


/** Plugin that provides a domain-specific vector search strategy. */
export interface VectorSearchPlugin extends Plugin {
    /** Create the domain vector search (called during SearchAPI wiring). */
    createVectorSearch(): DomainVectorSearch | undefined;
}

/** Check if a plugin provides a domain vector search. */
export function isVectorSearchPlugin(p: Plugin): p is VectorSearchPlugin {
    return typeof (p as VectorSearchPlugin).createVectorSearch === 'function';
}

/** Plugin that contributes sections to the context builder output. */
export interface ContextFormatterPlugin extends Plugin {
    /** Append formatted markdown sections to `parts`. */
    formatContext(results: SearchResult[], parts: string[], options?: Record<string, unknown>): void;
}

/** Check if a plugin provides context formatting. */
export function isContextFormatterPlugin(p: Plugin): p is ContextFormatterPlugin {
    return typeof (p as ContextFormatterPlugin).formatContext === 'function';
}


/** Plugin that owns database tables and supports versioned migrations. */
export interface MigratablePlugin extends Plugin {
    /** Current schema version for this plugin. */
    readonly schemaVersion: number;
    /** Ordered list of migrations (version 1, 2, 3, …). */
    readonly migrations: Migration[];
}

/** Check if a plugin supports schema migrations. */
export function isMigratable(p: Plugin): p is MigratablePlugin {
    return typeof (p as MigratablePlugin).schemaVersion === 'number'
        && Array.isArray((p as MigratablePlugin).migrations);
}


/** Plugin that can do FTS5 keyword search on its own tables. */
export interface BM25SearchPlugin extends Plugin {
    /** Run BM25 keyword search. Returns scored results. */
    searchBM25(query: string, k: number, minScore?: number): SearchResult[];
    /** Rebuild the FTS5 index from the content table. */
    rebuildFTS?(): void;
}

/** Check if a plugin provides BM25 keyword search. */
export function isBM25SearchPlugin(p: Plugin): p is BM25SearchPlugin {
    return typeof (p as BM25SearchPlugin).searchBM25 === 'function';
}
