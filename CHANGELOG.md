# Changelog

All notable changes to BrainBank will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]
### Breaking Changes
- **`DatabaseAdapter` replaces `Database`** — the core `Database` class (`src/db/database.ts`) has been replaced with a `DatabaseAdapter` interface (`src/db/adapter.ts`) + `SQLiteAdapter` implementation (`src/db/sqlite-adapter.ts`). All internal APIs, plugin schemas, and test helpers now use the adapter interface. Plugins should use `PluginContext['db']` type (which is now `DatabaseAdapter`). The `raw<T>()` escape hatch provides typed access to the underlying driver during the transition period. Public export changed: `Database` → `DatabaseAdapter` (type) + `SQLiteAdapter` (class)
- **Plugin migration signatures changed** — `Migration.up(db: RawDb)` → `Migration.up(adapter: DatabaseAdapter)`. Plugin schemas updated to use `adapter.exec()` instead of raw `better-sqlite3` calls
- **`PluginContext.db` type changed** — from concrete `Database` (with `.db` accessor) to `DatabaseAdapter` interface. Plugins that accessed `ctx.db.db` must use `ctx.db` directly or `ctx.db.raw<T>()` for driver-specific features
- **`WatchablePlugin` interface replaced** — old `watchPatterns(): string[]` + `onFileChange(path, event): Promise<boolean>` removed. New contract: `watch(onEvent: WatchEventHandler): WatchHandle` + optional `watchConfig(): WatchConfig`. Plugins now drive their own watching
- **`WatchOptions` simplified** — removed `paths` option (plugins handle their own paths). Callback renamed `onIndex(sourceId, pluginName)` (was `onIndex(file, indexer)`)
- **`Watcher` constructor changed** — accepts `Plugin[]` instead of `Map<string, Plugin>` + `repoPath`

### Added
- **Plugin-driven watch system** — plugins drive their own watching (fs.watch, API polling, webhooks). Core only coordinates handles, debounce, and re-indexing
- **`WatchEvent`** type — generalized event beyond files (`sourceId`, `sourceName`, `payload`)
- **`WatchHandle`** type — lifecycle control for plugin watchers (`stop()`, `active`)
- **`WatchConfig`** type — optional per-plugin hints (`debounceMs`, `batchSize`, `priority`)
- **`WatchEventHandler`** type — callback signature for plugin event reporting
- **`WebhookServer`** — optional shared HTTP server for push-based watch plugins. Opt-in via `new BrainBank({ webhookPort })`. Plugins register routes via `ctx.webhookServer?.register()`
- **`IndexablePlugin.indexItems?(ids)`** — optional granular re-indexing by item ID. Watcher uses this when available, falls back to full `index()`
- **`webhookPort`** config option — added to `BrainBankConfig` and `ResolvedConfig`
- **`webhookServer`** on `PluginContext` — available to plugins during initialization
- **Multi-process coordination** — cross-process HNSW staleness detection, hot-reload, and file locking
  - `index_state` table (schema v7→8) — monotonic version counter per HNSW index, tracks `writer_pid` and `updated_at`
  - `bumpVersion()`, `getVersions()`, `getVersion()` helpers in `src/db/index-state.ts`
  - `acquireLock()`, `releaseLock()`, `withLock()` advisory file lock in `src/lib/write-lock.ts` — uses `O_EXCL` atomic creation with exponential backoff and stale lock detection (dead PID auto-steal)
  - `BrainBank.ensureFresh()` — compares DB versions with in-memory snapshot, hot-reloads stale HNSW indices from disk. Called implicitly before `search()`, `hybridSearch()`, `searchBM25()`, `getContext()`
  - `reloadHnsw()` in `hnsw-loader.ts` — reinitializes a single HNSW index + vector cache from disk/SQLite
  - `EmbeddingWorkerProxy` — drop-in `EmbeddingProvider` that offloads embedding to a `worker_threads.Worker`, keeping the main event loop free for search requests
  - `embedding-worker-thread.ts` — worker script with zero-copy `ArrayBuffer` transfer
  - New exports from `brainbank` barrel: `bumpVersion`, `getVersions`, `getVersion`, `acquireLock`, `releaseLock`, `withLock`, `EmbeddingWorkerProxy`

### Documentation
- **Full docs audit** — updated all stale `Database`/`database.ts` references to `DatabaseAdapter`/`SQLiteAdapter` across `architecture.md` (7 fixes), `AGENTS.md` (5 fixes), `local-development.md`, and `custom-plugins.md`

### Changed
- **`saveAllHnsw()` is now async** — wrapped with `withLock()` for cross-process file locking. Returns `Promise<boolean>` instead of `boolean`
- **`IndexDeps` expanded** — now includes `db`, `dbPath`, `sharedHnsw`, `kvHnsw` for version bumping and HNSW persistence after indexing
- **`index-api.ts` bumps version** — calls `bumpVersion(db, baseType)` after each plugin completes indexing, then saves HNSW with file lock
- **MCP pool invalidation** — replaced fragile `hnswSize === 0` heuristic with `brain.ensureFresh()` on every pool hit. Cleaned up `any` types in pool code
- **Schema version 7→8** — added `index_state` table

### Breaking Changes
- **`ProjectConfig.plugins`** — type changed from `('code' | 'git' | 'docs')[]` to `string[]`. Config files remain compatible
- **`IndexStats`** — removed hardcoded `code?`, `git?`, `documents?` typed fields. Only the generic `[pluginName: string]` index signature remains
- **`ScanResult`** — replaced hardcoded `.code`/`.git`/`.docs` fields with dynamic `modules: ScanModule[]` array (internal CLI type)
- **Removed `CodeConfig`/`GitConfig`/`DocsConfig`** typed interfaces from `config-loader.ts` — per-plugin config now accessed generically via `config[pluginName]` index signature

### Changed
- **CLI plugin loading** — replaced individual `loadCodePlugin`/`loadGitPlugin`/`loadDocsPlugin` with generic `PLUGIN_LOADERS` registry map. New `loadPlugin(name)` is the single entry point
- **CLI builtin registration** — `registerBuiltins()` now iterates `pluginNames: string[]` generically. Per-plugin config resolved via `pluginCfg(config, name)` helper. Multi-repo support uses `MULTI_REPO_PLUGINS` set
- **CLI scan** — `scanRepo()` returns `modules: ScanModule[]` instead of hardcoded fields. Each scanner produces a generic module descriptor with name, availability, summary, and details
- **CLI commands** — `printScanTree()`, `promptModules()`, `buildDefaultModules()`, `offerSaveConfig()` all iterate modules generically
- **CLI stats** — `cmdStats()` iterates `Object.entries(brain.stats())` dynamically instead of accessing hardcoded keys
- **CLI DocsPlugin access** — `docs.ts`, `collection.ts`, `context.ts` use shared `findDocsPlugin(brain)` utility with `isDocsPlugin()` type guard instead of `brain.plugin<DocsPlugin>('docs')`
- **`plugin-loader.ts`** — merged `provider-setup.ts` functionality (`setupProviders`, `resolveEmbeddingKey`). Added `registerPluginLoader()` for custom plugin loaders

### Fixed
- **Config loading**: `loadConfig()` now resolves `.brainbank/config.json` relative to the target repo path, not the process CWD. This fixes ignore patterns, plugin lists, and per-plugin config not being applied when running `brainbank index <path>` from a different directory
- **Docs collection paths**: `registerConfigCollections` now resolves relative collection paths against the repo path instead of CWD
- **Initialization order**: `brain.initialize()` is now called before `registerConfigCollections` to ensure plugins have DB access for collection registration

### Breaking Changes
- **Plugin decoupling** — removed typed accessors `brain.docs`, `brain.git`, `brain.code`. Use `brain.plugin<T>('name')` instead
- Removed `PLUGIN` constant from core — plugin names are owned by their packages
- Removed `IndexStats` typed return from `brain.stats()` — now returns generic `Record<string, Record<string, number | string> | undefined>`
- Removed `CodeVectorSearch`, `GitVectorSearch`, `PatternVectorSearch`, `SqlCodeGraphProvider` exports from core — these belong in `@brainbank/code` / `@brainbank/git`
- Removed `brain.indexCode()` and `brain.indexGit()` — use `brain.plugin('code')?.index()` directly
- **`@brainbank/memory` removed** — deleted `packages/memory/` and all core references (`memory_patterns`, `memory_vectors`, `distilled_strategies` tables, `fts_patterns` FTS5, `PatternVectorSearch`, `MemoryPatternRow`, `LearningPattern`, `DistilledStrategy`, `PatternResult`, `HnswPlugin`, `isHnswPlugin`, `isPatternResult`, `formatPatternResults`). Memory/pattern storage should use `brain.collection()` KV collections instead
- **Schema v7** — domain tables (code, git, docs) removed from core schema. Each plugin now creates its own tables via the migration system. Schema version bumped from 6 to 7
- **`KeywordSearch` removed** — deleted `src/search/keyword/keyword-search.ts` and its public export. All BM25 keyword search now goes through `CompositeBM25Search` which discovers `BM25SearchPlugin` instances from the registry. Tests rewritten to use raw FTS5 SQL + `sanitizeFTS`/`normalizeBM25` utilities
- **`CodeGraphProvider`, `CodeChunkSummary` removed from core** — moved to `@brainbank/code` package
- **Domain row types removed from core** — `CodeChunkRow`, `GitCommitRow`, `DocChunkRow`, `CollectionRow`, `ImportRow` removed from `db/rows.ts`. Each package defines its own row types

### Added
- `VectorSearchPlugin` capability interface — plugins can register domain-specific vector search strategies
- `ContextFormatterPlugin` capability interface — plugins can provide custom context formatting for LLM prompts
- `DomainVectorSearch` interface — generic abstraction for pre-embedded vector search
- `isVectorSearchPlugin()`, `isContextFormatterPlugin()` type guards
- `MigratablePlugin` + `BM25SearchPlugin` capability interfaces — plugins own their schema and FTS5 search
- `isMigratable()`, `isBM25SearchPlugin()` type guards
- `runPluginMigrations()` — per-plugin versioned migration runner backed by `plugin_versions` table
- `CompositeBM25Search` — generic BM25 coordinator that discovers `BM25SearchPlugin` instances from the registry
- `plugin_versions` table in core schema — tracks per-plugin migration versions
- Generic `brain.index()` — discovers `IndexablePlugin` implementations automatically
- Generic `brain.stats()` — iterates all plugins with `stats()` method
- `brain.code` typed accessor (matches existing `brain.docs` and `brain.git`)
- `docs/local-development.md` — local dev setup guide
- `.agents/workflows/setup-local.md` — automated workflow for fresh machine setup
- **npm workspaces** — `packages/*` are now workspace members; `npm install --legacy-peer-deps` + `npm run build` is the entire setup. `postinstall` script auto-links local `brainbank` core for plugin resolution

### Fixed
- **BUG-01: docs-only setup crash** — `createSearchAPI()` now always returns a `SearchAPI` instance. Docs-only setups no longer crash on `brain.search()`
- **BUG-02: ghost HNSW vectors** — `KVService.delete()` now removes vectors from HNSW + vecCache before deleting DB rows
- **BUG-04: DocChunkRow type mismatch** — renamed `hash` → `content_hash` to match actual SQLite column name
- **BUG-05: metadata spread clobber** — reversed spread order in `Collection.searchAsResults()` so system keys (`id`, `collection`) always win
- **BUG-06: reranker resource leak** — `close()` now releases the reranker (e.g. Qwen3Reranker native model)
- **BUG-07: watcher data loss** — failed code files are re-queued to `_pending` instead of being silently dropped
- **BUG-08: reembed missing table check** — `reembedAll()` now checks both text and vector table existence before processing
- **BUG-11: LIKE injection** — added `escapeLike()` to `lib/fts.ts`, applied in `keyword-search.ts` path queries with `ESCAPE '\\'`
- **ANTI-14: saveAllHnsw silent failure** — returns `boolean` so callers can detect and log persistence failures
- **ANTI-15: minScore not forwarded to docs** — `ContextBuilder` now passes `minScore` to `docsSearch` callback
- **ANTI-21: import-graph unescaped LIKE** — all LIKE queries in `import-graph.ts` now use `escapeLike()` with `ESCAPE '\\'`
- **ANTI-25: batch type safety** — `Database.batch<T>` bound changed from `any[]` to `unknown[]`
- **ANTI-27: IndexStats extensibility** — added `[pluginName: string]` index signature for plugin-provided stats
- **ANTI-30: duplicate metadata write** — removed inline `embedding_meta` upsert in `reembedAll`, uses canonical `setEmbeddingMeta()` only
- **Zero `any` in production** — typed `HnswlibIndex`/`HnswlibModule` in `hnsw-index.ts`, `XenovaModule` in `local-embedding.ts`, `NodeLlamaCppModule` in `qwen3-reranker.ts`, `catch (err: unknown)` + typed request body in `openai-embedding.ts`, `Record<string, unknown>` in `collection.ts`, `SearchResult[]` in `cli/utils.ts`, `as string[]` casts on `JSON.parse` in search files

### Changed
- **Init inlined** — `earlyInit()` / `lateInit()` / `buildPluginContext()` / `resolveStartupEmbedding()` from `bootstrap/initializer.ts` inlined into `BrainBank._runInitialize()` as a linear 8-step flow with private helpers `_resolveEmbedding()` and `_buildPluginContext()`. File deleted — zero indirection
- **IndexAPI → free function** — replaced `IndexAPI` class with `runIndex()` free function; class had one method and no state
- **search-factory merged** — `createSearchAPI()` and `SearchAPIDeps` moved into `search-api.ts`; deleted `search-factory.ts` and `engine/types.ts`
- **Search API: generic `sources` param** — replaced `codeK`/`gitK`/`patternK` in `SearchOptions` and `codeResults`/`gitResults`/`patternResults` in `ContextOptions` with unified `sources: Record<string, number>`. Any plugin or KV collection can now be scoped from the public API.
- **docs/architecture.md** — updated all sections (facade API, SearchOptions, hybridSearch flow, ContextBuilder, SearchAPI, data flow diagrams, CLI flags) to reflect generic `sources` API; removed `searchCode`/`searchCommits` references
- `ContextBuilder` accepts optional `SearchStrategy` for docs-only setups
- `lateInit()` return type simplified from `SearchAPI | undefined` to `SearchAPI`
- `brainbank.ts` uses safe `?.` access instead of `!` non-null assertions on `_searchAPI`
- `DocsSearchFn` type now includes optional `minScore` param

### Removed
- `searchCode()` and `searchCommits()` convenience methods from `BrainBank` and `SearchAPI` (use `search(query, { sources: { code: 10, git: 0 } })` instead)
- `collections` param from `hybridSearch()` (merged into `sources`)

### Added
- **`fuseRankedLists<T>()`** — generic RRF function in `lib/rrf.ts` that works on any type. Enables `Collection` to fuse `CollectionItem[]` directly without converting to/from `SearchResult`
- **`Collection.searchAsResults()`** — returns `SearchResult[]` for use in hybrid search pipelines, encapsulating the CollectionItem→SearchResult mapping
- **`ReembeddablePlugin`** — new capability interface in `plugin.ts`. Plugins that own vector tables implement `reembedConfig()` to provide table descriptors for re-embedding. Eliminates text builder duplication between core and plugins
- **`ReembedTable` type** — moved from private in `reembed.ts` to public in `plugin.ts`, exported from `index.ts` for plugin authors
- **Table existence check** — `reembedAll()` now checks `sqlite_master` before processing each table, skipping tables for uninstalled plugins
- **`IndexOptions` interface** — typed options for `IndexablePlugin.index()` replacing `any` (supports `forceReindex`, `depth`, `onProgress`)
- **`engine/types.ts`** — centralized `IndexAPIDeps` and `SearchAPIDeps` interfaces for engine layer dependency injection

### Changed
- **Type safety: `any` eliminated** — 10 files updated to remove all `any` types:
  - `plugin.ts`: `stats()` returns `Record<string, number | string>`, `index()` uses `IndexOptions`, `search()` uses `Record<string, unknown>`
  - `index-api.ts`: `emit` data param is `unknown`, docs result properly typed, result object uses typed accumulators
  - `types.ts`: `ICollection.add/addMany` metadata uses `Record<string, unknown>`
  - `docs.ts`: `onProgress` has full callback signature
  - `config-loader.ts`: `brainbank` field uses `Partial<BrainBankConfig>`, index signature uses `unknown`
  - `plugin-loader.ts`: `PluginFactory` type replaces inline `(opts: any) => Plugin`
  - `local-embedding.ts`: `XenovaPipeline` interface replaces `any` for pipeline
  - `qwen3-reranker.ts`: `LlamaModel` and `LlamaRankingContext` interfaces replace `any`
  - `code-formatter.ts` and `document-formatter.ts`: use `isCodeResult()`/`isDocumentResult()` type guards instead of `Record<string, any>` casts
- **Catch blocks typed** — `catch (err: any)` replaced with `catch (err: unknown)` + `instanceof Error` guards in `config-loader.ts`, `plugin-loader.ts`
- **Context formatters consolidated (4→2 files)** — `code-formatter.ts` + `graph-formatter.ts` merged into `formatters.ts`; `document-formatter.ts` merged into `result-formatters.ts`
- **`provider-setup.ts` merged into `plugin-loader.ts`** — eliminates a 30-line single-purpose file
- **`IndexAPIDeps`/`SearchAPIDeps` centralized** — moved from inline definitions to `engine/types.ts`

### Fixed
- **Race condition in `initialize()`** — concurrent calls could see `_initPromise = null` during cleanup, starting a new init while the first was still resetting state. Fixed by replacing `finally` with explicit `.then()`/`.catch()` nulling
- **Silent failure in `serve.ts`** — missing `@brainbank/mcp` now shows clear error with install instructions instead of silently importing
- **Empty catch blocks hardened** — 4 catch blocks now either emit warnings (HNSW reinit), add comments (DB close, HNSW save), or discriminate error types (`reembed.ts` only swallows `no such table`, `builtin-registration.ts` only swallows `already registered`)

### Removed
- **Dead code** — deleted `VectorSearch` (157 lines, superseded by `CompositeVectorSearch`) and `FTSMaintenance` (22 lines, inlined into `KeywordSearch.rebuild()`)
- **`ResultCollector`** — 72-line wrapper class eliminated; methods inlined as private on `SearchAPI`
- **`getDocsPlugin` callback** — removed from `SearchAPIDeps`; docs resolved via `registry.firstByType(PLUGIN.DOCS)` directly

### Changed
- **`Initializer` → free functions** — class with no state replaced by `earlyInit()` / `lateInit()` exports. `_buildSearchLayer()` wrapper inlined (delegates directly to `buildSearchLayer()`)
- **`PluginRegistry` → `services/`** — moved from `bootstrap/registry.ts` to `services/plugin-registry.ts`. Fixes `engine/ → bootstrap/` layer violation (registry has live state, not startup-only)
- **`ContextBuilder` encapsulated** — now internal to `SearchAPI` via `SearchAPIDeps.contextBuilder`. `BrainBank._contextBuilder` field and `search/context-builder` import eliminated. `getContext()` delegates to `SearchAPI.getContext()` — single entry point
- **`collection` callback → `kvService` direct** — `SearchAPIDeps.collection(n)` callback replaced with `kvService: KVService`. Eliminates 4-hop chain (`SearchAPI → lambda → brainbank.collection → kvService`)
- **`search-layer-builder` → `engine/search-factory`** — `buildSearchLayer()` moved from `bootstrap/` to `engine/search-factory.ts` as `createSearchAPI()`. Returns fully-built `SearchAPI` — no intermediate `SearchLayer` struct
- **`lateInit` simplified** — params reduced from `(config, early, registry, sharedHnsw, kvVecs, getCollection)` to `(config, early, registry, sharedHnsw, kvService)`. Returns `SearchAPI | undefined` directly. `LateInit` type alias eliminated
- **`reembed` auto-init** — `searchBM25()` and `reembed()` now use `await this.initialize()` instead of `_requireInit()`. Consistent with all other search/context methods
- **`reembedAll` consolidation** — `setEmbeddingMeta()` + `saveAllHnsw()` calls moved from `brainbank.ts` into `reembedAll()` via `persist` param. Removes `setEmbeddingMeta` and `saveAllHnsw` imports from facade
- **`providerKey()` → `lib/`** — moved from `providers/embeddings/resolve.ts` to `lib/provider-key.ts` to fix `db/ → providers/` layer violation
- **`ICollection` interface** — defined in `types.ts`. `PluginContext.collection()` now returns `ICollection` instead of concrete `Collection`, decoupling `plugin.ts` from `services/`
- **HNSW helpers extracted** — `hnswPath`, `countRows`, `saveAllHnsw`, `loadVectors`, `loadVecCache` moved from `bootstrap/initializer.ts` to `providers/vector/hnsw-loader.ts`
- **`Watcher` class** — converted `createWatcher()` factory function to a `Watcher` class with `close()` + `active` API. Consistent with all other service classes
- **`reembed.ts` → `engine/`** — moved from `services/` to `engine/` where stateless orchestration functions belong
- **Reranking single-responsibility** — removed reranker from `CompositeVectorSearch`; reranking now only happens in `SearchAPI.hybridSearch()`. Eliminates double-reranking bug
- **`_rerankResults` inlined** — 3-line indirection eliminated; logic inlined directly in `hybridSearch()`
- **`id` in `CodeResultMetadata`** — added `id` field to type and both search implementations (`CodeVectorSearch`, `KeywordSearch`). Enables call graph annotations in `code-formatter.ts` which were silently failing
- **`SearchLayer.bm25`** — changed from concrete `KeywordSearch` to `SearchStrategy` interface for consistency
- **`BrainBank.collection()` → `ICollection`** — return type changed from concrete `Collection` to `ICollection` for consistency with `PluginContext.collection()`. Same change applied to `SearchAPIDeps.collection()` and `lateInit` parameter
- **`DocsPlugin` interface** — defined in `plugin.ts` with `addCollection()`, `listCollections()`, `indexDocs()`, `removeCollection()`, `addContext()`, `listContexts()`. `listCollections()` now returns `DocumentCollection[]` (was `string[]`). `PathContext` type added. `isDocsPlugin()` is now a proper type predicate (`i is DocsPlugin`), eliminating `as any` casts in CLI and `index-api.ts`
- **`docs` accessor typed** — `BrainBank.docs` now returns `DocsPlugin | undefined` (was `Plugin | undefined`) with `isDocsPlugin` guard. All CLI `as any` casts removed
- **`CollectionResultMetadata`** — new typed interface replaces `Record<string, any>` on `CollectionResult.metadata`. Has `id`, `collection`, `rrfScore`, plus `[key: string]: unknown` for user metadata
- **`rrfScore` on all metadata interfaces** — added to `CodeResultMetadata`, `CommitResultMetadata`, `PatternResultMetadata`, `DocumentResultMetadata`, `CollectionResultMetadata`. Eliminates `as any` cast in `rrf.ts`
- **SQLite row types** — added `MemoryPatternRow`, `EmbeddingMetaRow`, `ImportRow`, `VectorRow`, `CountRow` to `rows.ts`. Applied to 10 files replacing `as any[]` casts: `keyword-search.ts`, `code-vector-search.ts`, `git-vector-search.ts`, `pattern-vector-search.ts`, `embedding-meta.ts`, `schema.ts`, `hnsw-loader.ts`, `reembed.ts`, `kv-service.ts`, `import-graph.ts`
- **null→undefined coercions** — SQLite returns `null` for absent values; metadata types use `undefined`. Added `?? undefined` coercions at row→metadata boundary in 4 search files
- **Collection hybrid search** — replaced `reciprocalRankFusion` roundtrip (CollectionItem→SearchResult→CollectionItem) with `fuseRankedLists<CollectionItem>` direct fusion. Removes 2 type casts and the `allById` lookup map
- **`SearchAPI._collectKvCollections`** — delegates to `Collection.searchAsResults()` instead of inline CollectionItem→SearchResult mapping
- **CLI factory typed** — `brainOpts` changed from `Record<string, any>` to `Partial<BrainBankConfig> & Record<string, unknown>`. `setupProviders` param also typed as `Record<string, unknown>`
- **`reembed.ts` plugin-driven** — removed 3 hardcoded `TABLES` entries (code, git, docs). `reembedAll()` now collects table descriptors from registered `ReembeddablePlugin`s via `collectTables()`. Core-owned tables (`memory`, `kv`) stay as `CORE_TABLES`. Deduplicates by `vectorTable` for multi-repo
- **`ReembedResult`** — changed from hardcoded fields (`code`, `git`, `docs`, `kv`, `memory`) to `{ counts: Record<string, number>; total: number }`. Adapts automatically to any plugin set
- **CLI `reembed` command** — replaced 5 hardcoded output lines with dynamic iteration over `result.counts`
- **HNSW dims synced from provider** — `earlyInit()` now derives HNSW dims from `embedding.dims` instead of `config.embeddingDims` (which defaults to 384). Prevents silent dimension mismatch when using providers with different dims (e.g. OpenAI 1536)

### Fixed
- **Reembed provider_key not updated** — `brain.reembed()` did not call `setEmbeddingMeta()`. After switching providers and reembedding, next startup detected a provider mismatch and threw. Now updates `provider_key` in DB
- **Reembed HNSW not persisted** — `brain.reembed()` rebuilt HNSW in memory but never called `saveAllHnsw()`. On restart, stale `.index` files were loaded, causing silently incorrect search results. Now saves to disk after reembedding
- **Double-reranking bug** — `CompositeVectorSearch.search()` reranked results, then `SearchAPI.hybridSearch()` reranked again after RRF fusion. Results now only reranked once, at the `SearchAPI` level
- **Call graph annotations** — `getCallAnnotation()` in `code-formatter.ts` always returned null because code metadata never included the chunk `id`. Fixed by adding `id: r.id` to both `CodeVectorSearch` and `KeywordSearch`
- **`registry.get()` → `firstByType()`** — `SearchAPI._collectDocs()` and `search-layer-builder.ts` docs callback used `registry.get()` which throws when docs plugin isn't loaded. Replaced with `firstByType()` which returns `undefined`
- **Private HNSW persistence** — `createHnsw()` now registers indexes for disk persistence via `saveAllHnsw()`. DocsPlugin and patterns plugin HNSW indexes are saved to disk, enabling fast `tryLoad()` on subsequent startups instead of rebuilding from SQLite

### Added
- **`CodeGraphProvider` interface** (`src/search/types.ts`) — abstracts call graph and import graph queries. `SqlCodeGraphProvider` encapsulates all `code_refs`/`code_imports`/`code_chunks` SQL queries, decoupling `ContextBuilder` from the DB schema
- **`PLUGIN` / `HNSW` constants** (`src/constants.ts`) — single source of truth for plugin type names and HNSW index keys. Exported from `brainbank` barrel
- **`HnswPlugin` / `CoEditPlugin` interfaces** — typed capability interfaces for plugins that expose HNSW indexes or co-edit suggestions, with `isHnswPlugin()` / `isCoEditPlugin()` type guards
- **§20 Testing Strategy** in `docs/architecture.md` — documents test infrastructure, unit/integration test coverage, and commands
- **§21 Concurrency & WAL Strategy** in `docs/architecture.md` — documents WAL model, single-writer design, known limitations, and scaling path
- **`docs/architecture.md` fully updated** for Phases 1-4 — reflects `KVService`, `CompositeVectorSearch` (domain split), `FTSMaintenance`, `DocumentFormatter`, `SearchLayerBuilder`, and `@brainbank/memory` patterns consolidation across all 21 sections
- **Retrieval quality gate** (`test/integration/quality/retrieval-quality.test.ts`) — self-contained regression test with synthetic corpus, 6 golden queries, recall@5/MRR metrics, and threshold assertions. Runs with hash embeddings (~0.2s, no model download)

### Changed
- **Adaptive Collection over-fetch** — `Collection._searchVector()` now uses density-based multiplier (ratio of total HNSW size to collection count, clamped [3, 50]) instead of hardcoded `k * 10`
- **ContextBuilder decoupled from SQL** — `code-formatter.ts` and `graph-formatter.ts` now accept `CodeGraphProvider` interface instead of raw `Database`. SQL queries centralized in `SqlCodeGraphProvider`
- **SearchAPI decomposed** — extracted `ResultCollector` (`src/engine/result-collector.ts`) for docs/custom-plugin/KV gathering. SearchAPI is now a thin pipeline orchestrator: collect → fuse → rerank
- **Pattern learning moved to `@brainbank/memory`** — `PatternStore`, `Consolidator`, `PatternDistiller`, and patterns plugin moved from `src/services/memory/` to `packages/memory/src/`. Factory renamed `patterns()` (`memory()` kept as deprecated alias). Removes AGENTS.md violation and naming confusion with `@brainbank/memory`
- **KVService extracted** — `_kvHnsw`, `_kvVecs`, `_collections` moved from `brainbank.ts` to `src/services/kv-service.ts`. BrainBank delegates `collection()`, `listCollectionNames()`, `deleteCollection()`
- **FTSMaintenance extracted** — `KeywordSearch.rebuild()` delegates to `src/db/fts-maintenance.ts`
- **DocumentFormatter extracted** — `SearchAPI.getContext()` doc formatting moved to `src/search/context/document-formatter.ts`
- **VectorSearch domain split** — monolithic `VectorSearch` replaced by `CodeVectorSearch`, `GitVectorSearch`, `PatternVectorSearch`, composed by `CompositeVectorSearch`. Each domain is independently testable
- **SearchLayerBuilder extracted** — `Initializer._buildSearchLayer()` (35 lines of inline construction) replaced by `bootstrap/search-layer-builder.ts`. Initializer no longer knows about search internals
- **Removed `as any` casts** — `initializer.ts` and `brainbank.ts` now use typed `isHnswPlugin` / `isCoEditPlugin` type guards instead of `as any` for plugin access
- **Flattened singletons** — `config/defaults.ts` → `config.ts`, `plugins/base.ts` → `plugin.ts`
- **Renamed `core/` → `engine/`** — `search-api.ts` and `index-api.ts` live under `engine/`
- **Merged `domain/` → `services/`** — `collection.ts` and `memory/` consolidated into `services/`
- **Split `context-builder.ts`** (375 → 50 lines) — formatting logic extracted to `src/search/context/` with 4 focused modules: `code-formatter.ts`, `graph-formatter.ts`, `result-formatters.ts`, `import-graph.ts`
- **Split `factory.ts`** (376 → 46 lines) — config loading, plugin discovery, provider setup, and builtin registration extracted to `src/cli/factory/` with 4 focused modules
- **Split `commands/system.ts`** — into 5 focused files: `stats.ts`, `reembed.ts`, `watch.ts`, `serve.ts`, `help.ts`
- **Renamed `index-cmd.ts` → `index.ts`** — aligns with command naming convention

### Added
- **Documentation refactor** — README.md rewritten as a concise landing page; all content moved to 13 focused `docs/` files (getting-started, cli, plugins, collections, search, custom-plugins, config, embeddings, multi-repo, mcp, memory, indexing, architecture). ARCHITECTURE.md moved to `docs/architecture.md`. CONTRIBUTING.md updated with current terminology and project structure
- **Typed plugin accessors** — `brain.docs` and `brain.git` provide direct, type-safe access to built-in plugins without casting. Custom plugins use `brain.plugin<T>('name')` with generics
- **`plugin<T>()` returns `T | undefined`** — no longer throws; supports safe optional chaining (`brain.plugin<NotesPlugin>('notes')?.searchNotes()`)
- **Package: `@brainbank/code`** — code indexer extracted as a separate npm package with tree-sitter as a peer dependency
- **Package: `@brainbank/git`** — git history indexer extracted as a separate npm package with simple-git as a dependency
- **Package: `@brainbank/docs`** — document collection indexer extracted as a separate npm package
- **Graph Expansion Engine** — context builder performs 2-hop import graph traversal + directory clustering to achieve ~93% feature coverage from a single query
- **`Collection.update(id, content, options?)`** — update an item's content with re-embedding. Preserves original metadata/tags unless overridden
- **Plugin examples** — `examples/custom-plugin/` (notes plugin + quotes CLI plugin) and `examples/custom-package/` (CSV package scaffold) with full READMEs and sample data
- **Custom plugin indexing** — `brain.index()` now calls `index()` on any registered `IndexablePlugin` beyond built-in code/git/docs
- **Custom plugin search** — `brain.search()` and `brain.hybridSearch()` now call `search()` on any registered `SearchablePlugin` and fuse results via RRF
- **New public exports** — `vecToBuffer`, `isIgnoredDir`, `isIgnoredFile`, `normalizeBM25`, `rerank` now exported from `brainbank` for plugin authors
- **Code Graph: Import graph** — new `code_imports` table tracks file-level import relationships. Context builder shows `## Related Files (Import Graph)` section with importing/imported files
- **Code Graph: Symbol index** — new `code_symbols` table extracts all function/class/method definitions with name, kind, and line number. Linked to chunk IDs for cross-referencing
- **Code Graph: Call references** — new `code_refs` table tracks function calls within each chunk. Context builder annotates results with `calls:` and `called by:` info
- **Enriched embedding text** — chunk embeddings now include import context and parent class name, improving semantic search relevance
- **Import extractor** (`import-extractor.ts`) — regex-based, supports all 19 languages (JS/TS, Python, Go, Ruby, Rust, Java, C/C++, etc.)
- **Symbol extractor** (`symbol-extractor.ts`) — AST-based extraction of symbols and call references using tree-sitter
- **Benchmark suite** — professional retrieval quality and performance benchmarks restored in `test/benchmarks/` with documentation in `docs/benchmarks.md`
- **Watch demo** — `examples/custom-plugin/` now includes `brain.watch()` usage example

### Changed
- **Core decoupled from plugins** — deleted `src/indexers/code/`, `src/indexers/git/`, `src/indexers/docs/` from core. All plugin logic now lives exclusively in `packages/`. Core is framework-only
- **Removed `@expose` decorator** — plugin methods are no longer injected onto `BrainBank` at runtime. Use `brain.docs.method()` or `brain.git.method()` for built-in plugins, `brain.plugin<T>('name').method()` for custom plugins
- **Removed `CollectionPlugin` interface** — docs plugin now implements `SearchablePlugin` + `IndexablePlugin` directly
- **`plugin()` returns `T | undefined`** — previously threw if plugin not found; now returns undefined for safe optional chaining
- **Removed backward compat aliases** — `MultiIndexSearch`, `BM25Search` exports removed from barrel. Use `VectorSearch` and `KeywordSearch` directly
- **Removed deprecated `builtins` config field** — use `plugins` instead in `.brainbank/config.json`
- **Removed backward compat re-exports from `reembed.ts`** — import `setEmbeddingMeta`, `getEmbeddingMeta`, `detectProviderMismatch` from `services/embedding-meta.ts` directly
- **Removed tree-sitter and simple-git from core** — `optionalDependencies` and subpath exports cleared. Install `@brainbank/code` for tree-sitter, `@brainbank/git` for simple-git
- **Removed `notes` plugin** — `NoteStore` was a stripped-down `Collection` (same hybrid search, but no reranker/TTL/tags). Use `brain.collection('notes')` for equivalent functionality. Removed: `src/domain/notes/`, schema tables (`note_memories`, `note_vectors`, `fts_notes`), `brainbank/notes` subpath export
- **Schema version 5 → 6** — removed notes tables. Existing databases with notes data should re-create their DB
- **CLI plugin directory renamed** — `.brainbank/indexers/` → `.brainbank/plugins/` (matches the v0.6 Indexer→Plugin rename)
- **CLI uses dynamic imports** — `src/cli/factory.ts` loads `@brainbank/*` plugins with `import()`. Missing plugins now print a warning instead of crashing
- **`brain.docs` / `brain.git` return `Plugin | undefined`** — previously typed as concrete plugin classes, now duck-typed via the generic `Plugin` interface
- **Directory structure reorganized** — `src/indexers/` renamed to `src/plugins/`, `languages.ts` moved to `src/lib/`
- **tree-sitter deps moved to `optionalDependencies`** — reduces mandatory install size from ~950MB to ~60MB. Grammars are loaded on demand; missing ones fall back to sliding-window chunking
- **Hybrid search: increased defaults** — `codeK` 6→20, `gitK` 5→8 for more candidate results
- **CLI score filter** — `printResults` now filters results by score ≥ 70% (max 20), showing only high-quality matches
- **CLI source filtering** — all search commands accept dynamic `--<source> <n>` flags (e.g. `--code 10 --git 0 --docs 5 --notes 3`). Replaces `--codeK`/`--gitK`/`--docsK`/`--collections` with a unified pattern that works with built-in sources and custom plugins
- **Code ignore patterns** — `code({ ignore: ['sdk/**', 'vendor/**'] })` skips files matching glob patterns during indexing
- **Interactive index scan** — `brainbank index` now scans the repo first, shows a summary tree, and prompts with interactive checkboxes to select modules

## [0.7.0] — 2026-03-27

### Added
- **Per-plugin embedding overrides** — each plugin (`code`, `git`, `docs`) accepts an `embeddingProvider` option. Different plugins can use different providers and dimensions. HNSW indices are created with the correct dimensions automatically
- **Project config file** (`.brainbank/config.json`) — declarative config for plugins, per-plugin embedding keys, docs collections, git depth, reranker. Auto-read by `brainbank index`. CLI flags override config
- **`tree-sitter-python` included by default** — Python grammar is now a hard dependency alongside JavaScript and TypeScript

### Changed
- **README rewritten** — repositioned as a code-aware knowledge engine; comparison table includes QMD, mem0/Zep, LangChain; Programmatic API example shows per-plugin embeddings and collections upfront

## [0.6.0] — 2026-03-27

### Added
- **Embedding auto-resolve** — stores `provider_key` in DB; on startup, auto-resolves the correct provider without env vars. Priority: explicit config > stored DB key > local default
- **`resolveEmbedding(key)` + `providerKey(provider)`** — exported from barrel for programmatic use
- **CLI `--embedding` flag** — `brainbank index --embedding openai` (replaces env var)
- **Optional tree-sitter grammars** — 17 language grammars moved to `optionalDependencies`; install only what you need (JS + TS remain as hard deps). Missing grammars throw with `npm install` instructions instead of silently falling back

### Changed
- **BREAKING: `Indexer` → `Plugin`** — base interface renamed to `Plugin`, `IndexerContext` → `PluginContext`, `IndexerRegistry` → `PluginRegistry`. No backward compat aliases — clean break
- **BREAKING: `.indexer()` → `.plugin()`** — accessor renamed, `.indexers` → `.plugins`
- **BREAKING: `BRAINBANK_EMBEDDING` env var removed** — use `--embedding` flag on first index, then auto-resolves from DB
- **`app/` → `api/`** — use-case layer renamed for clarity (was ambiguous with UI "app")
- **File names synced with classes** — `code-indexer.ts` → `code-walker.ts`, `docs-search.ts` → `document-search.ts`, `distiller.ts` → `pattern-distiller.ts`
- **`reembed.ts` split** — extracted `embedding-meta.ts` (single responsibility: startup metadata vs reembed logic)
- **Circular dep removed** — `searchDocs` callback replaced with `getDocsPlugin()` accessor in SearchAPI
- **Internal renames** — `_applyReranking` → `_rerankResults`, `_pushLastChunk` → `_flushRemainder`, `flush` → `processPending`
- **MCP server simplified** — removed `createEmbeddingProvider()` and `BRAINBANK_EMBEDDING` env var; embedding auto-resolves from DB
- **MCP repo auto-detect** — `BRAINBANK_REPO` env var is now optional; falls back to `findRepoRoot(cwd)`

### Fixed
- **`bm25!` crash** — non-null assertion replaced with safe `bm25?.search() ?? []` fallback

### Removed
- **`brainbank/reranker` subpath export** — `Qwen3Reranker` is now exported from the main `brainbank` barrel (`import { Qwen3Reranker } from 'brainbank'`)

## [0.5.0] — 2026-03-26

### Added
- HNSW disk persistence — indexes saved to `.brainbank/hnsw-{name}.index`, loaded on startup (skips O(n) rebuild)
- `vecToBuffer()` helper in `math.ts` for safe Float32Array → Buffer conversion
- `deleteCollection()` on BrainBank for evicting collections from memory
- RAG benchmarks moved to `test/benchmarks/rag/` with README (custom dataset eval + BEIR standard)

### Fixed
- **Buffer.from byteOffset bug** — 7 callsites stored entire shared buffer instead of vector slice (data corruption)
- **Reembed non-atomic** — used temp table swap instead of delete-before-rebuild (ACID guarantee)
- **Reembed temp table leak** — try/finally ensures temp table is dropped even if embedBatch fails mid-batch
- **Code-indexer crash window** — wrapped delete + insert in single transaction (prevents orphaned files)
- **Watch concurrent flush** — added flushing guard to prevent parallel flush() race conditions
- **embedBatch shared memory** — `LocalEmbedding.embedBatch` now copies via `.slice()` instead of creating views
- **Silent FTS catch blocks** — `keyword-search.ts` only swallows FTS5 syntax errors now, other errors propagate
- **Collection remove order** — DB delete first, then HNSW+cache. Prevents inconsistent state on disk full/lock
- **Dead code** — removed unused `escapeRegex` in `docs-indexer.ts`
- Fixed stale file paths in `search-quality.mjs` benchmark (4 paths from old architecture)

### Changed
- **MCP server consolidated** — 11 tools → 6: merged 3 search tools into `brainbank_search` (mode param), 3 collection tools into `brainbank_collection` (action param), removed standalone `coedits` (already in `context`)
- **Indexer interface composition** — stripped 15 optional methods to core contract + 4 composed interfaces (`IndexablePlugin`, `SearchablePlugin`, `WatchablePlugin`, `CollectionPlugin`) with runtime type guards
- **DocsPlugin split** — search logic extracted to `docs-search.ts` (DocsPlugin 324 → 140 lines)
- **`_requireDocs` init check** — replaced with type-safe `_docsPlugin()` that includes init + type guard check
- **Row types** — `db/rows.ts` with typed interfaces for kv_data, code_chunks, etc. Applied to `collection.ts` (10 `as any[]` → typed)
- `loadVectors` uses `.iterate()` cursor instead of `.all()` (O(1) vs O(n) memory)
- Reranking deduplicated — 4 inline copies → single `rerank()` in `rerank.ts`
- Collection `_searchVector` uses fixed k×10 multiplier (removed COUNT query per search)
- CLI factory cache uses `NOT_LOADED` sentinel instead of confusing `undefined`/`null`

## [0.4.1] — 2026-03-26

### Added
- Embedding provider benchmark results table in README (Local vs OpenAI vs Perplexity)
- Notes and Agent Memory plugin documentation in README

## [0.4.0] — 2026-03-26

### Added
- `PerplexityEmbedding` provider — standard embeddings via `pplx-embed-v1-{0.6b,4b}` models
- `PerplexityContextEmbedding` provider — contextualized embeddings via `pplx-embed-context-v1-{0.6b,4b}` (cross-chunk context awareness)
- CLI/MCP support: `BRAINBANK_EMBEDDING=perplexity` and `BRAINBANK_EMBEDDING=perplexity-context`
- Matryoshka dimension reduction support for Perplexity models
- Embedding provider benchmark script (`test/benchmarks/embedding-providers.ts`)

## [0.3.1] — 2026-03-25

### Fixed
- CLI `kv`, `context`, and `collection` commands now use `stripFlags()` — `--repo` values no longer pollute positional args

## [0.3.0] — 2026-03-25

### Added
- Type guards: `isCodeResult()`, `isCommitResult()`, `isDocumentResult()`, `isPatternResult()`, `isCollectionResult()`
- `matchResult()` pattern-matching helper for exhaustive SearchResult handling
- Reembed test for embedding dimension mismatch (384 → 128)
- `/publish` workflow (`.agents/workflows/publish.md`)
- Anti-pattern rules in `AGENTS.md`: size limits (40 lines/function, 300 lines/file), inline imports, `../` imports
- `CodePlugin.stats()` and `GitPlugin.stats()` now return DB counts (files, chunks, commits, coEdits)
- `_requireDocs()` guard in BrainBank for document-related methods
- SQLite `busy_timeout = 5000` to prevent `SQLITE_BUSY` under concurrent writes
- OpenAI embedding: 30s request timeout via `AbortController`, 100ms delay between batch chunks
- MCP server: pool max size (10) with LRU eviction to prevent OOM

### Changed
- `DocumentResult.filePath` is now required (was optional — docs indexer always provides it)
- `Collection.search()` results now use `type: 'collection'` instead of `type: 'document'`
- `reembed` streams per-batch — O(batchSize) memory instead of O(totalRows)
- `fileHistory()` delegated to `GitPlugin` (no raw SQL in BrainBank)
- Refactored 10 methods exceeding 40-line limit into focused helpers (largest: GitIndexer.index 152→15 lines)
- `AGENTS.md` fully translated to English
- `BrainBank.stats()` delegates to plugin indexers instead of running raw SQL
- `Collection.search()` RRF bridge uses typed metadata instead of `as any`
- `BrainBank` initialization uses `undefined!` instead of `undefined as any`
- `fileHistory()` and `coEdits()` return typed results instead of `any`
- `git commit` / `git push` moved to "NEVER without approval" in AGENTS.md
- Embedding provider mismatch now throws hard error instead of silent warning (use `initialize({ force: true })` for recovery)
- `LocalEmbedding.embedBatch` now uses real batch processing (groups of 32) instead of sequential one-by-one

### Fixed
- 162 pre-existing tsc errors in integration tests (dynamic assert imports → static)
- Dead import path in `packages/memory/test/helpers.ts` (`src/engine/brainbank.ts` → `src/brainbank.ts`)
- Dead import path in `packages/reranker/test/helpers.ts` (`src/engine/brainbank.ts` → `src/brainbank.ts`)
- Wrong collection name in `memory-entities.test.ts` (`memory_facts` → `memories`)
- `BrainBank.close()` now calls `embedding.close()` to release model resources

## [0.2.2] — 2025-03-25

### Changed
- Dissolved `engine/` directory into 4-layer architecture (Foundation → Infrastructure → Domain → Orchestration)
- Replaced all `../` imports with `@/` path aliases (108 imports across 53 files)
- Moved `rrf.ts` and `fts.ts` to `lib/` (pure stateless functions)
- Consolidated `src/memory/` into `src/indexers/memory/`
- `SearchAPI` now depends on `SearchStrategy` interface instead of concrete classes

### Added
- `SearchStrategy` interface with optional `rebuild()` method
- `@brainbank/memory` type declarations in `packages.d.ts`
- Comprehensive `AGENTS.md` with 4-layer rules, import conventions, naming standards

### Fixed
- Zero backwards imports — all cross-layer imports use `@/` aliases