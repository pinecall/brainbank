# Changelog

All notable changes to `@brainbank/code` will be documented in this file.

## [Unreleased]

### Added
- Own schema creation via `MigratablePlugin` — `code_chunks`, `code_vectors`, `indexed_files`, `code_imports`, `code_symbols`, `code_refs`, `fts_code` tables are now created by the code plugin, not core
- `VectorSearchPlugin` implementation — `CodeVectorSearch` with MMR diversity
- `ContextFormatterPlugin` implementation — code results and import graph context formatting
- `BM25SearchPlugin` implementation — FTS5 search against `fts_code` + file-path LIKE fallback
- Moved `code-vector-search.ts`, `sql-code-graph.ts`, `import-graph.ts`, `code-context-formatter.ts` from core into package

### Fixed
- **BUG-03: HNSW/DB inconsistency on rollback** — HNSW `add()`/`remove()` calls moved outside DB transaction in `CodeWalker._indexFile()`. If the transaction rolls back, the in-memory HNSW index stays consistent with the DB
- **ANTI-13: LIKE injection in fileHistory** — file path search now escapes SQL LIKE wildcards (`%`, `_`) with `ESCAPE '\\'`

### Added
- Initial release as separate package (extracted from `brainbank` core)
- AST-aware code chunking for 20+ languages via tree-sitter
- Import graph extraction (`code_imports` table)
- Symbol index with call references (`code_symbols`, `code_refs` tables)
- Contextual embeddings (file path + imports + parent class enrichment)
- Incremental indexing (FNV-1a hash-based change detection)
- Custom ignore patterns via picomatch globs
- Multi-repo support via named code plugins (`code:frontend`, `code:backend`)
