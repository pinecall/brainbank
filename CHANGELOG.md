# Changelog

All notable changes to BrainBank will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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