# Changelog

All notable changes to BrainBank will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Type guards: `isCodeResult()`, `isCommitResult()`, `isDocumentResult()`, `isPatternResult()`, `isCollectionResult()`
- `matchResult()` pattern-matching helper for exhaustive SearchResult handling
- Reembed test for embedding dimension mismatch (384 → 128)
- `/publish` workflow (`.agents/workflows/publish.md`)
- Anti-pattern rules in `AGENTS.md`: size limits (40 lines/function, 300 lines/file), inline imports, `../` imports

### Changed
- `DocumentResult.filePath` is now required (was optional — docs indexer always provides it)
- `Collection.search()` results now use `type: 'collection'` instead of `type: 'document'`
- `reembed` streams per-batch — O(batchSize) memory instead of O(totalRows)
- `fileHistory()` delegated to `GitPlugin` (no raw SQL in BrainBank)
- Refactored 10 methods exceeding 40-line limit into focused helpers (largest: GitIndexer.index 152→15 lines)
- `AGENTS.md` fully translated to English

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