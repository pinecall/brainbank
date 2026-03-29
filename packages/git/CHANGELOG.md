# Changelog

All notable changes to `@brainbank/git` will be documented in this file.

## [Unreleased]

### Added
- Initial release as a separate package
- **`@expose` decorator** on `suggestCoEdits()` and `fileHistory()` — auto-injected onto BrainBank after `initialize()`
- Git history indexing with incremental processing
- Commit embedding with enriched text (message + author + files + diff)
- Co-edit analysis — suggests files that change together
- Multi-repo support via named plugin instances
- `simple-git` as a dependency (previously bundled in core)
