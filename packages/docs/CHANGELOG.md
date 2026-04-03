# Changelog

All notable changes to `@brainbank/docs` will be documented in this file.

## [Unreleased]

### Fixed
- **Orphan cleanup** — `indexCollection()` now removes chunks and vectors for files that were deleted from disk. Previously, deleting a file left stale entries in the DB forever
- `indexCollection()` return type now includes `removed` count
- **Docs always re-indexing** — `addCollection()` used `INSERT OR REPLACE INTO collections` which SQLite implements as DELETE+INSERT, triggering `ON DELETE CASCADE` on `doc_chunks` and wiping all indexed data on every startup. Changed to `INSERT … ON CONFLICT DO UPDATE` (true upsert)

### Changed
- **Incremental tracking migrated to core** — Replaced custom `_isUnchanged` query (doc_chunks + doc_vectors join) with `PluginContext.createTracker()`. Uses shared `plugin_tracking` table for hash-based change detection and orphan cleanup
- **BREAKING: search pipeline alignment** — DocsPlugin now implements `VectorSearchPlugin`, `BM25SearchPlugin`, and `ContextFormatterPlugin`, matching Code and Git plugin pattern. Docs results now flow through `CompositeVectorSearch` + `CompositeBM25Search` → central RRF instead of entering pre-fused via the `SearchablePlugin` catch-all path
- Switched from private HNSW (`createHnsw()`) to shared HNSW (`getOrCreateSharedHnsw('docs')`) — docs vectors now load once and participate in the standard search pipeline
- `searchBM25()` uses core `sanitizeFTS()` instead of a custom FTS query builder

### Added
- `DocsVectorSearch` class — pure HNSW vector search for doc_chunks (no internal RRF)
- `createVectorSearch()` — VectorSearchPlugin implementation exposing `DocsVectorSearch`
- `searchBM25()` / `rebuildFTS()` — BM25SearchPlugin implementation (docs now appear in keyword-only searches)
- `formatContext()` — ContextFormatterPlugin with document-specific formatting for LLM context
- Own schema creation via `MigratablePlugin` — `collections`, `doc_chunks`, `doc_vectors`, `path_contexts`, `fts_docs` tables are now created by the docs plugin, not core

### Fixed
- **Double-RRF scoring bug** — docs results no longer get RRF'd internally before entering the outer RRF. Scores are now comparable with code and git results
- **Missing keyword search** — docs were completely excluded from `brain.searchBM25()` because the plugin didn't implement `BM25SearchPlugin`
- **Missing context formatting** — docs results in `brain.getContext()` were rendered as generic bullet points instead of having domain-specific markdown formatting
- Eliminated all `db: any` types in `DocumentSearch` and `DocumentSearchDeps`
- Replaced all `as any` casts in `document-search.ts` with properly typed row interfaces

### Added
- `index()` method — implements `IndexablePlugin` so docs participates in generic `brain.index()` pipeline
- Eliminated all `any` from `stats()`, `listCollections()`, `listContexts()`

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
