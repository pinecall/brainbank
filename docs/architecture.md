# Table of Contents

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
8. [MCP Server (Core)](#8-mcp-server-core)
9. [Collection — KV Store](#9-collection--kv-store)
10. [Search Layer](#10-search-layer)
    - 10.1 [SearchStrategy Interface](#101-searchstrategy-interface)
    - 10.2 [CompositeVectorSearch](#102-compositevectorsearch)
    - 10.3 [CompositeBM25Search](#103-compositebm25search)
    - 10.4 [Hybrid Search + RRF](#104-hybrid-search--rrf)
    - 10.5 [MMR — Diversity](#105-mmr--diversity)
    - 10.6 [ContextBuilder](#106-contextbuilder)
    - 10.7 [Pruning](#107-pruning)
    - 10.8 [Expansion](#108-expansion)
    - 10.9 [DocumentSearch](#109-documentsearch)
11. [Infrastructure](#11-infrastructure)
    - 11.1 [Database](#111-database)
    - 11.2 [HNSWIndex](#112-hnswindex)
    - 11.3 [HNSW Loader](#113-hnsw-loader)
    - 11.4 [Embedding Providers](#114-embedding-providers)
12. [Services](#12-services)
    - 12.1 [Watch Service](#121-watch-service)
    - 12.2 [Reembed Engine](#122-reembed-engine)
    - 12.3 [EmbeddingMeta](#123-embeddingmeta)
    - 12.4 [HTTP Daemon](#124-http-daemon)
    - 12.5 [Query Logger](#125-query-logger)
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
plugin framework. All data lives in SQLite files with two retrieval layers
and optional post-processing on top:

| Layer | Technology | Characteristic |
|-------|-----------|----------------|
| Vector search | HNSW (hnswlib-node) | Semantic similarity, O(log n) |
| Keyword search | FTS5 BM25 (SQLite) | Exact/stem match, O(log n) |
| Hybrid | Vector + BM25 → RRF | Best of both |
| Pruning | LLM noise filter (optional) | Haiku 4.5 binary classification |
| Expansion | LLM context expansion (optional) | Haiku 4.5 chunk selection |

Everything is accessed through a **single facade** (`BrainBank`) that composes
specialized subsystems via a **capability-based plugin architecture**. The core
package owns all infrastructure (DB, KV schema, HNSW, embeddings, search
orchestration, CLI, MCP server). Plugin packages (`@brainbank/code`, `@brainbank/git`,
`@brainbank/docs`) implement domain-specific indexing and
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
|-------|---------|----------|
| **Facade / Engine** | Public surface, delegation, init guards | `brainbank.ts`, `engine/` |
| **Domain / Plugin** | Indexing, searching, formatting | `plugin.ts`, `packages/*/` |
| **Infrastructure** | DB, vectors, embeddings, math | `db/`, `providers/`, `lib/`, `services/` |

---

## 2. Repository Structure

```
brainbank/
├── src/                               ← Core library (published as "brainbank")
│   ├── brainbank.ts                   ← Main facade (BrainBank class, 621 lines)
│   ├── index.ts                       ← Public exports (160 lines)
│   ├── types.ts                       ← All TypeScript interfaces (505 lines)
│   ├── constants.ts                   ← HNSW.KV typed constant (14 lines)
│   ├── config.ts                      ← resolveConfig() + DEFAULTS (51 lines)
│   ├── plugin.ts                      ← Plugin interfaces, PluginContext, type guards (324 lines)
│   │
│   ├── engine/
│   │   ├── index-api.ts               ← runIndex(): orchestrates indexing across plugins (86 lines)
│   │   ├── search-api.ts              ← SearchAPI + createSearchAPI(): plugin-agnostic wiring (223 lines)
│   │   └── reembed.ts                 ← reembedAll(): atomic vector swap without re-parsing (207 lines)
│   │
│   ├── db/
│   │   ├── adapter.ts                 ← DatabaseAdapter interface + PreparedStatement<T> + row types (113 lines)
│   │   ├── sqlite-adapter.ts          ← SQLiteAdapter: better-sqlite3 implementation + core schema DDL (209 lines)
│   │   ├── metadata.ts                ← Cross-process versioning + embedding provider tracking (131 lines)
│   │   ├── migrations.ts              ← Plugin migration system (runPluginMigrations) (67 lines)
│   │   └── tracker.ts                 ← IncrementalTracker for standardized change detection (92 lines)
│   │
│   ├── providers/
│   │   ├── embeddings/
│   │   │   ├── local-embedding.ts     ← @xenova/transformers WASM (384d, offline) (116 lines)
│   │   │   ├── openai-embedding.ts    ← OpenAI API (1536d / 3072d) (168 lines)
│   │   │   ├── perplexity-embedding.ts ← Perplexity standard (2560d, base64 int8) (166 lines)
│   │   │   ├── perplexity-context-embedding.ts ← Contextualized (2560d, best quality) (196 lines)
│   │   │   ├── resolve.ts             ← resolveEmbedding(key) + providerKey re-export (35 lines)
│   │   │   ├── embedding-worker.ts    ← EmbeddingWorkerProxy (offloads to worker_threads) (142 lines)
│   │   │   └── embedding-worker-thread.ts ← Worker script: zero-copy ArrayBuffer transfer (96 lines)
│   │   ├── pruners/
│   │   │   ├── haiku-pruner.ts         ← LLM noise filter via Anthropic Haiku 4.5 (113 lines)
│   │   │   └── haiku-expander.ts       ← LLM context expansion via Haiku 4.5 (167 lines)
│   │   └── vector/
│   │       ├── hnsw-index.ts          ← HNSWIndex: hnswlib-node wrapper (175 lines)
│   │       └── hnsw-loader.ts         ← hnswPath, loadVectors, saveAllHnsw, reloadHnsw (130 lines)
│   │
│   ├── search/
│   │   ├── types.ts                   ← SearchStrategy, DomainVectorSearch, SearchOptions (36 lines)
│   │   ├── context-builder.ts         ← ContextBuilder: search → prune → expand → format (301 lines)
│   │   ├── bm25-boost.ts              ← boostWithBM25, filterByPath, filterByIgnore, resultKey (68 lines)
│   │   ├── keyword/
│   │   │   └── composite-bm25-search.ts ← Discovers BM25SearchPlugin instances from registry (63 lines)
│   │   └── vector/
│   │       ├── composite-vector-search.ts ← Generic: embed once, delegate to strategies (77 lines)
│   │       └── mmr.ts                 ← Maximum Marginal Relevance diversification (65 lines)
│   │
│   ├── services/
│   │   ├── collection.ts              ← Collection: KV store (hybrid search, tags, TTL) (406 lines)
│   │   ├── kv-service.ts              ← KVService: owns shared kvHnsw + kvVecs (66 lines)
│   │   ├── plugin-registry.ts         ← PluginRegistry: registration + type-prefix lookup (110 lines)
│   │   ├── watch.ts                   ← Watcher: plugin-driven + shared fs.watch fallback (349 lines)
│   │   ├── webhook-server.ts          ← WebhookServer: optional HTTP for push plugins (101 lines)
│   │   ├── daemon.ts                  ← PID file management for HTTP daemon (88 lines)
│   │   └── http-server.ts             ← HttpServer: JSON API + SimplePool for daemon mode (289 lines)
│   │
│   ├── lib/
│   │   ├── fts.ts                     ← sanitizeFTS, normalizeBM25, escapeLike (58 lines)
│   │   ├── languages.ts               ← SUPPORTED_EXTENSIONS, IGNORE_DIRS, IGNORE_FILES (181 lines)
│   │   ├── math.ts                    ← cosineSimilarity, normalize, vecToBuffer (88 lines)
│   │   ├── provider-key.ts            ← providerKey(): EmbeddingProvider → canonical key (21 lines)
│   │   ├── prune.ts                   ← pruneResults: bridges SearchResult[] → Pruner (72 lines)
│   │   ├── rrf.ts                     ← reciprocalRankFusion + fuseRankedLists<T> (134 lines)
│   │   ├── write-lock.ts              ← Advisory file lock (O_EXCL, stale PID detection) (109 lines)
│   │   └── logger.ts                  ← Query debug logger → /tmp/brainbank.log (126 lines)
│   │
│   └── cli/
│       ├── index.ts                   ← CLI dispatcher (63 lines)
│       ├── utils.ts                   ← Colors, arg parsing, result printer (122 lines)
│       ├── server-client.ts           ← HTTP client for daemon delegation (136 lines)
│       ├── factory/
│       │   ├── index.ts               ← createBrain(context?) orchestrator (66 lines)
│       │   ├── brain-context.ts       ← BrainContext type + contextFromCLI() (44 lines)
│       │   ├── config-loader.ts       ← .brainbank/config.json loader + cache (73 lines)
│       │   ├── plugin-loader.ts       ← Dynamic @brainbank/* loading + folder discovery (147 lines)
│       │   └── builtin-registration.ts ← Plugin registration (~90 lines)
│       └── commands/                  ← 15 command files (index, scan, search, context, kv, etc.)
│
│   └── mcp/                           ← MCP stdio server (built into core)
│       ├── mcp-server.ts              ← MCP stdio server (1 tool: context)
│       ├── workspace-pool.ts          ← Memory-pressure + TTL eviction pool (225 lines)
│       └── workspace-factory.ts       ← Delegates to core createBrain() (67 lines)
│
└── packages/
    ├── code/                          ← @brainbank/code (CODE_SCHEMA_VERSION = 5)
    │   └── src/
    │       ├── index.ts               ← Public barrel exports (28 lines)
    │       ├── plugin.ts              ← CodePlugin: 9 capability interfaces (401 lines)
    │       ├── schema.ts              ← 5 migrations (v1→v5: chunk-level vectors) (176 lines)
    │       ├── parsing/
    │       │   ├── chunker.ts         ← AST-first tree-sitter chunker (413 lines)
    │       │   ├── grammars.ts        ← Grammar registry (20+ languages) (137 lines)
    │       │   └── symbols.ts         ← AST symbol defs + call references (265 lines)
    │       ├── graph/
    │       │   ├── import-extractor.ts ← Regex import extraction (304 lines)
    │       │   ├── import-resolver.ts ← Resolves specifiers to file paths (384 lines)
    │       │   ├── provider.ts        ← SqlCodeGraphProvider (238 lines)
    │       │   └── traversal.ts       ← Bidirectional BFS + call tree builder (634 lines)
    │       ├── search/
    │       │   └── vector-search.ts    ← Dual-level hybrid search + RRF (308 lines)
    │       ├── indexing/
    │       │   └── walker.ts          ← File walker + incremental indexer (435 lines)
    │       └── formatting/
    │           └── context-formatter.ts ← V4 Flat Workflow Trace (638 lines)
    │
    ├── git/                           ← @brainbank/git (GIT_SCHEMA_VERSION = 1)
    │   └── src/
    │       ├── index.ts               ← Public barrel exports (6 lines)
    │       ├── git-plugin.ts          ← GitPlugin: 7 capability interfaces (208 lines)
    │       ├── git-schema.ts          ← 1 migration (80 lines)
    │       ├── git-indexer.ts         ← 4-phase commit pipeline (287 lines)
    │       ├── git-vector-search.ts   ← GitVectorSearch (67 lines)
    │       ├── git-context-formatter.ts ← Git + co-edit formatting (62 lines)
    │       └── co-edit-analyzer.ts    ← File co-occurrence queries (31 lines)
    │
    ├── docs/                          ← @brainbank/docs (DOCS_SCHEMA_VERSION = 1)
    │   └── src/
    │       ├── index.ts               ← Public barrel exports (8 lines)
    │       ├── docs-plugin.ts         ← DocsPlugin: 8 capability interfaces (316 lines)
    │       ├── docs-schema.ts         ← 1 migration (83 lines)
    │       ├── docs-indexer.ts        ← Smart markdown chunker (350 lines)
    │       ├── docs-vector-search.ts  ← DocsVectorSearch (87 lines)
    │       ├── docs-context-formatter.ts ← Document formatting (26 lines)
    │       └── document-search.ts     ← Hybrid search (RRF + dedup by file) (225 lines)
    │
    └── mcp/                           ← MCP stdio server (built into core)
        └── src/
            ├── mcp-server.ts          ← MCP stdio server (3 tools) (266 lines)
            ├── workspace-pool.ts      ← Memory-pressure + TTL eviction pool (225 lines)
            └── workspace-factory.ts   ← Delegates to core createBrain() (67 lines)
```

**Package dependency graph:**

```
@brainbank/code    ── peerDep ──► brainbank (core)
@brainbank/git     ── peerDep ──► brainbank (core)
@brainbank/docs    ── peerDep ──► brainbank (core)
```

> **Schema ownership:** Core owns ONLY KV tables + metadata tables. Domain tables
> are created by their respective plugins via `runPluginMigrations()` during
> `plugin.initialize()`.

---

## 3. BrainBank — Main Facade

**File:** `src/brainbank.ts` (621 lines)
**Pattern:** Facade + EventEmitter

`BrainBank` is a **thin orchestrator**. It owns state, enforces initialization
guards, and delegates every operation to specialized subsystems.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          BrainBank                                     │
│                     extends EventEmitter                               │
│                                                                        │
│  STATE                                                                 │
│  ─────────────────────────────────────────────────────────────────    │
│  _config:       ResolvedConfig           merged defaults + user cfg    │
│  _db:           DatabaseAdapter          root SQLite connection        │
│  _embedding:    EmbeddingProvider        active embedding model        │
│  _registry:     PluginRegistry           all registered plugins        │
│  _searchAPI:    SearchAPI | undefined    search + context ops          │
│  _indexDeps:    IndexDeps | undefined    indexing orchestration        │
│  _kvService:    KVService | undefined    KV infra (hnsw, vecs, map)    │
│  _sharedHnsw:   Map<string, {hnsw, vecCache}>  per-type HNSW pool     │
│  _repoDBs:     Map<string, DatabaseAdapter>  per-repo SQLite DBs      │
│  _loadedVersions: Map<string, number>    snapshot of index_state       │
│  _initialized:  boolean                  init guard flag               │
│  _initPromise:  Promise<void> | null     dedup concurrent inits        │
│  _watcher:      Watcher | undefined      watch handle                  │
│  _webhookServer: WebhookServer | undefined  optional push server       │
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
│  .hybridSearch(query, opts)  vector + BM25 → RRF                      │
│  .searchBM25(query, opts)  keyword-only search                         │
│  .getContext(task, opts)    formatted markdown for LLM system prompt    │
│  .resolveFiles(patterns)   direct file lookup (no search)              │
│  .ensureFresh()            hot-reload stale HNSW indices               │
│  .memoryHint()             estimated HNSW memory footprint (bytes)     │
│  .rebuildFTS()             rebuild FTS5 indices                        │
│  .reembed(opts)            re-generate all vectors (provider switch)   │
│  .watch(opts)              start plugin-driven auto-reindex            │
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
│  'initialized'  → { plugins: string[] }                               │
│  'indexed'      → { code?, git?, docs?, [custom]? }                   │
│  'reembedded'   → ReembedResult                                        │
│  'progress'     → string message                                       │
│  'warn'         → string message                                       │
└────────────────────────────────────────────────────────────────────────┘
```

**Auto-init vs require-init:**

```
Auto-init (calls await this.initialize() transparently):
  index, search, hybridSearch, searchBM25, getContext, reembed

ensureFresh() (hot-reload stale HNSW before query):
  search, hybridSearch, searchBM25, getContext

_requireInit() (throw if not initialized):
  rebuildFTS, watch, stats, listCollectionNames, deleteCollection, resolveFiles

collection() — special: throws "Collections not ready" if _kvService undefined

.use(plugin) — throws after _initialized === true
```

**close() cleanup sequence:**

```
_watcher?.close()
_webhookServer?.close()
for (plugin of registry.all): plugin.close?.()
pruner?.close?.()
expander?.close?.()
_embedding?.close().catch(() => {})
for (db of _repoDBs.values()): db.close()   ← per-repo DBs
_repoDBs.clear()
_db?.close()                                 ← root DB
_initialized = false
_kvService?.clear()
_sharedHnsw.clear()
_loadedVersions.clear()
_kvService = undefined
_searchAPI = undefined
_indexDeps = undefined
_webhookServer = undefined
_registry.clear()
```

---

## 4. Initialization

**File:** `src/brainbank.ts` — `_runInitialize()` method
**Pattern:** Linear 8-step construction

```
BrainBank._runInitialize({ force? })
│
├── 1. Open Database
│     new SQLiteAdapter(config.dbPath)
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
│     _kvService = new KVService(db, embedding, kvHnsw, new Map())
│     ← collection() NOW WORKS for plugins
│
├── 5. Load KV Vectors (unless skipVectorLoad)
│     tryLoad(kvIndexPath, kvCount) → loadVecCache (hit) / loadVectors (miss)
│
├── 6. Initialize Plugins
│     for each mod in registry.all:
│       pluginDb = _getOrCreatePluginDb(mod.name)  ← per-repo DB if namespaced
│       if pluginDb !== _db: setEmbeddingMeta(pluginDb, embedding)
│       ctx = _buildPluginContext(skipVectorLoad, privateHnsw, pluginDb, mod.name)
│       await mod.initialize(ctx)
│       ← plugins run their own runPluginMigrations() here
│       ← plugins call ctx.getOrCreateSharedHnsw() / ctx.createHnsw()
│
├── 7. Start Webhook Server (if configured)
│     if config.webhookPort: new WebhookServer().listen(port)
│
├── 8. Persist HNSW Indices
│     saveAllHnsw(dbPath, kvHnsw, sharedHnsw, privateHnsw)
│
├── 9. Build SearchAPI + IndexDeps
│     createSearchAPI(db, embedding, config, registry, kvService, sharedHnsw)
│     _indexDeps = { registry, emit, db, dbPath, sharedHnsw, kvHnsw }
│
└── 10. Snapshot Index Versions
      _loadedVersions = getVersions(db)
      _initialized = true
```

**Per-Repo Database Isolation (`_getOrCreatePluginDb`):**

Namespaced plugins (e.g. `code:servicehub-backend`) get their own SQLite database:

```
_getOrCreatePluginDb(pluginName):
  if !pluginName.includes(':') → return _db (root)
  repoName = pluginName.split(':').slice(1).join(':')
  if _repoDBs.has(repoName) → return cached
  repoDbPath = path.join(dirname(config.dbPath), `${repoName}.db`)
  db = new SQLiteAdapter(repoDbPath)
  _repoDBs.set(repoName, db)
  return db
```

Result: `.brainbank/data/servicehub-backend.db`, `.brainbank/data/servicehub-frontend.db`, etc.

**HNSW persistence strategy:**

```
Startup (tryLoad):
  file exists AND row count matches → load graph file (~50ms)
    → populate only Map<id, Float32Array> (loadVecCache)
  file missing OR count differs → rebuild from SQLite BLOBs

After all plugins initialize:
  saveAllHnsw() with cross-process file locking → .index files

HNSW file naming:
  ctx.loadVectors uses: hnsw-{tableName}-{root|repo}.index
  Shared HNSW saved as: hnsw-{type}.index (e.g. hnsw-code:backend.index)
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
│  register(plugin)   → _map.set(plugin.name, plugin)
│  has('code')        → checks exact 'code' OR any key starting with 'code:'
│  get<T>('code')     → ALIASES → exact → firstByType → throw
│  allByType('code')  → all plugins where name === 'code' OR name.startsWith('code:')
│  firstByType('git') → first match, undefined if none
│  names → string[]
│  all   → Plugin[]
│  raw   → Map<string, Plugin>
│  clear()
```



---

## 6. Plugin System & Plugin Context

**File:** `src/plugin.ts` (324 lines)
**Pattern:** Extension Point + Capability Interfaces + Dependency Injection

### 6.1 Plugin Interfaces

```
Plugin  (base — every plugin must implement)
│  readonly name: string
│  initialize(ctx: PluginContext): Promise<void>
│  stats?():  Record<string, number | string>
│  close?():  void

IndexablePlugin extends Plugin
│  index(options?: IndexOptions): Promise<IndexResult>
│  indexItems?(ids: string[]): Promise<IndexResult>  ← optional granular re-index

SearchablePlugin extends Plugin
│  search(query: string, options?): Promise<SearchResult[]>

WatchablePlugin extends Plugin
│  watch(onEvent: WatchEventHandler): WatchHandle
│  watchConfig?(): WatchConfig   ← debounceMs, batchSize, priority

VectorSearchPlugin extends Plugin
│  createVectorSearch(): DomainVectorSearch | undefined

BM25SearchPlugin extends Plugin
│  searchBM25(query: string, k: number, minScore?): SearchResult[]
│  rebuildFTS?(): void

ContextFormatterPlugin extends Plugin
│  formatContext(results: SearchResult[], parts: string[], fields: Record<string, unknown>): void

ContextFieldPlugin extends Plugin
│  contextFields(): ContextFieldDef[]   ← declares configurable fields

ExpandablePlugin extends Plugin
│  buildManifest(excludeFilePaths: string[], excludeIds: number[]): ExpanderManifestItem[]
│  resolveChunks(ids: number[]): SearchResult[]

FileResolvablePlugin extends Plugin
│  resolveFiles(patterns: string[]): SearchResult[]

MigratablePlugin extends Plugin
│  readonly schemaVersion: number
│  readonly migrations: Migration[]

ReembeddablePlugin extends Plugin
│  reembedConfig(): ReembedTable

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
isWatchable(p)              → typeof p.watch === 'function'
isDocsPlugin(p)             → typeof p.addCollection + listCollections
isCoEditPlugin(p)           → 'coEdits' in p && typeof suggest === 'function'
isReembeddable(p)           → typeof p.reembedConfig === 'function'
isVectorSearchPlugin(p)     → typeof p.createVectorSearch === 'function'
isContextFormatterPlugin(p) → typeof p.formatContext === 'function'
isContextFieldPlugin(p)     → typeof p.contextFields === 'function'
isMigratable(p)             → typeof schemaVersion === 'number' && Array.isArray(migrations)
isBM25SearchPlugin(p)       → typeof p.searchBM25 === 'function'
isExpandablePlugin(p)       → typeof p.buildManifest + resolveChunks === 'function'
isFileResolvable(p)         → typeof p.resolveFiles === 'function'
```

### 6.2 PluginContext — Dependency Injection Container

Built by `_buildPluginContext()` in `src/brainbank.ts`.

```
PluginContext
│
├── db: DatabaseAdapter
│     ← per-plugin DB (per-repo for namespaced, root for others)
│
├── embedding: EmbeddingProvider
│     ← global embedding; plugins may override via opts.embeddingProvider
│
├── config: ResolvedConfig
│
├── createHnsw(maxElements?, dims?, name?): Promise<HNSWIndex>
│     ← PRIVATE HNSW — not in main search pipeline
│
├── loadVectors(table, idCol, hnsw, cache): void
│     ← no-op if skipVectorLoad; tries disk → SQLite fallback
│     ← HNSW file: hnsw-{tableName}-{root|repo}.index
│
├── getOrCreateSharedHnsw(type, maxElements?, dims?):
│     Promise<{ hnsw, vecCache, isNew }>
│     ← checks _sharedHnsw Map by type key
│     ← isNew=true → first caller should loadVectors
│
├── collection(name): ICollection
│     ← delegates to kvService.collection(name)
│
├── createTracker(): IncrementalTracker
│     ← scoped to plugin name, uses plugin_tracking table
│
└── webhookServer?: WebhookServer
      ← undefined if webhookPort not configured
```

**HNSW allocation per plugin type:**

```
Plugin        │ HNSW key                       │ Shared?           │ Persisted as
──────────────┼────────────────────────────────┼───────────────────┼──────────────
CodePlugin    │ this.name ('code:backend')      │ Per-repo instance │ hnsw-code:backend.index
GitPlugin     │ literal 'git'                   │ All git:* share   │ hnsw-git.index
DocsPlugin    │ literal 'docs'                  │ All docs:* share  │ hnsw-docs.index
KV store      │ KVService._hnsw (kvHnsw)        │ All collections   │ hnsw-kv.index
```

---

## 7. Built-in Plugins

### 7.1 @brainbank/code

**Files:** `packages/code/src/` — 12 source files, CODE_SCHEMA_VERSION = 5

**Capabilities implemented (9):**
`IndexablePlugin`, `VectorSearchPlugin`, `BM25SearchPlugin`,
`ContextFormatterPlugin`, `ContextFieldPlugin`, `ReembeddablePlugin`,
`ExpandablePlugin`, `FileResolvablePlugin`, `MigratablePlugin`

**Context fields declared:**
`lines` (boolean), `callTree` (object), `imports` (boolean), `symbols` (boolean), `compact` (boolean)

**Schema owned** (via `CODE_MIGRATIONS`, 5 versions):
`code_chunks`, `code_vectors`, `indexed_files`, `code_imports` (v2: with `import_kind`, `resolved`),
`code_symbols`, `code_refs`, `code_call_edges` (v3), `fts_code`

```
code({ repoPath?, name?, embeddingProvider?, maxFileSize?, include?, ignore? })
         │
         ▼
CodePlugin.initialize(ctx)
         │
         ├── runPluginMigrations(db, name, CODE_SCHEMA_VERSION=5, CODE_MIGRATIONS)
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── shared = ctx.getOrCreateSharedHnsw(this.name, undefined, embedding.dims)
         │     ← this.name = e.g. 'code:backend' → per-repo HNSW
         ├── if shared.isNew: _loadChunkVectors(db)
         │     ← loads from code_vectors (chunk_id, embedding)
         └── new CodeWalker(repoPath, { db, hnsw, vectorCache, embedding }, ...)
```

**Indexing pipeline (`CodeWalker._indexFile`):**

```
1. CodeChunker.chunk(rel, content, language)
     AST-first: always tries tree-sitter (no short-circuit for small files)
     class > MAX → _splitClassIntoMethods()
     large block → _splitLargeBlock(overlap=5) with '(part N)' naming
     fallback → single 'file' chunk or sliding window

2. Build contextual embedding text per chunk:
     "File: src/api.ts\nmethod foo (L10-25)\nImports: express, zod\n---\n<code>"

3. Single embedBatch call for ALL vectors (chunks + file synopsis)
     ← merging into one API call halves round-trips

4. Concurrent file processing (CONCURRENCY = 5)
     ← ~10× faster indexing on API-based providers

5. extractImportPaths + ImportResolver     ← resolved import graph
6. extractSymbols + extractCallRefs        ← symbol index + call refs

7. DB TRANSACTION (atomic delete-old + insert-new):
     DELETE + INSERT code_chunks, code_vectors, code_imports,
     code_symbols, code_refs, indexed_files
     INSERT synopsis chunk (chunk_type='synopsis') + its vector

8. AFTER COMMIT: hnsw.remove(old) + hnsw.add(new) for chunks AND synopsis

9. _linkCallEdges() — build code_call_edges from code_refs → code_symbols
     Pass 1: Exact name match (function → function)
     Pass 2: Method suffix match (on_turn_end → TurnController.on_turn_end)
```

**Dual-level search (`CodeVectorSearch`):**

```
search(queryVec, k, minScore, ...):
  1. HNSW search → classify hits by chunk_type:
       'synopsis' → synopsisFileScores (file-level match)
       other     → chunkFileScores (function-level match)

  2. Cross-level scoring:
       Both levels match → max(scores) × CROSS_LEVEL_BOOST (1.4)
       Chunk only        → chunkScore × CHUNK_ONLY_PENALTY (0.7)
       Synopsis only     → synopsisScore as-is

  3. Chunk density filter:
       matchedChunks/totalChunks < DENSITY_THRESHOLD (0.20) → 0.25× penalty

  4. BM25 search on fts_code → aggregate best score per file

  5. RRF fusion at FILE level (vector + BM25, balanced 1:1)

  6. Return ONE result per file with all chunks concatenated (zero truncation)
       metadata.chunkIds = array of code chunk IDs for call graph seeding
```

**V4 Workflow Trace context formatter:**

```
formatCodeContext(codeHits, parts, codeGraph, pathPrefix, fields):
  1. Collect seed chunk IDs from search hits
  2. _expandAdjacentParts: if 'foo (part 5)' matched → fetch ±2 sibling parts
  3. buildCallTree(seedIds, callTreeDepth): recursive DFS on code_call_edges
     MAX_CALL_DEPTH=1 (configurable via callTree.depth), MAX_CALL_NODES=40
     Filters: test files, infra files, generic CRUD methods
     Requires import edge exists (ci.resolved=1) between caller/callee files
  4. _buildFlatList: topologically ordered, deduplicated, contained-chunk removal
     Search hits first → call tree DFS with calledBy annotations
  5. Render: file header → label + annotations → full code block
     Trivial wrappers (≤2 meaningful lines) → compact one-liner
     compact=true for non-hit chunks → signature only
  6. _renderSymbolIndex (if symbols=true): all functions/classes from matched files
  7. _renderDependencySummary (if imports≠false): downstream + upstream file lists
```

**FileResolvablePlugin (`resolveFiles`):**

```
4-tier resolution per pattern:
  Tier 1: Exact file_path match
  Tier 2: Directory prefix (trailing /) → all files under path
  Tier 3: Glob pattern (picomatch) → filter all known paths
  Tier 4: Fuzzy basename match → LIKE '%/basename' fallback
```

### 7.2 @brainbank/git

**Files:** `packages/git/src/` — 7 source files, GIT_SCHEMA_VERSION = 1

**Capabilities implemented (7):**
`IndexablePlugin`, `VectorSearchPlugin`, `BM25SearchPlugin`,
`ContextFormatterPlugin`, `ReembeddablePlugin`, `CoEditPlugin`, `MigratablePlugin`

**Schema owned:**
`git_commits`, `commit_files`, `co_edits`, `git_vectors`, `fts_commits`

```
GitPlugin.initialize(ctx):
  shared = ctx.getOrCreateSharedHnsw('git', 500_000, embedding.dims)
  ← literal 'git' key → all git:* plugins share ONE HNSW
```

**Indexing pipeline (`GitIndexer.index`):**

```
Phase 1: _collectCommits() [async git calls per commit]
  skip if has_vector; zombie cleanup if data but no vector
  _parseCommit: git show --numstat + --unified=3
  text = "Commit: {msg}\nAuthor:\nDate:\nFiles:\nChanges:\n{diff[:2000]}"

Phase 2: embedding.embedBatch(all new texts) → vecs

Phase 3: _insertCommits() [one DB transaction]
  INSERT git_commits + commit_files + git_vectors

Phase 4: _updateHnsw() + _computeCoEdits()
  hnsw.add + vectorCache.set per commit
  co_edits UPSERT: file pairs from commits with 2–20 co-changes
```

### 7.3 @brainbank/docs

**Files:** `packages/docs/src/` — 7 source files, DOCS_SCHEMA_VERSION = 1

**Capabilities implemented (8):**
`IndexablePlugin`, `VectorSearchPlugin`, `BM25SearchPlugin`,
`ContextFormatterPlugin`, `SearchablePlugin`, `ReembeddablePlugin`,
`DocsPlugin`, `MigratablePlugin`

**Schema owned:**
`collections`, `doc_chunks`, `doc_vectors`, `path_contexts`, `fts_docs`

```
DocsPlugin.initialize(ctx):
  shared = await ctx.getOrCreateSharedHnsw('docs', undefined, embedding.dims)
  ← literal 'docs' key → all docs:* share ONE HNSW
  indexer = new DocsIndexer(db, embedding, hnsw, vecCache, ctx.createTracker())
  _search = new DocumentSearch({ db, embedding, hnsw, vecCache })
```

**Smart chunking (qmd-inspired):**

```
Target: ~3000 chars per chunk (~900 tokens)
Break scores: H1=100, H2=90, H3=80, code-fence-close=80, ---=60, blank=20
Distance decay: score × (1 - (dist/600)² × 0.7)
Minimum chunk: 200 chars (tiny → merge into previous)
```

**addCollection upsert:**

```sql
INSERT INTO collections (...) VALUES (...)
ON CONFLICT(name) DO UPDATE SET ...
```
> Uses true upsert (not INSERT OR REPLACE) to avoid triggering CASCADE deletes
> on `doc_chunks` that reference `collections(name)`.

---

## 8. MCP Server (Core)

**Files:** `src/mcp/` — 3 source files (migrated into core, no longer a separate package)

**1 MCP tool** via `@modelcontextprotocol/sdk`:

| Tool | Description |
|------|------------|
| `brainbank_context` | Workflow Trace: search + call tree + `called by` annotations |

> **Indexing is CLI-only.** The `brainbank_index` tool was removed to prevent AI agents from triggering re-indexing mid-conversation.

`brainbank_context` params:
- `task` (string, required), `repo` (string, required), `affectedFiles` (string[]),
  `codeResults` (number=20), `gitResults` (number=5), `docsResults` (number?),
  `sources` (Record?), `path` (string?), `ignore` (string[]?)
- BrainBankQL fields: `lines`, `symbols`, `compact`, `callTree`, `imports`, `expander`

**WorkspacePool** (`workspace-pool.ts`):

```
WorkspacePool(options: PoolOptions)
  _pool: Map<string, PoolEntry>
  _maxMemoryBytes  (BRAINBANK_MAX_MEMORY_MB, default 2048 MB)
  _ttlMs           (BRAINBANK_TTL_MINUTES, default 30 min)

  get(repoPath):
    if pool hit: ensureFresh() + return
    _evictByMemoryPressure()
    factory(repoPath) → brain.initialize()

  withBrain(repoPath, fn):
    entry.activeOps++ → fn(brain) → entry.activeOps-- (prevents eviction)

  _evictStale():  ← runs every 60s, evicts past TTL with zero activeOps
  _evictByMemoryPressure(): ← sorts by lastAccess, evicts oldest idle first
```

**WorkspaceFactory** — delegates to core `createBrain({ repoPath, env })`.
No hardcoded plugin imports. Silences console.log → stderr during init to
prevent ANSI output from corrupting MCP JSON-RPC stdio transport.

> The MCP server binary is `brainbank-mcp` (registered in `bin/` of the root package). Run via `npx brainbank-mcp` or configure as an MCP server in your IDE.

---

## 9. Collection — KV Store

**Files:** `src/services/collection.ts` (406 lines), `src/services/kv-service.ts` (66 lines)

All collections share **one kvHnsw** owned by `KVService`. Collection isolation
via `WHERE collection = ?` after adaptive over-fetch.

```
KVService(db, embedding, hnsw, vecs)
  collection(name) → cached or new Collection(...)
  listNames()      → SELECT DISTINCT collection FROM kv_data
  delete(name)     → hnsw.remove + vecs.delete per id; DELETE FROM kv_data
  hnsw / vecs      → getters for reembed access
```

**Collection search pipeline:**

```
search(query, { k=5, mode='hybrid', minScore=0.15, tags? })
  _pruneExpired()
  mode='keyword' → _searchBM25 → _filterByTags
  mode='vector'  → _searchVector → _filterByTags
  mode='hybrid':
    parallel: _searchVector + _searchBM25
    fuseRankedLists<T>([vec, bm25])  ← generic RRF (not SearchResult-typed)
    _filterByTags

_searchVector: adaptive over-fetch
  ratio = ceil(totalHnswSize / collectionCount), clamped [3, 50]
  searchK = k × ratio
```

---

## 10. Search Layer

### 10.1 SearchStrategy Interface

```typescript
interface SearchStrategy {
    search(query: string, options?: SearchOptions): Promise<SearchResult[]>
    rebuild?(): void
}
interface DomainVectorSearch {
    search(queryVec: Float32Array, k: number, minScore: number,
           useMMR?: boolean, mmrLambda?: number, queryText?: string): SearchResult[]
}
```

### 10.2 CompositeVectorSearch

**File:** `src/search/vector/composite-vector-search.ts` (77 lines)

Embeds the query **once**, delegates to registered `DomainVectorSearch` strategies.
Results sorted by score, capped to requested K, normalized 0–1.

```
search(query, options):
  queryVec = await embedding.embed(query)   ← ONE embed call
  for each [name, strategy] in strategies:
    baseName = name.split(':')[0]
    k = src[name] ?? src[baseName] ?? DEFAULT_K (6)
    if k > 0: hits = strategy.search(queryVec, k, minScore, useMMR, mmrLambda, query)
    multi-repo: prefix filePaths with sub-repo name

  sort by score, cap to requestedK, normalize globally
```

### 10.3 CompositeBM25Search

**File:** `src/search/keyword/composite-bm25-search.ts` (64 lines)

```
search(query, options):
  for each plugin in registry.all:
    if !isBM25SearchPlugin(plugin) → skip
    baseType = plugin.name.split(':')[0]
    k = sources[baseType] ?? DEFAULT_K (8)
    if k > 0: results.push(...plugin.searchBM25(query, k))
    multi-repo: prefix filePaths with sub-repo name
  sort by score DESC
```

### 10.4 Hybrid Search + RRF

```
SearchAPI.hybridSearch(query, options?)
         │
         ├── if CompositeVectorSearch:
         │     parallel: vectorSearch.search() + bm25?.search()
         │     lists.push(vecResults, kwResults)
         │
         ├── _collectSearchablePlugins():
         │     for SearchablePlugin BUT NOT VectorSearchPlugin:
         │       lists.push(hits)
         │
         ├── _collectKvCollections(query, sources):
         │     for [name, k] in sources where name ∉ plugin names:
         │       kvService.collection(name).searchAsResults(query, k)
         │
         └── reciprocalRankFusion(lists, k=60, maxResults=15)


reciprocalRankFusion(resultSets, k=60, maxResults=15):
  for each list, for rank i:
    key = resultKey(r)
    rrfScore += 1.0 / (k + rank + 1)
  sort by rrfScore DESC, normalize to 0..1

Result key generation:
  'code'       → "code:{filePath}:{startLine}-{endLine}"
  'commit'     → "commit:{hash or shortHash}"
  'document'   → "document:{filePath}:{collection}:{seq}:{content[:80]}"
  'collection' → "collection:{id or content[:80]}"
```

### 10.5 MMR — Diversity

**File:** `src/search/vector/mmr.ts` (65 lines)

```
searchMMR(index, query, vectorCache, k, lambda=0.7)
  candidates = index.search(query, k*3)
  greedy selection:
    mmrScore = lambda * relevance - (1 - lambda) * max_sim_to_selected
```

### 10.6 ContextBuilder

**File:** `src/search/context-builder.ts` (301 lines)
**Pattern:** Pipeline orchestrator

```
ContextBuilder(search?, registry, pruner?, embedding?, configFields, expander?)

build(task, options?):
  1. Primary: vector search (includes per-repo BM25 fusion internally)
  2. Path scoping: filterByPath(results, pathPrefix)
  3. Path exclusion: filterByIgnore(results, ignorePaths)
  4. LLM noise pruning (optional): pruneResults(task, results, pruner)
  5. Session dedup: filter excludeFiles
  6. LLM context expansion (optional — when expander field = true):
       _expand(task, results) → buildManifest + expander.expand() + resolveChunks
  7. Format output:
       _appendFormatterResults: ContextFormatterPlugin per base type
         Multi-repo: scope results to repo prefix per plugin
       _appendSearchableResults: non-formatter SearchablePlugins
  8. Append expander note (if any)

  Logs all queries via logQuery() to /tmp/brainbank.log
```

**Field resolution:**

```
_resolveFields(options):
  1. Collect plugin defaults (from ContextFieldPlugin.contextFields())
  2. Merge: defaults ← config.contextFields ← options.fields
```

### 10.7 Pruning

**Files:** `src/lib/prune.ts` (72 lines), `src/providers/pruners/haiku-pruner.ts` (113 lines)

Runs **after** path scoping + ignore filtering and **before** context formatting.

```
pruneResults(query, results, pruner):
  items = results.map(r → { id, filePath, preview: _buildPreview(content), metadata })
  keepIds = await pruner.prune(query, items)   ← Haiku API call
  return keepIds.filter(valid).map(id → results[id])

_buildPreview(content):
  if content.length <= 8K chars → return as-is
  else → top 60% + "[... N lines omitted ...]" + bottom 25%
```

**Fail-open:** If the API call fails, all results pass through unchanged.

### 10.8 Expansion

**Files:** `src/providers/pruners/haiku-expander.ts` (167 lines)

Runs **after** pruning, only when `expander` field is `true`.

```
ContextBuilder._expand(task, results):
  1. Detect multi-repo prefix from results
  2. Collect excludeFilePaths + excludeIds from current results
  3. For matching ExpandablePlugin:
       manifest = plugin.buildManifest(excludeFilePaths, excludeIds)
  4. expander.expand(task, excludeIds, manifest)
       → { ids: number[], note?: string }
  5. plugin.resolveChunks(ids) → additional SearchResults
  6. Splice into results, return note for display

HaikuExpander.expand(query, currentIds, manifest):
  Compact manifest: "#42 src/auth.ts | method login L10-L25"
  Haiku selects relevant chunk IDs + optional codebase observation
  ~$0.001 per call, ~300-600ms latency
  Fail-open: errors return empty array
```

### 10.9 DocumentSearch

**File:** `packages/docs/src/document-search.ts` (225 lines)

DocsPlugin's internal hybrid search engine (independent from CompositeVectorSearch):

```
search(query, { collection?, k=8, minScore=0, mode='hybrid' })
  mode='keyword' → _dedup(_searchBM25, k)
  mode='vector'  → _dedup(_searchVector, k)
  mode='hybrid':
    parallel: _searchVector(k*2) + _searchBM25(k*2)
    reciprocalRankFusion([vecHits, bm25Hits])
    _dedup(results, k)

_searchBM25: OR-mode FTS5, custom stop-word filter
  bm25(fts_docs, 10.0, 2.0, 5.0, 1.0)  ← title×10, content×2, path×5, collection×1
_dedup: keep best-scoring per filePath
```

---

## 11. Infrastructure

### 11.1 Database Adapter

**Files:** `src/db/adapter.ts` (113 lines), `src/db/sqlite-adapter.ts` (209 lines)

```
DatabaseAdapter (interface):
  prepare<T>(sql) → PreparedStatement<T>    { get, all, run, iterate }
  exec(sql)
  transaction<T>(fn: () => T): T
  batch<T>(sql, rows: T[])
  close()
  capabilities: AdapterCapabilities  ← { fts: 'fts5', upsert: 'or-replace', json: true, vectors: false }
  raw<T>(): T | undefined            ← deprecated escape hatch

SQLiteAdapter:
  constructor(dbPath):
    mkdirSync(dirname, { recursive: true })
    new BetterSqlite3(dbPath)
    PRAGMA journal_mode = WAL
    PRAGMA busy_timeout = 5000
    PRAGMA synchronous = NORMAL
    PRAGMA foreign_keys = ON
    createSchema(this)   ← core-only tables (SCHEMA_VERSION = 9)
```

### 11.2 HNSWIndex

**File:** `src/providers/vector/hnsw-index.ts` (175 lines)

```
HNSWIndex(dims, maxElements=2_000_000, M=16, efConstruction=200, efSearch=50)
  init()       → dynamic import 'hnswlib-node', initIndex, setEf
  add(vec, id) → idempotent (skip duplicates), throws if full
  remove(id)   → markDelete (soft delete, safe for nonexistent)
  search(q, k) → [{ id, score: 1 - cosine_distance }]
  save(path) / tryLoad(path, expectedCount): boolean
  reinit()     → fresh empty index, same params
  size / maxElements
```

### 11.3 HNSW Loader

**File:** `src/providers/vector/hnsw-loader.ts` (130 lines)

```
hnswPath(dbPath, name) → join(dirname(dbPath), 'hnsw-{name}.index')
lockDir(dbPath)        → dirname(dbPath)
saveAllHnsw()          → wraps in withLock(lockDir, 'hnsw', ...)
reloadHnsw(deps)       → reinit + clear cache + tryLoad or loadVectors
loadVectors()          → iterate rows → Float32Array → hnsw.add + cache.set
loadVecCache()         → same but skips hnsw.add (graph loaded from file)
countRows()            → SELECT COUNT(*) for staleness check
```

### 11.4 Embedding Providers

All implement `EmbeddingProvider`: `{ dims, embed(text), embedBatch(texts), close() }`

```
LocalEmbedding (384d)
  Xenova/all-MiniLM-L6-v2, quantized WASM, ~23MB, BATCH_SIZE=32

OpenAIEmbedding (1536d / 3072d)
  text-embedding-3-small/large, ada-002, MAX_BATCH=100
  Token-limit retry: truncate to 8k → 6k chars

PerplexityEmbedding (2560d / 1024d)
  pplx-embed-v1-4b/0.6b, base64 int8 decoding to Float32Array

PerplexityContextEmbedding (2560d / 1024d)
  pplx-embed-context-v1-4b/0.6b
  Input: string[][] (docs × chunks), splitIntoDocuments at 80k chars/doc

resolveEmbedding(key): lazy-loads provider class by key string
providerKey(p): constructor.name → canonical key ('local'|'openai'|'perplexity'|'perplexity-context')

EmbeddingWorkerProxy: offloads to worker_threads, zero-copy ArrayBuffer transfer
```

---

## 12. Services

### 12.1 Watch Service

**File:** `src/services/watch.ts` (349 lines)
**Pattern:** Plugin-driven watching with shared fs.watch fallback

```
Watcher(reindexFn, plugins, options, repoPath?)

_startWatching():
  FOR each WatchablePlugin:
    handle = plugin.watch(onEvent)     ← plugin controls HOW

  FOR IndexablePlugins WITHOUT watch():
    collect for shared fs.watch fallback

  _startSharedFsWatch(fallbackPlugins, repoPath):
    ONE recursive fs.watch tree for all fallback plugins
    Pre-compute routing info per plugin: baseName, subRepo prefix
    macOS dedup: Map<path, timestamp>, DEDUP_MS=100

    Fan-out per event:
      if subRepo && !relPath.startsWith(subRepo + '/') → skip
      if baseName === 'docs' && !DOC_EXTENSIONS.has(ext) → skip
      if baseName !== 'docs' && !isSupported(fullPath) → skip
      → _onEvent(plugin, event)

_onEvent(plugin, event):
  resolve debounce: plugin.watchConfig()?.debounceMs > global > 2000ms
  check batchSize from watchConfig
  debounce or immediate → _flush(batch)

_flush(batch):
  if plugin.indexItems → indexItems([ids])   ← granular
  else if plugin.index → index()             ← full
  else → reindexFn()                         ← global fallback
  onIndex?.(id, pluginName) for each event
```

### 12.1.1 WebhookServer

**File:** `src/services/webhook-server.ts` (101 lines)

Optional shared HTTP server for push-based watch plugins.
Opt-in via `new BrainBank({ webhookPort: 4242 })`.

```
WebhookServer
  listen(port)
  register(pluginName, path, handler)  ← POST-only routing
  unregister(pluginName)
  close()
```

### 12.2 Reembed Engine

**File:** `src/engine/reembed.ts` (207 lines)
**Pattern:** Atomic Swap via temp table

```
reembedAll(db, embedding, hnswMap, plugins, options?, persist?)

  collectTables(plugins):
    for each isReembeddable plugin: plugin.reembedConfig()
    + CORE_TABLES: 'kv' → kv_data/kv_vectors
    deduplicates by vectorTable (multi-repo share same table)

  for each table:
    PHASE 1: CREATE temp → embedBatch(batchSize=50) → INSERT temp
    PHASE 2: TRANSACTION { DELETE old + INSERT FROM temp }
    FINALLY: DROP temp

    rebuildHnsw: reinit() → load from new BLOBs

  setEmbeddingMeta + saveAllHnsw
```

### 12.3 EmbeddingMeta & Index State

**File:** `src/db/metadata.ts` (131 lines)

```
── Embedding Meta ──
embedding_meta (key/value): 'provider', 'dims', 'provider_key', 'indexed_at'
setEmbeddingMeta(db, embedding): UPSERT all four
getEmbeddingMeta(db): EmbeddingMeta | null
detectProviderMismatch(db, embedding): { mismatch, stored, current }

── Index State ──
index_state: name TEXT PK, version INTEGER, writer_pid INTEGER, updated_at INTEGER
bumpVersion(db, name): UPSERT → version + 1, RETURNING version
getVersions(db): Map<string, number>
getVersion(db, name): number (0 if not found)
```

### 12.4 HTTP Daemon

**Files:** `src/services/daemon.ts` (88 lines), `src/services/http-server.ts` (289 lines)

PID file at `~/.cache/brainbank/server.pid` (JSON: `{ pid, port }`).

```
HttpServer(options: HttpServerOptions)
  _pool: SimplePool (30min TTL, 5min eviction interval)
  Routes:
    POST /context  → brain.getContext()
    POST /index    → brain.index()
    GET  /health   → { ok, pid, uptime, port, workspaces }

CLI delegation (src/cli/server-client.ts):
  tryServerContext() → tries running daemon before local fallback
  tryServerIndex()
  serverHealth()
```

### 12.5 Query Logger

**File:** `src/lib/logger.ts` (126 lines)

```
logQuery(entry: QueryLogEntry): void
  Appends to /tmp/brainbank.log
  Covers: getContext, search, hybridSearch, searchBM25
  Includes: source, method, query, embedding, pruner,
            options, results, pruned items, durationMs
  Auto-truncates at 10MB (keeps newest half)
```

---

## 13. Engine Layer

### 13.1 IndexAPI

**File:** `src/engine/index-api.ts` (86 lines)

```
runIndex(deps: IndexDeps, options):
  want = Set(options.modules) or null (all)

  for mod in registry.all:
    baseType = mod.name.split(':')[0]
    if want && !want.has(baseType) → skip
    if !isIndexable(mod) → skip
    r = await mod.index({ forceReindex, onProgress, ...pluginOptions })
    results[baseType] = mergeResult(accumulator, r)  ← sums across multi-repo
    bumpVersion(db, mod.name)  ← full plugin name, matches HNSW key

  saveAllHnsw(dbPath, kvHnsw, sharedHnsw, new Map())
  emit('indexed', results)
```

> **Key:** `bumpVersion` uses `mod.name` (e.g. `code:backend`), NOT `baseType`
> (`code`). This ensures the version key matches the HNSW storage key, so
> `ensureFresh()` correctly detects and reloads stale indices per plugin.

### 13.2 SearchAPI

**File:** `src/engine/search-api.ts` (223 lines)

```
createSearchAPI(db, embedding, config, registry, kvService, sharedHnsw):
  strategies = Map<string, DomainVectorSearch>
  for mod in registry.all:
    if isVectorSearchPlugin(mod):
      vs = mod.createVectorSearch()
      strategies.set(mod.name, vs)  ← full name (e.g. 'code:backend')

  search = strategies.size > 0
    ? new CompositeVectorSearch({ strategies, embedding })
    : undefined

  bm25 = new CompositeBM25Search(registry)
  contextBuilder = new ContextBuilder(search, registry, config.pruner,
    embedding, config.contextFields, config.expander)

  return new SearchAPI({ search, bm25, registry, config, kvService, contextBuilder, embedding })
```

All search methods log via `logQuery()` with timing, results, and provider info.

---

## 14. CLI Layer

### 14.1 CLI Factory — createBrain()

```
createBrain(contextOrRepo?)  [src/cli/factory/index.ts]
  ctx: BrainContext = contextOrRepo ?? contextFromCLI()
  config = loadConfig(rp)
  folderPlugins = discoverFolderPlugins(rp)
  brainOpts = { repoPath, ...config?.brainbank }
  setupProviders(brainOpts, config, flags, env)  ← embedding + pruner + expander
  builtins = config?.plugins ?? ['code', 'git', 'docs']
  ignorePatterns from ctxFlag('ignore')
  includePatterns from ctxFlag('include')

  registerBuiltins(brain, rp, builtins, config, ignorePatterns, includePatterns):
    hasRootGit = fs.existsSync(path.join(rp, '.git'))
    gitSubdirs = !hasRootGit ? detectGitSubdirs(rp, configRepos) : []

    for each pluginName:
      factory = await loadPlugin(name)  ← dynamic import @brainbank/{name}
      if !factory → warn + skip

      if gitSubdirs.length > 0 && isMultiRepoCapable(name):
        for each subdir:
          brain.use(factory({ ...cfg, repoPath: sub.path, name: `${name}:${sub.name}` }))
      else:
        brain.use(factory({ ...cfg, repoPath: rp }))

  for plugin in folderPlugins: brain.use(plugin)
  for plugin in config?.indexers: brain.use(plugin)
  return brain   ← NOT initialized
```

**BrainContext** — portable factory input:

```typescript
interface BrainContext {
  repoPath: string;
  flags?: Record<string, string | undefined>;
  env?: Record<string, string | undefined>;
}
```

### 14.2 Commands

| Command | Handler | Notes |
|---------|---------|-------|
| `index [path]` | `cmdIndex` | Interactive: scanRepo → checkbox → index |
| `collection add/list/remove` | `cmdCollection` | Manage doc collections via DocsPlugin |
| `kv add/search/list/trim/clear` | `cmdKv` | KV store CRUD |
| `docs [--collection]` | `cmdDocs` | Index doc collections |
| `dsearch <query>` | `cmdDocSearch` | Docs-only search |
| `search <query>` | `cmdSearch` | Vector search |
| `hsearch <query>` | `cmdHybridSearch` | Hybrid (best quality) |
| `ksearch <query>` | `cmdKeywordSearch` | BM25 keyword |
| `context <task>` | `cmdContext` | Formatted LLM context (with BrainBankQL field flags) |
| `files <path\|glob>` | `cmdFiles` | Direct file viewer (no search) |
| `stats` | `cmdStats` | Index statistics |
| `reembed` | `cmdReembed` | Re-generate all vectors |
| `watch` | `cmdWatch` | Plugin-driven auto-reindex |
| `mcp` | `cmdMcp` | MCP server (built into core) |
| `daemon [start\|stop\|restart]` | `cmdDaemon` | HTTP daemon (foreground or background) |
| `status` | `cmdStatus` | Daemon status |

---

## 15. SQLite Schema

### Core Schema (`SCHEMA_VERSION = 9`)

Core creates ONLY infrastructure tables. Domain tables are plugin-owned.

```
━━━ CORE: KV COLLECTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

kv_data
  id INTEGER PRIMARY KEY AUTOINCREMENT
  collection TEXT   ← idx_kv_collection
  content TEXT
  meta_json TEXT DEFAULT '{}'
  tags_json TEXT DEFAULT '[]'
  expires_at INTEGER NULL
  created_at INTEGER   ← idx_kv_created DESC

kv_vectors
  data_id INTEGER PRIMARY KEY REFERENCES kv_data(id) ON DELETE CASCADE
  embedding BLOB

fts_kv (FTS5, content='kv_data', content_rowid='id')
  columns: content, collection
  triggers: trg_fts_kv_insert, trg_fts_kv_delete


━━━ CORE: METADATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

embedding_meta         key TEXT PRIMARY KEY, value TEXT
schema_version         version INTEGER PRIMARY KEY, applied_at INTEGER
plugin_versions        plugin_name TEXT PRIMARY KEY, version INTEGER, applied_at INTEGER

━━━ CORE: MULTI-PROCESS COORDINATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

index_state
  name TEXT PRIMARY KEY          ← 'code:backend', 'git', 'docs', 'kv'
  version INTEGER DEFAULT 0      ← monotonic, bumped after indexing
  writer_pid INTEGER
  updated_at INTEGER

━━━ CORE: INCREMENTAL TRACKING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

plugin_tracking
  plugin TEXT NOT NULL            ← plugin name
  key TEXT NOT NULL               ← file path or composite key
  content_hash TEXT NOT NULL
  indexed_at INTEGER
  PRIMARY KEY (plugin, key)
```

### Plugin Schemas

```
━━━ @brainbank/code (CODE_SCHEMA_VERSION = 5) ━━━━━━━━━━━━━━━━━━━━━━━━

code_chunks          id, file_path, chunk_type, name, start_line, end_line,
                     content, language, file_hash, indexed_at
code_vectors         chunk_id PK → code_chunks(id) CASCADE, embedding BLOB
indexed_files        file_path PK, file_hash, indexed_at
code_imports         file_path + imports_path PK, import_kind, resolved
code_symbols         id, file_path, name, kind, line, chunk_id → code_chunks
code_refs            chunk_id → code_chunks CASCADE, symbol_name
code_call_edges      caller_chunk_id + callee_chunk_id + symbol_name PK
fts_code             (file_path, name, content) content='code_chunks'

━━━ @brainbank/git (GIT_SCHEMA_VERSION = 1) ━━━━━━━━━━━━━━━━━━━━━━━━━━

git_commits          id, hash UNIQUE, short_hash, message, author, date,
                     timestamp, files_json, diff, additions, deletions, is_merge
commit_files         commit_id → git_commits, file_path
co_edits             file_a + file_b PK, count
git_vectors          commit_id PK → git_commits CASCADE, embedding BLOB
fts_commits          (message, author, diff) content='git_commits'

━━━ @brainbank/docs (DOCS_SCHEMA_VERSION = 1) ━━━━━━━━━━━━━━━━━━━━━━━━

collections          name PK, path, pattern, ignore_json, context, created_at
doc_chunks           id, collection → collections CASCADE, file_path, title,
                     content, seq, pos, content_hash, indexed_at
doc_vectors          chunk_id PK → doc_chunks CASCADE, embedding BLOB
path_contexts        collection + path PK, context
fts_docs             (title, content, file_path, collection) content='doc_chunks'
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
    ┌────▼──────────────────────────────────────────────┐
    │  1. new SQLiteAdapter(config.dbPath)               │
    │  2. resolveEmbedding → openai (explicit)           │
    │  3. detectProviderMismatch                         │
    │  4. KVService ready (kvHnsw + vecs)                │
    │  5. Load KV vectors                                │
    └───────────────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────────────────┐
    │  6. Plugin initialization                          │
    │                                                    │
    │  CodePlugin.initialize(ctx):                       │
    │    pluginDb = root DB (no ':' in name)             │
    │    runPluginMigrations → code_* tables             │
    │    getOrCreateSharedHnsw(this.name='code')         │
    │    _loadChunkVectors()                             │
    │                                                    │
    │  GitPlugin.initialize(ctx):                        │
    │    runPluginMigrations → git_* tables              │
    │    getOrCreateSharedHnsw('git')                    │
    │    loadVectors('git_vectors', 'commit_id', ...)    │
    │                                                    │
    │  DocsPlugin.initialize(ctx):                       │
    │    runPluginMigrations → doc_* tables              │
    │    getOrCreateSharedHnsw('docs')                   │
    │    loadVectors('doc_vectors', 'chunk_id', ...)     │
    └───────────────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────────────────┐
    │  7. WebhookServer (if configured)                  │
    │  8. saveAllHnsw() → write .index files             │
    │  9. createSearchAPI() → discover VectorSearchPlugin│
    │  10. snapshot _loadedVersions                      │
    │     _initialized = true                            │
    └───────────────────────────────────────────────────┘
```


### 16.3 Hybrid Search Flow

```
brain.hybridSearch("auth middleware", { sources: { code: 10, git: 5 } })
         │
    ┌────┴──────────────────────────────────────────────────┐
    │                  parallel                              │
    ├──────────────────────┬───────────────────────────────┤
    ▼                      ▼                               ▼
VectorSearch           BM25Search                   SearchablePlugins
(Composite)            (Composite)                  (non-VectorSearch)
embed once →           discovers
HNSW per strategy      BM25SearchPlugin
code:fe, code:be,      per plugin
git, docs              [kwResults]                  [pluginResults]
[vecResults]
    │                   │                             │
    └───────────────────┴─────────────────────────────┘
                        │
          + KV collection lists (from sources)
                        │
          reciprocalRankFusion(all lists, k=60, maxResults=15)
                        │
          [sorted SearchResult[]]
```

### 16.4 Context Building Flow

```
brain.getContext("add rate limiting to the auth API", { fields: { expander: true } })
  │
  ContextBuilder.build(task):
    1. vectorResults = CompositeVectorSearch.search(task)
    2. filterByPath(results, pathPrefix)
    3. filterByIgnore(results, ignorePaths)
    4. if pruner: pruneResults(task, results, pruner)
    5. if excludeFiles: filter session dedup
    6. if expander field=true && _expander:
         buildManifest → expander.expand() → resolveChunks()
         splice expanded results + capture note

    7. _appendFormatterResults (per plugin, multi-repo scoped):
         CodePlugin.formatContext():
           expand adjacent parts → build call tree → flat workflow trace
         GitPlugin.formatContext():
           commit history + diff snippets + co-edit suggestions
         DocsPlugin.formatContext():
           document results grouped by collection + title

    8. _appendSearchableResults:
         SearchablePlugins (not ContextFormatters): generic bullet list

    9. Append expander note (if any)

    → markdown for LLM system prompt
```

### 16.5 Reembed Flow

```
brain.reembed()
  │
  collectTables:
    isReembeddable plugins (code, git, docs) + core KV
    dedup by vectorTable
  for each table:
    CREATE temp → embedBatch(50) → INSERT temp
    TRANSACTION: DELETE old + INSERT FROM temp  ← atomic swap
    DROP temp
    rebuildHnsw: reinit() + load from new BLOBs
  setEmbeddingMeta + saveAllHnsw
```

---

## 17. Design Patterns Reference

| # | Pattern | Where used | What it does |
|---|---------|-----------|-------------|
| 1 | **Facade** | `BrainBank` | Single entry point hiding all subsystems |
| 2 | **Capability Interface** | `VectorSearchPlugin`, `BM25SearchPlugin`, etc. | Plugins declare capabilities; core discovers at runtime |
| 3 | **Strategy** | `SearchStrategy`, `DomainVectorSearch`, `EmbeddingProvider` | Interchangeable backends |
| 4 | **Registry + Prefix Matching** | `PluginRegistry` | `has('code')` matches `code`, `code:frontend` |
| 5 | **Linear Construction** | `_runInitialize()` | 10-step sequential init |
| 6 | **Factory Method** | `code()`, `git()`, `docs()`, `createBrain()` | Hide instantiation complexity |
| 7 | **Dependency Injection** | `PluginContext` | Plugins receive all deps through one context object |
| 8 | **Repository** | `Collection`, `DocsIndexer` | Encapsulate read/write per domain |
| 9 | **Observer / EventEmitter** | `BrainBank extends EventEmitter` | `initialized`, `indexed`, `reembedded`, `progress` |
| 10 | **Flyweight** | `_sharedHnsw` pool | git:frontend + git:backend share ONE HNSW |
| 11 | **Builder** | `ContextBuilder` | Incrementally assembles markdown from plugin formatters |
| 12 | **Composite** | `CompositeVectorSearch`, `CompositeBM25Search` | Embed once, delegate to domain strategies |
| 13 | **Lazy Singleton + Promise Dedup** | `LocalEmbedding` | Expensive resources loaded on first use |
| 14 | **Memento / Persistence** | `HNSWIndex.save()` / `tryLoad()` | Graph persisted with staleness check |
| 15 | **Adapter** | Embedding providers | OpenAI `number[]`, Perplexity base64 int8 → `Float32Array` |
| 16 | **Guard / Precondition** | `_requireInit()` | Descriptive errors before null-pointer crashes |
| 17 | **Template Method** | `plugin.initialize(ctx)` | BrainBank controls sequence; plugins fill in logic |
| 18 | **Atomic Swap** | `reembedTable()` | Temp table → TRANSACTION DELETE+INSERT |
| 19 | **Incremental Processing** | `CodeWalker`, `DocsIndexer`, `GitIndexer` | Content-hash skip |
| 20 | **Discriminated Union** | `SearchResult` | `isCodeResult()`, `matchResult()` |
| 21 | **Pipeline** | Hybrid search → RRF → prune → expand → format | Composable stages |
| 22 | **Memory-Aware Pool** | `WorkspacePool` | Memory-pressure + TTL eviction |
| 23 | **Plugin Migrations** | `runPluginMigrations()` | Per-plugin versioned schema |
| 24 | **Per-Repo DB Isolation** | `_getOrCreatePluginDb()` | Namespaced plugins get separate SQLite files |
| 25 | **Fan-Out Routing** | `Watcher._startSharedFsWatch()` | One fs.watch tree → multiple plugins |
| 26 | **Field Resolution** | `ContextBuilder._resolveFields()` | Plugin defaults ← config ← per-query |

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
          └──────┬────────┘   │   │  CodePlugin (per-repo HNSW + DB)     │
                 │            │   │    ├── CodeWalker (tree-sitter AST)   │
                 │            │   │    ├── CodeVectorSearch (dual-level)  │
                 │            │   │    ├── context-formatter (V4 trace)   │
                 │            │   │    ├── SqlCodeGraphProvider           │
                 │            │   │    ├── ExpandablePlugin (manifest)    │
                 │            │   │    ├── FileResolvablePlugin           │
                 │            │   │    └── code-schema (5 migrations)     │
                 │            │   │                                      │
                 │            │   │  GitPlugin (shared 'git' HNSW)       │
                 │            │   │    ├── GitIndexer (simple-git)        │
                 │            │   │    ├── GitVectorSearch                │
                 │            │   │    ├── git-context-formatter          │
                 │            │   │    └── CoEditAnalyzer                 │
                 │            │   │                                      │
                 │            │   │  DocsPlugin (shared 'docs' HNSW)     │
                 │            │   │    ├── DocsIndexer (smart chunker)    │
                 │            │   │    ├── DocumentSearch (own hybrid)    │
                 │            │   │    └── DocsVectorSearch               │
                 │            │   └──────────────────────────────────────┘
                 │            │
          ┌──────▼────────────▼──────────────────────────────────────────┐
          │                     Search Layer                             │
          │  CompositeVectorSearch (score-based merge if multi-repo)     │
          │  CompositeBM25Search (per-plugin keyword search)             │
          │  ContextBuilder (orchestrator + field resolution + expander) │
          │  reciprocalRankFusion + fuseRankedLists<T>                   │
          │  pruneResults (LLM noise filter)                             │
          │  searchMMR (diversity)                                       │
          └──────────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────────────┐
     │                       Infrastructure                             │
     │  DatabaseAdapter ── SQLiteAdapter (better-sqlite3)               │
     │  Per-repo DBs ── _repoDBs Map for namespaced plugins            │
     │  Migrations ── runPluginMigrations() per plugin                  │
     │  IncrementalTracker ── plugin_tracking table                     │
     │                                                                  │
     │  HNSWIndex ── hnswlib-node                                       │
     │    ├── KVService._hnsw (all KV collections share one)            │
     │    ├── _sharedHnsw['code:frontend'] (per-repo for code)          │
     │    ├── _sharedHnsw['code:backend']  (per-repo for code)          │
     │    ├── _sharedHnsw['git'] (all git:* share one)                  │
     │    └── _sharedHnsw['docs'] (all docs:* share one)                │
     │                                                                  │
     │  EmbeddingProviders: Local, OpenAI, Perplexity, PerplexityContext│
     │  HaikuPruner ── Anthropic Haiku 4.5 (optional)                   │
     │  HaikuExpander ── Anthropic Haiku 4.5 (optional)                 │
     └──────────────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────────────┐
     │                       Services                                   │
     │  KVService → Collection (kvHnsw shared + fts_kv + kv_data)       │
     │  reembedAll (atomic swap, per-table)                             │
     │  Watcher (plugin-driven + shared fs.watch fallback + debounce)   │
     │  WebhookServer (optional HTTP for push-based plugins)            │
     │  HttpServer + SimplePool (daemon mode for CLI delegation)        │
     │  EmbeddingMeta (provider tracking + mismatch detection)          │
     │  Logger (structured query log to /tmp/brainbank.log)             │
     └──────────────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────────────┐
     │                         CLI                                      │
     │  createBrain(): loadConfig + discoverFolderPlugins +             │
     │    setupProviders + registerBuiltins (multi-repo detection)      │
     │  BrainContext: portable factory input (flags, env, repoPath)     │
     │  scan.ts: scanRepo() → ScanResult (no BrainBank init)           │
     │  server-client.ts: daemon delegation (context, index, health)    │
     │  Commands: index, search, context, files, kv, collection, etc.   │
     └──────────────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────────────┐
     │                     MCP Server (core)                          │
     │  WorkspacePool: memory-pressure + TTL eviction, active-op guard │
     │  1 tool: context (Workflow Trace)                              │
     │  WorkspaceFactory → createBrain() (no hardcoded plugins)        │
     └──────────────────────────────────────────────────────────────────┘
```

---

## 19. Testing Strategy

### Test Infrastructure

- **Custom runner:** `test/run.ts` — discovers `test/{unit,integration}/` + `packages/*/test/{unit,integration}/`
- Tests export `{ name, tests }` — plain objects with assert functions
- **Hash-based embedding** (`hashEmbedding()`) — deterministic, unique per text, normalized
- **`createDomainSchema()`** — creates plugin domain tables in test DBs without loading plugins

### Package Tests

| Package | Test | Coverage |
|---------|------|----------|
| `@brainbank/code` | `code.test.ts` | Index TS+Python → HNSW → incremental skip → ignore patterns → include whitelist |
| `@brainbank/code` | `chunker.test.ts` (unit + integration) | AST: TS/JS/Python, content integrity, fallback, benchmarks |
| `@brainbank/code` | `code-graph.test.ts` | code_imports, code_symbols, code_refs + cascade delete |
| `@brainbank/code` | `import-extractor.test.ts` | Regex per 19 languages |
| `@brainbank/code` | `symbol-extractor.test.ts` | AST symbol defs + call refs + builtin filtering |
| `@brainbank/code` | `context-fields.test.ts` | BrainBankQL fields: lines, callTree, imports, symbols, compact |
| `@brainbank/code` | `chunk-density.test.ts` | Density threshold scoring for false positive filtering |
| `@brainbank/git` | `git.test.ts` | Real git repo → commits → co-edits → fileHistory |
| `@brainbank/docs` | `docs.test.ts` | Smart chunking → register → index → search → context |

### Core Tests

| Area | Tests |
|------|-------|
| BrainBank orchestrator | init, .use(), collections, modules filter, per-plugin embedding |
| Collections | add, search (all modes), tags, TTL, batch, trim, clear |
| Schema | core tables, domain tables, idempotency, transactions |
| Config | defaults, overrides, embedding passthrough |
| Hot-reload | ensureFresh, version detection, implicit in search methods |
| Index state | bumpVersion, getVersions, scoping, monotonicity |
| Reembed | KV vectors, preserve FTS, dimension mismatch, clean HNSW |
| Watch | WatchablePlugin, debounce, indexItems, error isolation |
| Write lock | acquire/release, withLock, stale PID stealing, serialization |
| Multi-process | shared DB, version tracking, file locking, KV hot-reload |
| Retrieval quality | Synthetic corpus, golden queries, recall@5, MRR thresholds |
| Embeddings | OpenAI mock, Perplexity int8 decode, batch, timeout |
| RRF | fusion correctness, dedup, maxResults, rank boosting |
| HNSW | init, add/search, remove, reinit, save/tryLoad |
| MMR | diversity selection, lambda=1.0 matches regular, k>candidates |
| Tracker | isUnchanged, markIndexed, findOrphans, plugin isolation |

---

## 20. Concurrency & WAL Strategy

### SQLite WAL Model

```
PRAGMA journal_mode = WAL
PRAGMA busy_timeout = 5000
PRAGMA synchronous = NORMAL
PRAGMA foreign_keys = ON
```

| Aspect | Behavior |
|--------|----------|
| **Readers** | Unlimited concurrent, never blocked |
| **Writers** | Single-writer serialized by WAL |
| **busy_timeout** | Wait up to 5s for write lock |

### Multi-Process Coordination

#### 1. SQLite Versioning (`index_state`)

```
┌──────────┐  bumpVersion('code:backend')  ┌─────────────────────┐
│ Process A │ ────────────────────────────► │ index_state          │
│ (indexer) │                              │ code:backend: v=3    │
└──────────┘                              └──────┬──────────────┘
                                                  │ getVersions()
┌──────────┐  stale! v_loaded=2 < v_db=3          │
│ Process B │ ◄──────────────────────────────────┘
│ (MCP srv) │ → reloadHnsw('code:backend')
└──────────┘
```

Cost: `getVersions()` is ~5μs (one SELECT). Called before every search.

#### 2. Advisory File Lock (`write-lock.ts`)

```
acquireLock(dir, name): O_CREAT | O_EXCL → retry with exponential backoff
releaseLock(dir, name): unlink
withLock(dir, name, fn): acquire → fn() → release (guaranteed via finally)
Stale detection: process.kill(pid, 0) → steal if dead
Max wait: 30 seconds
```

#### 3. Hot-Reload (`ensureFresh()`)

Called implicitly before `search()`, `hybridSearch()`, `searchBM25()`, `getContext()`.
Compares `_loadedVersions` against `getVersions(db)`. For each stale index:

- KV → always `kv_vectors` / `data_id`
- Shared HNSW → discovers `vectorTable` + `idCol` from `ReembeddablePlugin.reembedConfig()`
- Calls `reloadHnsw()` → reinit + tryLoad or loadVectors

#### 4. Per-Repo Database Isolation

Namespaced plugins get separate SQLite files:
- `code:frontend` → `.brainbank/data/frontend.db`
- `code:backend` → `.brainbank/data/backend.db`

Each per-repo DB has its own WAL, so concurrent indexing of different repos doesn't contend.
The root DB still holds KV data, `embedding_meta`, and `index_state`.

#### 5. MCP Pool Invalidation

`WorkspacePool` calls `brain.ensureFresh()` on every pool hit.
Memory pressure: `brain.memoryHint()` counts all HNSW indices (KV + shared).
Active ops tracked: pool never evicts during in-flight queries.

#### 6. Worker Thread Embedding

`EmbeddingWorkerProxy` offloads to `worker_threads.Worker`.
Vectors transferred via `Transferable` `ArrayBuffer` for zero-copy.

#### 7. HTTP Daemon

`HttpServer` with `SimplePool` manages per-repo BrainBank instances.
CLI commands check `isServerRunning()` (PID file) before cold-loading.
Daemon supports foreground + background (`fork` + `detached`) modes.

### Known Limitations

1. Long indexing holds SQLite write lock during transaction
2. No WAL checkpoint control (SQLite auto-checkpoints at 1000 pages)
3. HNSW graphs are in-memory; large repos with many chunks use significant RAM during indexing and search

