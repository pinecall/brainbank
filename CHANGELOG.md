# Changelog

All notable changes to BrainBank will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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