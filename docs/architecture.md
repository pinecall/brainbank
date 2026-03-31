## Table of Contents

1. [What is BrainBank](#1-what-is-brainbank)
2. [Repository Structure](#2-repository-structure)
3. [BrainBank — Main Facade](#3-brainbank--main-facade)
4. [Two-Phase Initialization](#4-two-phase-initialization)
5. [Plugin Registry](#5-plugin-registry)
6. [Plugin System & Plugin Context](#6-plugin-system--plugin-context)
7. [Built-in Plugins](#7-built-in-plugins)
   - 7.1 [@brainbank/code](#71-brainbankcode)
   - 7.2 [@brainbank/git](#72-brainbankgit)
   - 7.3 [@brainbank/docs](#73-brainbankdocs)
8. [@brainbank/memory Package](#8-brainbankmemory-package)
9. [@brainbank/mcp Package](#9-brainbankmcp-package)
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
(`@brainbank/code`, `@brainbank/git`, `@brainbank/docs`, `@brainbank/memory`,
`@brainbank/mcp`) implement domain-specific indexing and are loaded via `.use()`.

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
│  ┌───────────┐  ┌────────────┐  ┌──────────────┐  ┌─────────────┐   │
│  │ IndexAPI  │  │ SearchAPI  │  │ PluginRegistry│  │ Initializer │   │
│  └─────┬─────┘  └─────┬──────┘  └──────┬────────┘  └──────┬──────┘  │
└────────┼──────────────┼────────────────┼────────────────── ┼─────────┘
         │              │                │                    │
         ▼              ▼                ▼                    ▼
   ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────────────┐
   │ Plugins  │  │  SearchLayer │  │ Plugin   │  │  Database        │
   │ code/git/│  │  Composite   │  │ instances│  │  HNSWIndex       │
   │ docs/mem │  │  Keyword     │  │          │  │  EmbeddingProvider│
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
│   ├── bootstrap/
│   │   └── initializer.ts             ← Two-phase startup: earlyInit() / lateInit()
│   │                                     Builds PluginContext, calls plugin.initialize()
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
    ├── mcp/                           ← @brainbank/mcp
    │   └── src/
    │       └── mcp-server.ts          ← MCP stdio server (6 tools, LRU pool of 10 workspaces)
    │
    └── memory/                        ← @brainbank/memory
        └── src/
            ├── index.ts
            ├── memory.ts              ← Memory: LLM-powered fact extraction + dedup pipeline
            ├── entities.ts            ← EntityStore: entity/relationship knowledge graph
            ├── llm.ts                 ← LLMProvider interface + OpenAIProvider
            ├── prompts.ts             ← EXTRACT_PROMPT, EXTRACT_WITH_ENTITIES_PROMPT, DEDUP_PROMPT
            ├── patterns-plugin.ts     ← PatternsPlugin factory: patterns() / memory()
            ├── pattern-store.ts       ← PatternStore: LearningPattern CRUD + HNSW search
            ├── consolidator.ts        ← Consolidator: prune old failures + dedup near-duplicates
            └── pattern-distiller.ts   ← PatternDistiller: aggregate patterns → strategy text
```

**Package dependency graph:**

```
@brainbank/code    ── peerDep ──► brainbank (core)
@brainbank/git     ── peerDep ──► brainbank (core)
@brainbank/docs    ── peerDep ──► brainbank (core)
@brainbank/mcp     ── peerDep ──► brainbank + @brainbank/code + @brainbank/git + @brainbank/docs
@brainbank/memory  ── (none)  ──  uses Collection interface from brainbank at runtime
```

> **Schema ownership:** Core owns ALL table schemas. Plugins only populate them.
> Plugins never define DDL — they only call `ctx.db.prepare(...)` against tables
> that `createSchema()` already created.

---

## 3. BrainBank — Main Facade

**Pattern: Facade + EventEmitter**

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
│  .initialize(opts?)        two-phase init, idempotent, auto-called     │
│  .collection(name)         get/create KV Collection                   │
│  .listCollectionNames()    list all collections with data              │
│  .deleteCollection(name)   remove from DB + evict from cache           │
│  .index(opts)              delegates to IndexAPI                       │
│  .indexCode(opts)          code-only shortcut                          │
│  .indexGit(opts)           git-only shortcut                           │
│  .search(query, opts)      vector search (scope via sources: {code:10, git:0}) │
│  .hybridSearch(query, opts)  vector + BM25 → RRF, scope via sources            │
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
│  TYPED PLUGIN ACCESSORS (post-.use(), before init)                    │
│  ─────────────────────────────────────────────────────────────────    │
│  .docs  → DocsPlugin | undefined   (registry.firstByType('docs'))     │
│  .git   → Plugin | undefined       (registry.firstByType('git'))      │
│                                                                        │
│  NOTE: .docs returns DocsPlugin (typed), .git returns Plugin.         │
│  For plugin-specific methods like fileHistory(), use:                  │
│    brain.plugin('git') as any  OR  brain.git as any                   │
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
└────────────────────────────────────────────────────────────────────────┘
```

**Auto-init vs require-init:**

```
Methods that call await this.initialize() (auto-init, transparent):
  index, indexCode, indexGit
  search, hybridSearch, getContext
  collection (only the first call if not yet initialized)

Methods that call _requireInit() (throw if not initialized):
  searchBM25, rebuildFTS, watch, stats, reembed
  listCollectionNames, deleteCollection

  → Design intent: BM25 and stats are "quick" operations that
    shouldn't silently trigger a slow async init. The caller
    must explicitly initialize first.


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
                                                       .catch(() => _initPromise = null)
  NOTE: _initPromise is nulled via explicit .then/.catch, NOT via finally.
  A finally block would null the promise BEFORE the catch handler completes,
  allowing a concurrent caller to start a new init while cleanup is in progress.
```

---

## 4. Two-Phase Initialization

**Pattern: Two-Phase Construction**

The split exists because plugins call `ctx.collection()` during their own
`initialize()`. `collection()` requires `KVService` (which holds `kvHnsw`),
so `KVService` must exist before Phase 2 runs plugins. Only after
`this._kvService` is assigned can Phase 2 safely run.

```
BrainBank._runInitialize({ force? })
│
├── PHASE 1: earlyInit(config, emit, { force? })  [src/bootstrap/initializer.ts]
│   │
│   ├── new Database(config.dbPath)
│   │     fs.mkdirSync(dirname) if needed
│   │     WAL mode, FK constraints, FTS5 triggers, all tables via createSchema()
│   │
│   ├── resolveStartupEmbedding(config, emit, db):
│   │     1. config.embeddingProvider (explicit — highest priority)
│   │     2. embedding_meta.provider_key in DB → resolveEmbedding(key)
│   │        e.g. if prev indexed with 'openai' → auto-resolves OpenAIEmbedding
│   │     3. fallback → resolveEmbedding('local') → LocalEmbedding
│   │
│   ├── detectProviderMismatch(db, embedding):
│   │     compare { constructor.name, dims } stored vs current
│   │     ├── null → first time, no stored data, proceed
│   │     ├── mismatch && !force → db.close(), throw Error
│   │     │     "BrainBank: Embedding dimension mismatch (stored: X/384, current: Y/1536).
│   │     │      Run brain.reembed() or switch back."
│   │     └── mismatch && force → skipVectorLoad = true
│   │           ← load with wrong dims is OK; user must reembed() after
│   │
│   ├── setEmbeddingMeta(db, embedding)
│   │     UPSERT embedding_meta: provider, dims, provider_key, indexed_at
│   │
│   └── new HNSWIndex(dims, maxElements, M, efConstruction, efSearch).init()
│         ← kvHnsw READY
│         returns EarlyInit: { db, embedding, kvHnsw, skipVectorLoad }
│
│   BrainBank assigns:
│     this._db          = early.db
│     this._embedding   = early.embedding
│     this._kvService   = new KVService(db, embedding, kvHnsw, new Map(), reranker?)
│     ← collection() NOW WORKS (plugins can call ctx.collection() in Phase 2)
│
└── PHASE 2: lateInit(config, earlyResult, registry, sharedHnsw, kvService)
    │
    ├── Load KV vectors (unless skipVectorLoad):
    │     kvIndexPath = hnswPath(dbPath, 'kv')
    │     kvCount = countRows(db, 'kv_vectors')
    │     if kvHnsw.tryLoad(kvIndexPath, kvCount):
    │       loadVecCache(db, 'kv_vectors', 'data_id', kvService.vecs)
    │       ← HNSW graph loaded from file, only populate the Map
    │     else:
    │       loadVectors(db, 'kv_vectors', 'data_id', kvHnsw, kvService.vecs)
    │       ← rebuild HNSW from SQLite BLOBs (slower)
    │
    ├── privateHnsw = new Map<string, HNSWIndex>()
    ├── ctx = buildPluginContext(config, db, embedding, sharedHnsw, skipVectorLoad,
    │                            kvService, privateHnsw)
    │     createHnsw:              creates + registers in privateHnsw
    │     loadVectors:             wraps hnswPath/tryLoad/loadVectors with skip logic
    │     getOrCreateSharedHnsw:   checks sharedHnsw Map, creates if absent
    │     collection:              delegates to kvService.collection(name)
    │
    ├── for each mod in registry.all:
    │     await mod.initialize(ctx)
    │
    ├── saveAllHnsw(config.dbPath, kvHnsw, sharedHnsw, privateHnsw)
    │     kvHnsw.save('hnsw-kv.index')
    │     for [name, {hnsw}] in sharedHnsw: hnsw.save('hnsw-{name}.index')
    │     for [name, hnsw]   in privateHnsw: hnsw.save('hnsw-{name}.index')
    │     ← non-fatal try/catch; next startup rebuilds from SQLite if missing
    │
    └── createSearchAPI(db, embedding, config, registry, kvService, sharedHnsw)
          → SearchAPI | undefined   (undefined if no code/git/memory loaded)
          BrainBank assigns: this._searchAPI, this._indexAPI
          _initialized = true
          emit('initialized', { plugins })
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
  saveAllHnsw() → write .index files
  ← next cold start will be fast via tryLoad()

Error cleanup in _runInitialize (catch block):
  for {hnsw} in _sharedHnsw: hnsw.reinit()
  kvService.clear()
  kvService.hnsw.reinit()
  db.close()
  ← resets state so a subsequent .initialize() call can retry cleanly
```

---

## 5. Plugin Registry

**Pattern: Registry + Type-Prefix Matching**

```
PluginRegistry  [src/services/plugin-registry.ts]
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

**Pattern: Extension Point + Dependency Injection**

### 6.1 Plugin Interfaces  (`src/plugin.ts`)

```
Plugin  (base — every plugin must implement)
│  readonly name: string
│  initialize(ctx: PluginContext): Promise<void>
│  stats?():  Record<string, number | string>
│  close?():  void

IndexOptions  (typed, replaces `any`)
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
│  indexDocs(options?): Promise<Record<string, IndexResult>>
│  addContext(collection, path, context): void
│  listContexts(): PathContext[]

HnswPlugin extends Plugin
│  hnsw:     HNSWIndex
│  vecCache: Map<number, Float32Array>
│  ← used to expose plugin's HNSW to SearchFactory

CoEditPlugin extends Plugin
│  coEdits: { suggest(filePath: string, limit: number): CoEditSuggestion[] }
│  ← used by ContextBuilder for co-edit suggestions

ReembeddablePlugin extends Plugin
│  reembedConfig(): ReembedTable
│  ← ReembedTable: { name, textTable, vectorTable, idColumn, fkColumn, textBuilder }
│  ← reembedAll() collects these from all plugins + adds core tables (kv, memory)
```

**Type guards (all in `src/plugin.ts`):**

```typescript
isIndexable(p)    → typeof p.index === 'function'
isSearchable(p)   → typeof p.search === 'function'
isWatchable(p)    → typeof p.onFileChange === 'function'
                     && typeof p.watchPatterns === 'function'
isDocsPlugin(p)   → typeof p.addCollection === 'function'
                     && typeof p.listCollections === 'function'
isHnswPlugin(p)   → 'hnsw' in p && 'vecCache' in p
isCoEditPlugin(p) → 'coEdits' in p && typeof p.coEdits?.suggest === 'function'
isReembeddable(p) → typeof p.reembedConfig === 'function'
```

### 6.2 PluginContext — Dependency Injection Container

Every plugin receives exactly one `PluginContext` during `initialize()`.
This is the **only coupling** between core and plugin packages.
Built by `buildPluginContext()` in `src/bootstrap/initializer.ts`.

```
PluginContext
│
├── db: Database
│     ← shared SQLite (ALL plugins use the same file)
│
├── embedding: EmbeddingProvider
│     ← global OR per-plugin override
│     ← in plugin: const emb = opts.embeddingProvider ?? ctx.embedding
│
├── config: ResolvedConfig
│
├── createHnsw(maxElements?, dims?, name?): Promise<HNSWIndex>
│     ← creates a PRIVATE HNSW for the plugin
│     ← name → registered in privateHnsw Map → saved to 'hnsw-{name}.index'
│     ← dims defaults to config.embeddingDims (may be overridden by embedding.dims)
│     ← used by: DocsPlugin ('doc'), PatternsPlugin ('memory')
│
├── loadVectors(table, idCol, hnsw, cache): void
│     ← no-op if skipVectorLoad === true (force-init with dim mismatch)
│     ← otherwise: hnswPath → tryLoad → loadVecCache (hit) / loadVectors (miss)
│     ← wraps the hnsw-loader utilities with the skipVectorLoad guard
│
├── getOrCreateSharedHnsw(type, maxElements?, dims?): Promise<{hnsw, vecCache, isNew}>
│     ← checks _sharedHnsw Map for existing entry by type
│     ← if existing: return { hnsw, vecCache, isNew: false }
│     ← if new: create HNSWIndex, register in sharedHnsw, return { ..., isNew: true }
│     ← ONLY the FIRST plugin (isNew=true) should call loadVectors
│     ← used by: CodePlugin ('code'), GitPlugin ('git')
│
└── collection(name): ICollection
      ← delegates to kvService.collection(name)
      ← plugins can store their own data in KV during initialize()
```

**HNSW allocation per plugin type:**

```
Plugin        │ HNSW location            │ Shared? │ Persisted as
──────────────┼──────────────────────────┼─────────┼──────────────────────
CodePlugin    │ _sharedHnsw['code']       │ ✓ all code:* │ hnsw-code.index
GitPlugin     │ _sharedHnsw['git']        │ ✓ all git:*  │ hnsw-git.index
DocsPlugin    │ plugin.hnsw (private)     │ ✗       │ hnsw-doc.index
PatternsPlugin│ plugin.hnsw (private)     │ ✗       │ hnsw-memory.index
KV store      │ KVService._hnsw (kvHnsw)  │ ✓ all KV collections │ hnsw-kv.index
```

---

## 7. Built-in Plugins

### 7.1 @brainbank/code

**Purpose:** Semantic indexing of source code using Tree-sitter AST.
Chunks code into functions/classes/interfaces, builds import graph and
call graph, embeds with import context for better retrieval quality.

```
code({ repoPath?, name?, embeddingProvider?, maxFileSize?, ignore? })
         │
         ▼
CodePlugin.initialize(ctx)
         │
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── shared = ctx.getOrCreateSharedHnsw('code', undefined, embedding.dims)
         │     ← ALL code plugins share ONE HNSW in _sharedHnsw['code']
         ├── if shared.isNew:
         │     ctx.loadVectors('code_vectors', 'chunk_id', shared.hnsw, shared.vecCache)
         │     ← only the FIRST CodePlugin that initializes loads vectors
         └── new CodeWalker(repoPath ?? config.repoPath, {
                 db: ctx.db,
                 hnsw: shared.hnsw,
                 vectorCache: shared.vecCache,
                 embedding
             }, maxFileSize ?? config.maxFileSize, ignore)
               ← ignore compiled via picomatch({ dot: true }) if provided


CodeWalker.index({ forceReindex?, onProgress? })
         │
         ├── _walkRepo(repoPath) → absolute file paths[]
         │     filter rules:
         │       dirs:  isIgnoredDir(entry.name)   ← from lib/languages.ts
         │              _isIgnored(relDir) picomatch custom patterns
         │       files: isIgnoredFile(entry.name)  ← lockfiles etc
         │              ext not in SUPPORTED_EXTENSIONS
         │              stat.size > maxFileSize
         │              _isIgnored(relPath) picomatch
         │
         ├── for each file:
         │     content = fs.readFileSync()
         │     hash = FNV-1a(content)   ← fast non-crypto, 32-bit hex
         │     SELECT file_hash FROM indexed_files WHERE file_path = rel
         │     if same hash && !forceReindex → skipped++; continue
         │     chunkCount = await _indexFile(filePath, rel, content, hash)
         │     indexed++; totalChunks += chunkCount
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
         │     │     catch other → throw "BrainBank: Grammar not installed: npm i -g {pkg}"
         │     │
         │     ├── if parser + grammar:
         │     │     parser.setLanguage(grammar.grammar)
         │     │     tree = parser.parse(content)
         │     │     _extractChunks(rootNode, langConfig):
         │     │       iterate top-level AST nodes:
         │     │         export_statement → unwrap inner declaration
         │     │         decorated_definition → unwrap Python @decorator
         │     │         class/struct/impl:
         │     │           nodeLines > MAX → _splitClassIntoMethods()
         │     │             find body node; for each method:
         │     │               methodLines > MAX → _splitLargeBlock(overlap=5)
         │     │               else → _addChunk() as 'method'
         │     │             no methods found → _splitLargeBlock() as 'class'
         │     │           else → _addChunk() as 'class'
         │     │         function/interface/variable:
         │     │           nodeLines > MAX → _splitLargeBlock()
         │     │           else → _addChunk()
         │     │
         │     └── fallback → _chunkGeneric():
         │                     sliding window, step = MAX - OVERLAP (5)
         │
         ├── extractImports(content, language)  ← regex patterns per language
         │     typescript/javascript: from 'X', require('X')
         │     python:     import X, from X import
         │     go:         import "X"
         │     rust:       use X::Y, mod X
         │     java/kotlin/scala: import X.Y.Z
         │     c/cpp:      #include <X>
         │     ruby:       require 'X', require_relative 'X'
         │     php:        use X\Y, require 'X'
         │     (and more: lua, elixir, swift, bash, html, css)
         │     → simplified module names: ['react', 'express', 'pg']
         │
         ├── build embeddingTexts per chunk:
         │     "File: src/api.ts
         │      Imports: express, zod           ← context enrichment
         │      Class: MyService                ← for method chunks only
         │      function: handleRequest
         │      <code content>"
         │
         ├── embedding.embedBatch(embeddingTexts) → Float32Array[]
         │
         ├── _extractSymbolsSafe(content, rel, language)
         │     uses cached parser + grammar from CodeChunker
         │     extractSymbols(tree.rootNode, rel, language):
         │       walk AST → SymbolDef[] { name, kind, line, filePath }
         │       kinds: 'function'|'class'|'method'|'variable'|'interface'
         │       methods get qualified names: 'ClassName.methodName'
         │
         └── DB TRANSACTION (atomic delete-old + insert-new):
               _removeOldChunks(rel):
                 SELECT id FROM code_chunks WHERE file_path = rel
                 hnsw.remove(id) + vectorCache.delete(id) per id
                 DELETE FROM code_chunks WHERE file_path = rel (CASCADE deletes vectors)
               _removeOldGraph(rel):
                 DELETE FROM code_imports WHERE file_path = rel
                 DELETE FROM code_symbols WHERE file_path = rel
               INSERT code_chunks → id[] (lastInsertRowid)
               INSERT code_vectors (chunk_id, vecToBuffer(vec[i]))
               hnsw.add(vecs[i], id) + vectorCache.set(id, vecs[i]) per chunk
               INSERT OR IGNORE code_imports (file_path, imports_path) per import
               INSERT code_symbols (file_path, name, kind, line, chunk_id) per symbol
               INSERT code_refs (chunk_id, symbol_name) per call ref per chunk:
                 _extractCallRefsSafe(content, chunk, language)
                   extractCallRefs(tree.rootNode, language):
                     find call_expression / new_expression / method_invocation nodes
                     extract callee name (member_expression.property for JS/TS)
                     filter _isBuiltin(name): skip push, forEach, map, console, ...
               UPSERT indexed_files (file_path, file_hash)


CodePlugin.reembedConfig(): ReembedTable
  {
    name: 'code',
    textTable: 'code_chunks',
    vectorTable: 'code_vectors',
    idColumn: 'id',
    fkColumn: 'chunk_id',
    textBuilder: (r) => "File: {file_path}\n{chunk_type}: {name}\n{content}"
  }

CodePlugin.stats():
  { files: COUNT(DISTINCT file_path), chunks: COUNT(*), hnswSize: hnsw.size }
```

**Grammar registry (`grammars.ts`):**

```
typescript, javascript → tree-sitter-typescript (.typescript accessor)
python, go, rust, c, cpp, java, kotlin, scala
ruby, php (.php accessor), lua, bash, elixir, swift, html, css, c_sharp
```

---

### 7.2 @brainbank/git

**Purpose:** Index git commit history with message + diff embeddings.
Compute file co-editing patterns. Provide file history queries.

```
git({ repoPath?, depth?, maxDiffBytes?, name?, embeddingProvider? })
         │
         ▼
GitPlugin.initialize(ctx)
         │
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── shared = ctx.getOrCreateSharedHnsw('git', 500_000, embedding.dims)
         │     ← ALL git plugins share ONE HNSW in _sharedHnsw['git']
         ├── if shared.isNew:
         │     ctx.loadVectors('git_vectors', 'commit_id', shared.hnsw, shared.vecCache)
         ├── new GitIndexer(repoPath ?? config.repoPath, {
         │       db, hnsw: shared.hnsw, vectorCache: shared.vecCache, embedding
         │   }, maxDiffBytes ?? config.maxDiffBytes)
         └── new CoEditAnalyzer(ctx.db)


GitIndexer.index({ depth=500, onProgress? })
         │
         ├── simpleGit(repoPath)   ← dynamic import('simple-git')
         │   git.log({ maxCount: depth }) → { all: Commit[] }
         │
         ├── _prepareStatements()  ← hoist all SQL outside the loop
         │     check, deleteFiles, deleteCommit, insertCommit, insertFile, insertVec
         │
         ├── PHASE 1: _collectCommits() [async git calls per commit]
         │     for each commit c in log.all:
         │       onProgress('[hash] message...', i+1, total)
         │       stmts.check.get(c.hash) → { id, has_vector }
         │         has_vector → skipped++; continue
         │         exists but no vector (zombie) → deleteFiles + deleteCommit
         │       _parseCommit(git, c):
         │         git show --numstat → filesChanged[], additions, deletions
         │         git show --unified=3 --no-color → diff (truncated maxDiffBytes)
         │         isMerge = /^(Merge|merge)\s+(branch|pull|remote|tag)/.test(message)
         │         text = "Commit: {msg}\nAuthor: {author}\nDate: {date}\n
         │                 Files: {files.join(', ')}\nChanges:\n{diff[:2000]}"
         │       toProcess.push({ commit, diff, additions, deletions,
         │                        filesChanged, isMerge, text })
         │
         ├── embedding.embedBatch(toProcess.map(d => d.text)) → vecs[]
         │     ← SINGLE batch for all new commits (efficient API usage)
         │
         ├── PHASE 2: _insertCommits() [one DB transaction]
         │     for each CommitData + vec:
         │       INSERT git_commits (hash, short_hash, message, author, date,
         │                          timestamp, files_json, diff, additions,
         │                          deletions, is_merge)
         │       if result.changes === 0 → skip (concurrent insert race)
         │       INSERT commit_files (commit_id, file_path) per file
         │       INSERT git_vectors (commit_id, vecToBuffer(vecs[i]))
         │       newCommitIds.push({ commitId, vecIndex: i })
         │       indexed++
         │
         └── PHASE 3: _updateHnsw() + _computeCoEdits()
               for { commitId, vecIndex } in newCommitIds:
                 hnsw.add(vecs[vecIndex], commitId)
                 vectorCache.set(commitId, vecs[vecIndex])
               _computeCoEdits(newCommitIds):
                 _queryCommitFiles() in chunks of 500 (SQLite 999-variable limit)
                 group file_paths by commit_id
                 for each commit with 2–20 files (skip trivial / noisy):
                   for each pair (a, b): [a, b].sort() → canonical order
                   UPSERT co_edits (file_a, file_b, count) ON CONFLICT count+1


CoEditAnalyzer.suggest(filePath, limit=5):
  SELECT
    CASE WHEN file_a = ? THEN file_b ELSE file_a END AS file,
    count
  FROM co_edits
  WHERE file_a = ? OR file_b = ?
  ORDER BY count DESC LIMIT ?
  → [{ file: 'src/db.ts', count: 23 }]


GitPlugin.fileHistory(filePath, limit=20):
  SELECT c.short_hash, c.message, c.author, c.date, c.additions, c.deletions
  FROM git_commits c
  JOIN commit_files cf ON c.id = cf.commit_id
  WHERE cf.file_path LIKE '%{filePath}%' AND c.is_merge = 0
  ORDER BY c.timestamp DESC LIMIT limit


GitPlugin.reembedConfig(): ReembedTable
  {
    name: 'git',
    textTable: 'git_commits',
    vectorTable: 'git_vectors',
    idColumn: 'id',
    fkColumn: 'commit_id',
    textBuilder: (r) => "Commit: {message}\nAuthor: {author}\nDate: {date}\n
                         Files: {files_json_parsed}\nChanges:\n{diff[:2000]}"
  }

GitPlugin.stats():
  { commits, filesTracked: COUNT(DISTINCT file_path), coEdits, hnswSize }
```

---

### 7.3 @brainbank/docs

**Purpose:** Index folders of markdown/text files as named collections.
Heading-aware smart chunking, incremental by SHA-256 content hash.
Private HNSW per plugin instance (not shared).

```
docs({ embeddingProvider? })
         │
         ▼
DocsPlugin.initialize(ctx)
         │
         ├── embedding = opts.embeddingProvider ?? ctx.embedding
         ├── this.hnsw = await ctx.createHnsw(undefined, embedding.dims, 'doc')
         │     ← PRIVATE HNSW (NOT in _sharedHnsw pool)
         │     ← persisted to 'hnsw-doc.index'
         ├── ctx.loadVectors('doc_vectors', 'chunk_id', this.hnsw, this.vecCache)
         ├── this.indexer = new DocsIndexer(db, embedding, hnsw, vecCache)
         └── this._search = new DocumentSearch({
                 db, embedding, hnsw, vecCache,
                 reranker: ctx.config.reranker
             })


DocsPlugin.addCollection({ name, path, pattern?, ignore?, context? })
  INSERT OR REPLACE INTO collections (name, path, pattern, ignore_json, context)
  ← synchronous, no return value

DocsPlugin.removeCollection(name)
  → this.indexer.removeCollection(name):
      SELECT id FROM doc_chunks WHERE collection = ?
      hnsw.remove(id) + vecCache.delete(id) per id
      DELETE FROM doc_chunks (CASCADE deletes doc_vectors)
      DELETE FROM collections WHERE name = ?
      DELETE FROM path_contexts WHERE collection = ?

DocsPlugin.indexDocs({ collections?, onProgress? })
  listCollections() → all from DB
  filter if collections?: string[] provided
  for each: DocsIndexer.indexCollection(name, path, pattern, { ignore, onProgress })
  → Record<string, { indexed, skipped, chunks }>


DocsIndexer.indexCollection(collection, dirPath, pattern, opts)
         │
         ├── _walkFiles(absDir, pattern, ignore)
         │     recursive readdir
         │     skip: IGNORED_DOC_DIRS (node_modules, .git, dist, ...)
         │     skip: _isIgnoredFile(rel, ignore) → glob-to-regex via string replace
         │     filter: ext matches patternExt (e.g. 'md' from '**/*.md')
         │     → relPath[] (relative to absDir)
         │
         ├── for each relPath:
         │     content = fs.readFileSync()
         │     hash = SHA-256(content).slice(0, 16)   ← 16-char hex prefix
         │     _isUnchanged(collection, relPath, hash):
         │       SELECT dc.id, dc.content_hash, dv.chunk_id AS has_vector
         │       FROM doc_chunks LEFT JOIN doc_vectors
         │       → true if ALL rows: same hash AND has_vector not null
         │     if unchanged → skipped++; continue
         │     _removeOldChunks() → hnsw.remove() + vecCache.delete() + DELETE
         │     chunkCount = await _indexFile(collection, relPath, content, hash)
         │
         └── returns { indexed, skipped, chunks }


DocsIndexer._indexFile(collection, relPath, content, hash)
         │
         ├── _extractTitle(content, relPath)
         │     match /^#{1,3}\s+(.+)$/m → first H1/H2/H3
         │     fallback → path.basename(relPath, ext)
         │
         ├── _smartChunk(content) → [{ text, pos }]
         │     if content.length ≤ TARGET_CHARS (3000) → [{ text, pos: 0 }]
         │     _findBreakPoints(lines):
         │       track inCodeBlock (toggle on ```)
         │       score each line (outside code blocks only):
         │         H1=100, H2=90, H3=80, code-fence-close=80
         │         ---=60, ***=60, blank=20, list-item=5
         │       → [{ pos: charPos, score }]
         │     greedy split:
         │       WINDOW_CHARS = 600, targetEnd = chunkStart + TARGET_CHARS
         │       for each breakpoint in window:
         │         finalScore = score * (1 - (dist/WINDOW)² * 0.7)  ← distance decay
         │       flush remainder: merge into last chunk if < MIN_CHUNK_CHARS (200)
         │
         ├── TRANSACTION: INSERT doc_chunks (collection, file_path, title,
         │                                  content, seq, pos, content_hash)
         │     → chunkIds[]
         │
         ├── texts = chunks.map(c => "title: {title} | text: {c.text}")
         │   embeddings = await embedding.embedBatch(texts)
         │
         ├── TRANSACTION: INSERT OR REPLACE doc_vectors (chunk_id, embedding)
         │
         └── hnsw.add(embeddings[j], chunkIds[j]) + vecCache.set() per chunk


DocsPlugin.search(query, opts?)   → DocumentSearch.search()   (see §11.8)

DocsPlugin.addContext(collection, path, context)
  → UPSERT path_contexts (collection, path, context)

DocsPlugin.listContexts() → SELECT * FROM path_contexts

DocsPlugin.reembedConfig(): ReembedTable
  {
    name: 'docs',
    textTable: 'doc_chunks',
    vectorTable: 'doc_vectors',
    idColumn: 'id',
    fkColumn: 'chunk_id',
    textBuilder: (r) => "title: {title} | text: {content}"
  }

DocsPlugin.stats():
  { collections, documents: COUNT(DISTINCT file_path), chunks, hnswSize }
```

---

## 8. @brainbank/memory Package

**Purpose:** Unified memory for AI agents. Two complementary systems:

1. **Conversational Memory** (`Memory` + `EntityStore`) — LLM-powered fact
   extraction, deduplication, optional knowledge graph. Uses `Collection`
   (KV store) as storage backend.
2. **Pattern Learning** (`patterns()` plugin + `PatternStore`) — structured
   learning from completed tasks. Uses dedicated HNSW + DB tables owned by core.

```
packages/memory/src/
├── memory.ts            ← Memory class
├── entities.ts          ← EntityStore class
├── llm.ts               ← LLMProvider interface + OpenAIProvider
├── prompts.ts           ← extraction + dedup prompts
├── patterns-plugin.ts   ← patterns() / memory() plugin factory
├── pattern-store.ts     ← PatternStore: LearningPattern CRUD + vector search
├── consolidator.ts      ← prune old failures + cosine dedup
└── pattern-distiller.ts ← aggregate patterns → strategy text
```

### 8.1 Memory Class

```
Memory
│
│  constructor accepts either:
│    A) CollectionProvider + MemoryOptions   ← recommended
│         CollectionProvider = { collection(name): MemoryStore }
│         ← BrainBank satisfies this interface
│         → stores in brain.collection(opts.collectionName ?? 'memories')
│    B) MemoryStore + MemoryOptions
│         ← pass a Collection directly (legacy)
│
│  MemoryOptions:
│    llm:             LLMProvider    ← REQUIRED
│    entityStore?:    EntityStore    ← enables entity extraction (opt-in)
│    maxFacts?:       5              ← max facts extracted per turn
│    maxMemories?:    50             ← max existing memories for dedup context
│    dedupTopK?:      3              ← top-k similar memories sent to LLM
│    extractPrompt?:  string         ← override extraction prompt
│    dedupPrompt?:    string         ← override dedup prompt
│    onOperation?:    callback       ← fired per MemoryOperation
│    collectionName?: 'memories'
│
│  NOTE: if entityStore provided, constructor:
│    1. Switches to EXTRACT_WITH_ENTITIES_PROMPT automatically
│    2. Calls entityStore.setLLM(this.llm) to share the LLM instance


Memory.process(userMessage, assistantMessage): Promise<ProcessResult>
         │
         ├── STEP 1: extract facts (and entities if entityStore present)
         │     llm.generate([
         │       { role:'system', content: extractPrompt },
         │       { role:'user', content: "User: {u}\n\nAssistant: {a}" }
         │     ], { json: true, maxTokens: 500 })
         │     → { facts: string[], entities: [], relationships: [] }
         │     parse error → { facts:[], entities:[], relationships:[] }
         │
         ├── if facts.length === 0 && entities.length === 0 → return { operations: [] }
         │
         ├── STEP 2: existing = store.list({ limit: maxMemories })
         │
         ├── STEP 3: for each fact:
         │     similar = await store.search(fact, { k: dedupTopK })
         │     if similar.length === 0 → { action:'ADD', reason:'no similar found' }
         │     else:
         │       context = similar.map((m, i) => "[{i}] {m.content}").join('\n')
         │       llm.generate(DEDUP_PROMPT, "NEW FACT: {fact}\n\nEXISTING:\n{context}")
         │       → { action: 'ADD'|'UPDATE'|'NONE', reason: '...' }
         │       parse error → default to ADD
         │     execute:
         │       ADD    → store.add(fact)
         │       UPDATE → store.remove(similar[0].id) + store.add(fact)
         │       NONE   → skip
         │     onOperation?.(op)
         │
         └── STEP 4: if entityStore && entities/relationships found:
               context = first 200 chars of "${user} — ${assistant}"
               entityStore.processExtraction(entities, relationships, context)
               → { entitiesProcessed, relationshipsProcessed }

ProcessResult: { operations: MemoryOperation[], entities?: EntityOperation }
MemoryOperation: { fact, action: 'ADD'|'UPDATE'|'NONE', reason }

Memory.search(query, k=5)   → store.search(query, { k })
Memory.recall(limit=20)     → store.list({ limit })
Memory.count()              → store.count()
Memory.buildContext(limit=20):
  "## Memories\n- fact1\n- fact2..."
  + entityStore.buildContext() if present
Memory.getEntityStore()     → EntityStore | undefined


PROMPTS (src/prompts.ts):
  EXTRACT_PROMPT:               extracts { facts: [] }
  EXTRACT_WITH_ENTITIES_PROMPT: extracts { facts, entities, relationships }
  DEDUP_PROMPT: ADD / UPDATE / NONE with reason
    "Be conservative — if in doubt, say NONE."
```

### 8.2 EntityStore Class

```
EntityStore
│
│  constructor accepts either:
│    A) CollectionProvider + EntityStoreConfig   ← recommended
│         → brain.collection(entityCollectionName ?? 'entities')
│            brain.collection(relationCollectionName ?? 'relationships')
│    B) EntityStoreOptions (legacy):
│         → { entityCollection, relationCollection, llm?, onEntity? }
│
│  Entity: { name, type, attributes?, firstSeen?, lastSeen?, mentionCount? }
│  type: 'person'|'service'|'project'|'organization'|'concept'|string
│  Relationship: { source, target, relation, context?, timestamp? }
│  relation: lowercase verb phrases ('works_on', 'prefers', 'depends_on')


EntityStore.upsert(entity)
  findEntity(entity.name) → existing?
  if exists:
    remove old entry + re-add with mentionCount+1 + merged attributes
  if new:
    add with mentionCount=1
  onEntity?.({ action:'NEW'|'UPDATED', name, type })


EntityStore.findEntity(name): MemoryItem | null
  1. entities.search(name, { k: 5 })
  2. exact case-insensitive match: extractName(r.content).toLowerCase() === name.toLowerCase()
  3. if llm && candidates:
       resolveEntity(name, candidateNames):
         prompt: ENTITY_RESOLVE_PROMPT
           "TS" = "TypeScript", "berna" = "Berna", "GCP" = "Google Cloud Platform"
         response: matching name OR "NONE"
         verify response is actually in candidates list
  → first match or null


EntityStore.relate(source, target, relation, context?)
  relations.add("${source} → ${relation} → ${target}", {
    metadata: { source, target, relation, context, timestamp: Date.now() }
  })


EntityStore.traverse(startEntity, maxDepth=2): TraversalResult
  BFS:
    queue = [{ entity: start, depth: 0, path: [start], relation: '' }]
    while queue not empty:
      if depth > maxDepth || visited → continue
      rels = getRelated(entity)  ← filters source === entity OR target === entity
      push connected entities to queue
  → { start, maxDepth, nodes: TraversalNode[] }
  TraversalNode: { entity, relation, depth, path: string[] }


EntityStore.buildContext(entityName?)
  with entityName:   entity info + its relationships as markdown
  without:           all entities (name, type, mentions) + all relationships

EntityStore.processExtraction(entities[], relationships[], context?)
  for each entity: upsert()
  for each rel:    relate()
  → { entitiesProcessed, relationshipsProcessed }
```

### 8.3 patterns() Plugin (Structured Learning)

```
patterns() / memory()   ← memory() is a backwards-compat alias for patterns()
         │
         ▼
PatternsPlugin.initialize(ctx)
         │
         ├── this.hnsw = await ctx.createHnsw(100_000, undefined, 'memory')
         │     ← PRIVATE HNSW, persisted to 'hnsw-memory.index'
         ├── ctx.loadVectors('memory_vectors', 'pattern_id', this.hnsw, this.vecCache)
         ├── new PatternStore({ db, hnsw, vectorCache: vecCache, embedding: ctx.embedding })
         ├── new Consolidator(ctx.db, this.vecCache)
         └── new PatternDistiller(ctx.db)


PatternStore.learn(pattern: LearningPattern): Promise<number>
  INSERT memory_patterns (task_type, task, approach, outcome, success_rate,
                          critique, tokens_used, latency_ms)
  → id (lastInsertRowid)
  text = "{task_type} {task} {approach}"
  vec = await embedding.embed(text)
  INSERT memory_vectors (pattern_id, vecToBuffer(vec))
  hnsw.add(vec, id); vectorCache.set(id, vec)
  ← auto-consolidate every 50 patterns


PatternStore.search(query, k=4, minSuccess=0.5)
  embedding.embed(query) → queryVec
  hnsw.search(queryVec, k*2)   ← over-fetch
  SELECT * FROM memory_patterns WHERE id IN (?) AND success_rate >= ?
  sort by vector score, slice to k
  → (LearningPattern & { score: number })[]


Consolidator.prune(maxAgeDays=90, minSuccess=0.3)
  DELETE FROM memory_patterns WHERE success_rate < ? AND created_at < cutoff
  → count removed

Consolidator.dedup(threshold=0.95)
  iterate all entries in vectorCache as pairs
  cosine(vecA, vecB) > 0.95 → keep higher success_rate, delete other
  DELETE in batch + vectorCache.delete()
  → count deduped

Consolidator.consolidate() → { pruned, deduped }


PatternDistiller.distill(taskType, topK=10): DistilledStrategy | null
  SELECT approach, success_rate, critique FROM memory_patterns
  WHERE task_type = ? AND success_rate >= 0.7
  ORDER BY success_rate DESC LIMIT topK
  UPSERT distilled_strategies (task_type, strategy, confidence, updated_at)
  → formatted strategy text

PatternDistiller.get(taskType) → DistilledStrategy | null
PatternDistiller.list()        → DistilledStrategy[]


PatternsPlugin.stats():
  { patterns: COUNT(*), avgSuccess: AVG(success_rate), hnswSize: hnsw.size }
```

### 8.4 LLMProvider Interface

```typescript
// Framework-agnostic — implement to use any LLM
interface LLMProvider {
    generate(messages: ChatMessage[], options?: GenerateOptions): Promise<string>
}
interface ChatMessage { role: 'system'|'user'|'assistant'; content: string }
interface GenerateOptions { json?: boolean; maxTokens?: number; temperature?: number }

// Built-in: direct fetch to OpenAI
class OpenAIProvider implements LLMProvider {
    constructor({ apiKey?, model='gpt-4.1-nano', baseUrl? })
    generate() → POST /v1/chat/completions
      options.json=true → response_format: { type:'json_object' }
}

// Compatible with: LangChain, Vercel AI SDK, Anthropic, Ollama, etc.
// by wrapping their generate() in this interface
```

---

## 9. @brainbank/mcp Package

**Purpose:** Expose BrainBank as an MCP server via stdio transport.
Works with Claude Desktop, Google Gemini, and any MCP-compatible client.

**6 registered tools:**

| Tool | Description |
|------|------------|
| `brainbank_search` | Unified: hybrid (default), vector, or keyword mode |
| `brainbank_context` | Formatted context block (code + git + patterns + docs) |
| `brainbank_index` | Trigger incremental indexing + optional docs path register |
| `brainbank_stats` | Index stats + KV collection inventory |
| `brainbank_history` | Git commit history for a file path |
| `brainbank_collection` | KV operations: add, search, trim |

**Multi-workspace LRU pool:**

```
const _pool = new Map<string, { brain: BrainBank, lastAccess: number }>()
MAX_POOL_SIZE = 10

getBrainBank(targetRepo?)
         │
         ├── repo = targetRepo ?? BRAINBANK_REPO env ?? findRepoRoot(cwd)
         │     findRepoRoot: walk up from startDir checking for .git/
         │     fallback: use startDir if no .git found
         │     resolved = rp.replace(/\/+$/, '')  ← normalize trailing slash
         │
         ├── if _pool.has(resolved):
         │     health check: code HNSW empty but DB > 100KB → evict
         │     else: entry.lastAccess = Date.now(), return cached brain
         │
         ├── if _pool.size >= MAX_POOL_SIZE:
         │     evict entry with oldest lastAccess (LRU strategy)
         │
         └── _createBrain(resolved):
               read .brainbank/config.json (if exists)
               resolve plugins list from config (default: code + git + docs)
               resolve embedding: config.json.embedding > BRAINBANK_EMBEDDING env
               new BrainBank({ repoPath, reranker: _sharedReranker, embeddingProvider? })
               use(code(..., ignore: config.code.ignore))
               use(git(...))
               use(docs())
               brain.initialize()
               ← on HNSW corruption error ("Invalid the given array length"):
                   delete brainbank.db + wal + shm
                   recreate with fresh BrainBank instance

_sharedReranker: created once from BRAINBANK_RERANKER=qwen3 env
                 shared across ALL workspaces in the pool
```

---

## 10. Collection — KV Store

**Pattern: Repository + Hybrid Search + Shared HNSW**

The universal data primitive. All collections share **one kvHnsw** owned
by `KVService`. Cross-collection isolation is achieved via SQL `WHERE collection = ?`
filtering after an adaptive over-fetch.

```
brain.collection('debug_errors')
  → KVService.collection(name)
  → new Collection(name, db, embedding, kvHnsw, kvVecs, reranker?)
     ← KVService creates and caches Collection instances by name
     ← all collections share the same kvHnsw + kvVecs
```

**KVService (`src/services/kv-service.ts`):**

```
KVService(db, embedding, hnsw, vecs, reranker?)
  _collections: Map<string, Collection>   ← instance cache

  collection(name) → cached or new Collection
  listNames()      → SELECT DISTINCT collection FROM kv_data ORDER BY collection
  delete(name)     → DELETE FROM kv_data; _collections.delete(name)
  hnsw             → getter for kvHnsw
  vecs             → getter for kvVecs
  clear()          → _collections.clear(); _vecs.clear()
```

**Collection methods:**

```
add(content, options?)
  options shape A: { metadata?, tags?, ttl? }       ← recommended
  options shape B: { key: value, ... }               ← legacy metadata shorthand
  detection: 'tags' in opts || 'ttl' in opts || 'metadata' in opts → shape A
  │
  ├── embedding.embed(content)      ← embed FIRST (fail before DB orphan rows)
  ├── INSERT kv_data (collection, content, meta_json, tags_json, expires_at)
  │     expires_at = floor(now/1000) + parseDuration(ttl) if ttl given
  │     parseDuration: '7d'→604800, '24h'→86400, '30m'→1800, '5s'→5
  │     FTS trigger fires: INSERT INTO fts_kv(rowid, content, collection)
  ├── INSERT kv_vectors (data_id, vecToBuffer(vec))
  ├── kvHnsw.add(vec, id)
  └── kvVecs.set(id, vec)

update(id, content, options?)
  fetch existing row; merge metadata/tags; _removeById(id); add(content, ...)

addMany(items[])
  embedBatch(all texts)               ← single API call
  single DB transaction for all inserts
  HNSW + cache updated AFTER transaction ← no orphan risk on rollback

search(query, { k=5, mode='hybrid', minScore=0.15, tags? })
  │
  ├── _pruneExpired():
  │     SELECT id WHERE expires_at IS NOT NULL AND expires_at <= now
  │     _removeById(id) per expired item
  │
  ├── mode='keyword' → _searchBM25(q, k, minScore) → _filterByTags(results, tags)
  ├── mode='vector'  → _searchVector(q, k, minScore) → _filterByTags(results, tags)
  └── mode='hybrid':
        parallel: _searchVector(k, minScore=0) + _searchBM25(k, minScore=0)
        fuseRankedLists([vectorHits, bm25Hits], id => String(h.id), h => h.score ?? 0)
          ← generic RRF that works on CollectionItem (not SearchResult)
        map fused { item, score } back to CollectionItems
        filter score >= minScore, slice to k
        if reranker && results.length > 1:
          cast to SearchResult[] (type:'collection')
          await rerank(query, asSearchResults, reranker)
          map reranked scores back to CollectionItems
        _filterByTags(results, tags)

searchAsResults(query, k): Promise<SearchResult[]>
  search(query, { k })
  → map to { type:'collection', score, content, metadata: { id, collection, ...metadata } }
  ← used by SearchAPI._collectKvCollections()

_searchVector(query, k, minScore):
  queryVec = embedding.embed(query)
  searchK = _adaptiveSearchK(k):
    if totalSize === 0 → 0
    if collectionCount === 0 → min(k*3, totalSize)
    ratio = ceil(totalSize / collectionCount), clamped [3, 50]
    → min(k * ratio, totalSize)
    ← compensates for shared HNSW: if 1000 total / 50 in this collection → ratio=20
  kvHnsw.search(queryVec, searchK)
  SELECT * FROM kv_data WHERE id IN (?) AND collection = ?
  sort by score, filter >= minScore, slice to k

_searchBM25(query, k, minScore):
  sanitizeFTS(query) → ftsQuery
  SELECT d.*, bm25(fts_kv, 5.0, 1.0) AS score
  FROM fts_kv JOIN kv_data WHERE fts_kv MATCH ? AND collection = ?
  ORDER BY score ASC LIMIT k
  normalizeBM25 each score

_filterByTags(items, tags?):
  tags: item.tags must include ALL specified tags (AND semantics)

list({ limit=20, offset=0, tags? })
  SELECT * WHERE collection = ? AND (expires_at IS NULL OR expires_at > now)
  ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?

count()
  SELECT COUNT(*) WHERE collection = ? AND (expires_at IS NULL OR expires_at > now)

trim({ keep })
  SELECT id ORDER BY created_at DESC LIMIT -1 OFFSET keep → _removeById each

prune({ olderThan: '30d' })
  cutoff = now - parseDuration(olderThan)
  SELECT id WHERE created_at < cutoff → _removeById each

_removeById(id):
  DELETE FROM kv_data (CASCADE: deletes kv_vectors, FTS trigger fires)
  kvHnsw.remove(id)
  kvVecs.delete(id)
  ← DB first: if fails, HNSW+cache stay consistent (no phantom entries)
```

---

## 11. Search Layer

### 11.1 SearchStrategy Interface

```typescript
// src/search/types.ts
interface SearchStrategy {
    search(query: string, options?: SearchOptions): Promise<SearchResult[]>
    rebuild?(): void   // optional: FTS5 full rebuild
}

interface SearchOptions {
    sources?: Record<string, number> // e.g. { code: 6, git: 5, memory: 4 }
    minScore?:  number   // default 0.25
    useMMR?:    boolean  // default true
    mmrLambda?: number   // default 0.7
}
```

Both `CompositeVectorSearch` and `KeywordSearch` implement this interface.

### 11.2 CompositeVectorSearch

**Pattern: Composite — three domain strategies sharing one embed() call.**

```
CompositeVectorSearch({ code?, git?, patterns?, embedding })
  implements SearchStrategy

  .search(query, options):
    queryVec = await embedding.embed(query)   ← ONE embed call for all domains
    results = []

    if code && codeK > 0:
      CodeVectorSearch.search(queryVec, codeK, minScore, useMMR, mmrLambda)
        if hnsw.size === 0 → skip
        hits = useMMR
          ? searchMMR(hnsw, queryVec, vecs, k, lambda)
          : hnsw.search(queryVec, k)
        ids = hits.map(h => h.id)
        SELECT * FROM code_chunks WHERE id IN ({placeholders})
        for each row where score >= minScore:
          { type:'code', score, filePath, content,
            metadata: { id, chunkType, name, startLine, endLine, language } }

    if git && gitK > 0:
      GitVectorSearch.search(queryVec, gitK, minScore)
        hnsw.search(queryVec, k*2)   ← over-fetch for merge filtering
        SELECT * FROM git_commits WHERE id IN (?) AND is_merge = 0
        for each row where score >= minScore:
          { type:'commit', score, content: message,
            metadata: { hash, shortHash, author, date, files,
                        additions, deletions, diff } }

    if patterns && patternK > 0:
      PatternVectorSearch.search(queryVec, patternK, minScore, useMMR, mmrLambda)
        searchMMR or hnsw.search
        SELECT * FROM memory_patterns WHERE id IN (?) AND success_rate >= 0.5
        for each row where score >= minScore:
          { type:'pattern', score, content: approach,
            metadata: { taskType, task, outcome, successRate, critique } }

    results.sort((a, b) => b.score - a.score)
    → SearchResult[]


SearchResult discriminated union:
  CodeResult:       { type:'code',       score, filePath, content, context?, metadata: CodeResultMetadata }
  CommitResult:     { type:'commit',     score, content, context?, metadata: CommitResultMetadata }
  PatternResult:    { type:'pattern',    score, content, context?, metadata: PatternResultMetadata }
  DocumentResult:   { type:'document',   score, filePath, content, context?, metadata: DocumentResultMetadata }
  CollectionResult: { type:'collection', score, content, context?, metadata: CollectionResultMetadata }

Type guards: isCodeResult(), isCommitResult(), isDocumentResult(),
             isPatternResult(), isCollectionResult()

matchResult(result, { code: r=>..., commit: r=>..., _: r=>... }):
  exhaustive pattern match with optional fallback handler
```

### 11.3 KeywordSearch (BM25)

```
KeywordSearch(db)  implements SearchStrategy

.search(query, { sources: { code: 8, git: 5, memory: 4 } })
         │
         ├── sanitizeFTS(query):  [src/lib/fts.ts]
         │     1. strip FTS5 special chars: {}[]()^~*:
         │     2. remove boolean operators: AND OR NOT NEAR
         │     3. split compound words:
         │          camelCase: ([a-z])([A-Z]) → $1 $2
         │          acronyms:  ([A-Z]+)([A-Z][a-z]) → $1 $2
         │          separators: [_\-./\\] → space
         │          "MagicLinkCallback" → "Magic Link Callback"
         │          "tenant_worker"     → "tenant worker"
         │     4. split on whitespace, filter length > 1
         │     5. wrap each: "word" → implicit AND
         │     → '' if nothing left → return []
         │
         ├── _searchCode(ftsQuery, rawQuery, codeK, results):
         │     SELECT c.*, bm25(fts_code, 5.0, 3.0, 1.0) AS score
         │     FROM fts_code JOIN code_chunks ON rowid
         │     WHERE fts_code MATCH ? ORDER BY score ASC LIMIT codeK
         │     normalizeBM25(rawScore):
         │       abs = Math.abs(rawScore)   ← FTS5 returns negative (lower=better)
         │       1.0 / (1.0 + exp(-0.3 * (abs - 5)))   → 0..1 sigmoid
         │     seenIds.add() to avoid path-fallback duplicates
         │     _searchCodeByPath(rawQuery, seenIds):
         │       words from rawQuery (length > 2)
         │       LIKE '%word%' on file_path WHERE chunk_type = 'file'
         │       score = 0.6 (bm25-path label)
         │
         ├── _searchGit(ftsQuery, sources.git, results):
         │     bm25(fts_commits, 5.0, 2.0, 1.0)  message×5, author×2, diff×1
         │     filter: is_merge = 0
         │
         └── _searchPatterns(ftsQuery, sources.memory, results):
               bm25(fts_patterns, 3.0, 5.0, 5.0, 1.0)
               filter: success_rate >= 0.5

.rebuild():
  INSERT INTO fts_code(fts_code) VALUES('rebuild')
  INSERT INTO fts_commits(fts_commits) VALUES('rebuild')
  INSERT INTO fts_patterns(fts_patterns) VALUES('rebuild')
```

### 11.4 Hybrid Search + RRF

```
SearchAPI.hybridSearch(query, options?)
         │
         ├── sources = options?.sources ?? {}
         ├── codeK = sources.code ?? 20
         ├── gitK  = sources.git  ?? 8
         ├── docsK = sources.docs ?? 8
         │
         ├── if VectorSearch available (search field set):
         │     parallel:
         │     ├── vectorSearch.search(query, { ...options, sources: { code: codeK, git: gitK } }) → vecResults
         │     └── bm25?.search(query, { sources: { code: codeK, git: gitK } }) ?? []  → kwResults
         │     lists.push(vecResults, kwResults)
         │
         ├── if registry.has('docs'):
         │     docs = await _collectDocs(query, { k: docsK })
         │     if docs.length > 0: lists.push(docs)
         │
         ├── _collectCustomPlugins(query, options):
         │     for each plugin NOT in {'code','git','docs'} that isSearchable:
         │       hits = await mod.search(query, options)
         │       if hits.length > 0: lists.push(hits)
         │
         ├── _collectKvCollections(query, sources):
         │     for [name, k] in sources where name NOT in {'code','git','docs'}:
         │       hits = await kvService.collection(name).searchAsResults(query, k)
         │       if hits.length > 0: lists.push(hits)
         │
         ├── reciprocalRankFusion(lists, k=60, maxResults=15)  [src/lib/rrf.ts]
         │
         └── if config.reranker && fused.length > 1:
               rerank(query, fused, config.reranker)


reciprocalRankFusion(resultSets, k=60, maxResults=15):  [src/lib/rrf.ts]
  map: key → { result: SearchResult, rrfScore: number }
  for each list:
    for rank i, result r:
      key = type-specific unique string (see below)
      rrfScore += 1.0 / (60 + i + 1)
      if key seen: accumulate rrfScore + keep higher original score
  sort by rrfScore DESC, slice to maxResults
  maxRRF = sorted[0].rrfScore
  normalize: score = rrfScore / maxRRF  → 0..1 range
  metadata.rrfScore = raw rrfScore preserved for debugging

Unique key generation:
  'code'       → "code:{filePath}:{startLine}-{endLine}"
  'commit'     → "commit:{hash or shortHash}"
  'pattern'    → "pattern:{taskType}:{content.slice(0,60)}"
  'document'   → "document:{filePath}:{collection}:{seq}:{content.slice(0,80)}"
  'collection' → "collection:{id or content.slice(0,80)}"

fuseRankedLists<T>(lists, keyFn, scoreFn, k, maxResults):  [src/lib/rrf.ts]
  ← generic variant used by Collection.search() hybrid mode
  ← works on CollectionItem (no SearchResult needed)
```

### 11.5 MMR — Diversity

```
searchMMR(index, query, vectorCache, k, lambda=0.7)  [src/search/vector/mmr.ts]
         │
         ├── candidates = index.search(query, k*3)   ← over-fetch 3×
         ├── if candidates.length ≤ k → return candidates as-is
         │
         └── greedy selection loop (k iterations):
               for each remaining candidate i:
                 relevance = candidate[i].score
                 maxSim = max over already-selected:
                   cosine(vectorCache.get(candidate[i].id), vectorCache.get(sel.id))
                   if either not in cache → contribution = 0
                 mmrScore = lambda * relevance - (1 - lambda) * maxSim
               pick argmax(mmrScore), move to selected

lambda=0.7: 70% relevance, 30% diversity penalty (default)
lambda=1.0: pure relevance (identical to regular HNSW search)
lambda=0.0: pure diversity (maximize spread in embedding space)
```

### 11.6 Reranking

```
rerank(query, results, reranker): Promise<SearchResult[]>  [src/lib/rerank.ts]
         │
         ├── documents = results.map(r => r.content)
         ├── scores = await reranker.rank(query, documents)
         │     ← cross-encoder scores each doc against query in full context
         │
         ├── for each result at position i (pos = i + 1):
         │     rrfWeight = pos ≤ 3  ? 0.75   ← preserve exact matches at top
         │               : pos ≤ 10 ? 0.60   ← balanced middle zone
         │               :            0.40   ← trust reranker more for tail
         │     blended = rrfWeight * r.score + (1 - rrfWeight) * scores[i]
         │
         └── sort by blended DESC

Rationale: positions 1-3 are often exact keyword matches. Pure reranker
score would demote them. Position-aware blending preserves exact-match
precision while letting the reranker improve tail ordering.
```

### 11.7 ContextBuilder

**Decoupled from DB schema via `CodeGraphProvider` interface.**

```
ContextBuilder(search, coEdits?, codeGraph?, docsSearch?)
                                                ↑
                              DocsSearchFn: (query, opts?) => Promise<SearchResult[]>


CodeGraphProvider interface  [src/search/types.ts]:
  getCallInfo(chunkId, symbolName?): { calls: string[], calledBy: string[] } | null
  expandImportGraph(seedFiles: Set<string>): Set<string>
  fetchBestChunks(filePaths: string[]): CodeChunkSummary[]

SqlCodeGraphProvider  [src/search/context/sql-code-graph.ts]:
  implements CodeGraphProvider backed by SQLite
  encapsulates all code_refs, code_imports, code_chunks SQL in one file
  delegates expandImportGraph → importGraph.expandViaImportGraph(db, seedFiles)
  delegates fetchBestChunks  → importGraph.fetchBestChunks(db, filePaths)


ContextBuilder.build(task, options?)
   { sources: { code: 6, git: 5, memory: 4 },
     affectedFiles=[], minScore=0.25, useMMR=true, mmrLambda=0.7 }
         │
         ├── codeK = sources.code ?? 6, gitK = sources.git ?? 5
         │   memoryK = sources.memory ?? 4
         ├── results = await search.search(task, {
         │       sources: { code: codeK, git: gitK, memory: memoryK },
         │       minScore, useMMR, mmrLambda })
         │
         ├── parts = [`# Context for: "${task}"\n`]
         │
         ├── codeHits = results.filter(type==='code').slice(0, codeK)
         │   formatCodeResults(codeHits, parts, codeGraph?):
         │     group by filePath
         │     for each chunk:
         │       label = "function `name` (L10-50)" or "L10-50"
         │       callInfo = codeGraph.getCallInfo(chunkId, name):
         │         SELECT DISTINCT symbol_name FROM code_refs WHERE chunk_id = ?
         │         SELECT cc.file_path, cc.name FROM code_refs cr
         │                JOIN code_chunks cc WHERE cr.symbol_name = ?
         │         → { calls: ['validateToken'], calledBy: ['authenticate'] }
         │       "**{label}** — 87% match *(calls: X | called by: Y)*"
         │       ```typescript\n{content}\n```
         │
         ├── formatCodeGraph(codeHits, parts, codeGraph?):
         │     hitFiles = set of file paths from codeHits
         │     expandViaImportGraph(db, hitFiles):
         │       2-hop BFS on code_imports table:
         │         SELECT imports_path WHERE file_path = seed
         │         SELECT DISTINCT file_path WHERE imports_path LIKE basename
         │       clusterSiblings: 3+ hits from same dir → include all dir siblings
         │     fetchBestChunks(db, graphFiles):
         │       SELECT file_path, content, name, chunk_type, start_line, end_line
         │       FROM code_chunks WHERE file_path = ?
         │       ORDER BY (end_line - start_line) DESC LIMIT 1   ← largest chunk
         │     "## Related Code (Import Graph)\n..."
         │
         ├── formatGitResults(results, gitK, parts):
         │     filter type='commit', slice to limit
         │     "## Related Git History\n"
         │     "**[abc1234]** fix auth bypass *(Jane, 2024-01-15, 92%)*"
         │       Files: src/auth/middleware.ts
         │       ```diff\n@@ ...\n+if (!token) ...\n```
         │
         ├── formatCoEdits(affectedFiles, parts, coEdits?):
         │     for each file in affectedFiles (max 3):
         │       coEdits.suggest(file, 4)
         │     "## Co-Edit Patterns\n"
         │     "- **src/api.ts** → also tends to change: src/routes.ts (18x)"
         │
         ├── formatPatternResults(results, memoryK, parts):
         │     filter type='pattern', slice to limit
         │     "## Learned Patterns\n"
         │     "**api** — 87% success, 91% match"
         │     "Approach: ...", "Lesson: ..."
         │
         └── if docsSearch:
               docs = await docsSearch(task, { k: codeK })
               formatDocuments(docs):
                 "## Relevant Documents\n\n"
                 "**[collection]** title — _context_\n\n{content}"
```

**ContextBuilder is assembled in `createSearchAPI()` (`src/engine/search-factory.ts`):**

```
gitPlugin = registry.firstByType(PLUGIN.GIT)
coEdits   = isCoEditPlugin(gitPlugin) ? gitPlugin.coEdits : undefined
codeGraph = new SqlCodeGraphProvider(db)
docsSearch = async (query, opts?) => {
  const d = registry.firstByType(PLUGIN.DOCS)
  if (!d || !isSearchable(d)) return []
  return d.search(query, opts)
}
new ContextBuilder(compositeVectorSearch, coEdits, codeGraph, docsSearch)
```

### 11.8 DocumentSearch

```
DocumentSearch({ db, embedding, hnsw, vecCache, reranker? })

.search(query, { collection?, k=8, minScore=0, mode='hybrid' })
         │
         ├── mode='keyword' → _dedup(_searchBM25(q, k*2, minScore, coll), k)
         ├── mode='vector'  → _dedup(await _searchVector(q, k*2, minScore, coll), k)
         └── mode='hybrid':
               fetchK = k*2
               parallel: _searchVector(q, fetchK, 0, coll)  → vecHits
               parallel: _searchBM25(q, fetchK, 0, coll)    → bm25Hits

               if both empty → []
               if bm25 empty → _dedup(vecHits.filter(>=minScore), k)
               if vec empty  → _dedup(bm25Hits.filter(>=minScore), k)

               fused = reciprocalRankFusion([vecHits, bm25Hits])
               allById = Map<chunkId, SearchResult> from [...vecHits, ...bm25Hits]
               for each fused result: get original + merge score
               filter score >= minScore
               deduped = _dedup(results, k)
               → _rerankResults(query, deduped)


_searchVector(query, k, minScore, collection?):
  if hnsw.size === 0 → []
  queryVec = embedding.embed(query)
  searchK = k
  if collection:
    collCount = SELECT COUNT(*) FROM doc_chunks WHERE collection = ?
    total     = SELECT COUNT(*) FROM doc_chunks
    ratio = max(3, min(50, ceil(total / collCount)))
    searchK = min(k * ratio, hnsw.size)
    ← proportional over-fetch for shared HNSW across all doc collections
  hits = hnsw.search(queryVec, searchK)
  for each hit:
    chunk = SELECT * FROM doc_chunks WHERE id = ?
    if collection && chunk.collection !== collection → skip
    {type:'document', score, filePath: file_path, content,
     context: _getDocContext(collection, file_path),
     metadata: { collection, title, seq, chunkId: id }}


_searchBM25(query, k, minScore, collection?):
  _buildDocsFTS(query):
    strip FTS5 special chars + boolean operators + punctuation separators
    remove STOP_WORDS (the, is, at, a, an, and, or, but, in, with, ...)
    filter length >= 3
    wrap remaining words: "word" joined with OR   ← natural language OR-mode
    → '' if nothing left
  SELECT d.*, bm25(fts_docs, 10.0, 2.0, 5.0, 1.0) AS bm25_score
  FROM fts_docs JOIN doc_chunks
  WHERE fts_docs MATCH ? [AND d.collection = ?]
  ORDER BY bm25_score ASC LIMIT k*2
  ← title×10, file_path×5, content×2, collection×1


_dedup(results, k):
  keep only highest-scoring result per file_path
  → prevents 4 chunks from same document filling top-k
  sort by score DESC, slice to k


_getDocContext(collection, filePath):
  walk hierarchy upward: '/src/auth/middleware.ts' → '/src/auth' → '/src' → '/'
  for each prefix:
    SELECT context FROM path_contexts WHERE collection = ? AND path = ?
  fallback: SELECT context FROM collections WHERE name = ?
  → most specific context description found, or undefined


_rerankResults(query, results):
  if !reranker || results.length ≤ 1 → return as-is
  dynamic import { rerank } from 'brainbank'
  → rerank(query, results, reranker)
```

---

## 12. Infrastructure

### 12.1 Database

```
Database  [src/db/database.ts]
wrapper over better-sqlite3

constructor(dbPath):
  fs.mkdirSync(dirname, { recursive: true })   ← auto-create parent dirs
  new BetterSqlite3(dbPath)
  PRAGMA journal_mode = WAL        ← parallel reads, serialized writes
  PRAGMA busy_timeout = 5000       ← wait up to 5s for write lock (vs SQLITE_BUSY)
  PRAGMA synchronous = NORMAL      ← fsync on checkpoint, not every commit
  PRAGMA foreign_keys = ON         ← enforce FK + CASCADE DELETE
  createSchema(db)                 ← idempotent DDL (IF NOT EXISTS)

transaction<T>(fn: () => T): T
  db.transaction(fn)()             ← auto-commit on success, rollback on throw

batch(sql, rows[][])
  one transaction, one prepared stmt, run for each row array

prepare(sql) → BetterSqlite3.Statement   ← cached internally by better-sqlite3
exec(sql)    ← raw SQL, no result (DDL, PRAGMA)
close()
```

### 12.2 HNSWIndex

```
HNSWIndex(dims, maxElements=2_000_000, M=16, efConstruction=200, efSearch=50)
  [src/providers/vector/hnsw-index.ts]

init(): Promise<this>
  dynamic import 'hnswlib-node'
  _createIndex():
    HNSW = lib.default?.HierarchicalNSW ?? lib.HierarchicalNSW   ← CJS/ESM compat
    new HNSW('cosine', dims)
    initIndex(maxElements, M, efConstruction)
    setEf(efSearch)
    _ids = new Set()
  returns this   ← chainable: await new HNSWIndex(384).init()

add(vector, id):
  if _ids.has(id) → return   (idempotent: duplicate IDs silently skipped)
  if _ids.size >= maxElements → throw "HNSW index full"
  _index.addPoint(Array.from(vector), id)
  _ids.add(id)

remove(id):
  if !_ids.has(id) → return   (safe no-op)
  _index.markDelete(id)   ← soft delete (hnswlib feature, no memory freed)
  _ids.delete(id)

search(query, k):
  if !_index || _ids.size === 0 → []
  actualK = min(k, _ids.size)
  result = _index.searchKnn(Array.from(query), actualK)
  → [{ id, score: 1 - result.distances[i] }]
    ← cosine distance [0,2] → score [-1,1] with 1=identical

save(path):
  if _ids.size === 0 → skip (don't write empty index files)
  _index.writeIndexSync(path)

tryLoad(path, expectedCount): boolean
  if !existsSync(path) → false
  _index.readIndexSync(path)
  loadedCount = _index.getCurrentCount()
  if loadedCount !== expectedCount:
    this.reinit()   ← clear stale graph
    return false    ← caller rebuilds from SQLite
  _ids = new Set(_index.getIdsList())
  _index.setEf(efSearch)   ← restore after load (hnswlib doesn't persist ef)
  return true

reinit():
  if !_lib → throw "HNSW not initialized — call init() first"
  _createIndex()   ← fresh empty index, same dims/params
  ← called by: reembed service, failed tryLoad, force-init with mismatch

size:        number → _ids.size
maxElements: number → _maxElements
```

### 12.3 HNSW Loader

```
hnsw-loader.ts  [src/providers/vector/hnsw-loader.ts]
Utilities for persisting and loading HNSW indexes to/from disk.
Extracted from initializer.ts to keep vector I/O in the providers layer.

hnswPath(dbPath, name): string
  → join(dirname(dbPath), 'hnsw-{name}.index')
  e.g. '.brainbank/brainbank.db' → '.brainbank/hnsw-code.index'

countRows(db, table): number
  → SELECT COUNT(*) as c FROM {table}

saveAllHnsw(dbPath, kvHnsw, sharedHnsw, privateHnsw):
  try {
    kvHnsw.save(hnswPath(dbPath, 'kv'))
    for [name, { hnsw }] in sharedHnsw: hnsw.save(hnswPath(dbPath, name))
    for [name, hnsw]   in privateHnsw: hnsw.save(hnswPath(dbPath, name))
  } catch { /* non-fatal: next startup rebuilds from SQLite */ }

loadVectors(db, table, idCol, hnsw, cache):
  SELECT {idCol}, embedding FROM {table}   ← iterate via .iterate()
  for each row:
    vec = new Float32Array(buf.buffer.slice(byteOffset, byteOffset + byteLength))
    hnsw.add(vec, row[idCol])
    cache.set(row[idCol], vec)

loadVecCache(db, table, idCol, cache):
  same as loadVectors but skips hnsw.add()
  ← used when HNSW graph already loaded from .index file
  ← only populates the Map<id, Float32Array> cache
```

### 12.4 Embedding Providers

All implement `EmbeddingProvider`:

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
  cache:   .model-cache/ (downloaded on first use)
  offline: no API key, runs entirely in-process

  _getPipeline() [lazy singleton, promise-deduped]:
    if _pipeline → return it
    if _pipelinePromise → await it (dedup concurrent callers)
    _pipelinePromise = async () => {
      { pipeline, env } = await import('@xenova/transformers')
      env.cacheDir = '.model-cache'
      pipeline('feature-extraction', modelName, { quantized: true })
    }

  embed(text):
    pipe(text, { pooling:'mean', normalize:true }) → output.data

  embedBatch(texts):
    BATCH_SIZE = 32
    for each batch: pipe(batch, ...) → output.data (flat Float32Array)
    for j in batch: output.data.slice(j*dims, (j+1)*dims)
    ← MUST slice, not view: pipeline may reuse the underlying buffer


OpenAIEmbedding({ apiKey?, model='text-embedding-3-small', dims?, baseUrl?, timeout=30s })
  dims: 1536 (3-small) | 3072 (3-large) | 1536 (ada-002)
  custom dims only supported on text-embedding-3-*

  embedBatch:
    MAX_BATCH = 100, BATCH_DELAY_MS = 100
    chunk input, 100ms pause between chunks
    POST /v1/embeddings { model, input, dimensions? }
    response: { data: [{embedding: number[], index}] }
    sort by index → Float32Array[]

  token-limit retry logic:
    400 + "maximum context length" / "maximum input length":
      batch > 1 → retry each item individually at slice(0, 8000)
      single    → retry at slice(0, 6000), max 1 retry


PerplexityEmbedding({ apiKey?, model='pplx-embed-v1-4b', dims?, baseUrl?, timeout=30s })
  dims: 2560 (4b) | 1024 (0.6b)
  Matryoshka: custom dims via body.dimensions

  Response: base64-encoded signed int8 vectors
  decodeBase64Int8(b64, expectedDims):
    atob(b64) → binary string
    Int8Array: charCode << 24 >> 24   ← sign-extend each byte
    → Float32Array (cast int8 values, do not normalize)


PerplexityContextEmbedding({ apiKey?, model='pplx-embed-context-v1-4b', dims?, ... })
  dims: 2560 (4b) | 1024 (0.6b)
  endpoint: POST /v1/contextualizedembeddings
  KEY DIFFERENCE: input is string[][] (documents × chunks)
    chunks in same "document" share context → better retrieval quality

  embed(text):    wraps as [[text]]   (single doc, single chunk)
  embedBatch(texts):
    splitIntoDocuments(texts):
      MAX_CHARS_PER_DOC = 80_000 (~20k tokens at ~4 chars/token)
      if adding text exceeds limit → push current doc, start new
    for each sub-doc: _request([[...texts]])
  Response: { data: [{ index, data: [{ index, embedding }] }] }
  flattenContextResponse(): sort docs by index → sort chunks by index
                             → flat Float32Array[] via decodeBase64Int8


Provider resolution:  [src/providers/embeddings/resolve.ts]
  resolveEmbedding(key):
    'local'              → new LocalEmbedding()
    'openai'             → new OpenAIEmbedding()
    'perplexity'         → new PerplexityEmbedding()
    'perplexity-context' → new PerplexityContextEmbedding()
    default              → new LocalEmbedding()

  providerKey(p: EmbeddingProvider): EmbeddingKey
    p.constructor.name:
      'OpenAIEmbedding'             → 'openai'
      'PerplexityEmbedding'         → 'perplexity'
      'PerplexityContextEmbedding'  → 'perplexity-context'
      anything else                 → 'local'
    ← stored in embedding_meta for auto-resolution on next startup
```

### 12.5 Rerankers

```typescript
interface Reranker {
    rank(query: string, documents: string[]): Promise<number[]>
    close?(): Promise<void>
}
```

```
Qwen3Reranker({ modelUri?, cacheDir?, contextSize=2048 })
  [src/providers/rerankers/qwen3-reranker.ts]
  model:   Qwen3-Reranker-0.6B-Q8_0 (~640MB GGUF, auto-downloaded from HuggingFace)
  engine:  node-llama-cpp (optional peer dependency)
  cache:   ~/.cache/brainbank/models/

  _ensureLoaded() [lazy, singleton, promise-deduped]:
    getLlama() → llama engine
    resolveModelFile(modelUri, cacheDir) → local path (downloads if needed)
    llama.loadModel({ modelPath })
    model.createRankingContext({ contextSize, flashAttention: true })
      fallback without flashAttention if not supported by GPU

  rank(query, documents):
    1. deduplicate: Set(documents) → uniqueTexts (score each unique text once)
    2. truncate each doc to context budget:
         queryTokens = model.tokenize(query).length
         maxDocTokens = contextSize - 200 - queryTokens
         if tokens > max: model.detokenize(tokens.slice(0, maxDocTokens))
    3. context.rankAll(query, truncated) → scores[]
    4. build Map<text, score> from uniqueTexts + scores
    5. return scores in original document order (handles duplicates correctly)

  close(): dispose context + dispose model
```

---

## 13. Services

### 13.1 Watch Service

```
Watcher  [src/services/watch.ts]

new Watcher(reindexFn, indexers: Map<string,Plugin>, repoPath, options)
  { paths?, debounceMs=2000, onIndex?, onError? }
         │
         ├── _collectCustomPatterns():
         │     for each isWatchable plugin in indexers.values():
         │       _customPatterns.push({ indexer, patterns: plugin.watchPatterns() })
         │
         ├── _startWatching():
         │     for each path in paths:
         │       supportsRecursive = mac or win
         │       fs.watch(path, { recursive }, (_event, filename) => {
         │         if !active || !filename → skip
         │         if !_shouldWatch(filename) → skip
         │         _pending.add(filename)
         │         clearTimeout + setTimeout(_processPending, debounceMs)
         │       })
         │
         ├── _shouldWatch(filename):
         │     parts = filename.split(path.sep)
         │     any part in IGNORE_DIRS → false
         │     basename in IGNORE_FILES → false
         │     isSupported(filename) → true   (code file extension)
         │     matchCustomPlugin(resolve(repoPath, filename)) → true
         │     else → false
         │
         ├── _matchCustomPlugin(absPath):
         │     rel = path.relative(repoPath, absPath)
         │     for { indexer, patterns }:
         │       _matchGlob(rel, pattern):
         │         '**/ext' → filePath.endsWith(ext)
         │         '*.ext'  → filePath.endsWith(ext)
         │         else     → filePath === pattern
         │     → Plugin | null
         │
         └── _processPending() [serialized via _flushing flag]:
               files = [...pending]; pending.clear()
               needsReindex = false
               for each file:
                 absPath = resolve(repoPath, file)
                 customIndexer = _matchCustomPlugin(absPath)
                 if customIndexer && isWatchable:
                   handled = await customIndexer.onFileChange(absPath, detectEvent(absPath))
                   detectEvent: try accessSync → 'update', catch → 'delete'
                   if handled: onIndex(file, indexer.name); continue
                 if isSupported(file):
                   needsReindex = true
                   onIndex(file, 'code')
               if needsReindex: await reindexFn()
               if pending.size > 0:
                 timer = setTimeout(_processPending, debounceMs)

Watcher.close()  → active=false, clearTimeout, close all fs.FSWatcher instances
Watcher.active   → boolean (getter)
```

### 13.2 Reembed Engine

**Pattern: Atomic Swap — old data untouched until all new vectors are ready.**

```
reembedAll(db, embedding, hnswMap, plugins, options?, persist?)
  [src/engine/reembed.ts]
         │
         ├── collectTables(plugins):
         │     for each isReembeddable plugin: byVectorTable.set(vectorTable, config)
         │     CORE_TABLES (not plugin-owned, always included):
         │       kv: kv_data → kv_vectors (fkColumn: data_id)
         │           textBuilder: (r) => String(r.content)
         │       memory: memory_patterns → memory_vectors (fkColumn: pattern_id)
         │           textBuilder: (r) => "${task_type} ${task} ${approach}"
         │     deduplicates by vectorTable (multi-repo plugins share same table)
         │
         ├── for each table:
         │     exists? SELECT COUNT(*) FROM sqlite_master WHERE name=textTable → skip if 0
         │     totalCount = SELECT COUNT(*) FROM textTable
         │     if totalCount === 0 → skip
         │
         │     PHASE 1 — build new vectors in temp table (safe, old data untouched):
         │       tempTable = '_reembed_{vectorTable}'
         │       DROP TABLE IF EXISTS {tempTable}
         │       CREATE TABLE {tempTable} AS SELECT * FROM {vectorTable} WHERE 0
         │       for offset 0..total step batchSize:
         │         SELECT * FROM textTable LIMIT batchSize OFFSET offset
         │         texts = rows.map(r => table.textBuilder(r))
         │         vectors = await embedding.embedBatch(texts)
         │         TRANSACTION: INSERT INTO temp (fk, embedding) per item
         │         onProgress(tableName, processed, total)
         │       ← if embedBatch fails mid-batch: old data intact, temp partial
         │
         │     PHASE 2 — atomic swap:
         │       TRANSACTION:
         │         DELETE FROM {vectorTable}
         │         INSERT INTO {vectorTable} SELECT * FROM temp
         │       ← all-or-nothing: if fails, old data restored (SQLite txn)
         │
         │     finally: DROP TABLE IF EXISTS {tempTable}   ← always clean up
         │
         │     rebuildHnsw(db, table, entry.hnsw, entry.vecs):
         │       vecs.clear(); hnsw.reinit()
         │       SELECT {fkColumn} as id, embedding FROM {vectorTable}
         │       for each row:
         │         vec = new Float32Array from Buffer (handle byteOffset correctly)
         │         hnsw.add(vec, id); vecs.set(id, vec)
         │
         ├── UPSERT embedding_meta: provider, dims, reembedded_at
         │
         └── if persist:
               setEmbeddingMeta(db, embedding)   ← update provider_key too
               saveAllHnsw(persist.dbPath, persist.kvHnsw, persist.sharedHnsw, new Map())

returns ReembedResult: { counts: Record<string, number>, total: number }
  counts keys: 'code', 'git', 'docs', 'kv', 'memory' (only tables with data)
```

### 13.3 EmbeddingMeta

```
embedding_meta table (key/value):
  'provider'     → 'LocalEmbedding' | 'OpenAIEmbedding' | ...
  'dims'         → '384' | '1536' | '2560' | ...
  'provider_key' → 'local' | 'openai' | 'perplexity' | 'perplexity-context'
  'indexed_at'   → ISO timestamp

setEmbeddingMeta(db, embedding):
  UPSERT all four keys using embedding.constructor.name and providerKey(embedding)

getEmbeddingMeta(db): EmbeddingMeta | null
  SELECT each key individually
  return null if provider or dims row missing

detectProviderMismatch(db, embedding):
  meta = getEmbeddingMeta(db)
  if !meta → null  (first run, no stored data)
  currentName = embedding.constructor.name
  mismatch = meta.dims !== embedding.dims || meta.provider !== currentName
  → { mismatch: boolean, stored: 'LocalEmbedding/384', current: 'OpenAIEmbedding/1536' }

Startup behavior (earlyInit):
  mismatch + !force → db.close() + throw
    "BrainBank: Embedding dimension mismatch (stored: X/384, current: Y/1536).
     Run brain.reembed() to re-index with the new provider, or switch back."
  mismatch + force  → skipVectorLoad = true
    ← allows init with wrong dims for the reembed() flow
```

---

## 14. Engine Layer

### 14.1 IndexAPI

```
IndexAPI({ registry, gitDepth, emit })  [src/engine/index-api.ts]

index({ modules?, gitDepth?, forceReindex?, onProgress? })
  want = new Set(modules ?? ['code', 'git', 'docs'])

  if want.has('code'):
    for each mod in registry.allByType('code') that isIndexable:
      label = mod.name === 'code' ? 'code' : mod.name
      onProgress(label, 'Starting...')
      r = await mod.index({ forceReindex, onProgress: (f,i,t) => onProgress(label, ...) })
      accumulate result.code: indexed+=, skipped+=, chunks+=

  if want.has('git'):
    for each mod in registry.allByType('git') that isIndexable:
      r = await mod.index({ depth: gitDepth ?? config.gitDepth, onProgress: wrap })
      accumulate result.git: indexed+=, skipped+=

  if want.has('docs') && registry.has('docs'):
    docsPlugin = registry.get('docs')
    if isDocsPlugin(docsPlugin):
      result.docs = await docsPlugin.indexDocs({ onProgress: wrap })

  for each custom plugin NOT in {'code','git','docs'} that isIndexable:
    r = await mod.index({ onProgress: wrap })
    result[mod.name] = r

  emit('indexed', result)
  → { code?, git?, docs?, [customName]? }

indexCode({ forceReindex?, onProgress? })
  mods = registry.allByType('code').filter(isIndexable)
  if !mods.length → throw "BrainBank: Indexer 'code' is not loaded. Add .use(code())"
  accumulate → { indexed, skipped, chunks }

indexGit({ depth?, onProgress? })
  mods = registry.allByType('git').filter(isIndexable)
  if !mods.length → throw "BrainBank: Indexer 'git' is not loaded. Add .use(git())"
  accumulate → { indexed, skipped }
```

### 14.2 SearchAPI

```
SearchAPI({ search?, bm25?, registry, config, kvService, contextBuilder? })
  [src/engine/search-api.ts]

NOTE: SearchAPI is ALWAYS created even when search is undefined.
      BrainBank can unconditionally delegate to it.

getContext(task, options?):
  if !contextBuilder → return ''
  → contextBuilder.build(task, options)

search(query, options?):
  lists = []
  if search: lists.push(await search.search(query, options))
  else if registry.has('docs'): lists.push(await _collectDocs(query, { k:8 }))
  lists.push(...await _collectCustomPlugins(query, options))
  if lists.length === 0 → []
  if lists.length === 1 → lists[0]
  → reciprocalRankFusion(lists)

hybridSearch(query, options?):
  [see §11.4 for full flow]

searchBM25(query, options?):
  → bm25?.search(query, options) ?? []

rebuildFTS():
  → bm25?.rebuild?.()

_collectDocs(query, options?):
  plugin = registry.firstByType(PLUGIN.DOCS)
  if !plugin || !isSearchable(plugin) → []
  → plugin.search(query, options)

_collectCustomPlugins(query, options?):
  builtinTypes = { 'code', 'git', 'docs' }
  for each mod in registry.all NOT in builtinTypes that isSearchable:
    hits = await mod.search(query, options)
    if hits.length > 0: lists.push(hits)
  → SearchResult[][]

_collectKvCollections(query, sources: Record<string, number>):
  reserved = { 'code', 'git', 'docs' }
  for [name, k] in sources NOT in reserved:
    hits = await kvService.collection(name).searchAsResults(query, k)
    if hits.length > 0: lists.push(hits)
  → SearchResult[][]
```

### 14.3 SearchFactory

```
createSearchAPI(db, embedding, config, registry, kvService, sharedHnsw)
  [src/engine/search-factory.ts]
  → SearchAPI | undefined

  codeMod = sharedHnsw.get(PLUGIN.CODE)   ← set by CodePlugin.initialize()
  gitMod  = sharedHnsw.get(PLUGIN.GIT)    ← set by GitPlugin.initialize()
  memPlugin = registry.firstByType(PLUGIN.MEMORY)
  memMod    = memPlugin && isHnswPlugin(memPlugin) ? memPlugin : undefined

  if !codeMod && !gitMod && !memMod → return undefined
    ← no CompositeVectorSearch possible; SearchAPI returns undefined
    ← BrainBank._searchAPI = undefined (docs-only mode still works via SearchAPI)

  code     = codeMod ? new CodeVectorSearch({ db, hnsw, vecs }) : undefined
  git      = gitMod  ? new GitVectorSearch({ db, hnsw }) : undefined
  patterns = memMod  ? new PatternVectorSearch({ db, hnsw, vecs }) : undefined

  search = new CompositeVectorSearch({ code, git, patterns, embedding })
  bm25   = new KeywordSearch(db)

  gitPlugin = registry.firstByType(PLUGIN.GIT)
  coEdits   = isCoEditPlugin(gitPlugin) ? gitPlugin.coEdits : undefined
  codeGraph = new SqlCodeGraphProvider(db)
  docsSearch = async (query, opts?) => { ... }

  contextBuilder = new ContextBuilder(search, coEdits, codeGraph, docsSearch)

  return new SearchAPI({
    search, bm25, registry, config, kvService, contextBuilder
  })
```

---

## 15. CLI Layer

**Pattern: Command + Factory**

### 15.1 CLI Factory — createBrain()

```
createBrain(repoPath?)  [src/cli/factory/index.ts]
         │
         ├── rp = repoPath ?? getFlag('repo') ?? '.'
         ├── config = await loadConfig()
         │     searches .brainbank/ for: config.json, config.ts, config.js, config.mjs
         │     JSON → JSON.parse; others → dynamic import (mod.default ?? mod)
         │     cached in module-level _configCache (reset via resetConfigCache())
         │
         ├── folderPlugins = await discoverFolderPlugins()
         │     reads .brainbank/plugins/*.ts|js|mjs (sorted)
         │     for each file: dynamic import → must export default Plugin with .name
         │     warns "⚠ {file}: must export a default Plugin" on bad exports
         │     cached in _folderPluginsCache
         │
         ├── brainOpts = { repoPath: rp, ...(config.brainbank ?? {}) }
         │   if config.maxFileSize: brainOpts.maxFileSize = ...
         │
         ├── setupProviders(brainOpts, config):
         │     rerankerFlag = getFlag('reranker') ?? config.reranker
         │       'qwen3' → brainOpts.reranker = new Qwen3Reranker()
         │     embFlag = getFlag('embedding') ?? config.embedding ?? BRAINBANK_EMBEDDING env
         │       if set → provider = await resolveEmbeddingKey(embFlag)
         │                brainOpts.embeddingProvider = provider
         │                brainOpts.embeddingDims = provider.dims
         │
         ├── brain = new BrainBank(brainOpts)
         │
         ├── builtins = config.plugins ?? ['code', 'git', 'docs']
         ├── registerBuiltins(brain, rp, builtins, config):
         │     resolvedRp = path.resolve(rp)
         │     hasRootGit = existsSync(join(resolvedRp, '.git'))
         │     gitSubdirs = !hasRootGit ? detectGitSubdirs(resolvedRp) : []
         │       ← dirs not starting with '.' or 'node_modules' that have own .git
         │
         │     codeEmb = config.code?.embedding ? resolveEmbeddingKey(...) : undefined
         │     gitEmb  = config.git?.embedding  ? ...
         │     docsEmb = config.docs?.embedding ? ...
         │     ignoreFlag = getFlag('ignore')
         │     mergedIgnore = [...(config.code?.ignore ?? []), ...(cliIgnore)]
         │
         │     loadCodePlugin() ← try import('@brainbank/code'), null if not installed
         │     loadGitPlugin()  ← try import('@brainbank/git'),  null if not installed
         │     loadDocsPlugin() ← try import('@brainbank/docs'), null if not installed
         │     warn "⚠ @brainbank/X not installed" if in builtins but null
         │
         │     if gitSubdirs.length > 0 (multi-repo mode):
         │       log "Multi-repo: found N git repos: ..."
         │       for each sub:
         │         codeFactory({ repoPath:sub.path, name:'code:{sub.name}', embeddingProvider:codeEmb, ... })
         │         gitFactory({ repoPath:sub.path, name:'git:{sub.name}', embeddingProvider:gitEmb, ... })
         │     else (single repo):
         │       codeFactory({ repoPath:rp, embeddingProvider:codeEmb, maxFileSize, ignore })
         │       gitFactory({ embeddingProvider:gitEmb, depth, maxDiffBytes })
         │     docsFactory({ embeddingProvider:docsEmb })
         │
         ├── for each folderPlugin: brain.use(plugin)
         ├── for each config.indexers: brain.use(plugin)
         │
         └── return brain   ← NOT yet initialized, .use() still allowed

registerConfigCollections(brain, config):
  collections = config?.docs?.collections
  if !collections → return
  docsPlugin = brain.docs
  if !docsPlugin?.addCollection → return
  for each coll:
    absPath = path.resolve(coll.path)
    docsPlugin.addCollection({ name, path:absPath, pattern??'**/*.md', ignore, context })
    try/catch: skip if already registered (INSERT OR REPLACE handles it)
```

**Config priority (highest to lowest):**

```
1. CLI flags:    --embedding openai, --reranker qwen3, --ignore "sdk/**"
2. config.json:  .brainbank/config.json (or .ts/.js/.mjs)
3. DB meta:      embedding_meta table → auto-resolve provider on restart
4. Defaults:     local embedding, 384d, no reranker
```

### 15.2 Commands

| Command | Handler | Description |
|---------|---------|-------------|
| `index [path]` | `cmdIndex` | Interactive: scan → checkbox prompt → index |
| `collection add/list/remove` | `cmdCollection` | Manage doc collections via DocsPlugin |
| `kv add/search/list/trim/clear` | `cmdKv` | KV store operations |
| `docs [--collection name]` | `cmdDocs` | Index doc collections |
| `dsearch <query>` | `cmdDocSearch` | Search docs only |
| `search <query>` | `cmdSearch` | Vector search |
| `hsearch <query>` | `cmdHybridSearch` | Hybrid search (best quality) |
| `ksearch <query>` | `cmdKeywordSearch` | BM25 keyword search |
| `context <task>` | `cmdContext` | Get formatted LLM context |
| `context add/list` | `cmdContext` | Manage path contexts |
| `stats` | `cmdStats` | Show index statistics |
| `reembed` | `cmdReembed` | Re-generate all vectors |
| `watch` | `cmdWatch` | File watch + auto-reindex |
| `serve` | `cmdServe` | Start MCP server (stdio) |

**Dynamic source flags in search commands:**

```
parseSourceFlags():
  any --<name> <number> flag is treated as a source filter:
    --code 10    → sources.code = 10
    --git 0      → sources.git = 0 (skip git)
    --docs 5     → sources.docs = 5
    --notes 10   → sources.notes = 10 (KV collection)

NON_SOURCE_FLAGS (value flags, not source filters):
  repo, depth, collection, pattern, context, name, keep,
  reranker, only, docs-path, mode, limit, ignore, meta, k, yes, y, force, verbose


scan.ts (no BrainBank init required):
  scanRepo(repoPath) → ScanResult:
    { repoPath, code: { total, byLanguage },
      git: { commitCount, lastMessage, lastDate } | null,
      docs: [{ name, path, fileCount }],
      config: { exists, ignore?, plugins? },
      db: { exists, sizeMB, lastModified? } | null,
      gitSubdirs: [{ name }] }
  Used by cmdIndex to render tree + checkbox prompt before any indexing
```

---

## 16. SQLite Schema

```
SCHEMA_VERSION = 6  [src/db/schema.ts]

━━━ CODE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

indexed_files
  file_path TEXT PRIMARY KEY
  file_hash TEXT NOT NULL
  indexed_at INTEGER (unixepoch)

code_chunks
  id INTEGER PRIMARY KEY AUTOINCREMENT
  file_path TEXT NOT NULL              ← idx_cc_file
  chunk_type TEXT                      ← 'file'|'function'|'class'|'method'|'interface'|'block'
  name TEXT                            ← function/class name; NULL for generic blocks
  start_line INTEGER
  end_line INTEGER
  content TEXT
  language TEXT
  file_hash TEXT
  indexed_at INTEGER

code_vectors
  chunk_id INTEGER PRIMARY KEY REFERENCES code_chunks(id) ON DELETE CASCADE
  embedding BLOB

code_imports
  file_path TEXT NOT NULL
  imports_path TEXT NOT NULL
  PRIMARY KEY (file_path, imports_path)
  ← idx_ci_imports on imports_path (reverse lookup: who imports X?)

code_symbols
  id INTEGER PRIMARY KEY AUTOINCREMENT
  file_path TEXT     ← idx_cs_file, idx_cs_name
  name TEXT          ← 'ClassName.methodName' for methods
  kind TEXT          ← 'function'|'class'|'method'|'variable'|'interface'
  line INTEGER
  chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE

code_refs
  chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE  ← idx_cr_chunk
  symbol_name TEXT  ← idx_cr_symbol
  ← no UNIQUE: same chunk can call same symbol multiple times

fts_code (FTS5 virtual, content='code_chunks', content_rowid='id')
  columns: file_path, name, content
  tokenizer: porter unicode61
  BM25 weights: file_path×5, name×3, content×1
  triggers: trg_fts_code_insert (AFTER INSERT), trg_fts_code_delete (AFTER DELETE)


━━━ GIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

git_commits
  id INTEGER PRIMARY KEY AUTOINCREMENT
  hash TEXT UNIQUE NOT NULL  ← idx_gc_hash
  short_hash TEXT
  message TEXT
  author TEXT
  date TEXT
  timestamp INTEGER   ← idx_gc_ts DESC (for recency queries)
  files_json TEXT     ← JSON array of changed file paths
  diff TEXT           ← truncated to maxDiffBytes; NULL if empty
  additions INTEGER
  deletions INTEGER
  is_merge INTEGER    ← 0|1; merge commits excluded from vector + BM25 search

git_vectors
  commit_id INTEGER PRIMARY KEY REFERENCES git_commits(id) ON DELETE CASCADE
  embedding BLOB

commit_files
  commit_id INTEGER REFERENCES git_commits(id)  ← idx_cf_path
  file_path TEXT

co_edits
  file_a TEXT NOT NULL
  file_b TEXT NOT NULL
  count INTEGER DEFAULT 1
  PRIMARY KEY (file_a, file_b)
  ← file_a < file_b always (lexicographic sort before insert)

fts_commits (FTS5, content='git_commits', content_rowid='id')
  columns: message, author, diff
  BM25 weights: message×5, author×2, diff×1
  triggers: trg_fts_commits_insert, trg_fts_commits_delete


━━━ DOCUMENTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

collections
  name TEXT PRIMARY KEY
  path TEXT
  pattern TEXT DEFAULT '**/*.md'
  ignore_json TEXT DEFAULT '[]'
  context TEXT
  created_at INTEGER

doc_chunks
  id INTEGER PRIMARY KEY AUTOINCREMENT
  collection TEXT REFERENCES collections(name) ON DELETE CASCADE  ← idx_dc_collection
  file_path TEXT   ← idx_dc_file
  title TEXT
  content TEXT
  seq INTEGER      ← chunk sequence within file (0, 1, 2, ...)
  pos INTEGER      ← character position in original document
  content_hash TEXT  ← idx_dc_hash (incremental skip check)
  indexed_at INTEGER

doc_vectors
  chunk_id INTEGER PRIMARY KEY REFERENCES doc_chunks(id) ON DELETE CASCADE
  embedding BLOB

path_contexts
  collection TEXT NOT NULL
  path TEXT NOT NULL
  context TEXT NOT NULL
  PRIMARY KEY (collection, path)

fts_docs (FTS5, content='doc_chunks', content_rowid='id')
  columns: title, content, file_path, collection
  BM25 weights: title×10, file_path×5, content×2, collection×1
  triggers: trg_fts_docs_insert, trg_fts_docs_delete


━━━ AGENT MEMORY (pattern learning) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

memory_patterns
  id INTEGER PRIMARY KEY AUTOINCREMENT
  task_type TEXT   ← idx_mp_type
  task TEXT
  approach TEXT
  outcome TEXT
  success_rate REAL  ← idx_mp_success
  critique TEXT
  tokens_used INTEGER
  latency_ms INTEGER
  created_at INTEGER  ← idx_mp_created

memory_vectors
  pattern_id INTEGER PRIMARY KEY REFERENCES memory_patterns(id) ON DELETE CASCADE
  embedding BLOB

distilled_strategies
  task_type TEXT PRIMARY KEY
  strategy TEXT
  confidence REAL
  updated_at INTEGER

fts_patterns (FTS5, content='memory_patterns', content_rowid='id')
  columns: task_type, task, approach, critique
  BM25 weights: task_type×3, task×5, approach×5, critique×1
  triggers: trg_fts_patterns_insert, trg_fts_patterns_delete


━━━ KV COLLECTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

kv_data
  id INTEGER PRIMARY KEY AUTOINCREMENT
  collection TEXT   ← idx_kv_collection
  content TEXT
  meta_json TEXT DEFAULT '{}'
  tags_json TEXT DEFAULT '[]'
  expires_at INTEGER NULL   ← NULL = no expiry; int = unix timestamp
  created_at INTEGER   ← idx_kv_created DESC

kv_vectors
  data_id INTEGER PRIMARY KEY REFERENCES kv_data(id) ON DELETE CASCADE
  embedding BLOB

fts_kv (FTS5, content='kv_data', content_rowid='id')
  columns: content, collection
  BM25 weights: content×5, collection×1
  triggers: trg_fts_kv_insert, trg_fts_kv_delete


━━━ METADATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

embedding_meta
  key TEXT PRIMARY KEY
  value TEXT
  ← stores: provider, dims, provider_key, indexed_at

schema_version
  version INTEGER PRIMARY KEY  ← currently 6
  applied_at INTEGER


FTS5 trigger pattern (identical for all tables):
  AFTER INSERT → INSERT INTO fts_X(rowid, col1, col2, ...) VALUES (new.id, ...)
  AFTER DELETE → INSERT INTO fts_X(fts_X, rowid, ...) VALUES ('delete', old.id, ...)
  ← content tables: external content mode; manual sync via triggers
  ← no UPDATE trigger: indexers delete + re-insert on file change
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
    │    WAL + FK + FTS5 triggers + all tables          │
    │                                                   │
    │  resolveStartupEmbedding → openai (explicit)      │
    │                                                   │
    │  detectProviderMismatch:                          │
    │    DB: { provider:'LocalEmbedding', dims:384 }    │
    │    current: { OpenAIEmbedding, 1536 }             │
    │    mismatch + !force → throw (assume matches here)│
    │                                                   │
    │  setEmbeddingMeta(db, openai)                     │
    │                                                   │
    │  new HNSWIndex(1536, 2M).init() → kvHnsw          │
    │  new KVService(db, openai, kvHnsw, new Map())     │
    │  ← brain.collection() NOW WORKS                  │
    └───────────────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────────────────┐
    │               PHASE 2 (lateInit)                  │
    │                                                   │
    │  Load KV:                                         │
    │    tryLoad('hnsw-kv.index', count=45)             │
    │      HIT → loadVecCache (populate Map only)       │
    │      MISS → loadVectors (rebuild HNSW from DB)    │
    │                                                   │
    │  buildPluginContext(...)                          │
    │                                                   │
    │  CodePlugin.initialize(ctx):                      │
    │    getOrCreateSharedHnsw('code') → isNew=true     │
    │    tryLoad('hnsw-code.index', count=1200)         │
    │      HIT → loadVecCache                           │
    │    new CodeWalker(...)                            │
    │                                                   │
    │  GitPlugin.initialize(ctx):                       │
    │    getOrCreateSharedHnsw('git') → isNew=true      │
    │    tryLoad('hnsw-git.index', count=500)           │
    │    new GitIndexer + CoEditAnalyzer                │
    │                                                   │
    │  DocsPlugin.initialize(ctx):                      │
    │    createHnsw(dims, 'doc') → PRIVATE HNSW         │
    │    tryLoad('hnsw-doc.index', count=80)            │
    │    new DocsIndexer + DocumentSearch               │
    │                                                   │
    │  saveAllHnsw():                                   │
    │    write hnsw-kv.index, hnsw-code.index,          │
    │    hnsw-git.index, hnsw-doc.index                 │
    │                                                   │
    │  createSearchAPI():                               │
    │    codeMod = sharedHnsw.get('code')               │
    │    gitMod  = sharedHnsw.get('git')                │
    │    CodeVectorSearch + GitVectorSearch              │
    │    → CompositeVectorSearch                        │
    │    → KeywordSearch                                │
    │    → ContextBuilder(search, coEdits, codeGraph)   │
    │    → SearchAPI                                    │
    │                                                   │
    │  _initialized = true                              │
    │  emit('initialized', { plugins: [code,git,docs] })│
    └───────────────────────────────────────────────────┘
```

### 17.2 Indexing Flow

```
brain.index({ modules: ['code', 'git'] })
         │
    ┌────▼──────────────────────────────────────────┐
    │  CODE                                         │
    │                                               │
    │  CodeWalker._walkRepo() → files               │
    │                                               │
    │  for each file:                               │
    │    FNV-1a(content) === indexed_files.hash?    │
    │      YES → skipped++                          │
    │      NO  → _indexFile(file)                   │
    │              CodeChunker.chunk()              │
    │              extractImports()                 │
    │              build embeddingTexts             │
    │              embedBatch() → vecs              │
    │              extractSymbolsSafe()             │
    │              TRANSACTION:                     │
    │                DELETE old chunks + graph      │
    │                INSERT code_chunks             │
    │                INSERT code_vectors            │
    │                hnsw.add() per chunk           │
    │                INSERT code_imports            │
    │                INSERT code_symbols            │
    │                INSERT code_refs               │
    │                UPSERT indexed_files           │
    └───────────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────────────┐
    │  GIT                                          │
    │                                               │
    │  git.log(500) → commits[]                     │
    │                                               │
    │  PHASE 1 (async git calls):                   │
    │    check DB for each commit hash              │
    │    skip if has_vector                         │
    │    cleanup zombie (data, no vector)           │
    │    git show --numstat + --unified=3           │
    │    build embedding text                       │
    │                                               │
    │  embedBatch(all new texts) → vecs             │
    │                                               │
    │  PHASE 2 (one transaction):                   │
    │    INSERT git_commits                         │
    │    INSERT commit_files per file               │
    │    INSERT git_vectors                         │
    │                                               │
    │  PHASE 3:                                     │
    │    hnsw.add() + vecCache.set() per commit     │
    │    _computeCoEdits(newCommitIds)              │
    │      pairs (a<b) → UPSERT co_edits count+1   │
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
.search(query)         .search(query)               .search(query)
    │                      │                             │
embedding.embed()     sanitizeFTS()              DocumentSearch
    │                 FTS5 MATCH                  _searchVector
HNSW.search()        normalizeBM25()             + _searchBM25
SELECT chunks/          │                        RRF → _dedup
commits                 │                             │
    │               [kwResults]                  [docResults]
[vecResults]
    │                   │                             │
    └─────────────────── ────────────────────────────┘
                        │
          resultLists = [vec, bm25, docs]
          + custom plugin lists (if any)
          + KV collection lists (if --notes 5 etc)
                        │
          reciprocalRankFusion(resultLists, k=60)
          ┌─────────────────────────────────────┐
          │  key = type-specific unique string  │
          │  rrfScore += 1/(60 + rank + 1)      │
          │  accumulate, keep best orig score   │
          │  sort DESC, normalize to 0..1       │
          └─────────────────────────────────────┘
                        │
          if reranker:
            rerank(query, fused, reranker)
            position-aware: rrfWeight * score + (1-w) * rerankerScore
                        │
                        ▼
          [{ type:'code', score:0.95, filePath:'src/auth.ts', ... },
           { type:'commit', score:0.88, content:'add JWT middleware', ... },
           { type:'document', score:0.82, filePath:'docs/auth.md', ... }]
```

### 17.4 Collection Write + Read Flow

```
const errors = brain.collection('debug_errors')

await errors.add('TypeError: null check missing in api.ts:42',
                 { tags: ['critical'], ttl: '7d' })
         │
         ├── embedding.embed(content) → vec           ← FIRST (before any DB writes)
         ├── INSERT kv_data (expires_at = now + 7*86400s)
         │     FTS trigger: INSERT INTO fts_kv(rowid, content, collection)
         ├── INSERT kv_vectors (data_id, vecToBuffer(vec))
         ├── kvHnsw.add(vec, id)    ← SHARED across ALL collections
         └── kvVecs.set(id, vec)


results = await errors.search('null pointer', { mode:'hybrid', tags:['critical'] })
         │
         ├── _pruneExpired() → DELETE rows where expires_at <= now
         │
         ├── parallel:
         │   _searchVector('null pointer', k=5, minScore=0):
         │     embedding.embed('null pointer') → queryVec
         │     _adaptiveSearchK(5):
         │       totalSize=200 KV items / collectionCount=50 = ratio=4
         │       searchK = min(5*4, 200) = 20
         │     kvHnsw.search(queryVec, 20)
         │     SELECT * FROM kv_data WHERE id IN (?) AND collection='debug_errors'
         │
         │   _searchBM25('null pointer', k=5, minScore=0):
         │     sanitizeFTS → '"null" "pointer"'
         │     SELECT d.* FROM fts_kv JOIN kv_data
         │     WHERE MATCH ? AND collection='debug_errors'
         │
         ├── fuseRankedLists([vectorHits, bm25Hits])
         ├── filter score >= 0.15
         ├── slice to k=5
         ├── if reranker: rerank results
         └── _filterByTags(results, ['critical'])
```

### 17.5 Context Building Flow

```
brain.getContext("add rate limiting to the authentication API")
         │
    SearchAPI.getContext(task, options)
         │
    ContextBuilder.build(task):
         │
         ├── CompositeVectorSearch.search(task, { sources: { code: 6, git: 5, memory: 4 } })
         │     embedding.embed(task) → queryVec
         │     CodeVectorSearch  + searchMMR → code_chunks rows
         │     GitVectorSearch              → git_commits rows (no merge)
         │     PatternVectorSearch + searchMMR → memory_patterns rows
         │
         ├── formatCodeResults(codeHits, parts, sqlCodeGraph):
         │     "## Relevant Code\n"
         │     group by file path
         │     SqlCodeGraphProvider.getCallInfo(chunkId, name):
         │       SELECT code_refs + JOIN code_chunks
         │     "**function `validateToken` (L10-50)** — 87% match"
         │     "*(calls: verify, sendError | called by: authenticate)*"
         │     "```typescript\n...\n```"
         │
         ├── formatCodeGraph(codeHits, parts, sqlCodeGraph):
         │     SqlCodeGraphProvider.expandImportGraph(hitFiles):
         │       expandViaImportGraph(db, seedFiles):
         │         2 hops: SELECT imports_path + SELECT importers by basename
         │         clusterSiblings: 3+ hits same dir → include all siblings
         │     SqlCodeGraphProvider.fetchBestChunks(discovered):
         │       largest chunk per file (ORDER BY end_line - start_line DESC)
         │     "## Related Code (Import Graph)\n..."
         │
         ├── formatGitResults(results, 5, parts):
         │     "## Related Git History\n"
         │     "**[abc1234]** feat: add JWT *(Jane, 2024-01-15, 88%)*"
         │     diff snippet (+ and - lines, @@ headers, max 10 lines)
         │
         ├── formatCoEdits(affectedFiles, parts, coEdits):
         │     CoEditAnalyzer.suggest('src/api.ts', 4)
         │     "## Co-Edit Patterns\n"
         │     "- **src/api.ts** → also changes: src/routes.ts (18x)"
         │
         ├── formatPatternResults(results, 4, parts):
         │     "## Learned Patterns\n"
         │     "**api** — 87% success, 94% match"
         │
         └── docsSearch(task, { k: 6 }) → formatDocuments(docs)
               "## Relevant Documents\n\n"
               "**[docs]** Auth Guide — _Main API docs_\n\n{chunk content}"
         │
         └── parts.join('\n')
             → full markdown string for LLM system prompt injection
```

### 17.6 Reembed Flow

```
brain.reembed()   (switch from Local 384d → OpenAI 1536d)
         │
    BrainBank.reembed(options)
         │
         ├── build hnswMap: { 'kv': kvService, 'code': sharedHnsw.get('code'),
         │                    'git': sharedHnsw.get('git'), 'memory': memPlugin, ... }
         │
    reembedAll(db, openaiEmbedding, hnswMap, registry.all, options, persist)
         │
         ├── collectTables(plugins):
         │     CodePlugin.reembedConfig() → code table
         │     GitPlugin.reembedConfig()  → git table
         │     DocsPlugin.reembedConfig() → docs table
         │     CORE_TABLES: kv + memory (always included, not plugin-owned)
         │
         ├── for 'code' table (totalCount=1200):
         │     CREATE TABLE _reembed_code_vectors AS SELECT * FROM code_vectors WHERE 0
         │     for offset 0..1200 step 50:
         │       SELECT * FROM code_chunks LIMIT 50 OFFSET offset
         │       texts = rows.map(textBuilder)
         │       openaiEmbedding.embedBatch(texts) → vecs (1536d!)
         │       INSERT INTO _reembed_code_vectors (chunk_id, embedding)
         │     TRANSACTION:
         │       DELETE FROM code_vectors
         │       INSERT INTO code_vectors SELECT * FROM _reembed_code_vectors
         │     DROP TABLE _reembed_code_vectors
         │     rebuildHnsw(db, table, codeHnsw, codeVecs):
         │       codeVecs.clear(); codeHnsw.reinit()
         │       SELECT chunk_id, embedding FROM code_vectors
         │       codeHnsw.add(vec, id); codeVecs.set(id, vec)
         │
         ├── ... same for git, docs, kv, memory tables ...
         │
         └── setEmbeddingMeta(db, openaiEmbedding)
             saveAllHnsw(dbPath, kvHnsw, sharedHnsw, new Map())

→ { counts: { code:1200, git:500, docs:80, kv:45, memory:0 }, total:1825 }
```

---

## 18. Design Patterns Reference

| # | Pattern | Where used | What it does |
|---|---------|-----------|-------------|
| 1 | **Facade** | `BrainBank` | Single entry point hiding registry, init, plugins, search, index |
| 2 | **Plugin / Extension Point** | `Plugin` + `PluginRegistry` + `PluginContext` | Add data sources without modifying core; auto-discovery via `.brainbank/plugins/` |
| 3 | **Strategy** | `SearchStrategy` (Composite/Keyword); `EmbeddingProvider` | Interchangeable search backends and embedding models |
| 4 | **Registry + Prefix Matching** | `PluginRegistry` | `has('code')` matches `code`, `code:frontend`, `code:backend` |
| 5 | **Two-Phase Construction** | `earlyInit()` / `lateInit()` | Phase 1 creates `KVService`+`kvHnsw` so `collection()` works when plugins call it during Phase 2 `initialize()` |
| 6 | **Factory Method** | `code()`, `git()`, `docs()`, `patterns()`, `createBrain()` | Hide instantiation complexity; `createBrain()` composes the full runtime |
| 7 | **Dependency Injection (Context Object)** | `PluginContext` | Plugins receive all deps through one context object; no imports from core |
| 8 | **Repository** | `PatternStore`, `Collection`, `DocsIndexer` | Encapsulate all read/write for a domain entity behind a clean API |
| 9 | **Observer / EventEmitter** | `BrainBank extends EventEmitter` | `initialized`, `indexed`, `reembedded`, `progress` events |
| 10 | **Flyweight** | `_sharedHnsw` pool | `code:frontend` and `code:backend` share ONE HNSW + vecCache |
| 11 | **Builder** | `ContextBuilder` | Incrementally assembles markdown from code, graph, git, co-edits, patterns, docs |
| 12 | **Composite (Multi-Index)** | `CompositeVectorSearch` | Embeds query once, delegates to Code + Git + Pattern strategies, merges |
| 13 | **Lazy Singleton + Promise Dedup** | `LocalEmbedding._getPipeline()`, `Qwen3Reranker._ensureLoaded()` | Expensive resources loaded on first use; concurrent callers await same promise |
| 14 | **Memento / Persistence** | `HNSWIndex.save()` / `tryLoad()` | Graph persisted post-init; fast warm-up on next start with staleness check |
| 15 | **Adapter** | Embedding providers | OpenAI `number[]`, Perplexity base64 int8, WASM flat Float32Array → unified `Promise<Float32Array>` |
| 16 | **Guard / Precondition** | `_requireInit()` | Descriptive early errors before null-pointer crashes deep in stack |
| 17 | **Template Method** | `plugin.initialize(ctx)` called by `lateInit()` | Initializer controls call sequence; each plugin fills in domain-specific logic |
| 18 | **Atomic Swap** | `reembedTable()` | Build new vectors in temp table → TRANSACTION DELETE+INSERT; old data safe if embedding fails mid-way |
| 19 | **Incremental Processing** | `CodeWalker`, `DocsIndexer`, `GitIndexer` | Content-hash skip; only changed/new content is re-embedded |
| 20 | **Discriminated Union + Type Guards** | `SearchResult` union | `isCodeResult()`, `matchResult()` for exhaustive pattern matching |
| 21 | **Pipeline / Chain** | Hybrid search → RRF → rerank → ContextBuilder | Each stage transforms the result set; composable and independently testable |
| 22 | **LRU Pool** | `@brainbank/mcp` workspace pool | Up to 10 BrainBank instances; evict least-recently-used on overflow |
| 23 | **Decorator** | `rerank()`, call graph annotations in ContextBuilder | Wraps search results with extra scoring/annotations post-retrieval |

---

## 19. Complete Dependency Graph

```
                     ┌──────────────────────────────────────┐
                     │         BrainBank (Facade)           │
                     └──┬──────┬──────┬───────┬─────────────┘
                        │      │      │       │
                ┌───────▼─┐ ┌──▼───┐ ┌▼──────┐ ┌▼─────────────────┐
                │IndexAPI │ │Search│ │Plugin │ │   Initializer    │
                │         │ │API   │ │Reg.   │ │  earlyInit()     │
                └────┬────┘ └──┬───┘ └───┬───┘ │  lateInit()      │
                     │        │          │     └────────┬──────────┘
                     │        │          │              │
          ┌──────────▼────┐   │   ┌──────▼──────────────▼──────────────────┐
          │allByType()    │   │   │                Plugins                 │
          │code/git/docs  │   │   │                                        │
          └──────┬────────┘   │   │  CodePlugin                            │
                 │            │   │    └── CodeWalker                      │
                 │            │   │          ├── CodeChunker               │
           ┌─────▼──────┐     │   │          │     ├── tree-sitter         │
           │ CodeWalker │     │   │          │     └── grammars.ts (20+)   │
           │ GitIndexer │     │   │          ├── extractImports (regex)    │
           │DocsIndexer │     │   │          └── extractSymbols/CallRefs   │
           └─────┬──────┘     │   │                                        │
                 │            │   │  GitPlugin                             │
                 │            │   │    ├── GitIndexer (simple-git)         │
          ┌──────▼────────────▼──┐│   └── CoEditAnalyzer                  │
          │                      ││                                        │
          │   EmbeddingProvider  ││  DocsPlugin                            │
          │  (shared/per-plugin) ││    ├── DocsIndexer (smart chunker)     │
          │                      ││    └── DocumentSearch                  │
          │  LocalEmbedding      ││                                        │
          │  OpenAIEmbedding     ││                                        │
          │  PerplexityEmb.      ││  @brainbank/memory                     │
          │  PerplexityContext.. ││    ├── patterns() → PatternsPlugin     │
          └──────────────────────┘│    │     ├── PatternStore              │
                                  │    │     ├── Consolidator              │
                                  │    │     └── PatternDistiller          │
                                  │    ├── Memory (LLM pipeline)           │
                                  │    └── EntityStore (knowledge graph)   │
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
     │    ├── DocsPlugin.hnsw        (private, per-instance)            │
     │    └── PatternsPlugin.hnsw    (private, per-instance)            │
     │                                                                  │
     │  hnsw-loader.ts:                                                 │
     │    hnswPath, countRows, saveAllHnsw, loadVectors, loadVecCache   │
     │                                                                  │
     │  Qwen3Reranker ──── node-llama-cpp (optional peer dep)           │
     └──────────────────────────────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                       Search Layer                               │
     │                                                                  │
     │  SearchFactory (createSearchAPI)                                  │
     │    ├── sharedHnsw.get('code') → CodeVectorSearch (+ MMR)         │
     │    ├── sharedHnsw.get('git')  → GitVectorSearch                  │
     │    ├── registry.firstByType('memory') → PatternVectorSearch      │
     │    └── CompositeVectorSearch(code, git, patterns, embedding)     │
     │                                                                  │
     │  KeywordSearch ──── FTS5 (SQLite BM25)                           │
     │    ← sanitizeFTS: camelCase split + compound word expansion      │
     │    ← normalizeBM25: sigmoid(abs) → 0..1                         │
     │                                                                  │
     │  reciprocalRankFusion ──── src/lib/rrf.ts                        │
     │    ← fuseRankedLists: generic variant (no SearchResult needed)   │
     │                                                                  │
     │  rerank ──── src/lib/rerank.ts                                   │
     │    ← position-aware: top 1-3 = 75% RRF, 10+ = 40% RRF           │
     │                                                                  │
     │  ContextBuilder                                                   │
     │    ├── CompositeVectorSearch                                      │
     │    ├── CoEditAnalyzer (from GitPlugin via CoEditPlugin interface) │
     │    ├── SqlCodeGraphProvider (CodeGraphProvider interface)         │
     │    │     ← code_refs + code_imports + code_chunks SQL            │
     │    └── docsSearch: (query, opts) => DocsPlugin.search()          │
     │                                                                  │
     │  DocumentSearch (inside @brainbank/docs)                         │
     │    ├── DocsPlugin.hnsw (private HNSW)                            │
     │    ├── _searchVector: adaptive over-fetch ratio                  │
     │    ├── _searchBM25: OR-mode FTS, stop-word filtering             │
     │    └── _dedup: best chunk per file path                          │
     └──────────────────────────────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                       Services                                   │
     │                                                                  │
     │  KVService ──── kvHnsw (shared) + kvVecs + collection Map        │
     │    └── Collection ──── kvHnsw + fts_kv + kv_data                 │
     │          ├── add:    embed → INSERT → hnsw.add()                 │
     │          ├── search: hybrid (fuseRankedLists) + tags + TTL prune │
     │          └── remove: DB first → hnsw.remove() + vecs.delete()   │
     │                                                                  │
     │  reembedAll ──── EmbeddingProvider                               │
     │    ← collectTables: plugins (ReembeddablePlugin) + core tables   │
     │    ← atomic swap: temp table → TRANSACTION DELETE+INSERT         │
     │    └── rebuildHnsw: hnsw.reinit() + loadVectors from new BLOBs  │
     │                                                                  │
     │  Watcher ──── fs.watch                                           │
     │    ├── debounce + serialized flush                               │
     │    ├── custom plugin routing: isWatchable → onFileChange()       │
     │    └── built-in: isSupported → reindexFn()                       │
     │                                                                  │
     │  EmbeddingMeta ──── embedding_meta (SQLite key/value)            │
     │    ← detectProviderMismatch → throw or skipVectorLoad            │
     │    ← providerKey(): constructor.name → canonical key string      │
     └──────────────────────────────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                         CLI                                      │
     │                                                                  │
     │  createBrain()                                                    │
     │    ├── loadConfig (.brainbank/config.json|ts|js|mjs)             │
     │    ├── discoverFolderPlugins (.brainbank/plugins/)                │
     │    ├── setupProviders (--embedding, --reranker flags + config)    │
     │    ├── registerBuiltins:                                          │
     │    │     detectGitSubdirs → multi-repo code:X / git:X plugins    │
     │    │     per-plugin embeddingProvider override                    │
     │    └── new BrainBank() + .use(code/git/docs)                    │
     │                                                                  │
     │  scan.ts:                                                         │
     │    scanRepo() → ScanResult (no BrainBank init, pure fs/git)      │
     │    used by cmdIndex for scan → prompt → index UX flow            │
     │                                                                  │
     │  Commands: index (interactive scan+prompt), search/hsearch/ksearch│
     │    collection, kv, docs/dsearch, context, stats, reembed, watch  │
     │    serve → @brainbank/mcp (stdio MCP server)                     │
     └──────────────────────────────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                     @brainbank/mcp                               │
     │                                                                  │
     │  LRU pool: Map<repoPath, { brain, lastAccess }> max=10           │
     │  6 tools: search, context, index, stats, history, collection     │
     │  findRepoRoot: walk up from cwd looking for .git/               │
     │  BRAINBANK_REPO / BRAINBANK_EMBEDDING / BRAINBANK_RERANKER envs  │
     │  _sharedReranker: created once, shared across all pool entries   │
     │  corruption recovery: delete DB files + retry with fresh instance│
     └──────────────────────────────────────────────────────────────────┘


     ┌──────────────────────────────────────────────────────────────────┐
     │                  @brainbank/memory                               │
     │                                                                  │
     │  Memory ──── LLMProvider ──── Collection ('memories')            │
     │    ├── extract facts (+ entities/rels if EntityStore)            │
     │    ├── dedup against existing: ADD / UPDATE / NONE               │
     │    └── buildContext() → "## Memories\n- fact1\n..."              │
     │                                                                  │
     │  EntityStore ──── Collection ('entities')                        │
     │               └── Collection ('relationships')                   │
     │    ├── upsert: exact match → LLM entity resolution               │
     │    ├── relate: source → relation → target                        │
     │    ├── traverse: BFS multi-hop graph                             │
     │    └── buildContext(): entities + relationships as markdown      │
     │                                                                  │
     │  patterns() plugin:                                               │
     │    ├── PatternStore: memory_patterns + HNSW (private)            │
     │    ├── Consolidator: prune (age+success) + dedup (cosine>0.95)   │
     │    └── PatternDistiller: aggregate → distilled_strategies        │
     └──────────────────────────────────────────────────────────────────┘
```

---

## 20. Testing Strategy

### Test Infrastructure

- **Custom runner:** `test/run.ts` — discovers tests in `test/unit/` and
  `test/integration/`, plus `packages/*/test/unit/` and `packages/*/test/integration/`
- Tests export `{ name, tests }` — plain objects, no Jest/Vitest
- **Hash-based embedding** (`hashEmbedding()`) in helpers — deterministic, unique
  per text, normalized; used in all integration tests without model downloads
- Unit tests: ~200, ~11s total

### Unit Tests (`test/unit/`)

| File | Coverage |
|------|----------|
| `query/rrf.test.ts` | RRF fusion: dedup across systems, multi-list boost, maxResults |
| `query/bm25.test.ts` | FTS5 sanitization, camelCase splitting, BM25 normalization |
| `query/reranker.test.ts` | Position-aware score blending, Reranker interface |
| `core/brainbank.test.ts` | Facade lifecycle, .use() guard, index modules filter |
| `core/collection.test.ts` | KV add/search/list/trim/clear, FTS trigger sync |
| `core/schema.test.ts` | Database creation, WAL mode, schema version, transactions |
| `core/config.test.ts` | resolveConfig() defaults and overrides |
| `core/config-file.test.ts` | ProjectConfig type, registerConfigCollections() |
| `core/reembed.test.ts` | Atomic swap, dim mismatch flow, HNSW rebuild correctness |
| `core/tags-ttl.test.ts` | Tags AND-filter, TTL auto-prune, expires_at storage |
| `core/watch.test.ts` | fs.watch integration, custom plugin routing, debounce |
| `vector/hnsw.test.ts` | HNSW add/search/remove/reinit/save/tryLoad cycle |
| `vector/mmr.test.ts` | MMR diversity selection, lambda extremes |
| `embeddings/` | Provider factory, dim validation, fetch mocking, timeout |

### Integration Tests (`test/integration/`)

| File | Coverage |
|------|----------|
| `core/collections.test.ts` | Full KV pipeline: add → hybrid/keyword/vector → tag → TTL → trim |
| `query/search.test.ts` | code+git+docs+memory → search + getContext + minScore |
| `indexers/per-plugin-embedding.test.ts` | 3 different dims (64d/128d/256d), separate HNSW indices |
| `memory/memory.test.ts` | Learn → search → consolidate → distill cycle |
| `embeddings/real-model.test.ts` | LocalEmbedding semantic similarity, cross-encoder reranker |
| `quality/retrieval-quality.test.ts` | Recall@5 and MRR threshold assertions (synthetic corpus) |

### Package Integration Tests (`packages/*/test/integration/`)

| Package | Test | Coverage |
|---------|------|----------|
| `@brainbank/code` | `code.test.ts` | Index TS+Python → HNSW search → incremental skip → force reindex |
| `@brainbank/code` | `chunker.test.ts` | NestJS class methods, Python class, content integrity, benchmark |
| `@brainbank/git` | `git.test.ts` | Real git repo → commit indexing → co-edit analysis → fileHistory |
| `@brainbank/docs` | `docs.test.ts` | Smart chunking → register → index → search → context → remove |
| `@brainbank/memory` | `memory-entities.test.ts` | Real LLM: entity extraction + dedup + graph traversal |

### Retrieval Quality Gate (`test/integration/quality/retrieval-quality.test.ts`)

Self-contained regression test with a synthetic corpus (5 TypeScript files),
6 golden queries, and threshold assertions. Uses `hashEmbedding()` — no model
download, runs in ~0.2s. Measures:

- **Recall@5** — expected files appear in top-5 results (≥0.8 for exact queries)
- **MRR** — mean reciprocal rank of first relevant result (≥0.4 overall)
- Zero-recall guard: no exact query may return 0 relevant results

### Commands

```
npm test                                 # unit only (~200 tests, ~11s)
npm run test:integration                 # unit + integration (downloads model, ~30s)
npm test -- --filter <name>              # filter by test file or suite name
npm test -- --verbose --filter reembed   # verbose output for debugging
```

---

## 21. Concurrency & WAL Strategy

### Current Model

SQLite in WAL mode with `busy_timeout = 5000ms`:

| Aspect | Behavior |
|--------|----------|
| **Readers** | Unlimited concurrent, never blocked |
| **Writers** | Single-writer serialized by WAL |
| **busy_timeout** | Wait up to 5s for write lock before `SQLITE_BUSY` |
| **synchronous** | NORMAL — fsync on WAL checkpoint, not every commit |

### Why Single-Writer Works

BrainBank is single-process by design:

- **CLI:** one command at a time
- **MCP:** requests handled sequentially per workspace instance
- **Watch:** `_flushing` flag in Watcher prevents concurrent reindex calls
- **Indexing:** writes batched in transactions (one lock acquisition per batch)

### Known Limitations

1. **Multi-process writes:** Two BrainBank instances on the same DB will contend.
   `busy_timeout` mitigates but doesn't eliminate `SQLITE_BUSY`.
2. **Long indexing blocks writers:** Large repos hold the write lock during
   `brain.index()`. Reads remain unaffected (WAL mode).
3. **No WAL checkpoint control:** SQLite auto-checkpoints at 1000 pages.

### Scaling Path

If single-file SQLite becomes a bottleneck:

1. **Read replica** — second read-only connection for search while primary indexes
2. **Sharding** — split DB per domain (code.db, git.db, kv.db)
3. **External vector DB** — replace HNSW with Qdrant/Milvus; keep SQLite for metadata + FTS5