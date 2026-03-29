# Changelog

All notable changes to `@brainbank/docs` will be documented in this file.

## [Unreleased]

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
