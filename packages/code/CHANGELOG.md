# Changelog

All notable changes to `@brainbank/code` will be documented in this file.

## [Unreleased]

### Added
- **Dependency Tracker** — full bidirectional import graph with resolved file paths
  - `ImportResolver` class — resolves import specifiers to actual file paths at index time (exact match → extension probing → index file → dotted path → tail-index fallback)
  - `extractImportPaths()` — extracts raw import specifiers with kind classification (`static`, `dynamic`, `type`, `require`, `side-effect`, `export-from`) and local detection
  - `buildDependencyGraph()` — bidirectional BFS traversal (forward downstream + reverse upstream) with depth, in/out degree, and edge metadata
  - Schema migration v2: `import_kind` + `resolved` columns on `code_imports`, reverse lookup index
  - Context formatter now groups related code into **Dependents** (upstream), **Dependencies** (downstream), and **Related Files** (siblings) sections
  - **V2:** Inline import capture — removed `^` anchors so Python/Java/Kotlin/etc. inline imports are detected
  - **V2:** Dotted path resolution — `pinecall.pipeline.vad` → `src/pinecall/pipeline/vad.py` via dotted index
  - **V2:** Call graph fusion — `_symbolBFS` follows `code_refs→code_symbols` edges to discover definition files
  - **V2:** Adaptive hops — hub files (5+ dependents) traverse 3 hops instead of 2
  - **V2:** Weighted edges — runtime imports (`static`, `require`, `dynamic`) prioritized over `type` imports in BFS
  - **V3:** Stdlib/builtin filtering — Python (80+ modules), JS/TS (30+ Node builtins), Go, Rust, Java/Kotlin/Scala, C# stdlib imports excluded from graph
  - **V3:** Chunk-level call graph — `code_call_edges` table links caller chunks to callee chunks via `code_refs→code_symbols` join
  - **V3:** Called Functions section — context output shows exact definition chunks that are called by matched code, not just "best chunk per file"
  - **V3:** Schema migration v3 for `code_call_edges` table with caller/callee indices
  - **V3:** Context output optimization — precision-first section ordering (Called Functions before Dependencies), dedup files across sections, dependency cap at 8 files with source + summary for rest. Reduced output 37% (2668→1677 lines for a 2-result query)
  - **V4:** AST-first chunker — tree-sitter extraction runs for ALL files (not just >80 lines), producing function-level chunks even for small files. Critical for call graph resolution.
  - **V4:** Unified flat formatter — single `## Code Context` section replaces multi-section output. No sub-headers, no trimming, no truncation. Every chunk shows full source.
  - **V4:** `called by` annotations — each call-tree chunk shows which function calls it (e.g. `called by validate_token`). Uses `callerName` field on `CallTreeNode` populated by seed lookup in `buildCallTree`.
  - **V4:** Test file filtering — files matching `test/`, `tests/`, `__tests__`, `.test.`, `.spec.` excluded from call tree output.
- Own schema creation via `MigratablePlugin` — `code_chunks`, `code_vectors`, `indexed_files`, `code_imports`, `code_symbols`, `code_refs`, `fts_code` tables are now created by the code plugin, not core
- `VectorSearchPlugin` implementation — `CodeVectorSearch` with MMR diversity
- `ContextFormatterPlugin` implementation — code results and import graph context formatting
- `BM25SearchPlugin` implementation — FTS5 search against `fts_code` + file-path LIKE fallback
- Moved `code-vector-search.ts`, `sql-code-graph.ts`, `import-graph.ts`, `code-context-formatter.ts` from core into package

### Fixed
- Fixed TS5055 build error (`dist/index.d.ts` overwriting input) caused by `node_modules/brainbank` symlink — added `preserveSymlinks: true` + `skipLibCheck: true` to `tsconfig.build.json`
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
