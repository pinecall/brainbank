# Changelog

All notable changes to `@brainbank/code` will be documented in this file.

## [Unreleased]

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
