# Changelog

All notable changes to BrainBank will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.2.2] — 2025-03-25

### Changed
- Dissolved `engine/` directory into 4-layer architecture (Foundation → Infrastructure → Domain → Orchestration)
- Replaced all `../` imports with `@/` path aliases (108 imports across 53 files)
- Moved `rrf.ts` and `fts.ts` to `lib/` (pure stateless functions)
- Consolidated `src/memory/` into `src/indexers/memory/`
- Renamed provider files to kebab-case (`local-embedding.ts`, `openai-embedding.ts`, `hnsw-index.ts`)
- Renamed search files to kebab-case (`vector-search.ts`, `keyword-search.ts`)
- `SearchAPI` now depends on `SearchStrategy` interface instead of concrete classes
- `fileHistory()` delegated to `GitPlugin` instead of raw SQL in BrainBank

### Added
- `SearchStrategy` interface with optional `rebuild()` method (`src/search/types.ts`)
- `@brainbank/memory` type declarations in `packages.d.ts`
- Reembed test for embedding dimension mismatch (384 → 128)
- Comprehensive `AGENTS.md` with 4-layer rules, import conventions, naming standards

### Fixed
- Zero backwards imports — all cross-layer imports use `@/` aliases
