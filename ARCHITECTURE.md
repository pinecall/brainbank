# BrainBank — Complete Architecture Reference

> A semantic knowledge bank for AI agents. Indexes code, git history,
> documents, and arbitrary data. Retrieves by meaning, not just keywords.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [Directory Structure](#2-directory-structure)
3. [Core Orchestrator — BrainBank Facade](#3-core-orchestrator--brainbank-facade)
4. [Two-Phase Initialization](#4-two-phase-initialization)
5. [Plugin Registry](#5-plugin-registry)
6. [Plugin System & Plugin Context](#6-plugin-system--plugin-context)
7. [Built-in Plugins](#7-built-in-plugins)
   - 7.1 [Code Plugin](#71-code-plugin)
   - 7.2 [Git Plugin](#72-git-plugin)
   - 7.3 [Docs Plugin](#73-docs-plugin)
   - 7.4 [Memory Plugin — Agent Learning](#74-memory-plugin--agent-learning)

8. [Domain Layer](#8-domain-layer)
   - 8.1 [Collection — Generic KV Store](#81-collection--generic-kv-store)
   - 8.2 [PatternStore](#82-patternstore)
   - 8.3 [Consolidator](#83-consolidator)
   - 8.4 [PatternDistiller](#84-patterndistiller)

9. [Search Layer](#9-search-layer)
   - 9.1 [SearchStrategy Interface](#91-searchstrategy-interface)
   - 9.2 [VectorSearch](#92-vectorsearch)
   - 9.3 [KeywordSearch (BM25)](#93-keywordsearch-bm25)
   - 9.4 [Hybrid Search + RRF](#94-hybrid-search--rrf)
   - 9.5 [MMR — Maximum Marginal Relevance](#95-mmr--maximum-marginal-relevance)
   - 9.6 [Reranking](#96-reranking)
   - 9.7 [ContextBuilder](#97-contextbuilder)
   - 9.8 [DocumentSearch](#98-documentsearch)
10. [Infrastructure Layer](#10-infrastructure-layer)
    - 10.1 [Database](#101-database)
    - 10.2 [HNSWIndex — Vector Index](#102-hnswindex--vector-index)
    - 10.3 [Embedding Providers](#103-embedding-providers)
    - 10.4 [Rerankers](#104-rerankers)
11. [Services Layer](#11-services-layer)
    - 11.1 [Watch Service](#111-watch-service)
    - 11.2 [Reembed Service](#112-reembed-service)
    - 11.3 [EmbeddingMeta Service](#113-embeddingmeta-service)
12. [SQLite Schema](#12-sqlite-schema)
13. [CLI Layer](#13-cli-layer)
14. [API Layer](#14-api-layer)
15. [Shared HNSW Pool](#15-shared-hnsw-pool)
16. [Data Flow Diagrams](#16-data-flow-diagrams)
    - 16.1 [Index Flow](#161-index-flow)
    - 16.2 [Search Flow](#162-search-flow)
    - 16.3 [Hybrid Search Flow](#163-hybrid-search-flow)
    - 16.4 [Memory Learning Flow](#164-memory-learning-flow)

    - 16.6 [Startup Initialization Flow](#166-startup-initialization-flow)
17. [Design Patterns Reference](#17-design-patterns-reference)
18. [Complete Dependency Graph](#18-complete-dependency-graph)

---

## 1. High-Level Overview

BrainBank is a **local-first semantic knowledge engine**. It stores text in
SQLite with both vector embeddings (HNSW) and full-text search indices (FTS5).
Everything is accessed through a single **Facade** (`BrainBank`) that composes
specialized subsystems via a **Plugin architecture**.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            USER / AI AGENT                              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                    brain.index() / brain.search()
                    brain.getContext() / brain.collection()
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     BrainBank  (Facade + EventEmitter)                  │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  IndexAPI    │  │  SearchAPI   │  │PluginRegistry│  │Initializer │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
└─────────┼────────────────┼────────────────┼────────────────┼───────────┘
          │                │                │                │
          ▼                ▼                ▼                ▼
   ┌──────────┐    ┌──────────────┐  ┌──────────┐    ┌──────────────┐
   │code/git/ │    │VectorSearch  │  │  Plugin  │    │  Database    │
   │docs index│    │KeywordSearch │  │instances │    │  HNSWIndex   │
   │  plugins │    │ContextBuilder│  │          │    │  Embedding   │
   └──────────┘    └──────────────┘  └──────────┘    └──────────────┘
```

**Three layers at a glance:**

| Layer | Purpose | Key files |
|-------|---------|-----------|
| **Facade / API** | Public surface, delegation, guards | `brainbank.ts`, `api/` |
| **Domain / Plugin** | Indexing, searching, learning | `indexers/`, `domain/` |
| **Infrastructure** | DB, vectors, embeddings | `db/`, `providers/`, `services/` |

---

## 2. Directory Structure

```
src/
├── brainbank.ts              ← Main facade (BrainBank class)
├── index.ts                  ← Public exports
├── types.ts                  ← All TypeScript interfaces
│
├── api/
│   ├── index-api.ts          ← Indexing orchestration (delegates to plugins)
│   └── search-api.ts         ← All search/context operations
│
├── bootstrap/
│   ├── initializer.ts        ← Two-phase startup (early + late)
│   └── registry.ts           ← Plugin registration and lookup
│
├── config/
│   └── defaults.ts           ← Default config values + resolveConfig()
│
├── db/
│   ├── database.ts           ← SQLite wrapper (better-sqlite3)
│   ├── rows.ts               ← TypeScript row interfaces
│   └── schema.ts             ← DDL: all tables, triggers, FTS5 virtual tables
│
├── domain/
│   ├── collection.ts         ← Generic KV store with vector+BM25 search
│   ├── memory/
│   │   ├── memory-plugin.ts  ← Plugin entry point for agent learning
│   │   ├── pattern-store.ts  ← CRUD + vector search for LearningPattern
│   │   ├── consolidator.ts   ← Prune failed patterns, dedup near-duplicates
│   │   └── pattern-distiller.ts ← Aggregate patterns → strategy text

│
├── indexers/
│   ├── base.ts               ← Plugin interfaces, @expose decorator, type guards
│   ├── languages.ts          ← Supported extensions, ignore lists
│   ├── code/
│   │   ├── code-plugin.ts    ← Plugin entry point for code indexing
│   │   ├── code-walker.ts    ← File system walker + incremental indexer
│   │   ├── code-chunker.ts   ← Tree-sitter AST chunker (+ sliding window fallback)
│   │   ├── grammars.ts       ← Tree-sitter grammar registry (30+ languages)
│   │   ├── import-extractor.ts ← Regex-based import graph extraction
│   │   └── symbol-extractor.ts ← AST symbol/call-ref extraction
│   ├── git/
│   │   ├── git-plugin.ts     ← Plugin entry point for git history
│   │   ├── git-indexer.ts    ← Commit parsing, embedding, co-edit analysis
│   │   └── co-edit-analyzer.ts ← File co-occurrence queries
│   └── docs/
│       ├── docs-plugin.ts    ← Plugin entry point for document collections
│       ├── docs-indexer.ts   ← Smart markdown chunker + incremental indexer
│       └── document-search.ts ← Hybrid search for doc collections
│
├── providers/
│   ├── embeddings/
│   │   ├── local-embedding.ts         ← @xenova/transformers WASM (384d)
│   │   ├── openai-embedding.ts        ← OpenAI API (1536d/3072d)
│   │   ├── perplexity-embedding.ts    ← Perplexity standard (1024d/2560d)
│   │   ├── perplexity-context-embedding.ts ← Perplexity contextualized
│   │   └── resolve.ts                 ← Key → Provider factory
│   ├── rerankers/
│   │   └── qwen3-reranker.ts          ← Qwen3 cross-encoder via node-llama-cpp
│   └── vector/
│       └── hnsw-index.ts              ← HNSW wrapper (hnswlib-node)
│
├── search/
│   ├── types.ts              ← SearchStrategy interface + SearchOptions
│   ├── context-builder.ts    ← Formats search results → LLM-ready markdown (includes graph expansion engine)
│   ├── keyword/
│   │   └── keyword-search.ts ← FTS5 BM25 search across all tables
│   └── vector/
│       ├── vector-search.ts  ← Multi-HNSW search (code + git + patterns)
│       ├── mmr.ts            ← Maximum Marginal Relevance diversification
│       └── rerank.ts         ← Position-aware score blending with reranker
│
├── services/
│   ├── embedding-meta.ts     ← Track/detect embedding provider in DB
│   ├── reembed.ts            ← Re-generate all vectors (no re-parsing)
│   └── watch.ts              ← fs.watch auto-reindex on file changes
│
└── cli/
    ├── index.ts              ← CLI dispatcher
    ├── factory.ts            ← createBrain() with config/discovery
    ├── utils.ts              ← Colors, arg parsing, result printer
    └── commands/
        ├── index-cmd.ts      ← brainbank index
        ├── search.ts         ← brainbank search/hsearch/ksearch
        ├── docs.ts           ← brainbank docs/dsearch
        ├── collection.ts     ← brainbank collection add/list/remove
        ├── context.ts        ← brainbank context
        ├── kv.ts             ← brainbank kv add/search/list/trim/clear
        └── system.ts         ← brainbank stats/reembed/watch/serve
```

```
packages/
├── code/                             ← @brainbank/code (separate npm package)
│   ├── src/
│   │   ├── index.ts                 ← Package entry point
│   │   ├── code-plugin.ts           ← Plugin factory (imports from 'brainbank' peer dep)
│   │   ├── code-walker.ts           ← File walker + incremental indexer
│   │   ├── code-chunker.ts          ← Tree-sitter AST chunker (+ sliding window fallback)
│   │   ├── grammars.ts              ← Grammar registry (20 languages)
│   │   ├── import-extractor.ts      ← Regex-based import graph extraction
│   │   └── symbol-extractor.ts      ← AST symbol/call-ref extraction
│   ├── package.json                 ← peerDependency: brainbank >=0.7.0
│   └── CHANGELOG.md
├── mcp/                             ← @brainbank/mcp
└── memory/                          ← @brainbank/memory
```

### Package Dependency Graph

```
@brainbank/code
    └── peerDep: brainbank (core)
                    ├── better-sqlite3
                    ├── hnswlib-node
                    └── picomatch

@brainbank/mcp ──── peerDep: brainbank
@brainbank/memory ── peerDep: brainbank
```

> **DB Schema Ownership**: Core owns all table schemas (`code_chunks`, `code_imports`, `code_symbols`, `code_refs`, `git_commits`, etc.). Plugins only populate them. The `context-builder.ts` in core reads these tables directly for graph expansion without importing any plugin code.

---

## 3. Core Orchestrator — BrainBank Facade

**Pattern: Facade + EventEmitter**

`BrainBank` is a **thin facade**. It owns state, enforces initialization
guards, and delegates every operation to a specialized subsystem. It contains
**no business logic itself**.

```
┌────────────────────────────────────────────────────────────────────────┐
│                           BrainBank                                    │
│                     extends EventEmitter                               │
│                                                                        │
│  STATE                                                                 │
│  ──────────────────────────────────────────────────────────────────   │
│  _config: ResolvedConfig          ← merged defaults + user config      │
│  _db: Database                    ← SQLite connection                  │
│  _embedding: EmbeddingProvider    ← active embedding model             │
│  _registry: PluginRegistry        ← all registered plugins             │
│  _searchAPI: SearchAPI            ← all search/context ops             │
│  _indexAPI: IndexAPI              ← all indexing ops                   │
│  _collections: Map<name,Collection> ← KV collection cache             │
│  _kvHnsw: HNSWIndex               ← HNSW for KV collections           │
│  _kvVecs: Map<id,Float32Array>    ← vector cache for KV               │
│  _sharedHnsw: Map<type,{hnsw,vecCache}> ← shared pool (code/git)      │
│  _initialized: boolean            ← init guard flag                   │
│  _initPromise: Promise|null       ← prevents concurrent inits         │
│  _watcher: Watcher|undefined      ← fs.watch handle                   │
│                                                                        │
│  PUBLIC API                                                            │
│  ──────────────────────────────────────────────────────────────────   │
│  .use(plugin)          → registers plugin, chainable                   │
│  .initialize(opts)     → two-phase init (idempotent)                   │
│  .collection(name)     → get/create KV Collection                     │
│  .index(opts)          → delegates to IndexAPI                        │
│  .indexCode(opts)      → delegates to IndexAPI                        │
│  .indexGit(opts)       → delegates to IndexAPI                        │
│  .search(query)        → delegates to SearchAPI                       │
│  .hybridSearch(query)  → delegates to SearchAPI                       │
│  .searchBM25(query)    → delegates to SearchAPI                       │
│  .searchCode(query)    → delegates to SearchAPI                       │
│  .searchCommits(query) → delegates to SearchAPI                       │
│  .getContext(task)     → delegates to SearchAPI                       │
│                                                                        │
│  PLUGIN-INJECTED (@expose)                                             │
│  ──────────────────────────────────────────────────────────────────   │
│  .addCollection(coll)  → injected from docs plugin via @expose        │
│  .indexDocs(opts)      → injected from docs plugin via @expose        │
│  .searchDocs(query)    → injected from docs plugin via @expose        │
│  .addContext(...)      → injected from docs plugin via @expose        │
│  .removeContext(...)   → injected from docs plugin via @expose        │
│  .listCollections()    → injected from docs plugin via @expose        │
│  .listContexts()       → injected from docs plugin via @expose        │
│  .suggestCoEdits(file) → injected from git plugin via @expose         │
│  .fileHistory(file)    → injected from git plugin via @expose         │
│  .stats()              → delegates to each plugin's stats()           │
│  .reembed(opts)        → delegates to reembedAll service              │
│  .watch(opts)          → delegates to createWatcher service           │
│  .close()              → cleanup all resources                        │
│                                                                        │
│  GUARDS                                                                │
│  ──────────────────────────────────────────────────────────────────   │
│  _requireInit(method)  → throws if not initialized                    │
│  _bindExposedMethods() → discovers @expose methods, binds to this     │
│                                                                        │
│  EVENTS EMITTED                                                        │
│  ──────────────────────────────────────────────────────────────────   │
│  'initialized'  → { plugins: string[] }                               │
│  'indexed'      → { code, git, docs }                                 │
│  'docsIndexed'  → { [collName]: stats }                               │
│  'reembedded'   → ReembedResult                                       │
│  'progress'     → string message                                      │
└────────────────────────────────────────────────────────────────────────┘
```

**Initialization guard pattern:**

```
caller calls brain.search("query")
         │
         ▼
 await this.initialize()   ← auto-init if not already done
         │
         ├─ _initialized === true  ──────────────────► continue to _searchAPI.search()
         │
         ├─ _initPromise !== null  ──────────────────► await existing promise (dedup)
         │
         └─ neither                ──────────────────► _runInitialize()
                                                              │
                                                    sets _initPromise
                                                    runs two-phase init
                                                    sets _initialized = true
                                                    clears _initPromise
```

---

## 4. Two-Phase Initialization

**Pattern: Two-Phase Construction + Template Method**

The `Initializer` class splits startup into two phases because `collection()`
must work during Phase 2 (when plugins call `ctx.collection()` in their
`initialize()` method), but `collection()` needs `_kvHnsw` which is created
in Phase 1.

```
BrainBank._runInitialize()
│
├── PHASE 1: initializer.early()
│   │
│   ├── new Database(config.dbPath)         ← open SQLite, create schema
│   ├── _resolveEmbedding(db)               ← local | openai | perplexity | auto from DB
│   ├── detectProviderMismatch(db, emb)     ← compare stored dims vs current
│   │     └── if mismatch && !force → throw ← force user to reembed first
│   ├── setEmbeddingMeta(db, embedding)     ← store provider name + dims
│   ├── new HNSWIndex(...).init()           ← KV vector index
│   │
│   └── returns EarlyInit { db, embedding, kvHnsw, skipVectorLoad }
│
│   BrainBank assigns: this._db, this._embedding, this._kvHnsw
│   ← NOW collection() works (it needs _kvHnsw)
│
└── PHASE 2: initializer.late(earlyResult, registry, sharedHnsw, kvVecs, getCollection)
    │
    ├── Load KV vectors (HNSW file → if stale → rebuild from SQLite)
    │     tryLoad(kvIndexPath, kvCount)
    │     └── success → loadVecCache()     ← populate Map only
    │     └── fail    → loadVectors()      ← insert into HNSW + Map
    │
    ├── _buildPluginContext(...)            ← creates the PluginContext object
    │     with: db, embedding, config,
    │           createHnsw(), loadVectors(), getOrCreateSharedHnsw(), collection()
    │
    ├── for each plugin in registry:
    │     await plugin.initialize(ctx)      ← each plugin sets itself up
    │
    ├── _bindExposedMethods()               ← discovers @expose methods, binds to BrainBank
    │
    ├── saveAllHnsw(config.dbPath, kvHnsw, sharedHnsw)  ← persist to disk
    │
    └── _buildSearchLayer(db, embedding, registry, sharedHnsw)
          │
          ├── sharedHnsw.get('code')  → codeMod
          ├── sharedHnsw.get('git')   → gitMod
          ├── registry.firstByType('memory') → memMod
          │
          ├── if none exist → return {}  (no search available)
          │
          ├── new VectorSearch({ codeHnsw, gitHnsw, patternHnsw, ... })
          ├── new KeywordSearch(db)
          ├── new ContextBuilder(search, firstGit?.coEdits, db)
          │
          └── returns LateInit { search, bm25, contextBuilder }
```

**HNSW Load Strategy (fast startup):**

```
startup
   │
   ├── hnsw.tryLoad("hnsw-code.index", countFromSQLite)
   │     │
   │     ├── file exists AND count matches → load graph file ─► loadVecCache() only
   │     │                                  ← ~50ms startup
   │     │
   │     └── file missing OR count mismatch → loadVectors()
   │                                          ← rebuild HNSW from SQLite BLOBs
   │                                          ← slower but always correct
   │
   └── After all plugins initialized:
         saveAllHnsw() → writes .index files for next startup
```

---

## 5. Plugin Registry

**Pattern: Registry + Type-Prefix Matching**

```
┌────────────────────────────────────────────────────┐
│                  PluginRegistry                    │
│                                                    │
│  _map: Map<string, Plugin>                         │
│                                                    │
│  register(plugin)   → _map.set(plugin.name, p)    │
│                                                    │
│  has('code')        → checks 'code' exact          │
│                        OR 'code:frontend'          │
│                        OR 'code:backend'  ← prefix │
│                                                    │
│  get('code')        → ALIASES lookup first         │
│                     → exact match                  │
│                     → first type-prefix match      │
│                     → throw if not found           │
│                                                    │
│  allByType('code')  → ['code', 'code:frontend',   │
│                         'code:backend']            │
│                        (all with prefix 'code:')   │
│                                                    │
│  firstByType('git') → first plugin matching 'git'  │
│                        or 'git:*'                  │
│                                                    │
│  all                → all Plugin instances         │
│  names              → all plugin name strings      │
│  raw                → the underlying Map           │
└────────────────────────────────────────────────────┘

Multi-repo example:
  brain
    .use(code({ name: 'code:frontend', repoPath: './fe' }))
    .use(code({ name: 'code:backend',  repoPath: './be' }))
    .use(git({ name: 'git:frontend',   repoPath: './fe' }))
    .use(git({ name: 'git:backend',    repoPath: './be' }))

  registry._map = {
    'code:frontend' → CodePlugin,
    'code:backend'  → CodePlugin,
    'git:frontend'  → GitPlugin,
    'git:backend'   → GitPlugin,
  }

  registry.allByType('code') → [CodePlugin(fe), CodePlugin(be)]
  registry.has('code')       → true (prefix match)
  registry.has('memory')     → false
```

---

## 6. Plugin System & Plugin Context

**Pattern: Plugin (Extension Point) + Context Object**

Every plugin receives a `PluginContext` during `initialize()`. This context
is a **dependency injection container** — the plugin gets everything it needs
without being coupled to `BrainBank` directly.

```
┌─────────────────────────────────────────────────────────────┐
│                     Plugin Interface                        │
│                                                             │
│  readonly name: string          ← unique identifier        │
│  initialize(ctx: PluginContext) ← setup phase               │
│  stats?(): Record<string,any>  ← optional stats            │
│  close?(): void                 ← optional cleanup          │
└─────────────────────────────────────────────────────────────┘

Extended Capability Interfaces:

┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ IndexablePlugin  │  │ SearchablePlugin  │  │ WatchablePlugin  │
│                  │  │                  │  │                  │
│ index(opts)      │  │ search(q, opts)  │  │ onFileChange()   │
│   → IndexResult  │  │   → SearchResult │  │ watchPatterns()  │
└──────────────────┘  └──────────────────┘  └──────────────────┘

┌──────────────────────────────────────────┐
│           CollectionPlugin               │
│                                          │
│ addCollection(DocumentCollection)        │
│ removeCollection(name)                   │
│ listCollections() → DocumentCollection[] │
│ indexDocs(opts) → Record<...>            │
│ searchDocs(query, opts) → SearchResult[] │
│ search(query, opts) → SearchResult[]     │
│ addContext?(collection, path, context)   │
│ removeContext?(collection, path)         │
│ listContexts?() → any[]                  │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│         @expose Decorator                │
│                                          │
│  Marks plugin methods for injection      │
│  onto the BrainBank instance.            │
│                                          │
│  class MyPlugin implements Plugin {      │
│      @expose                             │
│      myMethod() { ... }                  │
│  }                                       │
│                                          │
│  After initialize():                     │
│    brain.myMethod() → plugin.myMethod()  │
│                                          │
│  Collision detection prevents overrides. │
│  Uses Symbol('brainbank:exposed') on     │
│  the constructor to store method names.  │
└──────────────────────────────────────────┘

Type Guards (runtime capability detection):
  isIndexable(p)         → p has .index() function
  isSearchable(p)        → p has .search() function
  isWatchable(p)         → p has .onFileChange() + .watchPatterns()
  isCollectionPlugin(p)  → p has .addCollection() + .listCollections()
```

**PluginContext — what every plugin receives:**

```
PluginContext
│
├── db: Database                 ← shared SQLite (all plugins share one DB)
├── embedding: EmbeddingProvider ← global embedding (or per-plugin override)
├── config: ResolvedConfig       ← merged configuration
│
├── createHnsw(maxElements?, dims?)
│     → new HNSWIndex(...).init()
│     ← plugins create their OWN private index (e.g. docs, memory)
│
├── loadVectors(table, idCol, hnsw, cache)
│     → reads embedding BLOBs from SQLite
│     → inserts into HNSW + populates Map<id, Float32Array>
│     ← called during plugin initialize() to restore from disk
│
├── getOrCreateSharedHnsw(type, maxElements?, dims?)
│     → checks sharedHnsw Map for existing index
│     → if new: creates HNSWIndex, registers in map, returns { isNew: true }
│     → if existing: returns same index, { isNew: false }
│     ← code:frontend and code:backend share ONE HNSW
│        only first plugin to call this loads the vectors
│
└── collection(name)
      → brain.collection(name)
      ← plugins can create KV collections during initialize()
         e.g. a plugin storing its config in a collection
```

---

## 7. Built-in Plugins

### 7.1 Code Plugin

**Purpose:** Walk a git repository, chunk source files semantically using
Tree-sitter AST, embed chunks, store in SQLite + HNSW.

```
code({ repoPath: '.', name: 'code', ignore: ['sdk/**', 'vendor/**'] })
         │
         ▼
   CodePlugin.initialize(ctx)
         │
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── shared = ctx.getOrCreateSharedHnsw('code', undefined, embedding.dims)
         │     └── all code plugins share ONE HNSW index
         ├── if shared.isNew:
         │     ctx.loadVectors('code_vectors', 'chunk_id', hnsw, vecCache)
         └── new CodeWalker(repoPath, { db, hnsw, vecCache, embedding }, maxFileSize, ignore)
              └── ignore patterns compiled once via picomatch ({ dot: true })


CodePlugin.index({ forceReindex, onProgress })
         │
         ▼
   CodeWalker.index()
         │
         ├── _walkRepo(repoPath)         ← recursive dir traversal
         │     └── filters: IGNORE_DIRS, IGNORE_FILES, SUPPORTED_EXTENSIONS,
         │                  maxFileSize, custom ignore globs (picomatch)
         │         dirs:  isIgnoredDir(name) || _isIgnored(relDir)
         │         files: isIgnoredFile(name) || _isIgnored(relPath)
         │
         ├── for each file:
         │     ├── read content
         │     ├── compute FNV-1a hash
         │     ├── check indexed_files table (skip if same hash)
         │     └── _indexFile(filePath, rel, content, hash)
         │
         └── returns { indexed, skipped, chunks }


CodeWalker._indexFile()
         │
         ├── CodeChunker.chunk(filePath, content, language)
         │     │
         │     ├── if file ≤ MAX_LINES → single 'file' chunk
         │     │
         │     ├── _ensureParser() → lazy-load tree-sitter
         │     ├── _loadGrammar(language) → lazy-load grammar package
         │     │
         │     ├── if parser + grammar available:
         │     │     parser.setLanguage(grammar)
         │     │     tree = parser.parse(content)
         │     │     _extractChunks(rootNode) → walk top-level AST nodes
         │     │       ├── export_statement → unwrap, process inner
         │     │       ├── decorated_definition → unwrap decorator
         │     │       └── class/function/interface/variable → chunk
         │     │             └── large class → split into method chunks
         │     │
         │     └── fallback: _chunkGeneric() → sliding window (overlap=5)
         │
         ├── extractImports(content, language)  ← regex per language
         │     → ['react', 'express', 'lodash']
         │
         ├── build embeddingTexts:
         │     "File: src/api.ts\nImports: express, zod\nfunction: handleRequest\n<code>"
         │
         ├── embedding.embedBatch(embeddingTexts)  ← batch embed all chunks
         │
         ├── extractSymbols(tree.rootNode, rel, language)
         │     → [{ name: 'MyClass', kind: 'class', line: 10 }, ...]
         │
         ├── DB TRANSACTION:
         │     ├── DELETE old chunks (+ cascade: code_vectors, code_refs)
         │     ├── DELETE old imports + symbols
         │     ├── INSERT code_chunks (returns IDs)
         │     ├── INSERT code_vectors (embedding BLOBs)
         │     ├── hnsw.add(vec, id)  ← update live HNSW
         │     ├── vecCache.set(id, vec)
         │     ├── INSERT code_imports (import graph)
         │     ├── INSERT code_symbols (symbol definitions)
         │     ├── INSERT code_refs (call references per chunk)
         │     └── UPSERT indexed_files (hash + timestamp)
         │
         └── returns chunk count


Tree-sitter grammar loading:
         │
         ├── GRAMMARS['typescript'] → tryGrammar('tree-sitter-typescript', nodeTypes, 'typescript')
         ├── GRAMMARS['python']     → tryGrammar('tree-sitter-python', nodeTypes)
         ├── ...30+ languages
         │
         └── tryGrammar():
               try require(pkg)        ← CJS fast path
               catch ERR_REQUIRE_ASYNC → await import(pkg)  ← ESM fallback
               catch other             → throw "install pkg"


CodePlugin.stats():
  { files: count(DISTINCT file_path), chunks: count(*), hnswSize: hnsw.size }
```

### 7.2 Git Plugin

**Purpose:** Read git history via `simple-git`, embed commit messages +
diffs, analyze co-editing patterns between files.

```
git({ depth: 500 })
         │
         ▼
   GitPlugin.initialize(ctx)
         │
         ├── shared = ctx.getOrCreateSharedHnsw('git', 500_000, embedding.dims)
         ├── if shared.isNew:
         │     ctx.loadVectors('git_vectors', 'commit_id', hnsw, vecCache)
         ├── new GitIndexer(repoPath, { db, hnsw, vecCache, embedding }, maxDiffBytes)
         └── new CoEditAnalyzer(db)


GitIndexer.index({ depth, onProgress })
         │
         ├── simpleGit(repoPath)         ← dynamic import simple-git
         ├── git.log({ maxCount: depth }) ← get N commits
         │
         ├── _prepareStatements()         ← hoist SQL stmts out of loop
         │
         ├── PHASE 1: _collectCommits() [async git calls]
         │     for each commit:
         │       ├── check if hash exists in git_commits + has vector
         │       ├── skip if already indexed (has_vector)
         │       ├── if zombie (data but no vector) → DELETE and re-process
         │       └── _parseCommit():
         │             ├── git show --numstat → filesChanged, additions, deletions
         │             ├── git show --unified=3 → diff (truncated to maxDiffBytes)
         │             └── build text:
         │                   "Commit: fix null check\nAuthor: Jane\nFiles: api.ts\nChanges:\n..."
         │
         ├── embedding.embedBatch(all texts)  ← single batch for all new commits
         │
         ├── PHASE 2: _insertCommits() [one DB transaction]
         │     ├── INSERT git_commits
         │     ├── INSERT commit_files (one row per file per commit)
         │     └── INSERT git_vectors
         │
         └── PHASE 3: _updateHnsw()
               ├── hnsw.add(vec, commitId)
               ├── vecCache.set(commitId, vec)
               └── _computeCoEdits(newCommitIds)
                     ├── query commit_files for new commits
                     ├── group files by commit
                     └── for each commit with 2-20 files:
                           for each pair (a, b): sort → UPSERT co_edits(a,b, count+1)


CoEditAnalyzer.suggest(filePath, limit):
   SELECT file, count FROM co_edits
   WHERE file_a = ? OR file_b = ?
   ORDER BY count DESC LIMIT ?
   → [{ file: 'src/db.ts', count: 23 }, ...]


GitPlugin.fileHistory(filePath, limit):
   JOIN git_commits + commit_files WHERE file_path LIKE '%api.ts%'
   → [{ short_hash, message, author, date, additions, deletions }]


GitPlugin.stats():
  { commits, filesTracked, coEdits, hnswSize }
```

### 7.3 Docs Plugin

**Pattern: CollectionPlugin + Smart Chunker**

**Purpose:** Index folders of markdown/text files. Supports multiple named
collections (e.g. 'docs', 'wiki'). Incremental by content hash.

```
docs()
         │
         ▼
   DocsPlugin.initialize(ctx)
         │
         ├── ctx.createHnsw(undefined, embedding.dims)  ← PRIVATE index (not shared)
         ├── ctx.loadVectors('doc_vectors', 'chunk_id', hnsw, vecCache)
         ├── new DocsIndexer(db, embedding, hnsw, vecCache)
         └── new DocumentSearch({ db, embedding, hnsw, vecCache, reranker })


DocsPlugin.addCollection({ name, path, pattern, ignore, context })
   → UPSERT collections table


DocsPlugin.indexDocs({ collections?, onProgress })
   → for each collection in DB:
       DocsIndexer.indexCollection(name, path, pattern, { ignore, onProgress })


DocsIndexer.indexCollection()
         │
         ├── _walkFiles(absDir, pattern, ignore)
         │     └── recursive readdir, filter by extension, apply ignore globs
         │
         ├── for each file:
         │     ├── read content, compute SHA-256 hash (first 16 chars)
         │     ├── _isUnchanged(): check doc_chunks has rows with same hash + vectors
         │     ├── skip if unchanged
         │     └── _indexFile(collection, relPath, content, hash)
         │
         └── returns { indexed, skipped, chunks }


DocsIndexer._indexFile()
         │
         ├── _extractTitle(content)      ← first H1/H2/H3 heading or filename
         ├── _smartChunk(content)        ← heading-aware markdown splitter
         │     │
         │     ├── if content ≤ TARGET_CHARS (3000) → single chunk
         │     ├── _findBreakPoints(lines):
         │     │     score each line:
         │     │       H1=100, H2=90, H3=80, code-fence=80, ---=60, blank=20, list=5
         │     │     returns [{pos, score}, ...]
         │     │
         │     └── greedy split loop:
         │           find best break in window [targetEnd-600, targetEnd+300]
         │           score = breakScore * (1 - (distance/window)^2 * 0.7)
         │           flush remainder: merge if < MIN_CHUNK_CHARS (200)
         │
         ├── TRANSACTION: INSERT doc_chunks (collection, file_path, title, content, seq, hash)
         ├── embedding.embedBatch(["title: X | text: Y", ...])
         ├── TRANSACTION: INSERT doc_vectors
         ├── hnsw.add() + vecCache.set() for each chunk
         │
         └── returns chunk count


DocsPlugin.search() → DocumentSearch.search()    (see §9.8)
DocsPlugin.addContext(collection, path, context) → UPSERT path_contexts
DocsPlugin.listContexts()                        → SELECT path_contexts
```

### 7.4 Memory Plugin — Agent Learning

**This is the most conceptually unique plugin. Here is a full explanation:**

**What is it?**
The Memory Plugin is an **AI agent learning system**. When an AI agent
completes a task, it can call `brain.plugin('memory').learn({ ... })` to
record what it did, how it did it, and whether it succeeded. Over time,
the agent can search for similar past tasks and apply the same approach.

Think of it as the agent's **episodic memory** — "I've done something like
this before, here's what worked."

**Three sub-components:**

```
MemoryPlugin
│
├── PatternStore     ← CRUD: store/search LearningPattern records
├── Consolidator     ← Maintenance: prune failures, dedup near-duplicates
└── PatternDistiller ← Synthesis: aggregate patterns → strategy text
```

```
memory()
         │
         ▼
   MemoryPlugin.initialize(ctx)
         │
         ├── ctx.createHnsw(100_000)    ← PRIVATE index for patterns
         ├── ctx.loadVectors('memory_vectors', 'pattern_id', hnsw, vecCache)
         ├── new PatternStore({ db, hnsw, vectorCache, embedding })
         ├── new Consolidator(db, vecCache)
         └── new PatternDistiller(db)


LearningPattern interface:
  {
    taskType: 'api' | 'refactor' | 'debug' | string  ← category
    task:     "Add rate limiting to the auth endpoint" ← what was asked
    approach: "Used express-rate-limit with Redis store" ← how it was done
    outcome?:  "Reduced abuse by 95%, no false positives" ← what happened
    successRate: 0.9           ← 0.0 (failure) to 1.0 (perfect success)
    critique?:  "Should have set per-user limits, not global" ← lesson
    tokensUsed?: 2400          ← optional cost tracking
    latencyMs?:  8200          ← optional performance tracking
  }


MemoryPlugin.learn(pattern)
         │
         ▼
   PatternStore.learn(pattern)
         │
         ├── INSERT memory_patterns (task_type, task, approach, outcome,
         │                          success_rate, critique, tokens_used, latency_ms)
         ├── text = "api Add rate limiting to the auth endpoint Used express-rate-limit..."
         ├── embedding.embed(text)         ← embed the combined text
         ├── INSERT memory_vectors (pattern_id, embedding BLOB)
         ├── hnsw.add(vec, id)
         ├── vectorCache.set(id, vec)
         │
         └── if patternStore.count % 50 === 0:
               consolidator.consolidate()   ← auto-maintenance every 50 patterns


MemoryPlugin.search("how to add rate limiting", k=4)
         │
         ▼
   PatternStore.search(query, k, minSuccess=0.5)
         │
         ├── embedding.embed(query)
         ├── hnsw.search(queryVec, k*2)           ← over-fetch
         ├── SELECT memory_patterns WHERE id IN (...) AND success_rate >= 0.5
         └── sort by vector score, slice to k
             → [{ taskType, task, approach, successRate, score }, ...]


MemoryPlugin.consolidate()
         │
         ▼
   Consolidator.consolidate()
         │
         ├── prune(maxAgeDays=90, minSuccess=0.3)
         │     DELETE WHERE success_rate < 0.3 AND created_at < 90 days ago
         │     ← removes old failed attempts
         │
         └── dedup(threshold=0.95)
               for each pair of cached vectors:
                 cosineSimilarity(vecA, vecB) > 0.95?
                   → keep the one with higher success_rate
                   → DELETE the other from DB + vectorCache
               ← removes near-duplicate patterns


MemoryPlugin.distill('api')
         │
         ▼
   PatternDistiller.distill(taskType, topK=10)
         │
         ├── SELECT top 10 patterns WHERE task_type='api' AND success_rate >= 0.7
         │     ORDER BY success_rate DESC
         │
         ├── build strategy text:
         │     Strategy for "api" (8 patterns, avg success 87%):
         │     • Used express-rate-limit with Redis store (90%)
         │       └ Should set per-user limits
         │     • Validated input with Zod before processing (85%)
         │     ...
         │
         ├── UPSERT distilled_strategies (task_type, strategy, confidence, updated_at)
         │
         └── returns { taskType, strategy, confidence, updatedAt }


Data tables used by Memory:
  memory_patterns      ← LearningPattern records
  memory_vectors       ← embedding BLOBs (FK → memory_patterns)
  distilled_strategies ← synthesized strategy text per taskType
  fts_patterns         ← FTS5 virtual table for BM25 search
```

**Auto-maintenance loop:**

```
Agent calls learn() 50 times
         │
         ▼
patternStore.count % 50 === 0
         │
         ▼
consolidator.consolidate()
    │
    ├── prune: DELETE patterns older than 90 days with success < 30%
    │          ← keeps the database lean
    │
    └── dedup: find pairs with cosine_sim > 0.95
               keep higher success_rate
               ← prevents redundant near-identical patterns
```



---

## 8. Domain Layer

### 8.1 Collection — Generic KV Store

**Pattern: Repository + Hybrid Search**

`Collection` is the **universal data primitive**. Store anything as text
with optional metadata and tags. Search by meaning or keyword. Built on
the same HNSW+FTS5 infrastructure as code/git but fully generic.

```
brain.collection('debug_errors')
         │
         ▼
   BrainBank.collection(name)
         │
         ├── check _collections Map cache
         └── new Collection(name, db, embedding, kvHnsw, kvVecs, reranker)
             ← ALL collections share a SINGLE kvHnsw (not per-collection!)
             ← kvHnsw is a global KV HNSW index


Collection.add(content, options)
         │
         ├── embedding.embed(content)    ← embed FIRST (if this fails, no orphan rows)
         ├── INSERT kv_data (collection, content, meta_json, tags_json, expires_at)
         ├── INSERT kv_vectors (data_id, embedding BLOB)
         ├── kvHnsw.add(vec, id)
         └── kvVecs.set(id, vec)
             ← TTL: expires_at = now + parseDuration('7d')
                    parseDuration('30d') → 2592000 seconds


Collection.search(query, { k=5, mode='hybrid', minScore=0.15, tags? })
         │
         ├── _pruneExpired() → DELETE expired rows + remove from HNSW
         │
         ├── mode='keyword' → _searchBM25(query, k, minScore)
         ├── mode='vector'  → _searchVector(query, k, minScore)
         └── mode='hybrid':
               parallel: _searchVector() + _searchBM25()
               → RRF fusion
               → re-map fused results back to CollectionItem objects
               → if reranker: rerank results
               → _filterByTags(results, tags)
               ← tags filter: item must have ALL specified tags


IMPORTANT: Shared HNSW problem
  All collections (debug_errors, decisions, ...) share ONE kvHnsw.
  When searching, we over-fetch (k * 10) and filter by collection in SQL:
    SELECT * FROM kv_data WHERE id IN (?) AND collection = ?
  ← This compensates for cross-collection contamination in shared HNSW.


Collection.addMany(items[])
  → batch embed all texts at once (one embedBatch call)
  → single DB transaction for all inserts
  → HNSW updated AFTER transaction succeeds (no orphan risk)


Collection.trim({ keep: 100 })
  → SELECT id ORDER BY created_at DESC OFFSET 100
  → _removeById for each
  → keeps only the 100 most recent


Collection.prune({ olderThan: '30d' })
  → DELETE where created_at < (now - 30 days)


Data tables:
  kv_data     ← text content + metadata JSON + tags JSON + TTL
  kv_vectors  ← embedding BLOBs (FK → kv_data, CASCADE DELETE)
  fts_kv      ← FTS5 virtual table (content, collection)
```

### 8.2 PatternStore

(See §7.4 — part of Memory Plugin. Handles CRUD + vector search for
`LearningPattern` records in `memory_patterns` + `memory_vectors`.)

### 8.3 Consolidator

(See §7.4 — maintenance for Memory Plugin. Prunes old failures, deduplicates
near-identical patterns via cosine similarity comparison.)

### 8.4 PatternDistiller

(See §7.4 — synthesis for Memory Plugin. Aggregates top patterns by
`taskType` into a single readable strategy stored in `distilled_strategies`.)



---

## 9. Search Layer

### 9.1 SearchStrategy Interface

**Pattern: Strategy**

Both `VectorSearch` and `KeywordSearch` implement the same interface,
making them interchangeable and composable:

```
interface SearchStrategy {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  rebuild?(): void
}

interface SearchOptions {
  codeK?:    number   // max code results
  gitK?:     number   // max git results
  patternK?: number   // max pattern results
  minScore?: number   // filter threshold
  useMMR?:   boolean  // diversify results
  mmrLambda?: number  // MMR tradeoff (0=diverse, 1=relevant)
}
```

### 9.2 VectorSearch

**Pattern: Strategy + Composite (multi-index)**

Searches across up to three HNSW indices simultaneously:

```
VectorSearch.search(query, options)
         │
         ├── embedding.embed(query) → Float32Array
         │
         ├── _searchCode(queryVec, codeK, minScore, useMMR, mmrLambda)
         │     └── if useMMR: searchMMR(codeHnsw, queryVec, codeVecs, k, lambda)
         │         else:      codeHnsw.search(queryVec, k)
         │         → SELECT * FROM code_chunks WHERE id IN (?)
         │         → filter score >= minScore
         │         → push CodeResult objects
         │
         ├── _searchGit(queryVec, gitK, minScore)
         │     └── gitHnsw.search(queryVec, k*2)   ← over-fetch (merges filter)
         │         → SELECT * FROM git_commits WHERE id IN (?) AND is_merge=0
         │         → push CommitResult objects
         │
         ├── _searchPatterns(queryVec, patternK, minScore, useMMR, mmrLambda)
         │     └── if useMMR: searchMMR(patternHnsw, ...)
         │         → SELECT * FROM memory_patterns WHERE id IN (?) AND success_rate >= 0.5
         │         → push PatternResult objects
         │
         ├── results.sort((a,b) => b.score - a.score)  ← merge-sort all results
         │
         └── if reranker: rerank(query, results, reranker)
```

**SearchResult discriminated union:**

```
type SearchResult =
  | { type: 'code',       score, filePath, content, metadata: CodeResultMetadata }
  | { type: 'commit',     score, content, metadata: CommitResultMetadata }
  | { type: 'pattern',    score, content, metadata: PatternResultMetadata }
  | { type: 'document',   score, filePath, content, metadata: DocumentResultMetadata }
  | { type: 'collection', score, content, metadata: Record<string,any> }

Type guards: isCodeResult(), isCommitResult(), isDocumentResult(), ...
Pattern match: matchResult(result, { code: r=>..., commit: r=>..., _: r=>... })
```

### 9.3 KeywordSearch (BM25)

**Uses SQLite FTS5 with Porter stemming + unicode61 tokenizer.**

```
KeywordSearch.search(query, { codeK, gitK, patternK })
         │
         ├── sanitizeFTS(query)
         │     1. strip FTS5 special chars: {}[]()^~*:
         │     2. strip boolean operators: AND OR NOT NEAR
         │     3. split compound words:
         │          "MagicLinkCallback" → "Magic Link Callback"
         │          "tenant_worker"     → "tenant worker"
         │     4. quote each word: "magic" "link" "callback"
         │        → implicit AND (all words must match)
         │
         ├── _searchCode(ftsQuery, rawQuery, k, results)
         │     ├── FTS5 MATCH ftsQuery
         │     │   weighted: file_path×5, name×3, content×1
         │     │   bm25(fts_code, 5.0, 3.0, 1.0)
         │     ├── normalizeBM25(score)  ← negative BM25 → 0..1
         │     │   formula: 1 / (1 + exp(-0.3 * (|score| - 5)))
         │     └── _searchCodeByPath(rawQuery, seenIds)
         │           ← LIKE '%word%' on file_path for path-based queries
         │
         ├── _searchGit(ftsQuery, k, results)
         │     bm25(fts_commits, 5.0, 2.0, 1.0)
         │     filter: is_merge = 0
         │
         └── _searchPatterns(ftsQuery, k, results)
               bm25(fts_patterns, 3.0, 5.0, 5.0, 1.0)
               filter: success_rate >= 0.5


rebuild():
  INSERT INTO fts_code(fts_code) VALUES('rebuild')
  ← FTS5 content table rebuild command
```

### 9.4 Hybrid Search + RRF

**Pattern: Composite Search + Reciprocal Rank Fusion**

```
SearchAPI.hybridSearch(query, options)
         │
         ├── if VectorSearch available:
         │     parallel:
         │     ├── vectorSearch.search(query, { codeK, gitK })  → vecResults
         │     └── bm25.search(query, { codeK, gitK })          → kwResults
         │     resultLists.push(vecResults, kwResults)
         │
         ├── if docs plugin available:
         │     docsPlugin.search(query, { k: docsK })            → docResults
         │     resultLists.push(docResults)
         │
         ├── for each custom KV collection in options.collections:
         │     collection(name).search(query, { k })
         │     resultLists.push(collResults)
         │
         ├── reciprocalRankFusion(resultLists)
         │     see RRF algorithm below
         │
         └── if reranker: rerank(query, fused, reranker)


reciprocalRankFusion(resultSets, k=60, maxResults=15)
         │
         ├── for each result list:
         │     for each result at rank i:
         │       key = unique string (type:file:lines or type:hash or ...)
         │       rrfScore += 1 / (60 + i + 1)
         │       if key seen: add scores, keep higher original score
         │
         ├── sort by rrfScore descending
         ├── slice to maxResults
         └── normalize: score = rrfScore / maxRRFScore (→ 0..1)


Result key generation (deduplication across systems):
  'code'       → "code:src/api.ts:10-50"
  'commit'     → "commit:abc1234"
  'pattern'    → "pattern:api:Used express-rate-limit..."
  'document'   → "document:path:collection:seq:content-prefix"
  'collection' → "collection:id-or-content-prefix"
```

### 9.5 MMR — Maximum Marginal Relevance

**Pattern: Greedy Algorithm for Diversity**

MMR prevents returning 5 chunks from the same function when searching for code.
It balances **relevance** (score from HNSW) vs **diversity** (distance from
already-selected items).

```
searchMMR(index, query, vectorCache, k, lambda=0.7)
         │
         ├── candidates = index.search(query, k*3)  ← over-fetch
         │
         └── greedy selection loop:
               while selected.length < k AND remaining.length > 0:
                 for each candidate i:
                   relevance = candidate[i].score
                   maxSim = max(cosineSimilarity(vec[i], vec[sel]) for each selected)
                   mmrScore = lambda * relevance - (1 - lambda) * maxSim
                 pick candidate with highest mmrScore
                 move from remaining to selected


lambda = 0.7:  70% relevance weight, 30% diversity penalty
lambda = 1.0:  pure relevance (same as regular HNSW search)
lambda = 0.0:  pure diversity (maximize spread)
```

### 9.6 Reranking

**Pattern: Decorator (wraps search results)**

```
rerank(query, results, reranker)
         │
         ├── documents = results.map(r => r.content)
         ├── scores = await reranker.rank(query, documents)
         │     ← cross-encoder scores (0..1), more accurate than dot product
         │
         ├── for each result at position i:
         │     pos = i + 1
         │     rrfWeight = pos ≤ 3  ? 0.75   ← trust retrieval for top 3
         │               : pos ≤ 10 ? 0.60   ← balanced middle
         │               :            0.40   ← trust reranker for tail
         │     blendedScore = rrfWeight * r.score + (1 - rrfWeight) * scores[i]
         │
         └── sort by blendedScore descending


Position-aware blending rationale:
  Top results are already highly relevant (exact matches, symbol names).
  Reranker is better at semantic re-ordering of the "good but not perfect" tail.
  Pure reranker score would hurt exact-match precision at position 1.
```

### 9.7 ContextBuilder

**Pattern: Builder + Decorator**

Takes raw search results and formats them into LLM-ready markdown with
additional context from the code graph and co-edit patterns.

```
ContextBuilder.build(task, options)
         │
         ├── _search.search(task, { codeK, gitK, patternK, minScore, useMMR })
         │
         ├── _formatCodeResults(codeHits)
         │     group by file:
         │     ### src/api/auth.ts
         │     **function `handleRequest` (L10-50)** — 87% match *(calls: validate, respond)*
         │     ```typescript
         │     <code content>
         │     ```
         │
         ├── _formatCodeGraph(codeHits)
         │     for each file in results:
         │       SELECT imports_path FROM code_imports WHERE file_path = ?
         │       → imports: → src/db/client.ts
         │       SELECT file_path FROM code_imports WHERE imports_path LIKE '%basename%'
         │       → imported by: ← src/server.ts
         │     ## Related Files (Import Graph)
         │     - → src/db/client.ts
         │     - ← src/server.ts
         │
         ├── _getCallInfo(result) ← per-chunk call graph annotation
         │     SELECT symbol_name FROM code_refs WHERE chunk_id = ?
         │     → calls: validateToken, sendError
         │     SELECT file_path, name FROM code_refs cr
         │       JOIN code_chunks cc WHERE cr.symbol_name = ?
         │     → called by: middleware.ts:authenticate
         │
         ├── _formatGitResults(results, gitLimit)
         │     ## Related Git History
         │     **[abc1234]** fix auth bypass *(Jane, 2024-01-15, 92%)*
         │       Files: src/auth/middleware.ts
         │       ```diff
         │       @@ -10,3 +10,5 @@
         │       +  if (!token) throw new AuthError()
         │       ```
         │
         ├── _formatCoEdits(affectedFiles)
         │     ## Co-Edit Patterns
         │     - **src/api.ts** → also tends to change: src/routes.ts (18x), tests/api.test.ts (15x)
         │
         └── _formatPatternResults(results, patternLimit)
               ## Learned Patterns
               **api** — 87% success, 91% match
               Task: Add rate limiting
               Approach: express-rate-limit with Redis
               Lesson: Set per-user limits not global
```

### 9.8 DocumentSearch

**Hybrid search dedicated to document collections.**

```
DocumentSearch.search(query, { collection?, k, minScore, mode })
         │
         ├── mode='keyword' → _searchBM25() → _dedup() → return
         ├── mode='vector'  → _searchVector() → _dedup() → return
         └── mode='hybrid' (default):
               parallel: _searchVector(k*2) + _searchBM25(k*2)
               RRF fusion
               → map fused results back to original SearchResult objects
               → _dedup(results, k)       ← keep best chunk per file
               → _rerankResults(query, deduped)


_searchVector():
  - if collection filter: over-fetch proportional to (total/collectionCount)
    because HNSW is shared across all doc collections
  - filter by collection name in SQL

_searchBM25():
  bm25(fts_docs, 10.0, 2.0, 5.0, 1.0)  ← title×10, content×2, file×5, collection×1
  OR-mode query for natural language:
    "how does authentication work"
    → remove stop words: how, does, authentication, work
    → remove stop words: how, does, work
    → keep: "authentication"
    → "\"authentication\""

_dedup():
  Keep only the highest-scoring chunk per file path.
  Prevents 4 chunks from the same document all appearing.

_getDocContext(collection, filePath):
  Walks the path hierarchy upward checking path_contexts:
    /src/auth/middleware.ts → /src/auth → /src → / → collection default
  Returns the most specific context description found.
```

---

## 10. Infrastructure Layer

### 10.1 Database

**Pattern: Wrapper / Thin Facade over better-sqlite3**

```
Database
│
├── constructor(dbPath)
│     ├── fs.mkdirSync(dirname, { recursive: true })
│     ├── new BetterSqlite3(dbPath)
│     ├── PRAGMA journal_mode = WAL      ← parallel reads, single writer
│     ├── PRAGMA busy_timeout = 5000     ← wait up to 5s for lock
│     ├── PRAGMA synchronous = NORMAL    ← balance safety vs speed
│     ├── PRAGMA foreign_keys = ON       ← enforce FK constraints
│     └── createSchema(db)               ← idempotent DDL
│
├── transaction(fn)   → db.transaction(fn)()  ← auto-commit/rollback
├── batch(sql, rows)  → single transaction for N rows
├── prepare(sql)      → cached Statement
└── exec(sql)         → raw SQL execution
```

### 10.2 HNSWIndex — Vector Index

**Pattern: Adapter + Lazy Init + Persistence**

```
HNSWIndex
│
├── init(): Promise<this>
│     ├── dynamic import 'hnswlib-node'
│     ├── new HierarchicalNSW('cosine', dims)
│     └── initIndex(maxElements, M=16, efConstruction=200)
│         setEf(50)   ← search-time candidates
│
├── add(vector, id)
│     ├── if id already in _ids → skip (idempotent)
│     ├── if _ids.size >= maxElements → throw "index full"
│     └── _index.addPoint(Array.from(vector), id)
│         _ids.add(id)
│
├── remove(id)
│     └── _index.markDelete(id)    ← soft delete (hnswlib feature)
│         _ids.delete(id)
│
├── search(query, k)
│     └── _index.searchKnn(Array.from(query), min(k, _ids.size))
│         → { neighbors: [id,...], distances: [dist,...] }
│         → map to [{ id, score: 1 - dist }]  ← cosine distance → similarity
│
├── save(path)
│     └── _index.writeIndexSync(path)
│         ← saves the HNSW graph to disk (binary format)
│
├── tryLoad(path, expectedCount)
│     ├── if !existsSync(path) → return false
│     ├── _index.readIndexSync(path)
│     ├── if loadedCount !== expectedCount → reinit(), return false
│     │     ← stale: DB has different number of vectors
│     ├── rebuild _ids from _index.getIdsList()
│     └── return true
│
└── reinit()
      ← creates a fresh empty index (same dimensions/params)
      ← called on reembed or after failed tryLoad

Parameters (from ResolvedConfig):
  dims=384, maxElements=2_000_000, M=16, efConstruction=200, efSearch=50

Performance:
  O(log n) search at 1M vectors (~50ms)
  vs O(n) brute force (~5s)
```

### 10.3 Embedding Providers

**Pattern: Strategy + Adapter**

All providers implement the same `EmbeddingProvider` interface:

```
EmbeddingProvider interface:
  readonly dims: number
  embed(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
  close(): Promise<void>

┌─────────────────────────────────────────────────────────────────┐
│ LocalEmbedding                                                  │
│ model: Xenova/all-MiniLM-L6-v2 (WASM, no GPU required)         │
│ dims: 384                                                       │
│ cache: .model-cache/ (~23MB download on first use)             │
│                                                                 │
│ _getPipeline():  lazy singleton                                 │
│   _pipelinePromise deduplication → prevents concurrent loads    │
│                                                                 │
│ embedBatch():                                                   │
│   chunks into BATCH_SIZE=32                                     │
│   output.data is flat Float32Array, must .slice() per item      │
│   (pipeline may reuse underlying buffer between calls)          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ OpenAIEmbedding                                                 │
│ model: text-embedding-3-small (1536d) / 3-large (3072d)        │
│ API: POST https://api.openai.com/v1/embeddings                  │
│                                                                 │
│ embedBatch():                                                   │
│   chunks into MAX_BATCH=100                                     │
│   100ms delay between batches (BATCH_DELAY_MS)                  │
│   30s timeout (AbortController)                                 │
│                                                                 │
│ Token limit retry:                                              │
│   if 400 + "maximum context length":                            │
│     batch > 1 → retry each item individually at 8000 chars      │
│     single    → retry at 6000 chars (1 retry max)               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PerplexityEmbedding                                             │
│ model: pplx-embed-v1-4b (2560d) / pplx-embed-v1-0.6b (1024d)  │
│ API: POST https://api.perplexity.ai/v1/embeddings               │
│                                                                 │
│ Response format: base64-encoded signed int8 vectors             │
│ decodeBase64Int8(b64, dims):                                    │
│   atob(b64) → binary string                                     │
│   → Int8Array (sign-extend with << 24 >> 24)                    │
│   → Float32Array (cast each byte)                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PerplexityContextEmbedding                                      │
│ model: pplx-embed-context-v1-4b (2560d)                         │
│ API: POST https://api.perplexity.ai/v1/contextualizedembeddings │
│                                                                 │
│ Key difference: input is string[][] (docs × chunks)             │
│   chunks in same document share context → better retrieval      │
│                                                                 │
│ embed(text)       → wraps as [[text]] (single doc, single chunk)│
│ embedBatch(texts) → wraps as [texts] (one doc of N chunks)      │
│   splits large batches into sub-docs (max 80k chars/doc)        │
│                                                                 │
│ Response: nested { data: [{index, data: [{index, embedding}]}]} │
│ flattenContextResponse(): sort by doc index, then chunk index   │
└─────────────────────────────────────────────────────────────────┘

Provider resolution:
  resolveEmbedding(key: string): EmbeddingProvider
    'local'              → new LocalEmbedding()
    'openai'             → new OpenAIEmbedding()
    'perplexity'         → new PerplexityEmbedding()
    'perplexity-context' → new PerplexityContextEmbedding()

  providerKey(p: EmbeddingProvider): EmbeddingKey
    p.constructor.name → 'OpenAIEmbedding' → 'openai'
    ← used for DB storage and auto-resolution on next startup
```

### 10.4 Rerankers

```
Reranker interface:
  rank(query: string, documents: string[]): Promise<number[]>
  close?(): Promise<void>

┌─────────────────────────────────────────────────────────────────┐
│ Qwen3Reranker                                                   │
│ model: Qwen3-Reranker-0.6B-Q8_0 (~640MB GGUF)                  │
│ engine: node-llama-cpp (optional peer dependency)               │
│ cache: ~/.cache/brainbank/models/                               │
│                                                                 │
│ _ensureLoaded() [lazy, singleton, promise-deduped]:             │
│   getLlama() → llama engine                                     │
│   resolveModelFile(uri, cacheDir) → downloads if needed         │
│   llama.loadModel({ modelPath })                                │
│   model.createRankingContext({ contextSize:2048,                │
│                                flashAttention: true })          │
│                                                                 │
│ rank(query, documents):                                         │
│   1. deduplicate documents (identical texts scored once)        │
│   2. truncate to context budget:                                │
│        maxDocTokens = 2048 - 200 (overhead) - queryTokens       │
│   3. context.rankAll(query, truncated) → scores[]              │
│   4. map scores back by text → return in original order         │
│                                                                 │
│ close(): dispose context + model                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 11. Services Layer

### 11.1 Watch Service

**Pattern: Observer + Debounce + Delegation**

```
createWatcher(reindexFn, indexers, repoPath, options)
         │
         ├── collect watchPatterns from isWatchable plugins
         │
         ├── fs.watch(path, { recursive: mac/win only })
         │     └── on change event:
         │           shouldWatch(filename)?
         │             ├── skip ignored dirs (node_modules, .git, dist, ...)
         │             ├── skip ignored files (package-lock.json, ...)
         │             ├── accept SUPPORTED_EXTENSIONS files
         │             └── accept files matching custom plugin patterns
         │           → pending.add(filename)
         │           → clearTimeout + setTimeout(processPending, debounceMs=2000)
         │
         └── processPending() [serialized, no concurrent flushes]:
               files = [...pending]; pending.clear()
               for each file:
                 1. matchCustomPlugin(absPath)?
                      customIndexer.onFileChange(absPath, 'update'|'delete')
                      if handled → onIndex(file, indexer.name) → continue
                 2. isSupported(filePath)?
                      needsReindex = true
                      onIndex(file, 'code')
               if needsReindex:
                 await reindexFn()   ← brain.index()


Watcher interface:
  { close(): void, readonly active: boolean }
```

### 11.2 Reembed Service

**Pattern: Batch Processing + Atomic Swap**

Regenerates all vectors without re-parsing any files. Used when switching
embedding providers.

```
reembedAll(db, embedding, hnswMap, options)
         │
         ├── for each table in TABLES:
         │     [code, git, memory, docs, kv]
         │     reembedTable(db, embedding, table, batchSize=50)
         │         │
         │         ├── PHASE 1: Build in temp table
         │         │     CREATE TABLE _reembed_<vectorTable> AS SELECT * WHERE 0
         │         │     for offset in 0..totalCount step batchSize:
         │         │       rows = SELECT * FROM textTable LIMIT batchSize OFFSET offset
         │         │       texts = rows.map(textBuilder)
         │         │       vectors = embedding.embedBatch(texts)
         │         │       TRANSACTION: INSERT INTO temp (fk, embedding)
         │         │     ← OLD DATA UNTOUCHED during this phase
         │         │
         │         └── PHASE 2: Atomic swap
         │               TRANSACTION:
         │                 DELETE FROM vectorTable
         │                 INSERT INTO vectorTable SELECT * FROM temp
         │               DROP TABLE temp
         │               ← all-or-nothing: if embedBatch failed mid-way, old data intact
         │
         ├── rebuildHnsw(db, table, hnsw, vecs)
         │     hnsw.reinit()    ← clear stale vectors
         │     vecs.clear()
         │     for each row in vectorTable:
         │       hnsw.add(vec, id)
         │       vecs.set(id, vec)
         │
         └── UPSERT embedding_meta (provider, dims, reembedded_at)


Text builders (must match what the indexers embed originally):
  code:    "File: src/api.ts\nfunction: handleRequest\n<content>"
  git:     "Commit: fix null\nAuthor: Jane\nDate: ...\nFiles: ...\nChanges:\n..."
  memory:  "api Add rate limiting Used express-rate-limit..."

  docs:    "title: My Doc | text: <content>"
  kv:      "<content>"
```

### 11.3 EmbeddingMeta Service

```
embedding_meta table:
  key='provider'      value='LocalEmbedding'
  key='dims'          value='384'
  key='provider_key'  value='local'
  key='indexed_at'    value='2024-01-15T10:30:00Z'

setEmbeddingMeta(db, embedding):
  → UPSERT provider, dims, provider_key, indexed_at

getEmbeddingMeta(db):
  → { provider, dims, providerKey } | null

detectProviderMismatch(db, embedding):
  stored = { provider: 'LocalEmbedding', dims: 384 }
  current = { provider: 'OpenAIEmbedding', dims: 1536 }
  → { mismatch: true, stored: 'LocalEmbedding/384', current: 'OpenAIEmbedding/1536' }
  ← BrainBank throws on mismatch unless force=true
  ← user must call brain.reembed() to re-generate all vectors
```

---

## 12. SQLite Schema

```
Tables and their relationships:

  ┌──────────────────────────────────────────────────────────┐
  │                        CODE                              │
  │                                                          │
  │  indexed_files          code_chunks                      │
  │  ├── file_path (PK)     ├── id (PK)                     │
  │  ├── file_hash          ├── file_path → idx_cc_file      │
  │  └── indexed_at         ├── chunk_type                   │
  │                         ├── name                         │
  │                         ├── start_line / end_line        │
  │                         ├── content                      │
  │                         ├── language                     │
  │                         └── file_hash                    │
  │                               │                          │
  │  code_vectors                 │ CASCADE DELETE           │
  │  └── chunk_id (FK/PK) ────────┘                          │
  │      embedding (BLOB)                                    │
  │                                                          │
  │  code_symbols           code_imports         code_refs   │
  │  ├── id (PK)            ├── file_path (PK)   ├── chunk_id│
  │  ├── file_path          └── imports_path     └── symbol  │
  │  ├── name                                               │
  │  ├── kind                                               │
  │  ├── line                                               │
  │  └── chunk_id (FK)                                       │
  │                                                          │
  │  fts_code (FTS5 virtual, content='code_chunks')          │
  │    columns: file_path, name, content                     │
  │    tokenizer: porter unicode61                           │
  │    auto-sync via triggers: trg_fts_code_insert/delete    │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │                         GIT                              │
  │                                                          │
  │  git_commits                                             │
  │  ├── id (PK)                                             │
  │  ├── hash (UNIQUE)                                       │
  │  ├── short_hash                                          │
  │  ├── message                                             │
  │  ├── author / date / timestamp                           │
  │  ├── files_json                                          │
  │  ├── diff                                                │
  │  ├── additions / deletions                               │
  │  └── is_merge                                            │
  │        │ CASCADE DELETE                                   │
  │  git_vectors                                             │
  │  └── commit_id (FK/PK)                                   │
  │      embedding (BLOB)                                    │
  │                                                          │
  │  commit_files                                            │
  │  ├── commit_id (FK)                                      │
  │  └── file_path → idx_cf_path                             │
  │                                                          │
  │  co_edits                                                │
  │  ├── file_a / file_b (PK composite)                      │
  │  └── count                                               │
  │                                                          │
  │  fts_commits (FTS5, content='git_commits')               │
  │    columns: message, author, diff                        │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │                     DOCUMENTS                            │
  │                                                          │
  │  collections                                             │
  │  ├── name (PK)                                           │
  │  ├── path                                                │
  │  ├── pattern                                             │
  │  ├── ignore_json                                         │
  │  └── context                                             │
  │        │ CASCADE DELETE                                   │
  │  doc_chunks                                              │
  │  ├── id (PK)                                             │
  │  ├── collection (FK) → idx_dc_collection                 │
  │  ├── file_path → idx_dc_file                             │
  │  ├── title                                               │
  │  ├── content                                             │
  │  ├── seq (chunk sequence)                                │
  │  ├── pos (char position)                                 │
  │  └── content_hash → idx_dc_hash                          │
  │        │ CASCADE DELETE                                   │
  │  doc_vectors                                             │
  │  └── chunk_id (FK/PK)                                    │
  │      embedding (BLOB)                                    │
  │                                                          │
  │  path_contexts                                           │
  │  ├── collection / path (PK composite)                    │
  │  └── context                                             │
  │                                                          │
  │  fts_docs (FTS5, content='doc_chunks')                   │
  │    columns: title, content, file_path, collection        │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │                   AGENT MEMORY                           │
  │                                                          │
  │  memory_patterns                                         │
  │  ├── id (PK)                                             │
  │  ├── task_type → idx_mp_type                             │
  │  ├── task                                                │
  │  ├── approach                                            │
  │  ├── outcome                                             │
  │  ├── success_rate → idx_mp_success                       │
  │  ├── critique                                            │
  │  ├── tokens_used / latency_ms                            │
  │  └── created_at → idx_mp_created                         │
  │        │ CASCADE DELETE                                   │
  │  memory_vectors                                          │
  │  └── pattern_id (FK/PK)                                  │
  │      embedding (BLOB)                                    │
  │                                                          │
  │  distilled_strategies                                    │
  │  ├── task_type (PK)                                      │
  │  ├── strategy                                            │
  │  ├── confidence                                          │
  │  └── updated_at                                          │
  │                                                          │
  │  fts_patterns (FTS5, content='memory_patterns')          │
  │    columns: task_type, task, approach, critique          │
  └──────────────────────────────────────────────────────────┘



  ┌──────────────────────────────────────────────────────────┐
  │                  KV COLLECTIONS                          │
  │                                                          │
  │  kv_data                                                 │
  │  ├── id (PK)                                             │
  │  ├── collection → idx_kv_collection                      │
  │  ├── content                                             │
  │  ├── meta_json                                           │
  │  ├── tags_json                                           │
  │  ├── expires_at (nullable, TTL)                          │
  │  └── created_at → idx_kv_created                         │
  │        │ CASCADE DELETE                                   │
  │  kv_vectors                                              │
  │  └── data_id (FK/PK)                                     │
  │      embedding (BLOB)                                    │
  │                                                          │
  │  fts_kv (FTS5, content='kv_data')                        │
  │    columns: content, collection                          │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │                    METADATA                              │
  │  embedding_meta                                          │
  │  ├── key (PK)    'provider' | 'dims' | 'provider_key'   │
  │  └── value                                               │
  │                                                          │
  │  schema_version                                          │
  │  └── version (PK, currently 6)                           │
  └──────────────────────────────────────────────────────────┘


FTS5 Trigger Pattern (same for all tables):
  CREATE TRIGGER trg_fts_code_insert AFTER INSERT ON code_chunks BEGIN
    INSERT INTO fts_code(rowid, file_path, name, content)
    VALUES (new.id, new.file_path, COALESCE(new.name, ''), new.content);
  END;
  CREATE TRIGGER trg_fts_code_delete AFTER DELETE ON code_chunks BEGIN
    INSERT INTO fts_code(fts_code, rowid, ...)
    VALUES ('delete', old.id, ...);
  END;
  ← FTS5 content table sync: no fts_code UPDATE trigger because
     content tables use external content and need explicit sync
```

---

## 13. CLI Layer

**Pattern: Command + Factory**

```
cli/index.ts  ← dispatcher
         │
         ├── args[0] = 'index'      → cmdIndex()
         ├── args[0] = 'collection' → cmdCollection()
         ├── args[0] = 'kv'         → cmdKv()
         ├── args[0] = 'docs'       → cmdDocs()
         ├── args[0] = 'dsearch'    → cmdDocSearch()
         ├── args[0] = 'search'     → cmdSearch()
         ├── args[0] = 'hsearch'    → cmdHybridSearch()
         ├── args[0] = 'ksearch'    → cmdKeywordSearch()
         ├── args[0] = 'context'    → cmdContext()
         ├── args[0] = 'stats'      → cmdStats()
         ├── args[0] = 'reembed'    → cmdReembed()
         ├── args[0] = 'watch'      → cmdWatch()
         └── args[0] = 'serve'      → import('@brainbank/mcp')


createBrain(repoPath?)  ← cli/factory.ts
         │
         ├── loadConfig()
         │     checks .brainbank/config.json → config.ts → config.js → null
         │     cache in module-level variable (reset between tests)
         │
         ├── discoverFolderPlugins()
         │     reads .brainbank/plugins/*.ts|js|mjs
         │     each file must export default Plugin with .name property
         │
         ├── setupProviders(brainOpts, config)
         │     ├── --reranker qwen3 → new Qwen3Reranker()
         │     └── --embedding openai → resolveEmbeddingKey('openai')
         │
         ├── new BrainBank(brainOpts)
         │
         ├── registerBuiltins(brain, rp, builtins, config)
         │     ├── detectGitSubdirs(rp) → multi-repo detection
         │     │     checks if subdirs have .git → auto-namespace plugins
         │     ├── if multi-repo:
         │     │     code({ name: 'code:frontend', repoPath: './fe' })
         │     │     git({ name: 'git:frontend',   repoPath: './fe' })
         │     └── if single-repo:
         │           code({ repoPath: rp }), git(), docs()
         │
         ├── for each folderIndexer → brain.use(indexer)
         └── for each config.indexers → brain.use(indexer)


Config priority:
  --flag        (highest)
  config.json   field
  auto-detect from DB (for embedding provider)
  defaults      (lowest)


.brainbank/config.json example:
  {
    "plugins": ["code", "git", "docs"],
    "embedding": "openai",
    "reranker": "qwen3",
    "code": { "maxFileSize": 256000 },
    "git": { "depth": 200, "maxDiffBytes": 4096 },
    "docs": {
      "collections": [
        { "name": "wiki", "path": "./docs", "pattern": "**/*.md" }
      ]
    }
  }
```

---

## 14. API Layer

**Pattern: Facade Method Delegation**

```
IndexAPI
│
├── index({ modules, gitDepth, forceReindex, onProgress })
│     want = new Set(modules ?? ['code', 'git', 'docs'])
│
│     if want.has('code'):
│       for each registry.allByType('code') that isIndexable:
│         mod.index({ forceReindex, onProgress: wrap with label })
│         merge result.code (accumulated across multi-repo)
│
│     if want.has('git'):
│       for each registry.allByType('git') that isIndexable:
│         mod.index({ depth: gitDepth ?? config.gitDepth, onProgress })
│         merge result.git
│
│     if want.has('docs') and registry.has('docs'):
│       docsPlugin.indexDocs({ onProgress })
│       result.docs = { collName: { indexed, skipped, chunks } }
│
│     emit('indexed', result)
│
├── indexCode(options) → accumulate across all code plugins
└── indexGit(options)  → accumulate across all git plugins


SearchAPI
│
├── search(query, options)
│     if no VectorSearch: return docs-only or []
│     else: vectorSearch.search(query, options)
│
├── searchCode(query, k)
│     requires 'code' plugin + VectorSearch
│     search({ codeK: k, gitK: 0, patternK: 0 })
│
├── searchCommits(query, k)
│     requires 'git' plugin + VectorSearch
│     search({ codeK: 0, gitK: k, patternK: 0 })
│
├── hybridSearch(query, options)         (see §9.4)
│
├── searchBM25(query, options)
│     bm25?.search(query, options) ?? []
│
├── rebuildFTS()
│     bm25?.rebuild()
│
└── getContext(task, options)
      sections = []
      if contextBuilder:
        sections.push(await contextBuilder.build(task, options))
      if docs plugin:
        docs = await _searchDocs(task, { k: options.codeResults ?? 4 })
        sections.push(formatDocsSection(docs))
      return sections.join('\n\n')
```

---

## 15. Shared HNSW Pool

**Pattern: Flyweight + Registry**

Multiple plugins of the same type (code:frontend, code:backend) share a single
HNSW index to avoid memory duplication and keep search unified.

```
_sharedHnsw: Map<string, { hnsw: HNSWIndex, vecCache: Map<number, Float32Array> }>

Typical state after initialization:
  'code' → { hnsw: HNSWIndex(384d, 2M), vecCache: Map<id, vec> }
  'git'  → { hnsw: HNSWIndex(384d, 500k), vecCache: Map<id, vec> }

Private per-plugin indices (NOT in sharedHnsw):
  DocsPlugin.hnsw    ← each docs plugin has its own (different doc sets)
  MemoryPlugin.hnsw  ← private (pattern vectors)

  kvHnsw             ← on BrainBank directly (KV collections)


getOrCreateSharedHnsw('code', maxElements, dims):
  ┌──────────────────────────────────────┐
  │  sharedHnsw.has('code')?             │
  │       YES          NO                │
  │        │            │                │
  │  return existing   create new HNSW   │
  │  { isNew: false }  register in map   │
  │                    { isNew: true }   │
  └──────────────────────────────────────┘

First code plugin to initialize (isNew=true):
  → loads code_vectors from SQLite into the shared HNSW
  → all subsequent code plugins see isNew=false and skip loading

VectorSearch accesses sharedHnsw directly:
  codeMod = sharedHnsw.get('code')
  codeHnsw = codeMod?.hnsw
  codeVecs = codeMod?.vecCache
```

---

## 16. Data Flow Diagrams

### 16.1 Index Flow

```
brain.index({ modules: ['code', 'git'] })
         │
         ▼
IndexAPI.index()
         │
    ┌────┴────┐
    │  code   │
    └────┬────┘
         │
    CodeWalker.index()
    ┌─────────────────────────────────────────────┐
    │ walkRepo() → [file1.ts, file2.ts, ...]       │
    │   for each file:                             │
    │     read → hash → skip if unchanged          │
    │     ┌─────────────────────────────────────┐  │
    │     │ chunk()  → [chunk1, chunk2, ...]    │  │
    │     │ embed()  → [vec1, vec2, ...]        │  │
    │     │ TRANSACTION:                        │  │
    │     │   DELETE old → INSERT new           │  │
    │     │   HNSW.add() per chunk              │  │
    │     └─────────────────────────────────────┘  │
    └─────────────────────────────────────────────┘
         │
    ┌────┴────┐
    │   git   │
    └────┬────┘
         │
    GitIndexer.index()
    ┌─────────────────────────────────────────────┐
    │ git.log(500) → commits[]                    │
    │   for each commit (skip if vectorized):     │
    │     git show --numstat → files, stats       │
    │     git show → diff (truncated)             │
    │   embedBatch(all new commit texts)          │
    │   TRANSACTION: INSERT all commits + vecs    │
    │   HNSW.add() per commit                     │
    │   computeCoEdits(newIds)                    │
    └─────────────────────────────────────────────┘
         │
    emit('indexed', { code: {indexed,skipped,chunks}, git: {indexed,skipped} })
```

### 16.2 Search Flow

```
brain.search("authentication middleware")
         │
         ▼
SearchAPI.search(query, options)
         │
         ▼
VectorSearch.search(query)
         │
    embedding.embed("authentication middleware")
         │ → Float32Array[384]
         │
    ┌────┴─────────────────────────────────────┐
    │                                          │
    ▼                                          ▼
codeHnsw.search(queryVec, 6)          gitHnsw.search(queryVec, 10)
(or searchMMR for diversity)
    │                                          │
    ▼                                          ▼
SELECT code_chunks                    SELECT git_commits
WHERE id IN (?)                       WHERE id IN (?)
                                      AND is_merge = 0
    │                                          │
    ▼                                          ▼
[CodeResult, CodeResult, ...]        [CommitResult, CommitResult, ...]
    │                                          │
    └──────────────┬───────────────────────────┘
                   │
    sort(by score DESC)
                   │
    if reranker → rerank(query, results, reranker)
                   │
                   ▼
    [{ type:'code', score:0.91, filePath:'src/auth.ts', ... },
     { type:'commit', score:0.85, content:'add JWT middleware', ... },
     ...]
```

### 16.3 Hybrid Search Flow

```
brain.hybridSearch("rate limiting middleware")
         │
         ▼
SearchAPI.hybridSearch()
         │
    ┌────┴──────────────────────────────────────────────┐
    │              parallel execution                   │
    ├──────────────────────┬────────────────────────────┤
    ▼                      ▼                            ▼
VectorSearch           BM25Search                  DocsPlugin
.search(query)         .search(query)              .search(query)
    │                      │                            │
[vecResults]           [bm25Results]              [docResults]
    └──────────────────────┴────────────────────────────┘
                           │
              resultLists = [[vec...], [bm25...], [doc...]]
                           │
              reciprocalRankFusion(resultLists, k=60)
                           │
    ┌──────────────────────────────────────────────────┐
    │ for each result in each list:                    │
    │   key = unique identifier                        │
    │   rrfScore += 1 / (60 + rank + 1)               │
    │                                                  │
    │ sort by rrfScore, normalize to 0..1              │
    └──────────────────────────────────────────────────┘
                           │
    if reranker → rerank(query, fused, reranker)
                           │
                           ▼
    [{ type:'code', score:0.95, ... },   ← appeared in both vec + bm25 → high RRF
     { type:'document', score:0.82, ... },
     { type:'commit', score:0.71, ... },
     ...]
```

### 16.4 Memory Learning Flow

```
AI Agent completes a task → calls learn()

brain.plugin('memory').learn({
  taskType: 'api',
  task: 'Add rate limiting to auth endpoint',
  approach: 'Used express-rate-limit with Redis store, 100 req/min per IP',
  outcome: 'Reduced abuse 95%, zero false positives in production',
  successRate: 0.9,
  critique: 'Should use per-user limits not per-IP for authenticated routes',
  tokensUsed: 2400,
  latencyMs: 8200,
})
         │
         ▼
PatternStore.learn(pattern)
         │
    INSERT memory_patterns → id = 42
    text = "api Add rate limiting... Used express-rate-limit..."
    embedding.embed(text) → Float32Array[384]
    INSERT memory_vectors (42, blob)
    hnsw.add(vec, 42)
    vecCache.set(42, vec)
         │
         ▼
if count % 50 === 0:
  Consolidator.consolidate()
         │
    prune: DELETE WHERE success_rate < 0.3 AND age > 90d
    dedup: for each pair in vecCache:
             cosineSim > 0.95 → delete lower-success-rate one


Later: AI Agent faces similar task → search()

brain.plugin('memory').search("rate limiting API", k=4)
         │
         ▼
PatternStore.search()
         │
    embedding.embed("rate limiting API") → queryVec
    hnsw.search(queryVec, 8)  ← over-fetch
    SELECT WHERE id IN (?) AND success_rate >= 0.5
         │
         ▼
[{
  taskType: 'api',
  task: 'Add rate limiting...',
  approach: 'Used express-rate-limit...',
  successRate: 0.9,
  critique: 'Should use per-user limits...',
  score: 0.94
}]
```



### 16.6 Startup Initialization Flow

```
new BrainBank({ repoPath: '.', embeddingProvider: openai })
    .use(code({ repoPath: '.' }))
    .use(git())
    .use(docs())
         │
         ▼
brain.initialize() [or auto-called on first operation]
         │
    ┌────▼──────────────────────────────────────────────────┐
    │                   PHASE 1 (early)                     │
    │                                                       │
    │  new Database('.brainbank/brainbank.db')              │
    │    └── WAL mode, create all tables + triggers + FTS5  │
    │                                                       │
    │  _resolveEmbedding(db)                                │
    │    1. config.embeddingProvider? → use it              │
    │    2. embedding_meta.provider_key in DB? → resolve it │
    │    3. fallback → LocalEmbedding                       │
    │                                                       │
    │  detectProviderMismatch(db, embedding)                │
    │    stored: { provider:'LocalEmbedding', dims:384 }    │
    │    current: { provider:'OpenAIEmbedding', dims:1536 } │
    │    → throw Error (user must call reembed first)       │
    │    (unless force=true → skipVectorLoad=true)          │
    │                                                       │
    │  setEmbeddingMeta(db, embedding)                      │
    │    UPSERT: provider='OpenAIEmbedding', dims=1536      │
    │                                                       │
    │  new HNSWIndex(384, 2M, 16, 200, 50).init()          │
    │    → this._kvHnsw is now available                    │
    │    → brain.collection() NOW WORKS                     │
    └───────────────────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────────────────────┐
    │                   PHASE 2 (late)                      │
    │                                                       │
    │  Load KV vectors:                                     │
    │    kvHnsw.tryLoad('hnsw-kv.index', kvCount)          │
    │      hit  → loadVecCache('kv_vectors', 'data_id')    │
    │      miss → loadVectors('kv_vectors', 'data_id', ...) │
    │                                                       │
    │  Build PluginContext                                   │
    │                                                       │
    │  CodePlugin.initialize(ctx):                          │
    │    getOrCreateSharedHnsw('code') → NEW               │
    │    loadVectors('code_vectors', 'chunk_id', hnsw, cache)│
    │    new CodeWalker(...)                                │
    │                                                       │
    │  GitPlugin.initialize(ctx):                           │
    │    getOrCreateSharedHnsw('git') → NEW                │
    │    loadVectors('git_vectors', 'commit_id', ...)       │
    │    new GitIndexer(...), new CoEditAnalyzer(...)       │
    │                                                       │
    │  DocsPlugin.initialize(ctx):                          │
    │    createHnsw(default, embedding.dims) → PRIVATE      │
    │    loadVectors('doc_vectors', 'chunk_id', ...)        │
    │    new DocsIndexer(...), new DocumentSearch(...)      │
    │                                                       │
    │  saveAllHnsw():                                       │
    │    kvHnsw.save('hnsw-kv.index')                      │
    │    sharedHnsw['code'].save('hnsw-code.index')        │
    │    sharedHnsw['git'].save('hnsw-git.index')          │
    │                                                       │
    │  buildSearchLayer():                                  │
    │    new VectorSearch({ codeHnsw, gitHnsw, ... })      │
    │    new KeywordSearch(db)                              │
    │    new ContextBuilder(search, coEdits, db)            │
    │                                                       │
    │  new SearchAPI({ search, bm25, contextBuilder, ... }) │
    │  new IndexAPI({ registry, gitDepth, emit })           │
    │                                                       │
    │  _initialized = true                                  │
    │  emit('initialized', { plugins: [...] })              │
    └───────────────────────────────────────────────────────┘
```

---

## 17. Design Patterns Reference

### Pattern 1: Facade
**Where:** `BrainBank`
**What:** Single entry point hides complexity of registry, initializer, search
API, index API, collections, and all plugins.
```
User → BrainBank → SearchAPI / IndexAPI / DocsPlugin / GitPlugin / ...
```

### Pattern 2: Plugin / Extension Point
**Where:** `Plugin` interface + `PluginRegistry` + `PluginContext`
**What:** Open/closed principle. New data sources added without modifying core.
Custom plugins placed in `.brainbank/plugins/` are auto-discovered.

### Pattern 3: Strategy
**Where:** `SearchStrategy` interface (VectorSearch, KeywordSearch)
**What:** Both implement the same interface, composable in hybrid search.
`EmbeddingProvider` is also a strategy (Local, OpenAI, Perplexity are interchangeable).

### Pattern 4: Registry
**Where:** `PluginRegistry`
**What:** Central store for plugin instances with type-prefix matching.
`has('code')` matches `'code'`, `'code:frontend'`, `'code:backend'`.

### Pattern 5: Two-Phase Construction
**Where:** `Initializer.early()` / `Initializer.late()`
**What:** Phase 1 sets up primitives (DB, KV HNSW) so `collection()` works.
Phase 2 initializes plugins which may call `ctx.collection()`.

### Pattern 6: Factory Method
**Where:** `code()`, `git()`, `docs()`, `memory()` functions
**What:** Each returns a Plugin instance. Hides class instantiation from users.
`createBrain()` in CLI is a higher-level factory that composes everything.

### Pattern 7: Dependency Injection (via Context Object)
**Where:** `PluginContext` passed to `plugin.initialize(ctx)`
**What:** Plugins receive dependencies (db, embedding, config, helpers) through
a single context object rather than constructor injection or singletons.

### Pattern 8: Repository
**Where:** `PatternStore`, `Collection`
**What:** Each encapsulates all data access (read + write) for one domain entity.
Hides SQLite + HNSW + FTS5 complexity behind a clean domain API.

### Pattern 9: Observer / EventEmitter
**Where:** `BrainBank extends EventEmitter`
**What:** Clients subscribe to `'initialized'`, `'indexed'`, `'reembedded'`, `'progress'`.
Decouples async lifecycle events from polling.

### Pattern 10: Flyweight
**Where:** Shared HNSW pool (`_sharedHnsw` Map)
**What:** code:frontend and code:backend share ONE HNSW index and ONE vecCache.
Saves memory and ensures unified search across repos.

### Pattern 11: Builder
**Where:** `ContextBuilder`
**What:** Incrementally constructs a markdown string from search results,
code graph data, co-edit patterns, and memory patterns.

### Pattern 12: Decorator
**Where:** Reranking (`rerank.ts`), ContextBuilder's call annotations
**What:** Wraps existing search results with additional scoring or annotations
without changing the underlying SearchResult structure.

### Pattern 13: Composite (Multi-Index Search)
**Where:** `VectorSearch` searching code + git + pattern HNSW simultaneously
**What:** Treats multiple indices uniformly, merges results into one stream.

### Pattern 14: Lazy Loading + Singleton
**Where:** `LocalEmbedding._getPipeline()`, `Qwen3Reranker._ensureLoaded()`
**What:** Expensive resources (WASM model, LLM model) loaded on first use.
Promise deduplication (`_pipelinePromise`, `_loadPromise`) prevents concurrent loads.

### Pattern 15: Memento / Persistence
**Where:** `HNSWIndex.save()` / `HNSWIndex.tryLoad()`
**What:** HNSW graph persisted to disk after indexing. Loaded on next startup
for fast warm-up (~50ms vs rebuilding from SQLite).
Staleness detection: compare loaded count vs SQLite row count.

### Pattern 16: Adapter
**Where:** `EmbeddingProvider` implementations
**What:** OpenAI returns `number[][]`, Perplexity returns base64 int8, local
WASM returns flat Float32Array — all adapted to the same `Promise<Float32Array>` API.

### Pattern 17: Guard / Precondition
**Where:** `BrainBank._requireInit()`, `BrainBank._docsPlugin()`
**What:** Throws descriptive errors early if operations called before `initialize()`.
Prevents cryptic null-pointer errors deep in the stack.

### Pattern 18: Template Method
**Where:** Plugin `initialize(ctx)` called by `Initializer.late()`
**What:** Initializer orchestrates the call sequence; each plugin fills in
its specific initialization logic (which tables, which HNSW, which cache).

### Pattern 19: Command
**Where:** `IndexAPI.index()` orchestrates multiple indexers
**What:** Encapsulates "index everything" as a single reentrant operation.
`watch.ts` uses it as the reindex callback.

### Pattern 20: Pipeline / Chain
**Where:** hybrid search → RRF → rerank → ContextBuilder
**What:** Each stage transforms the result set. RRF fuses multiple rankings.
Reranker re-scores. ContextBuilder formats for LLM consumption.

### Pattern 21: Atomic Swap (for safe updates)
**Where:** `reembedTable()` in `reembed.ts`
**What:** Build new vectors in temp table → DELETE old → INSERT from temp, all
in one transaction. Old data is never corrupted if embedBatch fails mid-way.

### Pattern 22: Incremental Processing
**Where:** `CodeWalker`, `DocsIndexer`, `GitIndexer`
**What:** Content-hash comparison skips unchanged files.
Git checks `hash` in `indexed_files`; docs checks `content_hash` per chunk.
Only changed/new content is re-embedded.

### Pattern 23: Type Guard + Discriminated Union
**Where:** `SearchResult` type + `isCodeResult()`, `isCommitResult()`, etc.
**What:** Runtime type narrowing without `as` casts. `matchResult()` provides
exhaustive pattern matching over the union.

---

## 18. Complete Dependency Graph

```
                        ┌─────────────────────────────────────┐
                        │           BrainBank (Facade)         │
                        └──┬──────┬───────┬────────┬──────────┘
                           │      │       │        │
                    ┌──────▼──┐ ┌─▼────┐ ┌▼──────┐ ┌▼──────────────┐
                    │IndexAPI │ │Search│ │Plugin │ │ Initializer   │
                    │         │ │API   │ │Registry│ │ early()+late()│
                    └────┬────┘ └──┬───┘ └───┬───┘ └───────┬───────┘
                         │        │          │              │
          ┌──────────────┘        │    ┌─────┘              │
          │                       │    │                    │
          ▼                       │    ▼                    ▼
  ┌───────────────┐              │  ┌────────────────────────────────┐
  │ allByType()   │              │  │         Plugins                │
  │ code/git/docs │              │  │                                │
  │ indexers      │              │  │  CodePlugin                   │
  └───────┬───────┘              │  │    └── CodeWalker             │
          │                      │  │          ├── CodeChunker       │
          │                      │  │          │     └── tree-sitter │
    ┌─────▼──────┐               │  │          ├── extractImports    │
    │ CodeWalker  │               │  │          └── extractSymbols    │
    │ GitIndexer  │               │  │                               │
    │ DocsIndexer │               │  │  GitPlugin                    │
    └─────┬───────┘               │  │    ├── GitIndexer             │
          │                       │  │    └── CoEditAnalyzer         │
          │           ┌───────────▼─▼─▼┐                            │
          └──────────►│                │  DocsPlugin                │
                      │  EmbeddingProvider  ├── DocsIndexer         │
                      │  (shared or    │    └── DocumentSearch      │
                      │   per-plugin)  │                            │
                      │                │  MemoryPlugin              │
                      │                │    ├── PatternStore        │
                      │                │    ├── Consolidator        │
                      │                │    └── PatternDistiller    │
                      │                │                            │

                      └────────────────┘                            │
                              │         └────────────────────────────┘
                              │
                     ┌────────▼──────────────────────────────────────┐
                     │                 Infrastructure                │
                     │                                               │
                     │  Database ─────────────────────────────────   │
                     │    └── SQLite (WAL, FK, FTS5 triggers)        │
                     │                                               │
                     │  HNSWIndex ────────────────────────────────   │
                     │    ├── kvHnsw (KV collections)               │
                     │    ├── sharedHnsw['code']                    │
                     │    ├── sharedHnsw['git']                     │
                     │    ├── DocsPlugin.hnsw (private)             │
                     │    └── MemoryPlugin.hnsw (private)           │
                     │                                               │
                     │  Embedding Providers                          │
                     │    ├── LocalEmbedding (@xenova, WASM)        │
                     │    ├── OpenAIEmbedding (REST)                │
                     │    ├── PerplexityEmbedding (REST, int8)      │
                     │    └── PerplexityContextEmbedding (REST)     │
                     │                                               │
                     │  Rerankers                                    │
                     │    └── Qwen3Reranker (node-llama-cpp)        │
                     └───────────────────────────────────────────────┘
                              │
                     ┌────────▼──────────────────────────────────────┐
                     │               Search Layer                    │
                     │                                               │
                     │  VectorSearch ── searchMMR ── HNSWIndex       │
                     │       │                                       │
                     │  KeywordSearch ── FTS5 (SQLite)              │
                     │       │                                       │
                     │  DocumentSearch ── RRF ── VectorSearch        │
                     │                        └── KeywordSearch      │
                     │  reciprocalRankFusion()                       │
                     │       │                                       │
                     │  rerank() ── Qwen3Reranker                    │
                     │       │                                       │
                     │  ContextBuilder                               │
                     │    ├── VectorSearch                           │
                     │    ├── CoEditAnalyzer                         │
                     │    └── Database (code_imports, code_refs)     │
                     └───────────────────────────────────────────────┘
                              │
                     ┌────────▼──────────────────────────────────────┐
                     │               Services                        │
                     │                                               │
                     │  reembedAll() ── EmbeddingProvider           │
                     │               └── HNSWIndex (rebuild)        │
                     │                                               │
                     │  createWatcher() ── fs.watch                 │
                     │                 └── Plugin.onFileChange()    │
                     │                                               │
                     │  EmbeddingMeta ── embedding_meta table        │
                     └───────────────────────────────────────────────┘
                              │
                     ┌────────▼──────────────────────────────────────┐
                     │                  CLI                          │
                     │                                               │
                     │  createBrain()                                │
                     │    ├── loadConfig(.brainbank/config.json)     │
                     │    ├── discoverFolderPlugins(.brainbank/plugins/)│
                     │    ├── setupProviders (--reranker, --embedding)│
                     │    ├── detectGitSubdirs (multi-repo)         │
                     │    └── new BrainBank() + .use(plugins)       │
                     │                                               │
                     │  Commands: index, search, hsearch, ksearch,   │
                     │            context, collection, kv, docs,     │
                     │            dsearch, stats, reembed, watch,    │
                     │            serve                              │
                     └───────────────────────────────────────────────┘
