# Changelog

All notable changes to BrainBank will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **`PLUGIN` / `HNSW` constants** (`src/constants.ts`) — single source of truth for plugin type names and HNSW index keys. Exported from `brainbank` barrel
- **`HnswPlugin` / `CoEditPlugin` interfaces** — typed capability interfaces for plugins that expose HNSW indexes or co-edit suggestions, with `isHnswPlugin()` / `isCoEditPlugin()` type guards

### Changed
- **Removed `as any` casts** — `initializer.ts` and `brainbank.ts` now use typed `isHnswPlugin` / `isCoEditPlugin` type guards instead of `as any` for plugin access
- **Split `context-builder.ts`** (375 → 50 lines) — formatting logic extracted to `src/search/context/` with 4 focused modules: `code-formatter.ts`, `graph-formatter.ts`, `result-formatters.ts`, `import-graph.ts`
- **Split `factory.ts`** (376 → 46 lines) — config loading, plugin discovery, provider setup, and builtin registration extracted to `src/cli/factory/` with 4 focused modules

## [0.8.0] — 2026-03-30

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