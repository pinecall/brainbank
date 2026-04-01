
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
9. [Collection — KV Store](#9-collection--kv-store)
10. [Search Layer](#10-search-layer)
    - 10.1 [SearchStrategy Interface](#101-searchstrategy-interface)
    - 10.2 [CompositeVectorSearch](#102-compositevectorsearch)
    - 10.3 [CompositeBM25Search](#103-compositebm25search)
    - 10.4 [Hybrid Search + RRF](#104-hybrid-search--rrf)
    - 10.5 [MMR — Diversity](#105-mmr--diversity)
    - 10.6 [Reranking](#106-reranking)
    - 10.7 [ContextBuilder](#107-contextbuilder)
    - 10.8 [DocumentSearch](#108-documentsearch)
11. [Infrastructure](#11-infrastructure)
    - 11.1 [Database](#111-database)
    - 11.2 [HNSWIndex](#112-hnswindex)
    - 11.3 [HNSW Loader](#113-hnsw-loader)
    - 11.4 [Embedding Providers](#114-embedding-providers)
    - 11.5 [Rerankers](#115-rerankers)
12. [Services](#12-services)
    - 12.1 [Watch Service](#121-watch-service)
    - 12.2 [Reembed Engine](#122-reembed-engine)
    - 12.3 [EmbeddingMeta](#123-embeddingmeta)
13. [Engine Layer](#13-engine-layer)
    - 13.1 [IndexAPI](#131-indexapi)
    - 13.2 [SearchAPI](#132-searchapi)
14. [CLI Layer](#14-cli-layer)
15. [SQLite Schema](#15-sqlite-schema)
16. [Data Flow Diagrams](#16-data-flow-diagrams)
17. [Design Patterns Reference](#17-design-patterns-reference)
18. [Complete Dependency Graph](#18-complete-dependency-graph)
19. [Testing Strategy](#19-testing-strategy)
20. [Concurrency & WAL Strategy](#20-concurrency--wal-strategy)

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
specialized subsystems via a **capability-based plugin architecture**. The core
package owns all infrastructure (DB, KV schema, HNSW, embeddings, search
orchestration, CLI). Plugin packages (`@brainbank/code`, `@brainbank/git`,
`@brainbank/docs`, `@brainbank/mcp`) implement domain-specific indexing and
searching, and are loaded via `.use()`.

**Key architectural principle: the core is plugin-agnostic.** Search, indexing,
context building, and re-embedding are all discovered at runtime via capability
interfaces. No plugin names are hardcoded in the core.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        USER / AI AGENT                               │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  brain.index() / brain.search()
                            │  brain.getContext() / brain.collection()
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   BrainBank  (Facade + EventEmitter)                 │
│                                                                      │
│  ┌───────────┐  ┌────────────┐  ┌──────────────┐                    │
│  │ runIndex  │  │ SearchAPI  │  │ PluginRegistry│                    │
│  └─────┬─────┘  └─────┬──────┘  └──────┬────────┘                   │
└────────┼──────────────┼────────────────┼────────────────────────────┘
         │              │                │
         ▼              ▼                ▼
   ┌──────────┐  ┌──────────────┐  ┌──────────────────┐
   │ Plugins  │  │  SearchLayer │  │  Database         │
   │ code/git/│  │  Composite   │  │  HNSWIndex        │
   │ docs     │  │  BM25/Vector │  │  EmbeddingProvider │
   └──────────┘  │  Context     │  │  KVService         │
                 └──────────────┘  └──────────────────┘
```

**Three conceptual layers:**

| Layer | Purpose | Key files |
|-------|---------|-----------|
| **Facade / Engine** | Public surface, delegation, init guards | `brainbank.ts`, `engine/` |
| **Domain / Plugin** | Indexing, searching, formatting | `plugin.ts`, `packages/*/` |
| **Infrastructure** | DB, vectors, embeddings, math | `db/`, `providers/`, `lib/`, `services/` |

---

## 2. Repository Structure

```
brainbank/
├── src/                               ← Core library (published as "brainbank")
│   ├── brainbank.ts                   ← Main facade (BrainBank class)
│   ├── index.ts                       ← Public exports
│   ├── types.ts                       ← All TypeScript interfaces
│   ├── constants.ts                   ← HNSW.KV typed constant
│   ├── config.ts                      ← resolveConfig() + DEFAULTS
│   ├── plugin.ts                      ← Plugin interfaces, PluginContext, type guards
│   │
│   ├── engine/
│   │   ├── index-api.ts               ← runIndex(): orchestrates indexing across plugins
│   │   ├── search-api.ts              ← SearchAPI + createSearchAPI(): plugin-agnostic wiring
│   │   └── reembed.ts                 ← reembedAll(): atomic vector swap without re-parsing
│   │
│   ├── db/
│   │   ├── database.ts                ← better-sqlite3 wrapper (WAL, FK, transactions)
│   │   ├── schema.ts                  ← Core-only DDL: KV tables, embedding_meta, plugin_versions
│   │   ├── migrations.ts              ← Plugin migration system (runPluginMigrations)
│   │   ├── embedding-meta.ts          ← Track/detect/compare embedding provider in DB
│   │   └── rows.ts                    ← TypeScript interfaces for core DB row types
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
│   │   ├── types.ts                   ← SearchStrategy, DomainVectorSearch, SearchOptions
│   │   ├── context-builder.ts         ← ContextBuilder: discovers ContextFormatterPlugins
│   │   ├── keyword/
│   │   │   ├── composite-bm25-search.ts ← Discovers BM25SearchPlugin instances from registry
│   │   │   └── keyword-search.ts      ← DEPRECATED: hardcoded FTS5 (kept for backward compat)
│   │   └── vector/
│   │       ├── composite-vector-search.ts ← Generic: discovers DomainVectorSearch strategies
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
│       │   └── builtin-registration.ts ← Multi-repo detection + plugin registration
│       └── commands/
│           ├── index.ts               ← brainbank index (interactive scan → prompt → index)
│           ├── scan.ts                ← scanRepo(): lightweight scanner (no BrainBank init)
│           ├── search.ts              ← search / hsearch / ksearch
│           ├── docs.ts                ← docs / dsearch
│           ├── collection.ts          ← collection add/list/remove
│           ├── context.ts             ← context [task] / context add / context list
│           ├── kv.ts                  ← kv add/search/list/trim/clear
│           ├── stats.ts, reembed.ts, watch.ts, serve.ts, help.ts
│
└── packages/
    ├── code/                          ← @brainbank/code
    │   └── src/
    │       ├── index.ts
    │       ├── code-plugin.ts         ← CodePlugin: IndexablePlugin + VectorSearchPlugin
    │       │                            + BM25SearchPlugin + ContextFormatterPlugin
    │       │                            + ReembeddablePlugin + MigratablePlugin
    │       ├── code-schema.ts         ← code_chunks, code_vectors, indexed_files,
    │       │                            code_imports, code_symbols, code_refs, fts_code
    │       ├── code-walker.ts         ← File walker + incremental indexer (FNV-1a hash)
    │       ├── code-chunker.ts        ← Tree-sitter AST chunker + sliding window fallback
    │       ├── code-vector-search.ts  ← CodeVectorSearch (DomainVectorSearch impl)
    │       ├── code-context-formatter.ts ← Code result formatting + import graph
    │       ├── sql-code-graph.ts      ← CodeGraphProvider: call info + import traversal
    │       ├── import-graph.ts        ← 2-hop import traversal + sibling clustering
    │       ├── grammars.ts            ← Grammar registry (20+ languages, CJS/ESM fallback)
    │       ├── import-extractor.ts    ← Regex import extraction per language
    │       └── symbol-extractor.ts    ← AST symbol defs + call references per chunk
    │
    ├── git/                           ← @brainbank/git
    │   └── src/
    │       ├── index.ts
    │       ├── git-plugin.ts          ← GitPlugin: IndexablePlugin + VectorSearchPlugin
    │       │                            + BM25SearchPlugin + ContextFormatterPlugin
    │       │                            + ReembeddablePlugin + CoEditPlugin + MigratablePlugin
    │       ├── git-schema.ts          ← git_commits, commit_files, co_edits,
    │       │                            git_vectors, fts_commits
    │       ├── git-indexer.ts         ← 3-phase commit pipeline (collect → embed → insert)
    │       ├── git-vector-search.ts   ← GitVectorSearch (DomainVectorSearch impl)
    │       ├── git-context-formatter.ts ← Git result formatting + co-edit suggestions
    │       └── co-edit-analyzer.ts    ← File co-occurrence SQL queries
    │
    ├── docs/                          ← @brainbank/docs
    │   └── src/
    │       ├── index.ts
    │       ├── docs-plugin.ts         ← DocsPlugin: IndexablePlugin + VectorSearchPlugin
    │       │                            + BM25SearchPlugin + ContextFormatterPlugin
    │       │                            + SearchablePlugin + ReembeddablePlugin + MigratablePlugin
    │       ├── docs-schema.ts         ← collections, doc_chunks, doc_vectors,
    │       │                            path_contexts, fts_docs
    │       ├── docs-indexer.ts        ← Smart markdown chunker + incremental indexer (SHA-256)
    │       ├── docs-vector-search.ts  ← DocsVectorSearch (DomainVectorSearch impl)
    │       ├── docs-context-formatter.ts ← Document result formatting
    │       └── document-search.ts     ← Hybrid search (RRF + dedup by file)
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
@brainbank/mcp     ── dep ─────► brainbank + @brainbank/code + @brainbank/git + @brainbank/docs
```

> **Schema ownership:** Core owns ONLY KV tables + metadata tables (`kv_data`,
> `kv_vectors`, `fts_kv`, `embedding_meta`, `schema_version`, `plugin_versions`).
> Domain tables (code, git, docs) are created by their respective plugins via the
> `runPluginMigrations()` system during `plugin.initialize()`.

---

## 3. BrainBank — Main Facade

**File:** `src/brainbank.ts` (448 lines)
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
│  _indexDeps:    IndexDeps | undefined    indexing orchestration        │
│  _kvService:    KVService | undefined    KV infra (hnsw, vecs, map)    │
│  _sharedHnsw:   Map<string, {hnsw, vecCache}>  'code' / 'git' pool   │
│  _initialized:  boolean                  init guard flag               │
│  _initPromise:  Promise<void> | null     dedup concurrent inits        │
│  _watcher:      Watcher | undefined      fs.watch handle               │
│                                                                        │
│  PUBLIC API                                                            │
│  ─────────────────────────────────────────────────────────────────    │
│  .use(plugin)              register plugin, chainable, before init     │
│  .initialize(opts?)        inline init, idempotent, auto-called        │
│  .collection(name)         get/create KV Collection                    │
│  .listCollectionNames()    list all collections with data              │
│  .deleteCollection(name)   remove from DB + evict from cache           │
│  .index(opts)              delegates to runIndex()                     │
│  .search(query, opts)      vector search → RRF if multiple sources     │
│  .hybridSearch(query, opts)  vector + BM25 → RRF → optional rerank    │
│  .searchBM25(query, opts)  keyword-only search                         │
│  .getContext(task, opts)    formatted markdown for LLM system prompt    │
│  .rebuildFTS()             rebuild FTS5 indices                        │
│  .reembed(opts)            re-generate all vectors (provider switch)   │
│  .watch(opts)              start fs.watch auto-reindex                 │
│  .stats()                  stats from all loaded plugins               │
│  .has(name)                check if plugin loaded (prefix-match)       │
│  .plugin<T>(name)          typed plugin access, undefined if missing   │
│  .close()                  cleanup all resources                       │
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
  index, search, hybridSearch, searchBM25, getContext, reembed

Methods that call _requireInit() (throw if not initialized):
  rebuildFTS, watch, stats
  listCollectionNames, deleteCollection

collection() — special case:
  throws "Collections not ready" if _kvService is undefined

.use(plugin) — throws after _initialized === true

Concurrent init guard:
  _initPromise deduplicates concurrent initialize() calls.
  On failure: _cleanupAfterFailedInit() resets all state, rethrows.
```

**close() cleanup sequence:**

```
_watcher?.close()
for (plugin of registry.all): plugin.close?.()
reranker?.close?.()
_embedding?.close().catch(() => {})
_db?.close()
_initialized = false
_kvService?.clear()
_sharedHnsw.clear()
_kvService = undefined
_searchAPI = undefined
_indexDeps = undefined
_registry.clear()
```

---

## 4. Initialization

**File:** `src/brainbank.ts` — `_runInitialize()` method
**Pattern:** Linear 8-step construction

Plugins call `ctx.collection()` during their own `initialize()`.
`collection()` requires `KVService` (which holds `kvHnsw`),
so KVService is created in step 4, before plugins run in step 6.

```
BrainBank._runInitialize({ force? })
│
├── 1. Open Database
│     new Database(config.dbPath)
│     WAL mode, FK constraints, core-only schema via createSchema()
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
│     ← collection() NOW WORKS for plugins
│
├── 5. Load KV Vectors (unless skipVectorLoad)
│     tryLoad(kvIndexPath, kvCount) → loadVecCache (hit) / loadVectors (miss)
│
├── 6. Initialize Plugins
│     ctx = _buildPluginContext(skipVectorLoad, privateHnsw)
│     for each mod in registry.all:
│       await mod.initialize(ctx)
│       ← plugins run their own runPluginMigrations() here
│       ← plugins call ctx.getOrCreateSharedHnsw() / ctx.createHnsw()
│       ← plugins call ctx.loadVectors()
│
├── 7. Persist HNSW Indices
│     saveAllHnsw(dbPath, kvHnsw, sharedHnsw, privateHnsw)
│
└── 8. Build SearchAPI + IndexDeps
      createSearchAPI(db, embedding, config, registry, kvService, sharedHnsw)
      _indexDeps = { registry, emit }
      _initialized = true
```

**HNSW persistence strategy:**

```
Startup (tryLoad):
  file exists AND row count matches → load graph file (~50ms)
    → only populate Map<id, Float32Array> (loadVecCache)
    → HNSW graph already reconstructed from .index file

  file missing OR count differs (stale) → rebuild from SQLite BLOBs
    → SELECT id, embedding FROM table; hnsw.add() + cache.set() per row

After all plugins initialize:
  saveAllHnsw() → write .index files for kv, shared, and private
  ← next cold start will be fast via tryLoad()
```

---

## 5. Plugin Registry

**File:** `src/services/plugin-registry.ts` (110 lines)
**Pattern:** Registry + Type-Prefix Matching

```
PluginRegistry
│
│  _map: Map<string, Plugin>   (insertion-order)
│
│  register(plugin)
│    → _map.set(plugin.name, plugin)
│    ← duplicate names silently overwrite
│
│  has('code')
│    → checks exact 'code'
│    OR any key starting with 'code:'
│    → true for 'code', 'code:frontend', 'code:backend'
│
│  get<T>('code')
│    1. ALIASES lookup (currently empty, extensible)
│    2. exact match _map.get('code')
│    3. first type-prefix match (firstByType)
│    throws: "BrainBank: Plugin 'code' is not loaded."
│
│  allByType('code')
│    → all plugins where name === 'code' OR name.startsWith('code:')
│
│  firstByType('git')
│    → first match for 'git' or 'git:*', undefined if none
│
│  names    → string[]
│  all      → Plugin[]
│  raw      → Map<string, Plugin>
│  clear()  → remove all (called by BrainBank.close())
```

**Multi-repo naming convention:**

```typescript
brain
  .use(code({ name: 'code:frontend', repoPath: './fe' }))
  .use(code({ name: 'code:backend',  repoPath: './be' }))
  .use(git({  name: 'git:frontend',  repoPath: './fe' }))
  .use(git({  name: 'git:backend',   repoPath: './be' }))

// Both code plugins share ONE HNSW in _sharedHnsw['code']
// Both git  plugins share ONE HNSW in _sharedHnsw['git']
```

---

## 6. Plugin System & Plugin Context

**File:** `src/plugin.ts` (224 lines)
**Pattern:** Extension Point + Capability Interfaces + Dependency Injection

### 6.1 Plugin Interfaces

The plugin system uses **capability interfaces** — small, composable contracts
that plugins opt into. The core discovers capabilities at runtime via type guards.
No plugin names are ever hardcoded in the core.

```
Plugin  (base — every plugin must implement)
│  readonly name: string
│  initialize(ctx: PluginContext): Promise<void>
│  stats?():  Record<string, number | string>
│  close?():  void

IndexablePlugin extends Plugin
│  index(options?: IndexOptions): Promise<IndexResult>

SearchablePlugin extends Plugin
│  search(query: string, options?: Record<string, unknown>): Promise<SearchResult[]>

WatchablePlugin extends Plugin
│  onFileChange(filePath, event: 'create'|'update'|'delete'): Promise<boolean>
│  watchPatterns(): string[]

VectorSearchPlugin extends Plugin
│  createVectorSearch(): DomainVectorSearch | undefined
│  ← called during createSearchAPI() to build CompositeVectorSearch

BM25SearchPlugin extends Plugin
│  searchBM25(query: string, k: number, minScore?: number): SearchResult[]
│  rebuildFTS?(): void
│  ← called by CompositeBM25Search for keyword search

ContextFormatterPlugin extends Plugin
│  formatContext(results: SearchResult[], parts: string[], options?): void
│  ← called by ContextBuilder to assemble markdown

MigratablePlugin extends Plugin
│  readonly schemaVersion: number
│  readonly migrations: Migration[]
│  ← called by plugin's own initialize() via runPluginMigrations()

ReembeddablePlugin extends Plugin
│  reembedConfig(): ReembedTable
│  ← used by reembedAll() to re-generate vectors

CoEditPlugin extends Plugin
│  coEdits: { suggest(filePath, limit): CoEditSuggestion[] }

DocsPlugin extends SearchablePlugin
│  addCollection(), removeCollection(), listCollections()
│  indexDocs(), addContext(), listContexts()
```

**Type guards (all in `src/plugin.ts`):**

```typescript
isIndexable(p)              → typeof p.index === 'function'
isSearchable(p)             → typeof p.search === 'function'
isWatchable(p)              → typeof p.onFileChange + watchPatterns
isDocsPlugin(p)             → typeof p.addCollection + listCollections
isCoEditPlugin(p)           → 'coEdits' in p && typeof suggest === 'function'
isReembeddable(p)           → typeof p.reembedConfig === 'function'
isVectorSearchPlugin(p)     → typeof p.createVectorSearch === 'function'
isContextFormatterPlugin(p) → typeof p.formatContext === 'function'
isMigratable(p)             → typeof schemaVersion === 'number' && Array.isArray(migrations)
isBM25SearchPlugin(p)       → typeof p.searchBM25 === 'function'
```

### 6.2 Plugin Migrations

**File:** `src/db/migrations.ts` (67 lines)

Each plugin declares a `schemaVersion` and ordered `migrations[]`. Core stores
applied versions in the `plugin_versions` table. Plugins call
`runPluginMigrations(db, pluginName, version, migrations)` at the top of their
`initialize()`. Migrations use `IF NOT EXISTS` so first run on existing DB is safe.

```
plugin_versions
│  plugin_name TEXT PRIMARY KEY
│  version     INTEGER
│  applied_at  INTEGER

getPluginVersion(db, name) → stored version (0 if new)
setPluginVersion(db, name, version)
runPluginMigrations(db, name, targetVersion, migrations[]):
  skip if current >= target
  for each migration where version > current:
    transaction: m.up(db) + setPluginVersion
```

### 6.3 PluginContext — Dependency Injection Container

Built by `_buildPluginContext()` in `src/brainbank.ts`.
Every plugin receives exactly one `PluginContext` during `initialize()`.

```
PluginContext
│
├── db: Database
│     ← shared SQLite (ALL plugins use the same file)
│
├── embedding: EmbeddingProvider
│     ← global embedding; plugins may override via opts.embeddingProvider ?? ctx.embedding
│
├── config: ResolvedConfig
│
├── createHnsw(maxElements?, dims?, name?): Promise<HNSWIndex>
│     ← creates a PRIVATE HNSW for the plugin
│     ← name → registered in privateHnsw Map → saved to 'hnsw-{name}.index'
│
├── loadVectors(table, idCol, hnsw, cache): void
│     ← no-op if skipVectorLoad === true
│     ← otherwise: tryLoad (fast) or loadVectors from SQLite (slow)
│
├── getOrCreateSharedHnsw(type, maxElements?, dims?):
│     Promise<{ hnsw, vecCache, isNew }>
│     ← checks _sharedHnsw Map for existing entry by type key
│     ← if existing: return { ..., isNew: false }
│     ← if new: create HNSWIndex, register, return { ..., isNew: true }
│     ← ONLY the FIRST plugin (isNew=true) should call loadVectors
│     ← used by: CodePlugin ('code'), GitPlugin ('git'), DocsPlugin ('docs')
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
DocsPlugin    │ _sharedHnsw['docs']       │ ✓ all docs:* │ hnsw-docs.index
KV store      │ KVService._hnsw (kvHnsw)  │ ✓ all KV collections │ hnsw-kv.index
```

---

## 7. Built-in Plugins

### 7.1 @brainbank/code

**Files:** `packages/code/src/` — 12 source files

**Capabilities implemented:**
`IndexablePlugin`, `VectorSearchPlugin`, `BM25SearchPlugin`,
`ContextFormatterPlugin`, `ReembeddablePlugin`, `WatchablePlugin`

**Schema owned** (via `CODE_MIGRATIONS`):
`code_chunks`, `code_vectors`, `indexed_files`, `code_imports`,
`code_symbols`, `code_refs`, `fts_code`

```
code({ repoPath?, name?, embeddingProvider?, maxFileSize?, ignore? })
         │
         ▼
CodePlugin.initialize(ctx)
         │
         ├── runPluginMigrations(db, name, CODE_SCHEMA_VERSION, CODE_MIGRATIONS)
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── shared = ctx.getOrCreateSharedHnsw('code', undefined, embedding.dims)
         ├── if shared.isNew:
         │     ctx.loadVectors('code_vectors', 'chunk_id', shared.hnsw, shared.vecCache)
         └── new CodeWalker(repoPath, { db, hnsw, vectorCache, embedding },
                            maxFileSize, ignore)


CodeWalker.index({ forceReindex?, onProgress? })
         │
         ├── _walkRepo(repoPath) → absolute file paths[]
         │     filter: IGNORE_DIRS, IGNORE_FILES, SUPPORTED_EXTENSIONS,
         │             maxFileSize, picomatch custom ignore patterns
         │
         ├── for each file:
         │     content = fs.readFileSync()
         │     hash = FNV-1a(content)
         │     SELECT file_hash FROM indexed_files WHERE file_path = rel
         │     if same hash && !forceReindex → skip
         │     chunkCount = await _indexFile(...)
         │
         └── returns { indexed, skipped, chunks: totalChunks }


CodeWalker._indexFile(filePath, rel, content, hash)
         │
         ├── CodeChunker.chunk(rel, content, language)
         │     ├── small file (≤ MAX_LINES=80) → single 'file' chunk
         │     ├── tree-sitter parse → _extractChunks():
         │     │     export_statement unwrap, decorated_definition unwrap,
         │     │     class > MAX → _splitClassIntoMethods(),
         │     │     large block → _splitLargeBlock(overlap=5)
         │     └── fallback → sliding window (unsupported grammar)
         │
         ├── extractImports(content, language)  ← regex per 19 languages
         │
         ├── build embeddingTexts:
         │     "File: src/api.ts\nImports: express, zod\nClass: X\nmethod: Y\n<code>"
         │
         ├── embedding.embedBatch(embeddingTexts)
         │
         ├── extractSymbols + extractCallRefs (tree-sitter AST)
         │
         ├── Collect old chunk IDs BEFORE transaction
         │
         └── DB TRANSACTION (atomic delete-old + insert-new):
               DELETE + INSERT code_chunks, code_vectors, code_imports,
               code_symbols, code_refs, indexed_files
             AFTER commit:
               hnsw.remove(old) + hnsw.add(new) + cache update


CodePlugin.createVectorSearch() → CodeVectorSearch
  HNSW search with optional MMR diversity
  SELECT * FROM code_chunks WHERE id IN (?)

CodePlugin.searchBM25(query, k) → SearchResult[]
  FTS5 on fts_code + file-path LIKE fallback

CodePlugin.formatContext(results, parts)
  formatCodeResults (grouped by file, call graph annotations)
  formatCodeGraph (2-hop import graph expansion)

CodePlugin.reembedConfig() → ReembedTable
  textBuilder: "File: {file_path}\n{chunk_type}: {name}\n{content}"
```

### 7.2 @brainbank/git

**Files:** `packages/git/src/` — 7 source files

**Capabilities implemented:**
`IndexablePlugin`, `VectorSearchPlugin`, `BM25SearchPlugin`,
`ContextFormatterPlugin`, `ReembeddablePlugin`, `CoEditPlugin`

**Schema owned** (via `GIT_MIGRATIONS`):
`git_commits`, `commit_files`, `co_edits`, `git_vectors`, `fts_commits`

```
git({ repoPath?, depth?, maxDiffBytes?, name?, embeddingProvider? })
         │
         ▼
GitPlugin.initialize(ctx)
         │
         ├── runPluginMigrations(db, name, GIT_SCHEMA_VERSION, GIT_MIGRATIONS)
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── shared = ctx.getOrCreateSharedHnsw('git', 500_000, embedding.dims)
         ├── if shared.isNew:
         │     ctx.loadVectors('git_vectors', 'commit_id', shared.hnsw, shared.vecCache)
         ├── new GitIndexer(repoPath, { db, hnsw, vectorCache, embedding }, maxDiffBytes)
         └── new CoEditAnalyzer(ctx.db)


GitIndexer.index({ depth=500, onProgress? })
         │
         ├── simpleGit(repoPath).log({ maxCount: depth })
         │
         ├── PHASE 1: _collectCommits() [async git calls per commit]
         │     skip if has_vector; zombie cleanup if data but no vector
         │     _parseCommit: git show --numstat + --unified=3
         │     text = "Commit: {msg}\nAuthor:\nDate:\nFiles:\nChanges:\n{diff[:2000]}"
         │
         ├── embedding.embedBatch(all new texts) → vecs
         │
         ├── PHASE 2: _insertCommits() [one DB transaction]
         │     INSERT git_commits + commit_files + git_vectors
         │
         └── PHASE 3: _updateHnsw() + _computeCoEdits()
               hnsw.add() + vectorCache.set() per commit
               co_edits UPSERT: files with 2–20 co-changes per commit


GitPlugin.createVectorSearch() → GitVectorSearch
  HNSW search, filter is_merge = 0

GitPlugin.searchBM25(query, k) → SearchResult[]
  FTS5 on fts_commits, filter is_merge = 0

GitPlugin.formatContext(results, parts, options)
  formatGitResults: diff snippets
  formatCoEdits: affectedFiles → co-edit suggestions

GitPlugin.fileHistory(filePath, limit=20)
  LIKE search on commit_files + JOIN git_commits, ESCAPE '\\'
```

### 7.3 @brainbank/docs

**Files:** `packages/docs/src/` — 7 source files

**Capabilities implemented:**
`IndexablePlugin`, `VectorSearchPlugin`, `BM25SearchPlugin`,
`ContextFormatterPlugin`, `SearchablePlugin`, `ReembeddablePlugin`

> DocsPlugin participates in the standard search pipeline via shared HNSW.
> It implements `VectorSearchPlugin` + `BM25SearchPlugin` for CompositeVectorSearch
> and CompositeBM25Search, and `ContextFormatterPlugin` for ContextBuilder.
> It also retains `SearchablePlugin` for direct per-collection hybrid search.

**Schema owned** (via `DOCS_MIGRATIONS`):
`collections`, `doc_chunks`, `doc_vectors`, `path_contexts`, `fts_docs`

```
docs({ embeddingProvider? })
         │
         ▼
DocsPlugin.initialize(ctx)
         │
         ├── runPluginMigrations(db, 'docs', DOCS_SCHEMA_VERSION, DOCS_MIGRATIONS)
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── shared = await ctx.getOrCreateSharedHnsw('docs', undefined, embedding.dims)
         │     ← SHARED HNSW, persisted to 'hnsw-docs.index'
         ├── if shared.isNew:
         │     ctx.loadVectors('doc_vectors', 'chunk_id', shared.hnsw, shared.vecCache)
         ├── new DocsIndexer(db, embedding, hnsw, vecCache)
         └── new DocumentSearch({ db, embedding, hnsw, vecCache, reranker })


DocsIndexer._smartChunk(text) → [{ text, pos }]
  if text.length ≤ TARGET_CHARS (3000) → single chunk
  Break point scoring (qmd-inspired):
    H1=100, H2=90, H3=80, code-fence-close=80, ---=60, blank=20
  Distance decay: finalScore = score * (1 - (dist/WINDOW)² * 0.7)
  MIN_CHUNK_CHARS=200: merge tiny remainder into last chunk

DocsIndexer.indexCollection(collection, dirPath, pattern, opts)
  SHA-256(content).slice(0,16) → hash
  _isUnchanged: all chunks same hash AND have vectors? → skip
  _indexFile: embed FIRST → single transaction for chunks + vectors
  AFTER commit: hnsw.add() + vecCache.set()

DocsPlugin.search(query, options?) → SearchResult[]
  Delegates to DocumentSearch (see §10.8)

DocsPlugin.index(options?) → IndexResult
  Aggregates per-collection results from indexDocs()
```

---

## 8. @brainbank/mcp Package

**File:** `packages/mcp/src/mcp-server.ts` (514 lines)

6 registered MCP tools via `@modelcontextprotocol/sdk`:

| Tool | Description |
|------|------------|
| `brainbank_search` | Unified: hybrid (default), vector, or keyword mode |
| `brainbank_context` | Formatted context block (code + git + docs) |
| `brainbank_index` | Trigger incremental indexing + optional docs path |
| `brainbank_stats` | Index stats + KV collection inventory |
| `brainbank_history` | Git commit history for a file path |
| `brainbank_collection` | KV operations: add, search, trim |

**Multi-workspace LRU pool:**

```
_pool: Map<string, { brain: BrainBank, lastAccess: number }>
MAX_POOL_SIZE = 10

getBrainBank(targetRepo?)
  repo = targetRepo ?? BRAINBANK_REPO env ?? findRepoRoot(cwd)
  if pool hit: health check + return
  if pool full: evict oldest (LRU)
  _createBrain(resolved):
    read .brainbank/config.json
    resolve embedding: config > BRAINBANK_EMBEDDING env > auto from DB
    new BrainBank + use(code/git/docs)
    brain.initialize()
    ← corruption recovery: delete DB + retry fresh

_sharedReranker: created once from BRAINBANK_RERANKER env
                 shared across ALL pool entries
```

---

## 9. Collection — KV Store

**Files:** `src/services/collection.ts` (407 lines), `src/services/kv-service.ts` (66 lines)
**Pattern:** Repository + Hybrid Search + Shared HNSW

All collections share **one kvHnsw** owned by `KVService`. Cross-collection
isolation via `WHERE collection = ?` after adaptive over-fetch.

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
  options: { metadata?, tags?, ttl? } OR plain metadata object (legacy)
  embed FIRST → INSERT kv_data → INSERT kv_vectors → hnsw.add → cache.set
  ttl: parseDuration('30d'→2592000, '24h'→86400, '5m'→300)

addMany(items[])
  embedBatch (single API call) → single DB transaction → HNSW after commit

update(id, content, options?)
  remove old → add new (re-embeds)

search(query, { k=5, mode='hybrid', minScore=0.15, tags? })
  _pruneExpired()
  mode='keyword' → _searchBM25 → _filterByTags
  mode='vector'  → _searchVector → _filterByTags
  mode='hybrid':
    parallel: _searchVector + _searchBM25
    fuseRankedLists<T>([vec, bm25])  ← generic RRF
    optional reranker → _filterByTags

_searchVector: adaptive over-fetch based on collection density
  ratio = ceil(totalHnswSize / collectionCount), clamped [3, 50]

searchAsResults(query, k) → SearchResult[]
  ← used by SearchAPI._collectKvCollections()

trim({ keep }) → remove oldest beyond keep window
prune({ olderThan }) → remove by age
remove(id), clear()
```

---

## 10. Search Layer

### 10.1 SearchStrategy Interface

```typescript
// src/search/types.ts
interface SearchStrategy {
    search(query: string, options?: SearchOptions): Promise<SearchResult[]>
    rebuild?(): void
}
interface DomainVectorSearch {
    search(queryVec: Float32Array, k: number, minScore: number,
           useMMR?: boolean, mmrLambda?: number): SearchResult[]
}
interface SearchOptions {
    sources?: Record<string, number>  // { code: 6, git: 5, myNotes: 10 }
    minScore?:  number   // default 0.25
    useMMR?:    boolean  // default true
    mmrLambda?: number   // default 0.7
}
```

### 10.2 CompositeVectorSearch

**File:** `src/search/vector/composite-vector-search.ts` (43 lines)

Generic orchestrator. Embeds the query once, delegates to registered
`DomainVectorSearch` strategies discovered from `VectorSearchPlugin`
instances at wiring time.

```
CompositeVectorSearch({ strategies: Map<string, DomainVectorSearch>, embedding })

.search(query, options):
  queryVec = await embedding.embed(query)   ← ONE embed call
  for each [name, strategy] in strategies:
    k = sources[name] ?? DEFAULT_K (6)
    if k > 0: results.push(...strategy.search(queryVec, k, minScore, useMMR, mmrLambda))
  sort by score DESC
```

### 10.3 CompositeBM25Search

**File:** `src/search/keyword/composite-bm25-search.ts` (50 lines)

Generic BM25 coordinator. Discovers `BM25SearchPlugin` instances from the
registry and delegates per-source keyword search.

```
CompositeBM25Search(registry)

.search(query, options):
  for each plugin in registry.all:
    if !isBM25SearchPlugin(plugin) → skip
    baseType = plugin.name.split(':')[0]
    k = sources[baseType] ?? DEFAULT_K (8)
    if k > 0: results.push(...plugin.searchBM25(query, k))
  sort by score DESC

.rebuild():
  for each BM25SearchPlugin: plugin.rebuildFTS?.()
```

### 10.4 Hybrid Search + RRF

```
SearchAPI.hybridSearch(query, options?)
         │
         ├── if CompositeVectorSearch available:
         │     parallel:
         │       vectorSearch.search(query, options)
         │       bm25?.search(query, options) ?? []
         │     lists.push(vecResults, kwResults)
         │
         ├── _collectSearchablePlugins(query, options):
         │     for plugins that are SearchablePlugin BUT NOT VectorSearchPlugin:
         │       hits = await mod.search(query, ...)
         │       lists.push(hits)  ← custom SearchablePlugins only
         │
         ├── _collectKvCollections(query, sources):
         │     for [name, k] in sources where name ∉ registered plugin names:
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
  sort by rrfScore DESC, normalize to 0..1

Unique key generation:
  'code'       → "code:{filePath}:{startLine}-{endLine}"
  'commit'     → "commit:{hash or shortHash}"
  'document'   → "document:{filePath}:{collection}:{seq}:{content.slice(0,80)}"
  'collection' → "collection:{id or content.slice(0,80)}"
```

### 10.5 MMR — Diversity

**File:** `src/search/vector/mmr.ts` (65 lines)

```
searchMMR(index, query, vectorCache, k, lambda=0.7)
  candidates = index.search(query, k*3)   ← over-fetch 3×
  greedy selection (k iterations):
    mmrScore = lambda * relevance - (1 - lambda) * max_sim_to_selected
    pick argmax(mmrScore)

lambda=0.7: 70% relevance, 30% diversity (default)
```

### 10.6 Reranking

**File:** `src/lib/rerank.ts` (34 lines)

```
rerank(query, results, reranker):
  scores = await reranker.rank(query, documents)
  Position-aware blending:
    pos 1-3:   rrfWeight = 0.75  ← preserve exact matches
    pos 4-10:  rrfWeight = 0.60
    pos 11+:   rrfWeight = 0.40  ← trust reranker more
    blended = rrfWeight * r.score + (1 - rrfWeight) * scores[i]
  sort by blended DESC
```

### 10.7 ContextBuilder

**File:** `src/search/context-builder.ts` (58 lines)

Plugin-agnostic. Discovers `ContextFormatterPlugin` and `SearchablePlugin`
instances from the registry.

```
ContextBuilder(search?, registry)

.build(task, options?):
  results = search?.search(task, ...) ?? []
  parts = [`# Context for: "${task}"\n`]

  for mod in registry.all:
    if isContextFormatterPlugin(mod):
      mod.formatContext(results, parts, options)
      ← CodePlugin adds: code results + call graph + import graph
      ← GitPlugin adds: commit history + co-edit suggestions

  for mod in registry.all:
    if isSearchable(mod) && NOT isContextFormatterPlugin(mod):
      hits = await mod.search(task, ...)
      parts.push(formatted hits)
      ← custom SearchablePlugins only (DocsPlugin is a ContextFormatterPlugin)

  → parts.join('\n')
```

### 10.8 DocumentSearch

**File:** `packages/docs/src/document-search.ts` (221 lines)

DocsPlugin's internal search engine. Manages its own hybrid search pipeline
independently from the core CompositeVectorSearch.

```
DocumentSearch({ db, embedding, hnsw, vecCache, reranker? })

.search(query, { collection?, k=8, minScore=0, mode='hybrid' })
  mode='keyword' → _dedup(_searchBM25, k)
  mode='vector'  → _dedup(_searchVector, k)
  mode='hybrid':
    parallel: _searchVector(k*2) + _searchBM25(k*2)
    reciprocalRankFusion([vecHits, bm25Hits])
    map fused → originals via chunkId
    _dedup(results, k) → _rerankResults

_searchBM25: OR-mode FTS5, stop-word filtering
  bm25(fts_docs, 10.0, 2.0, 5.0, 1.0) ← title×10, content×2, file_path×5, collection×1

_searchVector: adaptive over-fetch for collection filtering

_dedup: keep best-scoring result per filePath

_getDocContext: walk path hierarchy → path_contexts → collection.context
```

---

## 11. Infrastructure

### 11.1 Database

**File:** `src/db/database.ts` (71 lines)

```
Database(dbPath):
  fs.mkdirSync(dirname, { recursive: true })
  new BetterSqlite3(dbPath)
  PRAGMA journal_mode = WAL
  PRAGMA busy_timeout = 5000
  PRAGMA synchronous = NORMAL
  PRAGMA foreign_keys = ON
  createSchema(db)   ← core-only tables

transaction<T>(fn: () => T): T    ← auto-commit/rollback
batch(sql, rows[][])              ← one txn, one stmt, many rows
prepare(sql) → Statement
exec(sql)
close()
```

### 11.2 HNSWIndex

**File:** `src/providers/vector/hnsw-index.ts` (175 lines)

```
HNSWIndex(dims, maxElements=2_000_000, M=16, efConstruction=200, efSearch=50)

init(): Promise<this>
  dynamic import 'hnswlib-node'
  new HNSW('cosine', dims); initIndex(); setEf()

add(vector, id):     idempotent (skip duplicates), throws if full
remove(id):          markDelete (soft delete)
search(query, k):    → [{ id, score: 1 - distance }]
save(path):          writeIndexSync (skip if empty)
tryLoad(path, expectedCount): boolean
  verify count matches → rebuild ids set; stale → reinit + false
reinit():            fresh empty index, same params
size / maxElements
```

### 11.3 HNSW Loader

**File:** `src/providers/vector/hnsw-loader.ts` (86 lines)

```
hnswPath(dbPath, name) → join(dirname(dbPath), 'hnsw-{name}.index')
countRows(db, table)   → SELECT COUNT(*)

saveAllHnsw(dbPath, kvHnsw, sharedHnsw, privateHnsw):
  try/catch: non-fatal, next startup rebuilds from SQLite

loadVectors(db, table, idCol, hnsw, cache):
  iterate rows → Float32Array from Buffer → hnsw.add + cache.set

loadVecCache(db, table, idCol, cache):
  same but skips hnsw.add() ← HNSW already loaded from file
```

### 11.4 Embedding Providers

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
LocalEmbedding (384d)
  Xenova/all-MiniLM-L6-v2, quantized WASM, ~23MB
  Lazy singleton pipeline, promise-deduped, BATCH_SIZE=32

OpenAIEmbedding (1536d / 3072d)
  text-embedding-3-small/large, ada-002
  MAX_BATCH=100, token-limit retry logic

PerplexityEmbedding (2560d / 1024d)
  pplx-embed-v1-4b/0.6b, base64 int8 decoding

PerplexityContextEmbedding (2560d / 1024d)
  pplx-embed-context-v1-4b/0.6b
  Input: string[][] (docs × chunks), splitIntoDocuments (80k char/doc)

resolveEmbedding(key): lazy-loads the right provider class
providerKey(p): constructor.name → canonical key
```

### 11.5 Rerankers

**File:** `src/providers/rerankers/qwen3-reranker.ts` (181 lines)

```
Qwen3Reranker({ modelUri?, cacheDir?, contextSize=2048 })
  Qwen3-Reranker-0.6B-Q8_0 (~640MB GGUF)
  node-llama-cpp (optional peer dep)
  Lazy load, flash attention with fallback
  Deduplicates identical texts, tokenizer-based truncation
  rank(query, documents) → scores[] (0.0–1.0)
```

---

## 12. Services

### 12.1 Watch Service

**File:** `src/services/watch.ts` (220 lines)

```
Watcher(reindexFn, indexers: Map<string,Plugin>, repoPath, options)
  { paths?, debounceMs=2000, onIndex?, onError? }

  _collectCustomPatterns(): isWatchable plugins → { indexer, patterns }
  _startWatching():
    fs.watch(path, { recursive: mac/win }, callback)
    filter: IGNORE_DIRS, IGNORE_FILES, isSupported, custom patterns
    debounce → _processPending()

  _processPending() [serialized via _flushing flag]:
    custom plugin: onFileChange(absPath, event)
    code files: await reindexFn() (full re-index)
    catch → re-queue for retry
```

### 12.2 Reembed Engine

**File:** `src/engine/reembed.ts` (208 lines)
**Pattern:** Atomic Swap

```
reembedAll(db, embedding, hnswMap, plugins, options?, persist?)

  collectTables(plugins):
    for each isReembeddable plugin: plugin.reembedConfig()
    CORE_TABLES: 'kv' → kv_data/kv_vectors
    deduplicates by vectorTable (multi-repo share same table)

  for each table:
    PHASE 1 — build new vectors in temp table (old data safe):
      CREATE temp → embedBatch in batches of 50 → INSERT temp
    PHASE 2 — atomic swap:
      TRANSACTION: DELETE old + INSERT FROM temp
    finally: DROP temp

    rebuildHnsw: reinit() + load from new BLOBs

  setEmbeddingMeta + saveAllHnsw

→ ReembedResult: { counts: Record<string, number>, total: number }
```

### 12.3 EmbeddingMeta

**File:** `src/db/embedding-meta.ts` (75 lines)

```
embedding_meta table (key/value):
  'provider'     → 'LocalEmbedding' | 'OpenAIEmbedding' | ...
  'dims'         → '384' | '1536' | '2560'
  'provider_key' → 'local' | 'openai' | 'perplexity' | 'perplexity-context'
  'indexed_at'   → ISO timestamp

setEmbeddingMeta(db, embedding): UPSERT all four keys
getEmbeddingMeta(db): EmbeddingMeta | null
detectProviderMismatch(db, embedding):
  → { mismatch: boolean, stored: "X/384", current: "Y/1536" }
```

---

## 13. Engine Layer

### 13.1 IndexAPI

**File:** `src/engine/index-api.ts` (62 lines)

Plugin-agnostic indexing orchestrator. Uses `isIndexable()` type guard
to discover which plugins can index.

```
runIndex(deps: { registry, emit }, options):
  want = Set(options.modules) or null (all)

  for mod in registry.all:
    baseType = mod.name.split(':')[0]   ← 'code:frontend' → 'code'
    if want && !want.has(baseType) → skip
    if !isIndexable(mod) → skip
    r = await mod.index({ forceReindex, onProgress, ...pluginOptions })
    results[baseType] = mergeResult(accumulator, r)

  emit('indexed', results)
```

**`mergeResult`** accumulates across multi-repo instances:
`code:frontend` + `code:backend` → single `code` result with summed counts.

### 13.2 SearchAPI

**File:** `src/engine/search-api.ts` (165 lines)

```
createSearchAPI(db, embedding, config, registry, kvService, sharedHnsw):
  strategies = Map<string, DomainVectorSearch>
  for mod in registry.all:
    if isVectorSearchPlugin(mod):
      vs = mod.createVectorSearch()
      strategies.set(baseType, vs)   ← 'code', 'git', or 'docs'

  search = strategies.size > 0
    ? new CompositeVectorSearch({ strategies, embedding })
    : undefined

  bm25 = new CompositeBM25Search(registry)
  contextBuilder = new ContextBuilder(search, registry)

  return new SearchAPI({ search, bm25, registry, config, kvService, contextBuilder })


SearchAPI:
  getContext(task, opts) → contextBuilder.build(task, opts)
  search(query, opts) → vector + searchable plugins → RRF if multiple lists
  hybridSearch(query, opts) → [see §10.4]
  searchBM25(query, opts) → bm25.search(query, opts)
  rebuildFTS() → bm25.rebuild()
```

---

## 14. CLI Layer

**Files:** `src/cli/` — `index.ts`, `utils.ts`, `factory/`, `commands/`

### 14.1 CLI Factory — createBrain()

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
    merge ignore: config.code.ignore + --ignore flag
    loadCodePlugin/loadGitPlugin/loadDocsPlugin (dynamic import, null if not installed)
    multi-repo → code:{sub.name}, git:{sub.name} per subdirectory
    single → code({ repoPath }), git(), docs()
  for plugin in folderPlugins: brain.use(plugin)
  for plugin in config?.indexers: brain.use(plugin)
  return brain   ← NOT initialized, .use() still allowed
```

**Config priority:** CLI flags > config.json > DB meta > defaults

### 14.2 Commands

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

---

## 15. SQLite Schema

### Core Schema (`src/db/schema.ts` — SCHEMA_VERSION = 7)

Core creates ONLY infrastructure tables. All domain tables are created
by plugins via `runPluginMigrations()`.

```
━━━ CORE: KV COLLECTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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


━━━ CORE: METADATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

embedding_meta
  key TEXT PRIMARY KEY, value TEXT

schema_version
  version INTEGER PRIMARY KEY, applied_at INTEGER

plugin_versions
  plugin_name TEXT PRIMARY KEY
  version INTEGER, applied_at INTEGER
```

### Plugin Schemas (created by migrations during initialize())

```
━━━ @brainbank/code (CODE_SCHEMA_VERSION = 1) ━━━━━━━━━━━━━━━━━━━━━━━━

code_chunks
  id INTEGER PRIMARY KEY AUTOINCREMENT
  file_path TEXT NOT NULL              ← idx_cc_file
  chunk_type TEXT                      ← 'file'|'function'|'class'|'method'|'interface'|'block'
  name TEXT, start_line INTEGER, end_line INTEGER
  content TEXT, language TEXT, file_hash TEXT, indexed_at INTEGER

code_vectors
  chunk_id INTEGER PRIMARY KEY REFERENCES code_chunks(id) ON DELETE CASCADE
  embedding BLOB

indexed_files
  file_path TEXT PRIMARY KEY, file_hash TEXT, indexed_at INTEGER

code_imports
  file_path TEXT, imports_path TEXT
  PRIMARY KEY (file_path, imports_path)   ← idx_ci_imports

code_symbols
  id INTEGER PRIMARY KEY AUTOINCREMENT
  file_path TEXT, name TEXT, kind TEXT, line INTEGER
  chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE
  ← idx_cs_name, idx_cs_file

code_refs
  chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE
  symbol_name TEXT
  ← idx_cr_symbol, idx_cr_chunk

fts_code (FTS5, content='code_chunks', content_rowid='id')
  columns: file_path, name, content
  triggers: trg_fts_code_insert, trg_fts_code_delete


━━━ @brainbank/git (GIT_SCHEMA_VERSION = 1) ━━━━━━━━━━━━━━━━━━━━━━━━━━

git_commits
  id INTEGER PRIMARY KEY AUTOINCREMENT
  hash TEXT UNIQUE NOT NULL   ← idx_gc_hash
  short_hash TEXT, message TEXT, author TEXT, date TEXT
  timestamp INTEGER   ← idx_gc_ts DESC
  files_json TEXT, diff TEXT, additions INTEGER, deletions INTEGER
  is_merge INTEGER

git_vectors
  commit_id INTEGER PRIMARY KEY REFERENCES git_commits(id) ON DELETE CASCADE
  embedding BLOB

commit_files
  commit_id INTEGER REFERENCES git_commits(id)
  file_path TEXT   ← idx_cf_path

co_edits
  file_a TEXT, file_b TEXT, count INTEGER DEFAULT 1
  PRIMARY KEY (file_a, file_b)

fts_commits (FTS5, content='git_commits', content_rowid='id')
  columns: message, author, diff
  triggers: trg_fts_commits_insert, trg_fts_commits_delete


━━━ @brainbank/docs (DOCS_SCHEMA_VERSION = 1) ━━━━━━━━━━━━━━━━━━━━━━━━

collections
  name TEXT PRIMARY KEY
  path TEXT, pattern TEXT DEFAULT '**/*.md'
  ignore_json TEXT DEFAULT '[]', context TEXT, created_at INTEGER

doc_chunks
  id INTEGER PRIMARY KEY AUTOINCREMENT
  collection TEXT REFERENCES collections(name) ON DELETE CASCADE
  file_path TEXT, title TEXT, content TEXT
  seq INTEGER, pos INTEGER, content_hash TEXT, indexed_at INTEGER
  ← idx_dc_collection, idx_dc_file, idx_dc_hash

doc_vectors
  chunk_id INTEGER PRIMARY KEY REFERENCES doc_chunks(id) ON DELETE CASCADE
  embedding BLOB

path_contexts
  collection TEXT, path TEXT, context TEXT
  PRIMARY KEY (collection, path)

fts_docs (FTS5, content='doc_chunks', content_rowid='id')
  columns: title, content, file_path, collection
  triggers: trg_fts_docs_insert, trg_fts_docs_delete
```

**FTS5 trigger pattern (all tables):**

```
AFTER INSERT → INSERT INTO fts_X(rowid, ...) VALUES (new.id, ...)
AFTER DELETE → INSERT INTO fts_X(fts_X, rowid, ...) VALUES ('delete', old.id, ...)
← no UPDATE trigger: indexers delete + re-insert on change
```

---

## 16. Data Flow Diagrams

### 16.1 Startup Flow

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
    │  1. new Database('.brainbank/brainbank.db')        │
    │     ← core schema only: KV + metadata + migrations│
    │  2. resolveEmbedding → openai (explicit)           │
    │  3. detectProviderMismatch → check stored vs current│
    │  4. KVService ready (kvHnsw + vecs)                │
    │  5. Load KV vectors (tryLoad or from SQLite)       │
    └───────────────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────────────────┐
    │  6. Plugin initialization (each creates own schema)│
    │                                                    │
    │  CodePlugin.initialize(ctx):                       │
    │    runPluginMigrations() → creates code_* tables   │
    │    getOrCreateSharedHnsw('code') → isNew=true      │
    │    loadVectors('code_vectors', 'chunk_id', ...)    │
    │                                                    │
    │  GitPlugin.initialize(ctx):                        │
    │    runPluginMigrations() → creates git_* tables    │
    │    getOrCreateSharedHnsw('git') → isNew=true       │
    │    loadVectors('git_vectors', 'commit_id', ...)    │
    │                                                    │
    │  DocsPlugin.initialize(ctx):                       │
    │    runPluginMigrations() → creates doc_* tables    │
    │    getOrCreateSharedHnsw('docs') → SHARED HNSW           │
    │    loadVectors('doc_vectors', 'chunk_id', ...)     │
    └───────────────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────────────────┐
    │  7. saveAllHnsw() → write all .index files         │
    │  8. createSearchAPI():                             │
    │       discover VectorSearchPlugin → strategies map  │
    │       CompositeBM25Search(registry)                │
    │       ContextBuilder(search, registry)             │
    │     _initialized = true                            │
    └───────────────────────────────────────────────────┘
```

### 16.2 Indexing Flow

```
brain.index({ modules: ['code', 'git'] })
         │
    ┌────▼──────────────────────────────────────────┐
    │  runIndex() iterates registry.all              │
    │                                                │
    │  CODE (isIndexable → true):                    │
    │  _walkRepo() → files (filter ignore/size/ext)  │
    │  for each file:                                │
    │    FNV-1a(content) === indexed_files.hash?     │
    │      YES → skip                                │
    │      NO  → chunk + embed + transaction         │
    │          → HNSW update after commit             │
    │                                                │
    │  GIT (isIndexable → true):                     │
    │  git.log(500) → commits[]                      │
    │  Phase 1: collect new commits (skip existing)  │
    │  Phase 2: embedBatch → INSERT transaction      │
    │  Phase 3: hnsw.add() + computeCoEdits()        │
    │                                                │
    │  mergeResult('code', r) → accumulated totals   │
    └───────────────────────────────────────────────┘
         │
    emit('indexed', { code: { indexed, skipped, chunks }, git: { ... } })
```

### 16.3 Hybrid Search Flow

```
brain.hybridSearch("authentication middleware", { sources: { code: 10, git: 5 } })
         │
    ┌────┴──────────────────────────────────────────────────┐
    │                  parallel                              │
    ├──────────────────────┬───────────────────────────────┤
    ▼                      ▼                               ▼
VectorSearch           BM25Search                   SearchablePlugins
(Composite)            (Composite)                  (custom only)
embed once →           discovers                    plugins that are
HNSW per strategy      BM25SearchPlugin             Searchable but NOT
(code, git, docs)      per plugin                   VectorSearchPlugin
[vecResults]           [kwResults]                  [pluginResults]
    │                   │                             │
    └───────────────────┴─────────────────────────────┘
                        │
          + KV collection lists (from sources)
                        │
          reciprocalRankFusion(all lists, k=60, maxResults=15)
                        │
          if reranker: rerank(query, fused, reranker)
                        │
          [sorted SearchResult[]]
```

### 16.4 Context Building Flow

```
brain.getContext("add rate limiting to the auth API")
  │
  ContextBuilder.build(task):
    CompositeVectorSearch.search(task) → code + git results

    for ContextFormatterPlugin:
      CodePlugin.formatContext():
        code results grouped by file + call graph annotations
        import graph: 2-hop BFS + sibling clustering + best chunks
      GitPlugin.formatContext():
        commit history + diff snippets
        co-edit suggestions for affectedFiles
      DocsPlugin.formatContext():
        document results grouped by collection + title

    for SearchablePlugin (not ContextFormatter):
      (custom plugins only — DocsPlugin is a ContextFormatterPlugin)

    → markdown for LLM system prompt
```

### 16.5 Reembed Flow

```
brain.reembed()   (switch Local 384d → OpenAI 1536d)
  │
  collectTables:
    isReembeddable plugins (code, git, docs)
    + core KV table
    dedup by vectorTable
  for each table:
    CREATE temp → embedBatch (50) → INSERT temp
    TRANSACTION: DELETE old + INSERT FROM temp  ← atomic swap
    DROP temp
    rebuildHnsw: reinit() + load from new BLOBs
  setEmbeddingMeta + saveAllHnsw
```

---

## 17. Design Patterns Reference

| # | Pattern | Where used | What it does |
|---|---------|-----------|-------------|
| 1 | **Facade** | `BrainBank` | Single entry point hiding registry, init, plugins, search, index |
| 2 | **Capability Interface** | `VectorSearchPlugin`, `BM25SearchPlugin`, `ContextFormatterPlugin`, etc. | Plugins declare capabilities; core discovers at runtime |
| 3 | **Strategy** | `SearchStrategy`, `DomainVectorSearch`, `EmbeddingProvider` | Interchangeable backends |
| 4 | **Registry + Prefix Matching** | `PluginRegistry` | `has('code')` matches `code`, `code:frontend` |
| 5 | **Linear Construction** | `_runInitialize()` | 8-step: DB → embed → mismatch → KV → vectors → plugins → save → wire |
| 6 | **Factory Method** | `code()`, `git()`, `docs()`, `createBrain()` | Hide instantiation complexity |
| 7 | **Dependency Injection** | `PluginContext` | Plugins receive all deps through one context object |
| 8 | **Repository** | `Collection`, `DocsIndexer` | Encapsulate read/write per domain |
| 9 | **Observer / EventEmitter** | `BrainBank extends EventEmitter` | `initialized`, `indexed`, `reembedded`, `progress` |
| 10 | **Flyweight** | `_sharedHnsw` pool | `code:frontend` + `code:backend` share ONE HNSW |
| 11 | **Builder** | `ContextBuilder` | Incrementally assembles markdown from plugin formatters |
| 12 | **Composite** | `CompositeVectorSearch`, `CompositeBM25Search` | Embed once, delegate to domain strategies |
| 13 | **Lazy Singleton + Promise Dedup** | `LocalEmbedding`, `Qwen3Reranker` | Expensive resources loaded on first use |
| 14 | **Memento / Persistence** | `HNSWIndex.save()` / `tryLoad()` | Graph persisted post-init with staleness check |
| 15 | **Adapter** | Embedding providers | OpenAI `number[]`, Perplexity base64 int8, WASM flat → `Float32Array` |
| 16 | **Guard / Precondition** | `_requireInit()` | Descriptive errors before null-pointer crashes |
| 17 | **Template Method** | `plugin.initialize(ctx)` | BrainBank controls sequence; plugins fill in domain logic |
| 18 | **Atomic Swap** | `reembedTable()` | Temp table → TRANSACTION DELETE+INSERT; old data safe on failure |
| 19 | **Incremental Processing** | `CodeWalker`, `DocsIndexer`, `GitIndexer` | Content-hash skip; only changed content re-embedded |
| 20 | **Discriminated Union** | `SearchResult` | `isCodeResult()`, `matchResult()` for exhaustive matching |
| 21 | **Pipeline** | Hybrid search → RRF → rerank | Composable, independently testable stages |
| 22 | **LRU Pool** | `@brainbank/mcp` workspace pool | Up to 10 instances; evict least-recently-used |
| 23 | **Plugin Migrations** | `runPluginMigrations()` | Per-plugin versioned schema, idempotent `IF NOT EXISTS` |

---

## 18. Complete Dependency Graph

```
                     ┌──────────────────────────────────────┐
                     │         BrainBank (Facade)           │
                     └──┬──────┬──────┬───────┬─────────────┘
                        │      │      │       │
                ┌───────▼─┐ ┌──▼───┐ ┌▼──────┐│
                │runIndex │ │Search│ │Plugin ││
                │         │ │API   │ │Reg.   ││
                └────┬────┘ └──┬───┘ └───┬───┘│
                     │        │          │    │
          ┌──────────▼────┐   │   ┌──────▼────▼──────────────────────────┐
          │ isIndexable?  │   │   │            Plugins                    │
          │ iterate all   │   │   │                                      │
          └──────┬────────┘   │   │  CodePlugin                          │
                 │            │   │    ├── CodeWalker (tree-sitter AST)   │
                 │            │   │    ├── CodeVectorSearch               │
                 │            │   │    ├── code-context-formatter         │
                 │            │   │    └── code-schema (migrations)       │
                 │            │   │                                      │
                 │            │   │  GitPlugin                           │
                 │            │   │    ├── GitIndexer (simple-git)        │
                 │            │   │    ├── GitVectorSearch                │
                 │            │   │    ├── git-context-formatter          │
                 │            │   │    ├── CoEditAnalyzer                 │
                 │            │   │    └── git-schema (migrations)        │
                 │            │   │                                      │
                 │            │   │  DocsPlugin                          │
                 │            │   │    ├── DocsIndexer (smart chunker)    │
                 │            │   │    ├── DocumentSearch (own hybrid)    │
                 │            │   │    └── docs-schema (migrations)       │
                 │            │   │                                      │
                 │            │   └──────────────────────────────────────┘
                 │            │
          ┌──────▼────────────▼──────────────────────────────────────────┐
          │                     Search Layer                             │
          │                                                              │
          │  createSearchAPI():                                          │
          │    discover VectorSearchPlugin → CompositeVectorSearch        │
          │    CompositeBM25Search(registry) → discover BM25SearchPlugin  │
          │    ContextBuilder(search, registry) → discover formatters     │
          │                                                              │
          │  reciprocalRankFusion + fuseRankedLists<T>                    │
          │  rerank (position-aware blending)                             │
          │  searchMMR (diversity)                                        │
          └──────────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────────────┐
     │                       Infrastructure                             │
     │                                                                  │
     │  Database ──── better-sqlite3 (WAL + FK + core schema only)      │
     │  Migrations ── runPluginMigrations() per plugin                   │
     │                                                                  │
     │  HNSWIndex ──── hnswlib-node                                     │
     │    ├── KVService._hnsw        (all KV collections share one)     │
     │    ├── _sharedHnsw['code']    (all code:* plugins share one)     │
     │    ├── _sharedHnsw['git']     (all git:*  plugins share one)     │
     │    └── DocsPlugin.hnsw        (private, per-instance)            │
     │                                                                  │
     │  EmbeddingProviders: Local, OpenAI, Perplexity, PerplexityContext│
     │  Qwen3Reranker ──── node-llama-cpp (optional)                    │
     └──────────────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────────────┐
     │                       Services                                   │
     │                                                                  │
     │  KVService → Collection (kvHnsw shared + fts_kv + kv_data)       │
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
     │  Commands: index, search/hsearch/ksearch, collection, kv,        │
     │    docs/dsearch, context, stats, reembed, watch, serve, help     │
     └──────────────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────────────┐
     │                     @brainbank/mcp                               │
     │                                                                  │
     │  LRU pool: Map<repoPath, { brain, lastAccess }> max=10          │
     │  6 tools: search, context, index, stats, history, collection     │
     │  findRepoRoot + corruption recovery + shared reranker            │
     └──────────────────────────────────────────────────────────────────┘
```

---

## 19. Testing Strategy

### Test Infrastructure

- **Custom runner:** `test/run.ts` — discovers `test/{unit,integration}/` + `packages/*/test/{unit,integration}/`
- Tests export `{ name, tests }` — plain objects with assert functions, no Jest/Vitest
- **Hash-based embedding** (`hashEmbedding()`) — deterministic, unique per text, normalized
- **`createDomainSchema()`** — helper that runs plugin migrations for tests needing domain tables

### Package Tests (`packages/*/test/`)

| Package | Test | Coverage |
|---------|------|----------|
| `@brainbank/code` | `code.test.ts` | Index TS+Python → HNSW → incremental skip → ignore patterns |
| `@brainbank/code` | `chunker.test.ts` | AST: TS/JS/Python, content integrity, fallback, benchmarks |
| `@brainbank/code` | `code-graph.test.ts` | code_imports, code_symbols, code_refs + cascade delete |
| `@brainbank/code` | `import-extractor.test.ts` | Regex per language (TS/Python/Go/Rust/Java/CSS...) |
| `@brainbank/code` | `symbol-extractor.test.ts` | AST symbol defs + call refs + builtin filtering |
| `@brainbank/code` | `languages.test.ts` | Extension mapping, ignore rules |
| `@brainbank/git` | `git.test.ts` | Real git repo → commits → co-edits → fileHistory |
| `@brainbank/docs` | `docs.test.ts` | Smart chunking → register → index → search → context |

### Commands

```
npm test                                 # unit only
npm run test:integration                 # unit + integration
npm test -- --filter <name>              # filter by name
npm test -- --verbose --filter reembed   # verbose output
```

---

## 20. Concurrency & WAL Strategy

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
</edit>

The document has been completely rewritten from scratch. Here's a summary of what changed vs the stale version:

**Removed (stale):**
- All `@brainbank/memory` references (package doesn't exist)
- `PatternVectorSearch`, `PatternStore`, `Consolidator`, `PatternDistiller`
- `memory_patterns` table and FTS
- Hardcoded plugin names in search/context/index layers
- `SearchFactory` as separate file (merged into `search-api.ts`)
- `earlyInit()`/`lateInit()` terminology (now linear 8-step)
- `IndexAPI` class (now just `runIndex()` function)
- Stale schema version (was 6, now 7)
- Core owning domain table schemas

**Added (new):**
- **Plugin migrations system** (`plugin_versions`, `runPluginMigrations()`)
- **Capability interfaces**: `VectorSearchPlugin`, `BM25SearchPlugin`, `ContextFormatterPlugin`, `MigratablePlugin`
- **CompositeBM25Search** — discovers BM25 plugins from registry
- **Plugin-owned schemas** — each plugin declares and runs its own migrations
- **`createSearchAPI()`** discovers strategies via `isVectorSearchPlugin()`
- **`ContextBuilder`** discovers formatters via `isContextFormatterPlugin()`
- **`runIndex()`** uses `isIndexable()` type guard — no hardcoded names
- Accurate file counts and line numbers for all source files
- Plugin code moved to packages: `code-vector-search.ts`, `sql-code-graph.ts`, `import-graph.ts`, `code-context-formatter.ts`, `git-vector-search.ts`, `git-context-formatter.ts`, `docs-context-formatter.ts`