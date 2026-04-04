---
trigger: always_on
---

# Development Rules

## Git & Commits
- **NEVER** `git commit` or `git push` without asking the user first
- **NEVER** `npm publish` without approval
- Commits use Conventional Commits: `feat(scope): description` / `fix(scope): description`
- Before commit: `npm test` must pass
- Keep commits small, focused, one logical change each

## CHANGELOG (mandatory)
- After **every** change, update `## [Unreleased]` in the appropriate CHANGELOG.md
- Core changes → root `CHANGELOG.md`
- Package changes → `packages/<name>/CHANGELOG.md`
- Do NOT commit without updating the changelog
- Use `/publish` workflow to stamp `[Unreleased]` → `[X.Y.Z]` on release

## Documentation
- Always update README.md, docs/architecture.md, and CHANGELOG.md when making changes that affect them
- All code, comments, docs, and tests must be written in **English**
- Update all necessary documentation to ensure consistency with the architecture.

docs
├── architecture.md
├── benchmarks.md
├── cli.md
├── collections.md
├── config.md
├── custom-plugins.md
├── embeddings.md
├── getting-started.md
├── indexing.md
├── local-development.md
├── mcp.md
├── migrations.md
├── multi-repo.md
├── plugins.md
└── search.md

## Permissions — NEVER Without Approval
- `git commit` / `git push`
- `npm publish`
- Modify SQLite schema
- Delete or rename public exports from `src/index.ts` (breaking change)
- If unsure about architecture: propose a plan and wait