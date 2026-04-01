# Changelog

All notable changes to `@brainbank/git` will be documented in this file.

## [Unreleased]

### Added
- Own schema creation via `MigratablePlugin` — `git_commits`, `commit_files`, `co_edits`, `git_vectors`, `fts_commits` tables are now created by the git plugin, not core
- `VectorSearchPlugin` implementation — `GitVectorSearch` for semantic commit search
- `ContextFormatterPlugin` implementation — git results and co-edit suggestion formatting
- `BM25SearchPlugin` implementation — FTS5 search against `fts_commits`
- Moved `git-vector-search.ts`, `git-context-formatter.ts` from core into package

### Added
- Initial release as a separate package
- **`@expose` decorator** on `suggestCoEdits()` and `fileHistory()` — auto-injected onto BrainBank after `initialize()`
- Git history indexing with incremental processing
- Commit embedding with enriched text (message + author + files + diff)
- Co-edit analysis — suggests files that change together
- Multi-repo support via named plugin instances
- `simple-git` as a dependency (previously bundled in core)
