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

## Permissions — Safe to Auto-Run
- Read files, list directories
- `npx tsc --noEmit`
- `npm test -- --filter <name>`
- Create new files in existing directories

## Permissions — NEVER Without Approval
- `git commit` / `git push`
- `npm publish`
- Modify SQLite schema
- Delete or rename public exports from `src/index.ts` (breaking change)
- If unsure about architecture: propose a plan and wait