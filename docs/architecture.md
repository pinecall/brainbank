## Table of Contents

1. [What is BrainBank](#1-what-is-brainbank)
2. [Repository Structure](#2-repository-structure)
3. [BrainBank — Main Facade](#3-brainbank--main-facade)
4. [Initialization](#4-initialization)
5. [Plugin Registry](#5-plugin-registry)
6. [Plugin System & Plugin Context](#6-plugin-system--plugin-context)
7. [Built-in Plugins](#7-built-in-plugins)
   - 7.1 [@brainbank/code](#71-brainbankcode)
   - 7.2 [@brainbank/git](#72-brainbankgit)
   - 7.3 [@brainbank/docs](#73-brainbankdocs)
8. [@brainbank/mcp Package](#8-brainbankmcp-package)
10. [Collection — KV Store](#10-collection--kv-store)
11. [Search Layer](#11-search-layer)
    - 11.1 [SearchStrategy Interface](#111-searchstrategy-interface)
    - 11.2 [CompositeVectorSearch](#112-compositevectorsearch)
    - 11.3 [KeywordSearch (BM25)](#113-keywordsearch-bm25)
    - 11.4 [Hybrid Search + RRF](#114-hybrid-search--rrf)
    - 11.5 [MMR — Diversity](#115-mmr--diversity)
    - 11.6 [Reranking](#116-reranking)
    - 11.7 [ContextBuilder](#117-contextbuilder)
    - 11.8 [DocumentSearch](#118-documentsearch)
12. [Infrastructure](#12-infrastructure)
    - 12.1 [Database](#121-database)
    - 12.2 [HNSWIndex](#122-hnswindex)
    - 12.3 [HNSW Loader](#123-hnsw-loader)
    - 12.4 [Embedding Providers](#124-embedding-providers)
    - 12.5 [Rerankers](#125-rerankers)
13. [Services](#13-services)
    - 13.1 [Watch Service](#131-watch-service)
    - 13.2 [Reembed Engine](#132-reembed-engine)
    - 13.3 [EmbeddingMeta](#133-embeddingmeta)
14. [Engine Layer](#14-engine-layer)
    - 14.1 [IndexAPI](#141-indexapi)
    - 14.2 [SearchAPI](#142-searchapi)
    - 14.3 [SearchFactory](#143-searchfactory)
15. [CLI Layer](#15-cli-layer)
16. [SQLite Schema](#16-sqlite-schema)
17. [Data Flow Diagrams](#17-data-flow-diagrams)
18. [Design Patterns Reference](#18-design-patterns-reference)
19. [Complete Dependency Graph](#19-complete-dependency-graph)
20. [Testing Strategy](#20-testing-strategy)
21. [Concurrency & WAL Strategy](#21-concurrency--wal-strategy)

---

## 1. What is BrainBank

BrainBank is a **local-first semantic knowledge engine** built as an extensible
plugin framework. All data lives in a single SQLite file with two retrieval layers
and an optional reranker on top:

| Layer | Technology | Characteristic |
|-------|-----------|----------------|
| Vector search | HNSW (hnswlib-node) | Semantic similarity, O(log n) |
| Keyword search | FTS5 BM25 (SQLite) | Exact/stem match, O(log n) |
| Hybrid | Vector + BM25 → RRF | Best of both |
| Reranking | Cross-encoder (optional) | Position-aware score blending |

Everything is accessed through a **single facade** (`BrainBank`) that composes
specialized subsystems via a **plugin architecture**. The core package owns all
infrastructure (DB, schema, HNSW, embeddings, search, CLI). Plugin packages
(`@brainbank/code`, `@brainbank/git`, `@brainbank/docs`,
`@brainbank/mcp`) implement domain-specific indexing and are loaded via `.use()`.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        USER / AI AGENT                               │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  brain.index() / brain.search()
                            │  brain.getContext() / brain.collection()
                            │  brain.code / brain.git / brain.docs
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   BrainBank  (Facade + EventEmitter)                 │
│                                                                      │
│  ┌───────────┐  ┌────────────┐  ┌──────────────┐                    │
│  │ IndexAPI  │  │ SearchAPI  │  │ PluginRegistry│                    │
│  └─────┬─────┘  └─────┬──────┘  └──────┬────────┘                   │
└────────┼──────────────┼────────────────┼────────────────── ┼─────────┘
         │              │                │                    │
         ▼              ▼                ▼                    ▼
   ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────────────┐
   │ Plugins  │  │  SearchLayer │  │ Plugin   │  │  Database        │
   │ code/git/│  │  Composite   │  │ instances│  │  HNSWIndex       │
   │ docs     │  │  Keyword     │  │          │  │  EmbeddingProvider│
   └──────────┘  │  Context     │  └──────────┘  └──────────────────┘
                 └──────────────┘
```

**Three conceptual layers:**

| Layer | Purpose | Key files |
|-------|---------|-----------|
| **Facade / Engine** | Public surface, delegation, init guards | `brainbank.ts`, `engine/` |
| **Domain / Plugin** | Indexing, searching, learning | `plugin.ts`, `services/`, `packages/*/` |
| **Infrastructure** | DB, vectors, embeddings, math | `db/`, `providers/`, `lib/` |

---

## 2. Repository Structure

```
brainbank/
├── src/                               ← Core library (published as "brainbank")
│   ├── brainbank.ts                   ← Main facade (BrainBank class)
│   ├── index.ts                       ← Public exports
│   ├── types.ts                       ← All TypeScript interfaces
│   ├── constants.ts                   ← PLUGIN / HNSW typed constants
│   ├── config.ts                      ← resolveConfig() + DEFAULTS
│   ├── plugin.ts                      ← Plugin interfaces, PluginContext, type guards
│   │
│   ├── bootstrap/                        ← (reserved for future system wiring)
│   │
│   ├── engine/
│   │   ├── types.ts                   ← IndexAPIDeps + SearchAPIDeps interfaces
│   │   ├── index-api.ts               ← IndexAPI: orchestrates indexing across plugins
│   │   ├── search-api.ts              ← SearchAPI: collect → fuse (RRF) → rerank
│   │   ├── search-factory.ts          ← createSearchAPI(): wires CompositeVectorSearch
│   │   │                                + KeywordSearch + ContextBuilder → SearchAPI
│   │   └── reembed.ts                 ← reembedAll(): atomic vector swap without re-parsing
│   │
│   ├── db/
│   │   ├── database.ts                ← better-sqlite3 wrapper (WAL, FK, transactions)
│   │   ├── schema.ts                  ← All DDL: tables, indices, FTS5, triggers
│   │   ├── embedding-meta.ts          ← Track/detect/compare embedding provider in DB
│   │   └── rows.ts                    ← TypeScript interfaces for DB row types
│   │
│   ├── providers/
│   │   ├── embeddings/
│   │   │   ├── local-embedding.ts     ← @xenova/transformers WASM (384d, offline)
│   │   │   ├── openai-embedding.ts    ← OpenAI API (1536d / 3072d)
│   │   │   ├── perplexity-embedding.ts ← Perplexity standard (2560d, base64 int8)
│   │   │   ├── perplexity-context-embedding.ts ← Contextualized (2560d, best quality)
│   │   │   └── resolve.ts             ← resolveEmbedding(key) + providerKey(provider)
│   │   ├── rerankers/
│   │   │   └── qwen3-reranker.ts      ← Qwen3 cross-encoder via node-llama-cpp
│   │   └── vector/
│   │       ├── hnsw-index.ts          ← HNSWIndex: hnswlib-node wrapper
│   │       └── hnsw-loader.ts         ← hnswPath, loadVectors, loadVecCache, saveAllHnsw
│   │
│   ├── search/
│   │   ├── types.ts                   ← SearchStrategy, SearchOptions, CodeGraphProvider
│   │   ├── context-builder.ts         ← ContextBuilder: assembles markdown for LLM
│   │   ├── import-graph.ts            ← 2-hop import traversal + sibling clustering
│   │   ├── context/
│   │   │   ├── formatters.ts          ← Format code results + call graph + import graph
│   │   │   ├── result-formatters.ts   ← Format git, co-edits, patterns, documents
│   │   │   └── sql-code-graph.ts      ← SqlCodeGraphProvider (CodeGraphProvider impl)
│   │   ├── keyword/
│   │   │   └── keyword-search.ts      ← FTS5 BM25 across code_chunks, git_commits, memory_patterns
│   │   └── vector/
│   │       ├── composite-vector-search.ts ← Composes Code + Git + Pattern strategies
│   │       ├── code-vector-search.ts  ← code_chunks HNSW + MMR
│   │       ├── git-vector-search.ts   ← git_commits HNSW
│   │       ├── pattern-vector-search.ts ← memory_patterns HNSW + MMR
│   │       └── mmr.ts                 ← Maximum Marginal Relevance diversification
│   │
│   ├── services/
│   │   ├── collection.ts              ← Collection: KV store (hybrid search, tags, TTL)
│   │   ├── kv-service.ts              ← KVService: owns shared kvHnsw + kvVecs + collection map
│   │   ├── plugin-registry.ts         ← PluginRegistry: registration + type-prefix lookup
│   │   └── watch.ts                   ← Watcher: fs.watch with debounce + plugin routing
│   │
│   ├── lib/
│   │   ├── fts.ts                     ← sanitizeFTS, normalizeBM25, escapeLike
│   │   ├── languages.ts               ← SUPPORTED_EXTENSIONS, IGNORE_DIRS, IGNORE_FILES
│   │   ├── math.ts                    ← cosineSimilarity, normalize, vecToBuffer
│   │   ├── provider-key.ts            ← providerKey(): EmbeddingProvider → canonical key
│   │   ├── rerank.ts                  ← Position-aware score blending
│   │   └── rrf.ts                     ← reciprocalRankFusion + fuseRankedLists<T>
│   │
│   └── cli/
│       ├── index.ts                   ← CLI dispatcher
│       ├── utils.ts                   ← Colors, arg parsing, result printer
│       ├── factory/
│       │   ├── index.ts               ← createBrain() orchestrator
│       │   ├── config-loader.ts       ← .brainbank/config.json loader + cache
│       │   ├── plugin-loader.ts       ← Dynamic @brainbank/* loading + folder discovery
│       │   │                            + embedding/reranker resolution from flags/config
│       │   └── builtin-registration.ts ← Multi-repo detection + plugin registration
│       └── commands/
│           ├── index.ts               ← brainbank index (interactive scan → prompt → index)
│           ├── scan.ts                ← scanRepo(): lightweight scanner (no BrainBank init)
│           ├── search.ts              ← search / hsearch / ksearch
│           ├── docs.ts                ← docs / dsearch
│           ├── collection.ts          ← collection add/list/remove
│           ├── context.ts             ← context [task] / context add / context list
│           ├── kv.ts                  ← kv add/search/list/trim/clear
│           ├── stats.ts               ← stats
│           ├── reembed.ts             ← reembed
│           ├── watch.ts               ← watch
│           ├── serve.ts               ← serve (delegates to @brainbank/mcp)
│           └── help.ts                ← help
│
└── packages/
    ├── code/                          ← @brainbank/code
    │   └── src/
    │       ├── index.ts
    │       ├── code-plugin.ts         ← CodePlugin factory: code()
    │       ├── code-walker.ts         ← File walker + incremental indexer (FNV-1a hash)
    │       ├── code-chunker.ts        ← Tree-sitter AST chunker + sliding window fallback
    │       ├── grammars.ts            ← Grammar registry (20+ languages, CJS/ESM fallback)
    │       ├── import-extractor.ts    ← Regex import extraction per language
    │       └── symbol-extractor.ts    ← AST symbol defs + call references per chunk
    │
    ├── git/                           ← @brainbank/git
    │   └── src/
    │       ├── index.ts
    │       ├── git-plugin.ts          ← GitPlugin factory: git()
    │       ├── git-indexer.ts         ← 3-phase commit pipeline (collect → embed → insert)
    │       └── co-edit-analyzer.ts    ← File co-occurrence SQL queries
    │
    ├── docs/                          ← @brainbank/docs
    │   └── src/
    │       ├── index.ts
    │       ├── docs-plugin.ts         ← DocsPlugin factory: docs() + collection management
    │       ├── docs-indexer.ts        ← Smart markdown chunker + incremental indexer (SHA-256)
    │       └── document-search.ts     ← Hybrid search for doc collections (RRF + dedup by file)
    │
    └── mcp/                           ← @brainbank/mcp
        └── src/
            └── mcp-server.ts          ← MCP stdio server (6 tools, LRU pool of 10 workspaces)
```

**Package dependency graph:**

```
@brainbank/code    ── peerDep ──► brainbank (core)
@brainbank/git     ── peerDep ──► brainbank (core)
@brainbank/docs    ── peerDep ──► brainbank (core)
@brainbank/mcp     ── peerDep ──► brainbank + @brainbank/code + @brainbank/git + @brainbank/docs
```

> **Schema ownership:** Core owns ALL table schemas via `createSchema()` in `src/db/schema.ts`.
> Plugins never define DDL — they only call `ctx.db.prepare(...)` against tables
> that `createSchema()` already created.

---

## 3. BrainBank — Main Facade

**File:** `src/brainbank.ts` (359 lines)
**Pattern:** Facade + EventEmitter

`BrainBank` is a **thin orchestrator**. It owns state, enforces initialization
guards, and delegates every operation to specialized subsystems. Contains
no business logic itself.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          BrainBank                                     │
│                     extends EventEmitter                               │
│                                                                        │
│  STATE                                                                 │
│  ─────────────────────────────────────────────────────────────────    │
│  _config:       ResolvedConfig           merged defaults + user cfg    │
│  _db:           Database                 SQLite connection             │
│  _embedding:    EmbeddingProvider        active embedding model        │
│  _registry:     PluginRegistry           all registered plugins        │
│  _searchAPI:    SearchAPI | undefined    search + context ops          │
│  _indexAPI:     IndexAPI | undefined     indexing orchestration        │
│  _kvService:    KVService | undefined    KV infra (hnsw, vecs, map)    │
│  _sharedHnsw:   Map<string, {hnsw, vecCache}>  'code' / 'git' pool     │
│  _initialized:  boolean                  init guard flag               │
│  _initPromise:  Promise<void> | null     dedup concurrent inits        │
│  _watcher:      Watcher | undefined      fs.watch handle               │
│                                                                        │
│  PUBLIC API                                                            │
│  ─────────────────────────────────────────────────────────────────    │
│  .use(plugin)              register plugin, chainable, before init     │
│  .initialize(opts?)        inline init, idempotent, auto-called      │
│  .collection(name)         get/create KV Collection                   │
│  .listCollectionNames()    list all collections with data              │
│  .deleteCollection(name)   remove from DB + evict from cache           │
│  .index(opts)              delegates to IndexAPI                       │
│  .search(query, opts)      vector search → RRF if multiple sources     │
│  .hybridSearch(query, opts)  vector + BM25 → RRF → optional rerank    │
│  .searchBM25(query, opts)  keyword-only search                         │
│  .getContext(task, opts)   formatted markdown for LLM system prompt    │
│  .rebuildFTS()             rebuild FTS5 indices                        │
│  .reembed(opts)            re-generate all vectors (provider switch)   │
│  .watch(opts)              start fs.watch auto-reindex                 │
│  .stats()                  stats from all loaded plugins               │
│  .has(name)                check if plugin loaded (prefix-match)       │
│  .plugin<T>(name)          typed plugin access, undefined if missing   │
│  .close()                  cleanup all resources                       │
│                                                                        │
│  TYPED PLUGIN ACCESSORS (available after .use(), before init)          │
│  ─────────────────────────────────────────────────────────────────    │
│  .docs  → DocsPlugin | undefined   (registry.firstByType('docs'))     │
│  .git   → Plugin | undefined       (registry.firstByType('git'))      │
│  .code  → Plugin | undefined       (registry.firstByType('code'))     │
│                                                                        │
│  CONFIG / STATUS (read-only)                                           │
│  .isInitialized  → boolean                                             │
│  .config         → Readonly<ResolvedConfig>                            │
│  .plugins        → string[]                                            │
│                                                                        │
│  EVENTS EMITTED                                                        │
│  ─────────────────────────────────────────────────────────────────    │
│  'initialized'  → { plugins: string[] }                               │
│  'indexed'      → { code?, git?, docs?, [custom]? }                   │
│  'reembedded'   → ReembedResult                                        │
│  'progress'     → string message                                       │
│  'warn'         → string message                                       │
└────────────────────────────────────────────────────────────────────────┘
```

**Auto-init vs require-init:**

```
Methods that call await this.initialize() (auto-init, transparent):
  index
  search, hybridSearch, getContext
  reembed (calls initialize first)

Methods that call _requireInit() (throw if not initialized):
  searchBM25, rebuildFTS, watch, stats
  listCollectionNames, deleteCollection

collection() — special case:
  throws "Collections not ready" if _kvService is undefined
  (i.e., must call initialize() first)

.use(plugin) — throws after _initialized === true:
  "Cannot add plugin 'X' after initialization. Call .use() before any operations."

Concurrent init guard:
  caller A → await brain.search()   ─────────────────────────► delegates
  caller B → await brain.search()   ─┐
                                     ├── _initialized? YES ──► delegates
                                     ├── _initPromise !== null? ──► await same promise
                                     └── neither ──► _runInitialize()
                                                       _initPromise = promise
                                                       earlyInit → lateInit
                                                       _initialized = true
                                                       .then(() => _initPromise = null)
                                                       .catch(() => cleanup + _initPromise = null + rethrow)
```

**Error cleanup in catch block** (`_runInitialize` catch):

```
for ({ hnsw } of _sharedHnsw.values()):
  try { hnsw.reinit() } catch { emit('warn', ...) }
_kvService?.clear()
try { _kvService.hnsw.reinit() } catch { emit('warn', ...) }
try { _db?.close() } catch { /* DB already closed */ }
_db = undefined
_kvService = undefined
_searchAPI = undefined
_indexAPI = undefined
_initPromise = null
throw err  ← re-throw so caller sees the failure
```

**close() cleanup sequence:**

```
_watcher?.close()
for (indexer of registry.all): indexer.close?.()
reranker?.close?.()    ← release Qwen3 native model
_embedding?.close().catch(() => {})
_db?.close()
_initialized = false
_kvService?.clear()
_sharedHnsw.clear()
_kvService = undefined
_searchAPI = undefined
_indexAPI = undefined
_registry.clear()
```

---

## 4. Initialization

**File:** `src/brainbank.ts` — `_runInitialize()` method
**Pattern:** Linear multi-step construction

Plugins call `ctx.collection()` during their own `initialize()`.
`collection()` requires `KVService` (which holds `kvHnsw`),
so KVService is created in step 4, before plugins run in step 6.

```
BrainBank._runInitialize({ force? })
│
├── 1. Open Database
│     new Database(config.dbPath)
│     WAL mode, FK constraints, FTS5 triggers, all tables via createSchema()
│
├── 2. Resolve Embedding
│     _resolveEmbedding():
│       1. config.embeddingProvider (explicit — highest priority)
│       2. embedding_meta.provider_key in DB → resolveEmbedding(key)
│       3. fallback → resolveEmbedding('local') → LocalEmbedding
│
├── 3. Check Dimension Mismatch
│     detectProviderMismatch(db, embedding):
│       null → first time, proceed
│       mismatch && !force → db.close(), throw Error
│       mismatch && force → skipVectorLoad = true
│     setEmbeddingMeta(db, embedding)
│
├── 4. Create KV HNSW + KVService
│     dims = embedding.dims ?? config.embeddingDims
│     kvHnsw = new HNSWIndex(dims, ...).init()
│     _kvService = new KVService(db, embedding, kvHnsw, new Map(), reranker)
│     ← collection() NOW WORKS
│
├── 5. Load KV Vectors (unless skipVectorLoad)
│     tryLoad(kvIndexPath, kvCount) → loadVecCache (hit) / loadVectors (miss)
│
├── 6. Initialize Plugins
│     ctx = _buildPluginContext(skipVectorLoad, privateHnsw)
│     for each mod in registry.all: await mod.initialize(ctx)
│
├── 7. Persist HNSW Indices
│     saveAllHnsw(dbPath, kvHnsw, sharedHnsw, privateHnsw)
│
└── 8. Build SearchAPI + IndexAPI
      createSearchAPI(db, embedding, config, registry, kvService, sharedHnsw)
      new IndexAPI({ registry, gitDepth, emit })
```

**HNSW persistence strategy:**

```
Startup (tryLoad):
  file exists AND row count matches → load graph file (~50ms)
    → only populate Map<id, Float32Array> (loadVecCache)
    → HNSW graph nodes already reconstructed from .index file

  file missing OR count differs (stale) → rebuild from SQLite BLOBs
    → SELECT id, embedding FROM table; hnsw.add() + cache.set() per row
    → slower but always correct

After all plugins initialize:
  saveAllHnsw() → write .index files for kv, shared, and private
  ← next cold start will be fast via tryLoad()
```

---

## 5. Plugin Registry

**File:** `src/services/plugin-registry.ts` (114 lines)
**Pattern:** Registry + Type-Prefix Matching

```
PluginRegistry
│
│  _map: Map<string, Plugin>   (insertion-order)
│
│  register(plugin)
│    → _map.set(plugin.name, plugin)
│    ← duplicate names silently overwrite (last .use() wins)
│
│  has('code')
│    → checks exact 'code'
│    OR any key starting with 'code:'
│    → true for 'code', 'code:frontend', 'code:backend'
│
│  get<T>('code')
│    1. ALIASES lookup (currently empty, extensible via const ALIASES)
│    2. exact match _map.get('code')
│    3. first type-prefix match (firstByType)
│    throws: "BrainBank: Plugin 'code' is not loaded. Add .use(code())."
│
│  allByType('code')
│    → all plugins where name === 'code' OR name.startsWith('code:')
│    → [code, code:frontend, code:backend]
│
│  firstByType('git')
│    → first match for 'git' or 'git:*', undefined if none
│
│  names    → string[]   insertion order
│  all      → Plugin[]   insertion order
│  raw      → Map<string, Plugin>   (used by Watch service)
│  clear()  → remove all (called by BrainBank.close())
```

**Multi-repo naming convention:**

```typescript
brain
  .use(code({ name: 'code:frontend', repoPath: './fe' }))
  .use(code({ name: 'code:backend',  repoPath: './be' }))
  .use(git({  name: 'git:frontend',  repoPath: './fe' }))
  .use(git({  name: 'git:backend',   repoPath: './be' }))

// _map keys: 'code:frontend', 'code:backend', 'git:frontend', 'git:backend'

registry.allByType('code')  → [CodePlugin(fe), CodePlugin(be)]
registry.has('code')        → true  (prefix match)
registry.has('docs')        → false (not registered)

// Both code plugins share ONE HNSW in _sharedHnsw['code']
// Both git  plugins share ONE HNSW in _sharedHnsw['git']
```

---

## 6. Plugin System & Plugin Context

**File:** `src/plugin.ts` (185 lines)
**Pattern:** Extension Point + Dependency Injection

### 6.1 Plugin Interfaces

```
Plugin  (base — every plugin must implement)
│  readonly name: string
│  initialize(ctx: PluginContext): Promise<void>
│  stats?():  Record<string, number | string>
│  close?():  void

IndexOptions  (typed options for IndexablePlugin.index())
│  forceReindex?: boolean
│  depth?: number
│  onProgress?: ProgressCallback

IndexablePlugin extends Plugin
│  index(options?: IndexOptions): Promise<IndexResult>
│  ← IndexResult: { indexed: number, skipped: number, chunks?: number }

SearchablePlugin extends Plugin
│  search(query: string, options?: Record<string, unknown>): Promise<SearchResult[]>

WatchablePlugin extends Plugin
│  onFileChange(filePath, event: 'create'|'update'|'delete'): Promise<boolean>
│  watchPatterns(): string[]   ← glob patterns like ['**/*.csv']

DocsPlugin extends SearchablePlugin
│  addCollection(collection: DocumentCollection): void
│  removeCollection(name: string): void
│  listCollections(): DocumentCollection[]
│  indexDocs(options?): Promise<Record<string, { indexed, skipped, chunks }>>
│  addContext(collection, path, context): void
│  listContexts(): PathContext[]

CoEditPlugin extends Plugin
│  coEdits: { suggest(filePath: string, limit: number): CoEditSuggestion[] }

ReembeddablePlugin extends Plugin
│  reembedConfig(): ReembedTable
│  ← ReembedTable: { name, textTable, vectorTable, idColumn, fkColumn, textBuilder }
```

**Type guards (all in `src/plugin.ts`):**

```typescript
isIndexable(p)    → typeof p.index === 'function'
isSearchable(p)   → typeof p.search === 'function'
isWatchable(p)    → typeof p.onFileChange === 'function'
                     && typeof p.watchPatterns === 'function'
isDocsPlugin(p)   → typeof p.addCollection === 'function'
                     && typeof p.listCollections === 'function'
isCoEditPlugin(p) → 'coEdits' in p && typeof p.coEdits?.suggest === 'function'
isReembeddable(p) → typeof p.reembedConfig === 'function'
```

### 6.2 PluginContext — Dependency Injection Container

Built by `_buildPluginContext()` in `src/brainbank.ts`.
Every plugin receives exactly one `PluginContext` during `initialize()`.

```
PluginContext
│
├── db: Database
│     ← shared SQLite (ALL plugins use the same file)
│
├── embedding: EmbeddingProvider
│     ← global embedding; plugins can override with opts.embeddingProvider ?? ctx.embedding
│
├── config: ResolvedConfig
│
├── createHnsw(maxElements?, dims?, name?): Promise<HNSWIndex>
│     ← creates a PRIVATE HNSW for the plugin
│     ← dims defaults to config.embeddingDims
│     ← name → registered in privateHnsw Map → saved to 'hnsw-{name}.index'
│     ← used by: DocsPlugin ('doc')
│
├── loadVectors(table, idCol, hnsw, cache): void
│     ← no-op if skipVectorLoad === true (force-init with dim mismatch)
│     ← otherwise: hnswPath → tryLoad → loadVecCache (hit) / loadVectors (miss)
│
├── getOrCreateSharedHnsw(type, maxElements?, dims?):
│     Promise<{ hnsw, vecCache, isNew }>
│     ← checks _sharedHnsw Map for existing entry by type
│     ← if existing: return { hnsw, vecCache, isNew: false }
│     ← if new: create HNSWIndex, register in sharedHnsw, return { ..., isNew: true }
│     ← ONLY the FIRST plugin (isNew=true) should call loadVectors
│     ← used by: CodePlugin ('code'), GitPlugin ('git')
│
└── collection(name): ICollection
      ← delegates to kvService.collection(name)
```

**HNSW allocation per plugin type:**

```
Plugin        │ HNSW location            │ Shared? │ Persisted as
──────────────┼──────────────────────────┼─────────┼──────────────────────
CodePlugin    │ _sharedHnsw['code']       │ ✓ all code:* │ hnsw-code.index
GitPlugin     │ _sharedHnsw['git']        │ ✓ all git:*  │ hnsw-git.index
DocsPlugin    │ plugin.hnsw (private)     │ ✗       │ hnsw-doc.index
KV store      │ KVService._hnsw (kvHnsw)  │ ✓ all KV collections │ hnsw-kv.index
```

---

## 7. Built-in Plugins

### 7.1 @brainbank/code

**Files:** `packages/code/src/` — `code-plugin.ts`, `code-walker.ts`, `code-chunker.ts`, `grammars.ts`, `import-extractor.ts`, `symbol-extractor.ts`

```
code({ repoPath?, name?, embeddingProvider?, maxFileSize?, ignore? })
         │
         ▼
CodePlugin.initialize(ctx)
         │
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── shared = ctx.getOrCreateSharedHnsw('code', undefined, embedding.dims)
         ├── if shared.isNew:
         │     ctx.loadVectors('code_vectors', 'chunk_id', shared.hnsw, shared.vecCache)
         └── new CodeWalker(repoPath, { db, hnsw, vectorCache, embedding },
                            maxFileSize, ignore)
               ← ignore compiled via picomatch({ dot: true }) if provided


CodeWalker.index({ forceReindex?, onProgress? })
         │
         ├── _walkRepo(repoPath) → absolute file paths[]
         │     filter rules:
         │       dirs:  isIgnoredDir(name)       ← IGNORE_DIRS from lib/languages.ts
         │              _isIgnored(relDir)        ← picomatch custom patterns
         │       files: isIgnoredFile(name)       ← lockfiles etc
         │              ext not in SUPPORTED_EXTENSIONS
         │              stat.size > maxFileSize
         │              _isIgnored(relPath)
         │
         ├── for each file:
         │     content = fs.readFileSync()
         │     hash = FNV-1a(content)   ← fast non-crypto, 32-bit hex
         │     SELECT file_hash FROM indexed_files WHERE file_path = rel
         │     if same hash && !forceReindex → skipped++; continue
         │     chunkCount = await _indexFile(filePath, rel, content, hash)
         │
         └── returns { indexed, skipped, chunks: totalChunks }


CodeWalker._indexFile(filePath, rel, content, hash)
         │
         ├── CodeChunker.chunk(rel, content, language)
         │     │
         │     ├── if lines.length ≤ MAX_LINES (80):
         │     │     → single chunk { chunkType:'file', startLine:1, endLine:N }
         │     │
         │     ├── _ensureParser() → lazy require('tree-sitter')
         │     │   _loadGrammar(language):
         │     │     try require(pkg)                  ← CJS fast path
         │     │     catch ERR_REQUIRE_ASYNC_MODULE
         │     │          ERR_REQUIRE_ESM → await import(pkg)  ← ESM fallback
         │     │     catch other → throw "Grammar not installed: npm i -g {pkg}"
         │     │
         │     ├── if parser + grammar:
         │     │     parser.setLanguage(grammar.grammar)
         │     │     tree = parser.parse(content)
         │     │     _extractChunks(rootNode, langConfig):
         │     │       export_statement → unwrap inner declaration
         │     │       decorated_definition → unwrap Python @decorator
         │     │       class/struct/impl > MAX_LINES → _splitClassIntoMethods()
         │     │       function/interface/variable > MAX_LINES → _splitLargeBlock(overlap=5)
         │     │       normal-sized → _addChunk()
         │     │
         │     └── fallback → _chunkGeneric():
         │           sliding window, step = MAX - OVERLAP (5)
         │
         ├── extractImports(content, language)  ← regex patterns per language
         │     typescript/javascript, python, go, rust, java/kotlin/scala,
         │     c/cpp, ruby, php, lua, elixir, swift, bash, html, css
         │     → simplified module names via simplifyModule()
         │
         ├── build embeddingTexts per chunk:
         │     "File: src/api.ts\nImports: express, zod\n
         │      Class: MyService\nfunction: handleRequest\n<code>"
         │
         ├── embedding.embedBatch(embeddingTexts) → Float32Array[]
         │
         ├── _extractSymbolsSafe(content, rel, language)
         │     extractSymbols(tree.rootNode, rel, language)
         │     → SymbolDef[] { name, kind, line, filePath }
         │     kinds: 'function'|'class'|'method'|'variable'|'interface'
         │
         ├── Collect old chunk IDs for HNSW cleanup BEFORE transaction
         │
         └── DB TRANSACTION (atomic delete-old + insert-new):
               DELETE code_chunks WHERE file_path = rel (CASCADE)
               DELETE code_imports, code_symbols WHERE file_path = rel
               INSERT code_chunks → chunkIds[]
               INSERT code_vectors (chunk_id, vecToBuffer(vec))
               INSERT OR IGNORE code_imports (file_path, imports_path)
               INSERT code_symbols (file_path, name, kind, line, chunk_id)
               INSERT code_refs (chunk_id, symbol_name) per call ref:
                 extractCallRefs(tree.rootNode, language)
                   → filter _isBuiltin(name): skip push, forEach, map, console...
               UPSERT indexed_files (file_path, file_hash)

             AFTER transaction success:
               hnsw.remove(oldId) + vectorCache.delete(oldId) per old chunk
               hnsw.add(vec, newId) + vectorCache.set(newId, vec) per new chunk


CodePlugin.reembedConfig(): ReembedTable
  { name:'code', textTable:'code_chunks', vectorTable:'code_vectors',
    idColumn:'id', fkColumn:'chunk_id',
    textBuilder: (r) => "File: {file_path}\n{chunk_type}: {name}\n{content}" }

CodePlugin.stats():
  { files: COUNT(DISTINCT file_path), chunks: COUNT(*), hnswSize: hnsw.size }
```

**Grammar registry (`grammars.ts`):**

```
typescript (.typescript accessor), javascript, python, go, rust, c, cpp
java, kotlin, scala, ruby, php (.php accessor), lua, bash, elixir
swift, html, css, c_sharp
```

---

### 7.2 @brainbank/git

**Files:** `packages/git/src/` — `git-plugin.ts`, `git-indexer.ts`, `co-edit-analyzer.ts`

```
git({ repoPath?, depth?, maxDiffBytes?, name?, embeddingProvider? })
         │
         ▼
GitPlugin.initialize(ctx)
         │
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── shared = ctx.getOrCreateSharedHnsw('git', 500_000, embedding.dims)
         ├── if shared.isNew:
         │     ctx.loadVectors('git_vectors', 'commit_id', shared.hnsw, shared.vecCache)
         ├── new GitIndexer(repoPath, { db, hnsw, vectorCache, embedding }, maxDiffBytes)
         └── new CoEditAnalyzer(ctx.db)


GitIndexer.index({ depth=500, onProgress? })
         │
         ├── simpleGit(repoPath)   ← dynamic import('simple-git')
         │   git.log({ maxCount: depth }) → { all: Commit[] }
         │
         ├── _prepareStatements()  ← hoist all SQL outside loops
         │
         ├── PHASE 1: _collectCommits() [async git calls per commit]
         │     for each commit:
         │       check DB: has_vector? → skip
         │       zombie (data, no vector)? → cleanup
         │       _parseCommit(git, c):
         │         git show --numstat → filesChanged[], additions, deletions
         │         git show --unified=3 → diff (truncated maxDiffBytes)
         │         isMerge = /^(Merge|merge)\s+(branch|pull|remote|tag)/.test(msg)
         │         text = "Commit: {msg}\nAuthor:\nDate:\nFiles:\nChanges:\n{diff[:2000]}"
         │
         ├── embedding.embedBatch(all new texts) → vecs[]
         │
         ├── PHASE 2: _insertCommits() [one DB transaction]
         │     INSERT git_commits + commit_files + git_vectors
         │
         └── PHASE 3: _updateHnsw() + _computeCoEdits()
               hnsw.add() + vectorCache.set() per commit
               _computeCoEdits:
                 _queryCommitFiles() in chunks of 500 (SQLite 999-var limit)
                 group by commit_id
                 for commits with 2–20 files:
                   UPSERT co_edits (file_a, file_b, count+1)
                   ← [a, b].sort() canonical order


CoEditAnalyzer.suggest(filePath, limit=5):
  SELECT file, count FROM co_edits WHERE file_a=? OR file_b=?
  ORDER BY count DESC LIMIT ?

GitPlugin.fileHistory(filePath, limit=20):
  SELECT ... FROM git_commits JOIN commit_files
  WHERE file_path LIKE '%{escaped}%' AND is_merge = 0
  ORDER BY timestamp DESC

GitPlugin.reembedConfig(): ReembedTable
  { name:'git', textTable:'git_commits', vectorTable:'git_vectors',
    idColumn:'id', fkColumn:'commit_id',
    textBuilder: (r) => "Commit: {message}\nAuthor:\nDate:\nFiles:\nChanges:\n{diff[:2000]}" }

GitPlugin.stats():
  { commits, filesTracked, coEdits, hnswSize }
```

---

### 7.3 @brainbank/docs

**Files:** `packages/docs/src/` — `docs-plugin.ts`, `docs-indexer.ts`, `document-search.ts`

```
docs({ embeddingProvider? })
         │
         ▼
DocsPlugin.initialize(ctx)
         │
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── this.hnsw = await ctx.createHnsw(undefined, embedding.dims, 'doc')
         │     ← PRIVATE HNSW (NOT in _sharedHnsw), persisted to 'hnsw-doc.index'
         ├── ctx.loadVectors('doc_vectors', 'chunk_id', this.hnsw, this.vecCache)
         ├── this.indexer = new DocsIndexer(db, embedding, hnsw, vecCache)
         └── this._search = new DocumentSearch({ db, embedding, hnsw, vecCache, reranker })


DocsIndexer._smartChunk(text) → [{ text, pos }]
  if text.length ≤ TARGET_CHARS (3000) → single chunk
  _findBreakPoints(lines):
    H1=100, H2=90, H3=80, H4=70, H5=60, H6=50
    code-fence-close=80, ---=60, ***=60, blank=20, list-item=5
    tracks inCodeBlock (toggle on ```)
  greedy split:
    WINDOW_CHARS=600, targetEnd = chunkStart + TARGET_CHARS
    for each breakpoint in window:
      finalScore = score * (1 - (dist/WINDOW)² * 0.7)  ← distance decay
    MIN_CHUNK_CHARS=200: merge tiny remainder into last chunk


DocsIndexer.indexCollection(collection, dirPath, pattern, opts)
  _walkFiles → filter by ext, IGNORED_DOC_DIRS, custom ignore patterns
  for each file:
    SHA-256(content).slice(0,16) → hash
    _isUnchanged: all chunks same hash AND have vectors? → skip
    _removeOldChunks() → hnsw.remove + vecCache.delete + DELETE
    _indexFile():
      _extractTitle: first H1/H2/H3 or basename
      _smartChunk(content)
      texts = chunks.map("title: {title} | text: {text}")
      embedding.embedBatch(texts) → embeddings
      TRANSACTION: INSERT doc_chunks + doc_vectors
      AFTER: hnsw.add() + vecCache.set() per chunk


DocsPlugin.reembedConfig(): ReembedTable
  { name:'docs', textTable:'doc_chunks', vectorTable:'doc_vectors',
    idColumn:'id', fkColumn:'chunk_id',
    textBuilder: (r) => "title: {title} | text: {content}" }

DocsPlugin.stats():
  { collections, documents: COUNT(DISTINCT file_path), chunks, hnswSize }
```

---

---

## 8. @brainbank/mcp Package

**File:** `packages/mcp/src/mcp-server.ts` (514 lines)

6 registered MCP tools via `@modelcontextprotocol/sdk`:

| Tool | Description |
|------|------------|
| `brainbank_search` | Unified: hybrid (default), vector, or keyword mode |
| `brainbank_context` | Formatted context block (code + git + docs) |
| `brainbank_index` | Trigger incremental indexing + optional docs path register |
| `brainbank_stats` | Index stats + KV collection inventory |
| `brainbank_history` | Git commit history for a file path |
| `brainbank_collection` | KV operations: add, search, trim |

**Multi-workspace LRU pool:**

```
_pool: Map<string, { brain: BrainBank, lastAccess: number }>
MAX_POOL_SIZE = 10

getBrainBank(targetRepo?)
  repo = targetRepo ?? BRAINBANK_REPO env ?? findRepoRoot(cwd)
  findRepoRoot: walk up from startDir checking for .git/
  if pool hit: health check (code HNSW empty but DB > 100KB → evict)
  if pool full: evict oldest lastAccess (LRU)
  _createBrain(resolved):
    read .brainbank/config.json
    resolve embedding: config > BRAINBANK_EMBEDDING env
    new BrainBank + use(code/git/docs)
    brain.initialize()
    ← corruption recovery: delete DB + retry fresh

_sharedReranker: created once from BRAINBANK_RERANKER=qwen3 env
                 shared across ALL workspace pool entries
```

---

## 10. Collection — KV Store

**Files:** `src/services/collection.ts` (407 lines), `src/services/kv-service.ts` (66 lines)
**Pattern:** Repository + Hybrid Search + Shared HNSW

All collections share **one kvHnsw** owned by `KVService`. Cross-collection isolation via `WHERE collection = ?` after adaptive over-fetch.

```
KVService(db, embedding, hnsw, vecs, reranker?)
  _collections: Map<string, Collection>   ← instance cache
  collection(name) → cached or new Collection(name, db, embedding, hnsw, vecs, reranker?)
  listNames()      → SELECT DISTINCT collection FROM kv_data
  delete(name)     → hnsw.remove() + vecs.delete() per id; DELETE FROM kv_data
  hnsw / vecs      → getters for reembed access
  clear()          → _collections.clear(); _vecs.clear()
```

**Collection methods:**

```
add(content, options?)
  options: { metadata?, tags?, ttl? } OR { key: value } (legacy shorthand)
  detection: 'tags' in opts || 'ttl' in opts || 'metadata' in opts → structured form
  │
  ├── embedding.embed(content)      ← embed FIRST (fail before DB orphans)
  ├── INSERT kv_data (collection, content, meta_json, tags_json, expires_at)
  │     expires_at = floor(now/1000) + parseDuration(ttl)
  │     parseDuration: '30d'→2592000, '24h'→86400, '5m'→300, '10s'→10
  │     FTS trigger fires: INSERT INTO fts_kv(rowid, content, collection)
  ├── INSERT kv_vectors (data_id, vecToBuffer(vec))
  ├── kvHnsw.add(vec, id)
  └── kvVecs.set(id, vec)

addMany(items[])
  embedBatch(all texts)                 ← single API call
  single DB transaction for all inserts
  HNSW + cache updated AFTER transaction ← no orphan risk on rollback

search(query, { k=5, mode='hybrid', minScore=0.15, tags? })
  _pruneExpired():
    SELECT WHERE expires_at IS NOT NULL AND expires_at <= now
    _removeById() per expired item

  mode='keyword' → _searchBM25 → _filterByTags
  mode='vector'  → _searchVector → _filterByTags
  mode='hybrid':
    parallel: _searchVector(k, 0) + _searchBM25(k, 0)
    fuseRankedLists([vectorHits, bm25Hits], String(h.id), h.score)
      ← generic RRF on CollectionItem (not SearchResult)
    filter score >= minScore, slice to k
    if reranker && results.length > 1:
      cast to SearchResult[] (type:'collection')
      rerank(query, asSearchResults, reranker)
      map scores back
    _filterByTags(results, tags)

_searchVector(query, k, minScore):
  queryVec = embedding.embed(query)
  searchK = _adaptiveSearchK(k):
    ratio = ceil(totalHnswSize / collectionCount), clamped [3, 50]
    → min(k * ratio, totalSize)
  kvHnsw.search(queryVec, searchK)
  SELECT * FROM kv_data WHERE id IN (?) AND collection = ?

_searchBM25(query, k, minScore):
  sanitizeFTS(query) → ftsQuery
  SELECT d.*, bm25(fts_kv, 5.0, 1.0) AS score
  FROM fts_kv JOIN kv_data WHERE MATCH ? AND collection = ?

_filterByTags(items, tags?):
  item.tags must include ALL specified tags (AND semantics)

_removeById(id):
  DELETE FROM kv_data (CASCADE + FTS trigger)  ← DB first, can fail
  kvHnsw.remove(id)                            ← these always succeed
  kvVecs.delete(id)

searchAsResults(query, k): Promise<SearchResult[]>
  → map CollectionItem to { type:'collection', score, content, metadata }
  ← used by SearchAPI._collectKvCollections()
```

---

## 11. Search Layer

### 11.1 SearchStrategy Interface

```typescript
// src/search/types.ts
interface SearchStrategy {
    search(query: string, options?: SearchOptions): Promise<SearchResult[]>
    rebuild?(): void
}
interface SearchOptions {
    sources?: Record<string, number>  // { code: 6, git: 5, myNotes: 10 }
    minScore?:  number   // default 0.25
    useMMR?:    boolean  // default true
    mmrLambda?: number   // default 0.7
}
```

### 11.2 CompositeVectorSearch

**File:** `src/search/vector/composite-vector-search.ts`

```
CompositeVectorSearch({ code?, git?, embedding })
  implements SearchStrategy

  .search(query, options):
    queryVec = await embedding.embed(query)   ← ONE embed call
    results = []

    if code && codeK > 0:
      CodeVectorSearch.search(queryVec, codeK, minScore, useMMR, mmrLambda)
        useMMR ? searchMMR(hnsw, queryVec, vecs, k, lambda) : hnsw.search(queryVec, k)
        SELECT * FROM code_chunks WHERE id IN (?)
        → { type:'code', score, filePath, content,
            metadata: { id, chunkType, name, startLine, endLine, language } }

    if git && gitK > 0:
      GitVectorSearch.search(queryVec, gitK, minScore)
        hnsw.search(queryVec, k*2)   ← over-fetch for merge filtering
        SELECT * FROM git_commits WHERE id IN (?) AND is_merge = 0
        → { type:'commit', score, content:message, metadata: { hash, ... } }



    results.sort((a, b) => b.score - a.score)
```

### 11.3 KeywordSearch (BM25)

**File:** `src/search/keyword/keyword-search.ts`

```
KeywordSearch(db)  implements SearchStrategy

.search(query, options):
  sanitizeFTS(query):  [src/lib/fts.ts]
    1. strip: {}[]()^~*:
    2. remove: AND OR NOT NEAR
    3. splitCompound:
         camelCase → "camel Case"
         HTMLParser → "HTML Parser"
         snake_case → "snake case"
    4. filter length > 1
    5. wrap each: "word" → implicit AND
    → '' → return []

  _searchCode(ftsQuery, rawQuery, codeK):
    bm25(fts_code, 5.0, 3.0, 1.0)  ← file_path×5, name×3, content×1
    + _searchCodeByPath(rawQuery): LIKE '%word%' fallback, score=0.6

  _searchGit(ftsQuery, gitK):
    bm25(fts_commits, 5.0, 2.0, 1.0)  ← message×5, author×2, diff×1
    filter: is_merge = 0



  normalizeBM25(rawScore):  [src/lib/fts.ts]
    abs = Math.abs(rawScore)   ← FTS5 returns negative (lower=better)
    1.0 / (1.0 + exp(-0.3 * (abs - 5)))   → 0..1 sigmoid

.rebuild():
  INSERT INTO fts_code(fts_code) VALUES('rebuild')
  INSERT INTO fts_commits(fts_commits) VALUES('rebuild')
```

### 11.4 Hybrid Search + RRF

```
SearchAPI.hybridSearch(query, options?)
         │
         ├── codeK = sources.code ?? 20, gitK = sources.git ?? 8, docsK = sources.docs ?? 8
         │
         ├── if CompositeVectorSearch available:
         │     parallel:
         │       vectorSearch.search(query, { code: codeK, git: gitK })
         │       bm25?.search(query, { code: codeK, git: gitK }) ?? []
         │     lists.push(vecResults, kwResults)
         │
         ├── if registry.has('docs'):
         │     _collectDocs(query, { k: docsK }) → lists.push(docResults)
         │
         ├── _collectCustomPlugins(query, options):
         │     non-builtin SearchablePlugins → lists.push(hits)
         │
         ├── _collectKvCollections(query, sources):
         │     for [name, k] in sources not in {code,git,docs}:
         │       kvService.collection(name).searchAsResults(query, k)
         │
         ├── reciprocalRankFusion(lists, k=60, maxResults=15)
         │
         └── if config.reranker && fused.length > 1:
               rerank(query, fused, config.reranker)


reciprocalRankFusion(resultSets, k=60, maxResults=15):  [src/lib/rrf.ts]
  for each list, for rank i:
    key = resultKey(r)   ← type-specific unique string
    rrfScore += 1.0 / (k + rank + 1)
    accumulate + keep higher original score
  sort by rrfScore DESC, normalize to 0..1

Unique key generation:
  'code'       → "code:{filePath}:{startLine}-{endLine}"
  'commit'     → "commit:{hash or shortHash}"
  'pattern'    → "pattern:{taskType}:{content.slice(0,60)}"
  'document'   → "document:{filePath}:{collection}:{seq}:{content.slice(0,80)}"
  'collection' → "collection:{id or content.slice(0,80)}"

fuseRankedLists<T>(lists, keyFn, scoreFn, k, maxResults):
  ← generic variant used by Collection.search() hybrid mode
```

### 11.5 MMR — Diversity

**File:** `src/search/vector/mmr.ts`

```
searchMMR(index, query, vectorCache, k, lambda=0.7)
  candidates = index.search(query, k*3)   ← over-fetch 3×
  if candidates.length ≤ k → return as-is

  greedy selection (k iterations):
    for each remaining candidate:
      relevance = candidate.score
      maxSim = max cosine(candidate, selected) over all selected
      mmrScore = lambda * relevance - (1 - lambda) * maxSim
    pick argmax(mmrScore)

lambda=0.7: 70% relevance, 30% diversity (default)
lambda=1.0: pure relevance (≡ regular HNSW search)
lambda=0.0: pure diversity
```

### 11.6 Reranking

**File:** `src/lib/rerank.ts`

```
rerank(query, results, reranker): Promise<SearchResult[]>
  documents = results.map(r => r.content)
  scores = await reranker.rank(query, documents)

  Position-aware blending:
    pos 1-3:   rrfWeight = 0.75  ← preserve exact matches
    pos 4-10:  rrfWeight = 0.60
    pos 11+:   rrfWeight = 0.40  ← trust reranker more
    blended = rrfWeight * r.score + (1 - rrfWeight) * scores[i]

  sort by blended DESC
```

### 11.7 ContextBuilder

**File:** `src/search/context-builder.ts`

```
ContextBuilder(search?, coEdits?, codeGraph?, docsSearch?)

.build(task, options?):
  { sources: { code:6, git:5 }, affectedFiles=[],
    minScore=0.25, useMMR=true, mmrLambda=0.7 }

  results = search.search(task, ...)
  parts = [`# Context for: "${task}"\n`]

  formatCodeResults(codeHits, parts, codeGraph?):
    group by filePath
    codeGraph.getCallInfo(chunkId, name):
      SELECT code_refs + JOIN code_chunks
      → "*(calls: X | called by: Y)*"

  formatCodeGraph(codeHits, parts, codeGraph?):
    expandImportGraph(db, hitFiles):
      2-hop BFS on code_imports
      clusterSiblings: 3+ hits same dir → include all
    fetchBestChunks(db, graphFiles):
      largest chunk per file (ORDER BY end_line - start_line DESC)
    → "## Related Code (Import Graph)\n..."

  formatGitResults(results, gitK, parts)
  formatCoEdits(affectedFiles, parts, coEdits?)


  if docsSearch:
    docs = await docsSearch(task, { k, minScore })
    formatDocuments(docs) → "## Relevant Documents\n..."

  → parts.join('\n')
```

**CodeGraphProvider interface** (`src/search/types.ts`):

```typescript
interface CodeGraphProvider {
    getCallInfo(chunkId: number, symbolName?: string):
        { calls: string[]; calledBy: string[] } | null
    expandImportGraph(seedFiles: Set<string>): Set<string>
    fetchBestChunks(filePaths: string[]): CodeChunkSummary[]
}
```

**SqlCodeGraphProvider** (`src/search/context/sql-code-graph.ts`):
Concrete implementation backed by SQLite. Delegates to `import-graph.ts`.

### 11.8 DocumentSearch

**File:** `packages/docs/src/document-search.ts`

```
DocumentSearch({ db, embedding, hnsw, vecCache, reranker? })

.search(query, { collection?, k=8, minScore=0, mode='hybrid' })
  mode='keyword' → _dedup(_searchBM25(...), k)
  mode='vector'  → _dedup(_searchVector(...), k)
  mode='hybrid':
    parallel: _searchVector(fetchK=k*2) + _searchBM25(fetchK=k*2)
    reciprocalRankFusion([vecHits, bm25Hits])
    map fused results to originals via chunkId
    _dedup(results, k) → _rerankResults(query, deduped)

_searchVector: adaptive over-fetch ratio for collection filtering
_searchBM25:
  _buildDocsFTS(query): OR-mode, stop-word filtering, length >= 3
  bm25(fts_docs, 10.0, 2.0, 5.0, 1.0)  ← title×10, content×2, file_path×5, collection×1

_dedup(results, k):
  keep only highest-scoring result per filePath
  prevents multiple chunks from same doc filling top-k

_getDocContext(collection, filePath):
  walk path hierarchy upward: /src/auth/middleware.ts → /src/auth → /src → /
  SELECT context FROM path_contexts WHERE collection=? AND path=?
  fallback: SELECT context FROM collections WHERE name=?
```

---

## 12. Infrastructure

### 12.1 Database

**File:** `src/db/database.ts` (71 lines)

```
Database(dbPath):
  fs.mkdirSync(dirname, { recursive: true })
  new BetterSqlite3(dbPath)
  PRAGMA journal_mode = WAL
  PRAGMA busy_timeout = 5000
  PRAGMA synchronous = NORMAL
  PRAGMA foreign_keys = ON
  createSchema(db)

transaction<T>(fn: () => T): T    ← auto-commit/rollback
batch(sql, rows[][])              ← one txn, one stmt, many rows
prepare(sql) → Statement          ← cached by better-sqlite3
exec(sql)                         ← raw DDL/PRAGMA
close()
```

### 12.2 HNSWIndex

**File:** `src/providers/vector/hnsw-index.ts` (153 lines)

```
HNSWIndex(dims, maxElements=2_000_000, M=16, efConstruction=200, efSearch=50)

init(): Promise<this>
  dynamic import 'hnswlib-node'
  HNSW = lib.default?.HierarchicalNSW ?? lib.HierarchicalNSW  ← CJS/ESM compat
  new HNSW('cosine', dims); initIndex(); setEf()

add(vector, id):
  if _ids.has(id) → return   (idempotent)
  if _ids.size >= maxElements → throw "HNSW index full"
  _index.addPoint(Array.from(vector), id)

remove(id):
  if !_ids.has(id) → return
  _index.markDelete(id)   ← soft delete
  _ids.delete(id)

search(query, k):
  actualK = min(k, _ids.size)
  searchKnn(Array.from(query), actualK)
  → [{ id, score: 1 - distances[i] }]

save(path):    writeIndexSync (skip if empty)
tryLoad(path, expectedCount): boolean
  readIndexSync → verify getCurrentCount() === expectedCount
  stale → reinit() + return false
  ok → _ids = Set(getIdsList()); setEf(); return true

reinit():     fresh empty index, same params
size:         _ids.size
maxElements:  _maxElements
```

### 12.3 HNSW Loader

**File:** `src/providers/vector/hnsw-loader.ts` (86 lines)

```
hnswPath(dbPath, name) → join(dirname(dbPath), 'hnsw-{name}.index')
countRows(db, table)   → SELECT COUNT(*) as c FROM {table}

saveAllHnsw(dbPath, kvHnsw, sharedHnsw, privateHnsw):
  try/catch: non-fatal, next startup rebuilds from SQLite

loadVectors(db, table, idCol, hnsw, cache):
  iterate SELECT {idCol}, embedding FROM {table}
  Float32Array from Buffer (handle byteOffset)
  hnsw.add(vec, id); cache.set(id, vec)

loadVecCache(db, table, idCol, cache):
  same but skips hnsw.add()  ← HNSW already loaded from file
```

### 12.4 Embedding Providers

All implement:
```typescript
interface EmbeddingProvider {
    readonly dims: number
    embed(text: string): Promise<Float32Array>
    embedBatch(texts: string[]): Promise<Float32Array[]>
    close(): Promise<void>
}
```

```
LocalEmbedding  [src/providers/embeddings/local-embedding.ts]
  model:   Xenova/all-MiniLM-L6-v2 (quantized WASM, ~23MB)
  dims:    384
  cache:   .model-cache/
  Lazy singleton pipeline, promise-deduped
  embedBatch: BATCH_SIZE=32, output.data.slice() per item

OpenAIEmbedding({ apiKey?, model='text-embedding-3-small', dims?, baseUrl?, timeout=30s })
  dims: 1536 (3-small) | 3072 (3-large) | 1536 (ada-002)
  Custom dims only on text-embedding-3-*
  MAX_BATCH=100, BATCH_DELAY_MS=100
  Token-limit retry: batch>1 → retry individually at 8k chars; single → 6k, max 1 retry

PerplexityEmbedding({ apiKey?, model='pplx-embed-v1-4b', dims?, ... })
  dims: 2560 (4b) | 1024 (0.6b), Matryoshka support
  decodeBase64Int8(b64, dims): atob → Int8Array → Float32Array

PerplexityContextEmbedding({ apiKey?, model='pplx-embed-context-v1-4b', dims?, ... })
  dims: 2560 (4b) | 1024 (0.6b)
  Input: string[][] (documents × chunks) — chunks share context
  embed(text) → [[text]], embedBatch(texts) → splitIntoDocuments (80k char/doc)
  Response: nested { data: [{ data: [{ embedding }] }] } → flattenContextResponse

resolveEmbedding(key):  [src/providers/embeddings/resolve.ts]
  'local' → LocalEmbedding, 'openai' → OpenAIEmbedding,
  'perplexity' → PerplexityEmbedding, 'perplexity-context' → PerplexityContextEmbedding

providerKey(p):  [src/lib/provider-key.ts]
  constructor.name → canonical key: 'local'|'openai'|'perplexity'|'perplexity-context'
```

### 12.5 Rerankers

**File:** `src/providers/rerankers/qwen3-reranker.ts` (170 lines)

```typescript
interface Reranker {
    rank(query: string, documents: string[]): Promise<number[]>
    close?(): Promise<void>
}
```

```
Qwen3Reranker({ modelUri?, cacheDir?, contextSize=2048 })
  model:  Qwen3-Reranker-0.6B-Q8_0 (~640MB GGUF, HuggingFace auto-download)
  engine: node-llama-cpp (optional peer dep)
  cache:  ~/.cache/brainbank/models/

  _ensureLoaded() [lazy, singleton, promise-deduped]:
    getLlama() → loadModel() → createRankingContext({ flashAttention: true })
    fallback without flashAttention if unsupported

  rank(query, documents):
    deduplicate identical texts → score each unique once
    truncate to context budget: contextSize - 200 - queryTokens
    context.rankAll(query, truncated) → scores[]
    map back to original order
```

---

## 13. Services

### 13.1 Watch Service

**File:** `src/services/watch.ts` (222 lines)

```
Watcher(reindexFn, indexers: Map<string,Plugin>, repoPath, options)
  { paths?, debounceMs=2000, onIndex?, onError? }

  _collectCustomPatterns(): isWatchable plugins → { indexer, patterns }
  _startWatching():
    fs.watch(path, { recursive: mac/win }, (event, filename) => {
      if !_shouldWatch(filename) → skip
      _pending.add(filename)
      clearTimeout + setTimeout(_processPending, debounceMs)
    })

  _shouldWatch(filename):
    any path segment in IGNORE_DIRS → false
    basename in IGNORE_FILES → false
    isSupported(filename) → true
    matchCustomPlugin → true

  _processPending() [serialized via _flushing flag]:
    for each file:
      customIndexer = _matchCustomPlugin(absPath)
      if custom + isWatchable: onFileChange(absPath, 'update'|'delete')
      if isSupported(file): needsReindex = true
    if needsReindex: await reindexFn()
      catch → re-queue code files for retry

  _matchGlob:
    '**/ext' → endsWith(ext)
    '*.ext'  → endsWith(ext)
    else     → exact match
```

### 13.2 Reembed Engine

**File:** `src/engine/reembed.ts` (219 lines)
**Pattern:** Atomic Swap

```
reembedAll(db, embedding, hnswMap, plugins, options?, persist?)

  collectTables(plugins):
    for each isReembeddable plugin: plugin.reembedConfig()
    CORE_TABLES (always included, not plugin-owned):
      'kv':     kv_data → kv_vectors, textBuilder: String(r.content)
    deduplicates by vectorTable (multi-repo plugins share same table)

  for each table:
    skip if table doesn't exist or totalCount === 0

    PHASE 1 — build new vectors in temp table (old data untouched):
      tempTable = '_reembed_{vectorTable}'
      CREATE TABLE temp AS SELECT * FROM vec WHERE 0
      for offset 0..total step batchSize(50):
        SELECT * FROM textTable LIMIT batchSize OFFSET offset
        texts = rows.map(textBuilder)
        vectors = await embedding.embedBatch(texts)
        TRANSACTION: INSERT INTO temp per item
      ← if embedBatch fails mid-batch: old data intact

    PHASE 2 — atomic swap:
      TRANSACTION:
        DELETE FROM vectorTable
        INSERT INTO vectorTable SELECT * FROM temp
      ← all-or-nothing

    finally: DROP TABLE IF EXISTS temp   ← always cleanup

    rebuildHnsw(db, table, entry.hnsw, entry.vecs):
      vecs.clear(); hnsw.reinit()
      SELECT fk, embedding FROM vectorTable
      hnsw.add(vec, id); vecs.set(id, vec)

  setEmbeddingMeta(db, embedding)
  saveAllHnsw(persist.dbPath, ...) if persist provided

→ ReembedResult: { counts: Record<string, number>, total: number }
```

### 13.3 EmbeddingMeta

**File:** `src/db/embedding-meta.ts` (74 lines)

```
embedding_meta table (key/value):
  'provider'     → 'LocalEmbedding' | 'OpenAIEmbedding' | ...
  'dims'         → '384' | '1536' | '2560'
  'provider_key' → 'local' | 'openai' | 'perplexity' | 'perplexity-context'
  'indexed_at'   → ISO timestamp

setEmbeddingMeta(db, embedding):
  UPSERT all four keys

getEmbeddingMeta(db): EmbeddingMeta | null
  SELECT each key; null if provider or dims missing

detectProviderMismatch(db, embedding):
  meta = getEmbeddingMeta(db)
  null → first run, no mismatch
  mismatch = meta.dims !== embedding.dims || meta.provider !== constructor.name
  → { mismatch: boolean, stored: "X/384", current: "Y/1536" }
```

---

## 14. Engine Layer

### 14.1 IndexAPI

**File:** `src/engine/index-api.ts` (124 lines)

```
IndexAPI({ registry, gitDepth, emit })

index({ modules?, gitDepth?, forceReindex?, onProgress? }):
  want = Set(modules ?? ['code', 'git', 'docs'])

  if want.has('code'):
    for mod in registry.allByType('code').filter(isIndexable):
      r = await mod.index({ forceReindex, onProgress })
      accumulate codeAcc: indexed+=, skipped+=, chunks+=

  if want.has('git'):
    for mod in registry.allByType('git').filter(isIndexable):
      r = await mod.index({ depth, onProgress })
      accumulate gitAcc

  if want.has('docs') && registry.has('docs'):
    docsPlugin = registry.get('docs')
    if isDocsPlugin: docsResult = await docsPlugin.indexDocs(...)

  for custom plugin NOT in {code,git,docs} that isIndexable:
    extras[mod.name] = await mod.index(...)

  emit('indexed', result)

```

### 14.2 SearchAPI

**File:** `src/engine/search-api.ts` (144 lines)

```
SearchAPI({ search?, bm25?, registry, config, kvService, contextBuilder? })

NOTE: Always created (even if search === undefined).
BrainBank unconditionally delegates to it.

getContext(task, options?) → contextBuilder?.build(task, options) ?? ''
search(query, options?)   → vector search + custom plugins → RRF if multiple
hybridSearch(query, opts?) → [see §11.4]
searchBM25(query, opts?)   → bm25?.search(query, options) ?? []
rebuildFTS()               → bm25?.rebuild?.()
```

### 14.3 SearchFactory

**File:** `src/engine/search-factory.ts` (74 lines)

```
createSearchAPI(db, embedding, config, registry, kvService, sharedHnsw):
  codeMod = sharedHnsw.get('code')
  gitMod  = sharedHnsw.get('git')

  code     = codeMod ? new CodeVectorSearch({ db, hnsw, vecs }) : undefined
  git      = gitMod  ? new GitVectorSearch({ db, hnsw }) : undefined

  hasAnyStrategy = codeMod || gitMod
  search = hasAnyStrategy
    ? new CompositeVectorSearch({ code, git, embedding })
    : undefined

  bm25 = new KeywordSearch(db)

  gitPlugin = registry.firstByType('git')
  coEdits = isCoEditPlugin(gitPlugin) ? gitPlugin.coEdits : undefined
  codeGraph = new SqlCodeGraphProvider(db)
  docsSearch = (query, opts?) => registry.firstByType('docs')?.search(query, opts) ?? []

  contextBuilder = new ContextBuilder(search, coEdits, codeGraph, docsSearch)

  return new SearchAPI({ search, bm25, registry, config, kvService, contextBuilder })
```

---

## 15. CLI Layer

**Files:** `src/cli/` — `index.ts`, `utils.ts`, `factory/`, `commands/`

### 15.1 CLI Factory — createBrain()

```
createBrain(repoPath?)  [src/cli/factory/index.ts]
  rp = repoPath ?? getFlag('repo') ?? '.'
  config = await loadConfig()   ← .brainbank/{config.json|.ts|.js|.mjs}
  folderPlugins = await discoverFolderPlugins()  ← .brainbank/plugins/*.ts|js|mjs
  brainOpts = { repoPath: rp, ...(config?.brainbank ?? {}) }
  setupProviders(brainOpts, config):
    --reranker qwen3 → Qwen3Reranker
    --embedding | config.embedding | BRAINBANK_EMBEDDING → resolveEmbeddingKey
  brain = new BrainBank(brainOpts)
  builtins = config?.plugins ?? ['code', 'git', 'docs']
  registerBuiltins(brain, rp, builtins, config):
    multi-repo detection: detectGitSubdirs() if no root .git
    per-plugin embedding: config.code.embedding, config.git.embedding, etc.
    merge ignore: config.code.ignore + --ignore flag via picomatch
    loadCodePlugin/loadGitPlugin/loadDocsPlugin (dynamic import, null if not installed)
    multi-repo → code:{sub.name}, git:{sub.name} per subdirectory
    single → code({ repoPath }), git(), docs()
  for plugin in folderPlugins: brain.use(plugin)
  for plugin in config?.indexers: brain.use(plugin)
  return brain   ← NOT initialized, .use() still allowed
```

**Config priority:** CLI flags > config.json > DB meta > defaults

### 15.2 Commands

| Command | Handler | Notes |
|---------|---------|-------|
| `index [path]` | `cmdIndex` | Interactive: scanRepo → checkbox prompt → index |
| `collection add/list/remove` | `cmdCollection` | Manage doc collections via DocsPlugin |
| `kv add/search/list/trim/clear` | `cmdKv` | KV store CRUD |
| `docs [--collection]` | `cmdDocs` | Index doc collections |
| `dsearch <query>` | `cmdDocSearch` | Docs-only search |
| `search <query>` | `cmdSearch` | Vector search |
| `hsearch <query>` | `cmdHybridSearch` | Hybrid (best quality) |
| `ksearch <query>` | `cmdKeywordSearch` | BM25 keyword |
| `context <task>` | `cmdContext` | Formatted LLM context |
| `context add/list` | `cmdContext` | Path context management |
| `stats` | `cmdStats` | Index statistics |
| `reembed` | `cmdReembed` | Re-generate all vectors |
| `watch` | `cmdWatch` | fs.watch auto-reindex |
| `serve` | `cmdServe` | MCP server (imports @brainbank/mcp) |

**Dynamic source flags in search commands:**

```
Any --<name> <number> is treated as a source filter:
  --code 10, --git 0, --docs 5, --notes 10 (KV collection)
NON_SOURCE_FLAGS excluded: repo, depth, collection, pattern, etc.
```

**scan.ts** — lightweight repo scanner (no BrainBank init):

```
scanRepo(repoPath) → ScanResult:
  { repoPath, code: { total, byLanguage },
    git: { commitCount, lastMessage, lastDate } | null,
    docs: [{ name, path, fileCount }],
    config: { exists, ignore?, plugins? },
    db: { exists, sizeMB, lastModified? },
    gitSubdirs: [{ name }] }
```

---

## 16. SQLite Schema

**File:** `src/db/schema.ts` — `SCHEMA_VERSION = 6`

```
━━━ CODE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

indexed_files
  file_path TEXT PRIMARY KEY
  file_hash TEXT NOT NULL
  indexed_at INTEGER (unixepoch)

code_chunks
  id INTEGER PRIMARY KEY AUTOINCREMENT
  file_path TEXT NOT NULL              ← idx_cc_file
  chunk_type TEXT                      ← 'file'|'function'|'class'|'method'|'interface'|'block'
  name TEXT
  start_line INTEGER, end_line INTEGER
  content TEXT, language TEXT
  file_hash TEXT, indexed_at INTEGER

code_vectors
  chunk_id INTEGER PRIMARY KEY REFERENCES code_chunks(id) ON DELETE CASCADE
  embedding BLOB

code_imports
  file_path TEXT NOT NULL
  imports_path TEXT NOT NULL
  PRIMARY KEY (file_path, imports_path)     ← idx_ci_imports on imports_path

code_symbols
  id INTEGER PRIMARY KEY AUTOINCREMENT
  file_path TEXT   ← idx_cs_file, idx_cs_name
  name TEXT, kind TEXT, line INTEGER
  chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE

code_refs
  chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE  ← idx_cr_chunk
  symbol_name TEXT  ← idx_cr_symbol

fts_code (FTS5, content='code_chunks', content_rowid='id')
  columns: file_path, name, content
  tokenize: 'porter unicode61'
  triggers: trg_fts_code_insert, trg_fts_code_delete


━━━ GIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

git_commits
  id INTEGER PRIMARY KEY AUTOINCREMENT
  hash TEXT UNIQUE NOT NULL   ← idx_gc_hash
  short_hash TEXT, message TEXT, author TEXT, date TEXT
  timestamp INTEGER           ← idx_gc_ts DESC
  files_json TEXT, diff TEXT
  additions INTEGER, deletions INTEGER, is_merge INTEGER

git_vectors
  commit_id INTEGER PRIMARY KEY REFERENCES git_commits(id) ON DELETE CASCADE
  embedding BLOB

commit_files
  commit_id INTEGER REFERENCES git_commits(id)
  file_path TEXT   ← idx_cf_path

co_edits
  file_a TEXT NOT NULL, file_b TEXT NOT NULL
  count INTEGER DEFAULT 1
  PRIMARY KEY (file_a, file_b)   ← file_a < file_b always

fts_commits (FTS5, content='git_commits', content_rowid='id')
  columns: message, author, diff
  triggers: trg_fts_commits_insert, trg_fts_commits_delete


━━━ DOCUMENTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

collections
  name TEXT PRIMARY KEY
  path TEXT, pattern TEXT DEFAULT '**/*.md'
  ignore_json TEXT DEFAULT '[]', context TEXT
  created_at INTEGER

doc_chunks
  id INTEGER PRIMARY KEY AUTOINCREMENT
  collection TEXT REFERENCES collections(name) ON DELETE CASCADE  ← idx_dc_collection
  file_path TEXT  ← idx_dc_file
  title TEXT, content TEXT
  seq INTEGER, pos INTEGER
  content_hash TEXT  ← idx_dc_hash
  indexed_at INTEGER

doc_vectors
  chunk_id INTEGER PRIMARY KEY REFERENCES doc_chunks(id) ON DELETE CASCADE
  embedding BLOB

path_contexts
  collection TEXT NOT NULL, path TEXT NOT NULL, context TEXT NOT NULL
  PRIMARY KEY (collection, path)

fts_docs (FTS5, content='doc_chunks', content_rowid='id')
  columns: title, content, file_path, collection
  triggers: trg_fts_docs_insert, trg_fts_docs_delete


━━━ KV COLLECTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

kv_data
  id INTEGER PRIMARY KEY AUTOINCREMENT
  collection TEXT   ← idx_kv_collection
  content TEXT
  meta_json TEXT DEFAULT '{}'
  tags_json TEXT DEFAULT '[]'
  expires_at INTEGER NULL   ← NULL = no expiry
  created_at INTEGER   ← idx_kv_created DESC

kv_vectors
  data_id INTEGER PRIMARY KEY REFERENCES kv_data(id) ON DELETE CASCADE
  embedding BLOB

fts_kv (FTS5, content='kv_data', content_rowid='id')
  columns: content, collection
  triggers: trg_fts_kv_insert, trg_fts_kv_delete


━━━ METADATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

embedding_meta
  key TEXT PRIMARY KEY, value TEXT

schema_version
  version INTEGER PRIMARY KEY, applied_at INTEGER


FTS5 trigger pattern (all tables):
  AFTER INSERT → INSERT INTO fts_X(rowid, ...) VALUES (new.id, ...)
  AFTER DELETE → INSERT INTO fts_X(fts_X, rowid, ...) VALUES ('delete', old.id, ...)
  ← no UPDATE trigger: indexers delete + re-insert on change
```

---

## 17. Data Flow Diagrams

### 17.1 Startup Flow

```
new BrainBank({ embeddingProvider: openai })
  .use(code({ repoPath: '.' }))
  .use(git())
  .use(docs())
         │
         ▼
brain.search("auth middleware")   ← auto-triggers initialize()
         │
    ┌────▼──────────────────────────────────────────────┐
    │               PHASE 1 (earlyInit)                 │
    │                                                   │
    │  new Database('.brainbank/brainbank.db')          │
    │  resolveStartupEmbedding → openai (explicit)      │
    │  detectProviderMismatch → check stored vs current  │
    │  setEmbeddingMeta(db, openai)                     │
    │  new HNSWIndex(1536, 2M).init() → kvHnsw          │
    │  new KVService(db, openai, kvHnsw, Map(), reranker)│
    │  ← collection() NOW WORKS                        │
    └───────────────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────────────────┐
    │               PHASE 2 (lateInit)                  │
    │                                                   │
    │  Load KV: tryLoad('hnsw-kv.index') → loadVecCache │
    │  buildPluginContext(...)                          │
    │                                                   │
    │  CodePlugin.initialize(ctx):                      │
    │    getOrCreateSharedHnsw('code') → isNew=true     │
    │    loadVectors('code_vectors', 'chunk_id', ...)   │
    │                                                   │
    │  GitPlugin.initialize(ctx):                       │
    │    getOrCreateSharedHnsw('git') → isNew=true      │
    │    loadVectors('git_vectors', 'commit_id', ...)   │
    │                                                   │
    │  DocsPlugin.initialize(ctx):                      │
    │    createHnsw(dims, 'doc') → PRIVATE HNSW         │
    │    loadVectors('doc_vectors', 'chunk_id', ...)    │
    │                                                   │
    │  saveAllHnsw() → write all .index files           │
    │  createSearchAPI() → SearchAPI                    │
    │  _initialized = true                              │
    └───────────────────────────────────────────────────┘
```

### 17.2 Indexing Flow

```
brain.index({ modules: ['code', 'git'] })
         │
    ┌────▼──────────────────────────────────────────┐
    │  CODE                                         │
    │  _walkRepo() → files (filter ignore/size/ext) │
    │  for each file:                               │
    │    FNV-1a(content) === indexed_files.hash?    │
    │      YES → skip                               │
    │      NO  → CodeChunker.chunk()               │
    │            extractImports()                   │
    │            embedBatch()                       │
    │            TRANSACTION:                       │
    │              DELETE old + INSERT new           │
    │              code_chunks + code_vectors        │
    │              code_imports + code_symbols       │
    │              code_refs + indexed_files         │
    │            AFTER: hnsw.remove(old) + add(new) │
    └───────────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────────────┐
    │  GIT                                          │
    │  git.log(500) → commits[]                     │
    │  PHASE 1: collect (async git calls per commit)│
    │  embedBatch(all new texts) → vecs             │
    │  PHASE 2: INSERT (one transaction)            │
    │  PHASE 3: hnsw.add() + computeCoEdits()      │
    └───────────────────────────────────────────────┘
         │
    emit('indexed', { code: {...}, git: {...} })
```

### 17.3 Hybrid Search Flow

```
brain.hybridSearch("authentication middleware", { sources: { code: 10, git: 5 } })
         │
    ┌────┴──────────────────────────────────────────────────┐
    │                  parallel                              │
    ├──────────────────────┬───────────────────────────────┤
    ▼                      ▼                               ▼
VectorSearch           BM25Search                   DocsPlugin
embedding.embed()     sanitizeFTS()              DocumentSearch
HNSW.search()        FTS5 MATCH                  vector + BM25
SELECT chunks/       normalizeBM25()             RRF → _dedup
commits                  │                             │
[vecResults]         [kwResults]                [docResults]
    │                   │                             │
    └───────────────────┴─────────────────────────────┘
                        │
          + custom plugin lists + KV collection lists
                        │
          reciprocalRankFusion(lists, k=60, maxResults=15)
                        │
          if reranker: rerank(query, fused, reranker)
                        │
          [sorted SearchResult[]]
```

### 17.4 Collection Write + Read Flow

```
const errors = brain.collection('debug_errors')

await errors.add('TypeError: null check missing',
                 { tags: ['critical'], ttl: '7d' })
  ├── embedding.embed(content) → vec       ← FIRST
  ├── INSERT kv_data (expires_at = now + 7d)
  ├── INSERT kv_vectors
  ├── kvHnsw.add(vec, id)
  └── kvVecs.set(id, vec)

results = await errors.search('null pointer', { mode:'hybrid', tags:['critical'] })
  ├── _pruneExpired()
  ├── parallel: _searchVector + _searchBM25
  ├── fuseRankedLists([vec, bm25])
  ├── filter minScore + slice k
  ├── if reranker: rerank
  └── _filterByTags(tags: ['critical'])
```

### 17.5 Context Building Flow

```
brain.getContext("add rate limiting to the auth API")
  │
  ContextBuilder.build(task):
    CompositeVectorSearch.search(task) → code + git + pattern results
    formatCodeResults + getCallInfo (code_refs)
    formatCodeGraph: expandImportGraph (2-hop) + fetchBestChunks
    formatGitResults + diff snippets
    formatCoEdits: CoEditAnalyzer.suggest()
    formatPatternResults
    docsSearch(task) → formatDocuments
    → markdown for LLM system prompt
```

### 17.6 Reembed Flow

```
brain.reembed()   (switch Local 384d → OpenAI 1536d)
  │
  collectTables: code + git + docs + kv
  for each table:
    CREATE temp → embedBatch in batches of 50 → INSERT temp
    TRANSACTION: DELETE old + INSERT FROM temp  ← atomic swap
    DROP temp
    rebuildHnsw: reinit() + load from new BLOBs
  setEmbeddingMeta + saveAllHnsw
```

---

## 18. Design Patterns Reference

| # | Pattern | Where used | What it does |
|---|---------|-----------|-------------|
| 1 | **Facade** | `BrainBank` | Single entry point hiding registry, init, plugins, search, index |
| 2 | **Plugin / Extension Point** | `Plugin` + `PluginRegistry` + `PluginContext` | Add data sources without modifying core |
| 3 | **Strategy** | `SearchStrategy`, `EmbeddingProvider` | Interchangeable search backends and embedding models |
| 4 | **Registry + Prefix Matching** | `PluginRegistry` | `has('code')` matches `code`, `code:frontend`, `code:backend` |
| 5 | **Two-Phase Construction** | `earlyInit()` / `lateInit()` | KVService ready before plugins call `ctx.collection()` |
| 6 | **Factory Method** | `code()`, `git()`, `docs()`, `patterns()`, `createBrain()` | Hide instantiation complexity |
| 7 | **Dependency Injection** | `PluginContext` | Plugins receive all deps through one context object |
| 8 | **Repository** | `Collection`, `DocsIndexer` | Encapsulate read/write per domain entity |
| 9 | **Observer / EventEmitter** | `BrainBank extends EventEmitter` | `initialized`, `indexed`, `reembedded`, `progress` |
| 10 | **Flyweight** | `_sharedHnsw` pool | `code:frontend` + `code:backend` share ONE HNSW |
| 11 | **Builder** | `ContextBuilder` | Incrementally assembles markdown from multiple sources |
| 12 | **Composite** | `CompositeVectorSearch` | Embed once, delegate to Code + Git strategies |
| 13 | **Lazy Singleton + Promise Dedup** | `LocalEmbedding._getPipeline()`, `Qwen3Reranker._ensureLoaded()` | Expensive resources loaded on first use |
| 14 | **Memento / Persistence** | `HNSWIndex.save()` / `tryLoad()` | Graph persisted post-init with staleness check |
| 15 | **Adapter** | Embedding providers | OpenAI `number[]`, Perplexity base64 int8, WASM flat → unified `Float32Array` |
| 16 | **Guard / Precondition** | `_requireInit()` | Descriptive errors before null-pointer crashes |
| 17 | **Template Method** | `plugin.initialize(ctx)` | BrainBank controls sequence; plugins fill in domain logic |
| 18 | **Atomic Swap** | `reembedTable()` | Temp table → TRANSACTION DELETE+INSERT; old data safe on failure |
| 19 | **Incremental Processing** | `CodeWalker`, `DocsIndexer`, `GitIndexer` | Content-hash skip; only changed content re-embedded |
| 20 | **Discriminated Union** | `SearchResult` | `isCodeResult()`, `matchResult()` for exhaustive matching |
| 21 | **Pipeline** | Hybrid search → RRF → rerank → Context | Composable, independently testable stages |
| 22 | **LRU Pool** | `@brainbank/mcp` workspace pool | Up to 10 instances; evict least-recently-used |
| 23 | **Decorator** | `rerank()`, call graph annotations | Extra scoring/annotations post-retrieval |

---

## 19. Complete Dependency Graph

```
                     ┌──────────────────────────────────────┐
                     │         BrainBank (Facade)           │
                     └──┬──────┬──────┬───────┬─────────────┘
                        │      │      │       │
                ┌───────▼─┐ ┌──▼───┐ ┌▼──────┐ ┌▼─────────────────┐
                │IndexAPI │ │Search│ │Plugin │
                │         │ │API   │ │Reg.   │
                └────┬────┘ └──┬───┘ └───┬───┘
                     │        │          │     └────────┬──────────┘
                     │        │          │              │
          ┌──────────▼────┐   │   ┌──────▼──────────────▼──────────────────┐
          │allByType()    │   │   │                Plugins                 │
          │code/git/docs  │   │   │                                        │
          └──────┬────────┘   │   │  CodePlugin                            │
                 │            │   │    └── CodeWalker                      │
                 │            │   │          ├── CodeChunker (tree-sitter)  │
           ┌─────▼──────┐     │   │          ├── extractImports (regex)    │
           │ CodeWalker │     │   │          └── extractSymbols/CallRefs   │
           │ GitIndexer │     │   │                                        │
           │DocsIndexer │     │   │  GitPlugin                             │
           └─────┬──────┘     │   │    ├── GitIndexer (simple-git)         │
                 │            │   │    └── CoEditAnalyzer                  │
          ┌──────▼────────────▼──┐│                                        │
          │                      ││  DocsPlugin                            │
          │   EmbeddingProvider  ││    ├── DocsIndexer (smart chunker)     │
          │  (shared/per-plugin) ││    └── DocumentSearch                  │
          │                      ││                                        │
          │  LocalEmbedding      ││                                        │
          │  OpenAIEmbedding     ││                                        │
          │  PerplexityEmb.      ││                                        │
          │  PerplexityContext.. ││                                        │
          └──────────────────────┘│                                        │
                                  │                                        │
                                  └────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                       Infrastructure                             │
     │                                                                  │
     │  Database ──── better-sqlite3                                    │
     │    └── WAL + FK + FTS5 triggers + all schemas (SCHEMA_VERSION=6) │
     │                                                                  │
     │  HNSWIndex ──── hnswlib-node                                     │
     │    ├── KVService._hnsw        (all KV collections share one)     │
     │    ├── _sharedHnsw['code']    (all code:* plugins share one)     │
     │    ├── _sharedHnsw['git']     (all git:*  plugins share one)     │
     │    └── DocsPlugin.hnsw        (private, per-instance)            │
     │                                                                  │
     │  hnsw-loader.ts: hnswPath, loadVectors, loadVecCache, saveAll    │
     │  Qwen3Reranker ──── node-llama-cpp (optional peer dep)           │
     └──────────────────────────────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                       Search Layer                               │
     │                                                                  │
     │  SearchFactory → CompositeVectorSearch(code, git)                │
     │  KeywordSearch ──── FTS5 BM25 (sanitizeFTS + normalizeBM25)     │
     │  reciprocalRankFusion + fuseRankedLists<T>                       │
     │  rerank (position-aware blending)                                │
     │  ContextBuilder → formatters + SqlCodeGraphProvider              │
     │  DocumentSearch (inside @brainbank/docs)                         │
     └──────────────────────────────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                       Services                                   │
     │                                                                  │
     │  KVService → Collection (kvHnsw shared + fts_kv + kv_data)      │
     │  reembedAll (atomic swap, per-table)                             │
     │  Watcher (fs.watch + debounce + plugin routing)                  │
     │  EmbeddingMeta (provider tracking + mismatch detection)          │
     └──────────────────────────────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                         CLI                                      │
     │                                                                  │
     │  createBrain(): loadConfig + discoverFolderPlugins +             │
     │    setupProviders + registerBuiltins (multi-repo detection)      │
     │  scan.ts: scanRepo() → ScanResult (no BrainBank init)           │
     │  Commands: index, search/hsearch/ksearch, collection, kv,       │
     │    docs/dsearch, context, stats, reembed, watch, serve, help     │
     └──────────────────────────────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                     @brainbank/mcp                               │
     │                                                                  │
     │  LRU pool: Map<repoPath, { brain, lastAccess }> max=10          │
     │  6 tools: search, context, index, stats, history, collection     │
     │  findRepoRoot + corruption recovery + shared reranker            │
     └──────────────────────────────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                  @brainbank/memory                               │
     │                                                                  │
     │  Memory: extract facts → dedup (ADD/UPDATE/NONE) → store        │
     │  EntityStore: upsert → LLM resolution → traverse → buildContext │
     │  patterns(): PatternStore + Consolidator + PatternDistiller      │
     └──────────────────────────────────────────────────────────────────┘
```

---

## 20. Testing Strategy

### Test Infrastructure

- **Custom runner:** `test/run.ts` — discovers `test/{unit,integration}/` + `packages/*/test/{unit,integration}/`
- Tests export `{ name, tests }` — plain objects with assert functions, no Jest/Vitest
- **Hash-based embedding** (`hashEmbedding()`) — deterministic, unique per text, normalized; used in all integration tests without model downloads
- **Mock embedding** (`mockEmbedding()`) — constant 0.1 vector, used in unit tests

### Unit Tests (`test/unit/`)

| File | Coverage |
|------|----------|
| `query/rrf.test.ts` | RRF fusion, dedup, multi-list boost, maxResults |
| `query/bm25.test.ts` | FTS5 sanitization, camelCase splitting, BM25 normalization |
| `query/reranker.test.ts` | Position-aware blending, Reranker interface |
| `core/brainbank.test.ts` | Facade lifecycle, .use() guard, index modules filter |
| `core/collection.test.ts` | KV add/search/list/trim/clear, FTS trigger sync |
| `core/schema.test.ts` | Database creation, WAL mode, schema version, transactions |
| `core/config.test.ts` | resolveConfig() defaults and overrides |
| `core/config-file.test.ts` | ProjectConfig type, registerConfigCollections() |
| `core/reembed.test.ts` | Atomic swap, dim mismatch flow, HNSW rebuild |
| `core/tags-ttl.test.ts` | Tags AND-filter, TTL auto-prune, expires_at |
| `core/watch.test.ts` | fs.watch integration, custom plugin routing, debounce |
| `vector/hnsw.test.ts` | HNSW add/search/remove/reinit/save/tryLoad |
| `vector/mmr.test.ts` | MMR diversity selection, lambda extremes |
| `embeddings/*.test.ts` | Provider factory, dim validation, fetch mocking, timeout |

### Integration Tests (`test/integration/`)

| File | Coverage |
|------|----------|
| `core/collections.test.ts` | Full KV pipeline: hybrid/keyword/vector + tags + TTL + trim |
| `query/search.test.ts` | code+git+docs → search + getContext + minScore |
| `indexers/per-plugin-embedding.test.ts` | 3 dims (64d/128d/256d), separate HNSW indices |
| `quality/retrieval-quality.test.ts` | Recall@5/MRR threshold assertions (synthetic corpus) |

### Package Tests (`packages/*/test/`)

| Package | Test | Coverage |
|---------|------|----------|
| `@brainbank/code` | `code.test.ts` | Index TS+Python → HNSW → incremental skip → ignore patterns |
| `@brainbank/code` | `chunker.test.ts` | AST: NestJS methods, Python class, content integrity |
| `@brainbank/code` | `code-graph.test.ts` | code_imports, code_symbols, code_refs + cascade delete |
| `@brainbank/code` | `import-extractor.test.ts` | Regex per language (TS/Python/Go/Rust/Java/CSS...) |
| `@brainbank/code` | `symbol-extractor.test.ts` | AST symbol defs + call refs + builtin filtering |
| `@brainbank/code` | `languages.test.ts` | Extension mapping, ignore rules |
| `@brainbank/git` | `git.test.ts` | Real git repo → commits → co-edits → fileHistory |
| `@brainbank/docs` | `docs.test.ts` | Smart chunking → register → index → search → context |


### Retrieval Quality Gate

`test/integration/quality/retrieval-quality.test.ts` — synthetic corpus (5 TS files), 6 golden queries:

- **Recall@5** ≥ 0.8 for exact queries
- **MRR** ≥ 0.4 overall
- Zero-recall guard: no exact query may return 0 results

### Commands

```
npm test                                 # unit only
npm run test:integration                 # unit + integration
npm test -- --filter <name>              # filter by name
npm test -- --verbose --filter reembed   # verbose output
```

---

## 21. Concurrency & WAL Strategy

### Current Model

SQLite in WAL mode with `busy_timeout = 5000ms`:

| Aspect | Behavior |
|--------|----------|
| **Readers** | Unlimited concurrent, never blocked |
| **Writers** | Single-writer serialized by WAL |
| **busy_timeout** | Wait up to 5s for write lock before SQLITE_BUSY |
| **synchronous** | NORMAL — fsync on checkpoint, not every commit |

### Why Single-Writer Works

BrainBank is single-process by design:

- **CLI:** one command at a time
- **MCP:** requests sequential per workspace instance
- **Watch:** `_flushing` flag prevents concurrent reindex
- **Indexing:** writes batched in transactions

### Known Limitations

1. **Multi-process writes:** Two BrainBank instances on same DB will contend
2. **Long indexing blocks writers:** Large repos hold write lock during index
3. **No WAL checkpoint control:** SQLite auto-checkpoints at 1000 pages