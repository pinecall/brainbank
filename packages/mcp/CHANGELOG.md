# Changelog

All notable changes to `@brainbank/mcp` will be documented in this file.

## [Unreleased]

### Breaking Changes
- **Removed 5 MCP tools**: `brainbank_search`, `brainbank_stats`, `brainbank_history`, `brainbank_collection`, `brainbank_workspaces`. Server now exposes only `brainbank_context` (primary) and `brainbank_index`
- `brainbank_context` description updated to reference Workflow Trace output

### Added
- **Project structure summary** — prepends a compact 2-level directory tree on the first MCP call per session for project awareness

### Removed
- **Session-level deduplication** — removed automatic file tracking across calls. It accumulated files from ALL queries/conversations, progressively stripping the best results from subsequent searches. Dedup caused a 4/10 → 8/10 quality swing between identical queries
- **`docsResults` param** on `brainbank_context` — explicit max document results, ensuring docs filtering works reliably across all MCP clients
- **`sources` param** on `brainbank_context` — per-source result limits (e.g. `{ code: 10, git: 0, docs: 5 }`), overrides named params when present
- **`path` param** on `brainbank_context` — filter results to files under a path prefix (e.g. `src/services/`)

### Fixed
- **Sources filtering** — `sources` Record param was silently dropped by some MCP clients. Named params (`codeResults`, `gitResults`, `docsResults`) now serve as the reliable base, with `sources` as an optional override

### Changed
- Server reduced from 443 lines to 160 lines
- Version bumped to 0.4.0

## [0.3.0]

### Breaking Changes
- `@brainbank/code`, `@brainbank/git`, `@brainbank/docs` moved from `dependencies` to optional `peerDependencies`. Users installing `@brainbank/mcp` standalone must install plugins separately

### Added
- **`WorkspacePool`** — manages BrainBank instance lifecycle per workspace with memory-pressure eviction (configurable via `BRAINBANK_MAX_MEMORY_MB`, default 2GB), TTL eviction for inactive workspaces (`BRAINBANK_TTL_MINUTES`, default 30min), and active-operation tracking to prevent mid-query eviction
- **`brainbank_workspaces` tool** — pool observability with `list`, `evict`, and `stats` actions. Shows loaded workspaces, memory usage, last access time, and active operations
- **`WorkspaceFactory`** — delegates BrainBank creation to core `createBrain()` factory, inheriting all plugin discovery from config

### Changed
- **Eliminated hardcoded plugin loading** — removed direct imports of `@brainbank/code`, `@brainbank/git`, `@brainbank/docs`. Plugins are now discovered and loaded by the core factory from `.brainbank/config.json`
- **Replaced arbitrary `MAX_POOL_SIZE=10`** with intelligent `WorkspacePool` class that evicts based on estimated memory usage and inactivity TTL
- **Eliminated `_createBrain` duplication** — MCP server no longer duplicates config reading and plugin registration logic from the CLI factory
- **Fixed all `any` types** — proper type narrowing throughout (stats, history, results, error handling)
- **`isDocsPlugin()` type guard** — replaces `(brainbank.docs as any)` for docs collection registration

## [0.2.0]

### Added
- Initial MCP server with 6 tools
- Multi-workspace pool with LRU eviction
