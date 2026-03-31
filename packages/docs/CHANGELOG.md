# Changelog

All notable changes to `@brainbank/docs` will be documented in this file.

## [Unreleased]

### Fixed
- **BUG-09: double-transaction partial state** — `DocsIndexer._indexFile()` now embeds first, then uses a single transaction for chunks + vectors atomically. HNSW deferred to after commit
- **ANTI-12: relative path storage** — `DocsPlugin.addCollection()` now resolves paths to absolute via `path.resolve()` before storing in DB
- **ANTI-16: glob pattern matching** — replaced fragile multi-step regex glob with cleaner implementation using anchored regex and proper escape ordering
- **HNSW persistence** — HNSW index now saved to disk via `createHnsw('doc')`, enabling fast `tryLoad()` on restart instead of rebuilding from SQLite

### Added
- Initial release as a separate package
- **`@expose` decorator** on all public methods — auto-injected onto BrainBank after `initialize()`
- `searchDocs()` exposed method (replaces internal `search()` for injection)
- `indexDocs()` replaces `indexCollections()` (backward compat alias available)
- Heading-aware smart chunking (qmd-inspired break point scoring)
- Hybrid search (vector + BM25 → RRF) for document collections
- Incremental indexing with content hash change detection
- Path-based context system for embedding enrichment
- Collection management (add, remove, list)
- Optional reranking support
