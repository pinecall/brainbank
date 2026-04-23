---
description: Bump version, update CHANGELOG, build, and publish to npm
---

# /publish workflow

Run this when the user says `/publish` or asks to release a new version.

## Scope

The user will specify what to publish. Options:
- **core** — `brainbank` (root package)
- **code** — `@brainbank/code` (packages/code)
- **git** — `@brainbank/git` (packages/git)
- **docs** — `@brainbank/docs` (packages/docs)
- **memory** — `@brainbank/memory` (packages/memory)
- **all** — publish everything that has unreleased changes

If the user doesn't specify, ask: "Which package(s) to publish? `core`, `code`, `git`, `docs`, `memory`, or `all`?"

---

## Steps (for each package being published)

### 1. Ensure tests pass
// turbo
```
npm test
```
If tests fail, STOP and fix them first.

### 2. Check what changed since last version

For **core** (`brainbank`):
// turbo
```
LAST_TAG=$(git tag -l 'v*' --sort=-v:refname | head -1); git log ${LAST_TAG:+${LAST_TAG}..}HEAD --oneline --no-merges -50
```

For **packages/** (e.g. `code`):
// turbo
```
LAST_TAG=$(git tag -l '@brainbank/code@*' --sort=-v:refname | head -1); git log ${LAST_TAG:+${LAST_TAG}..}HEAD --oneline --no-merges -- packages/code/ -50
```

Adapt the tag prefix and path for each package.

Save this output — you'll need it to verify the CHANGELOG.

### 3. Ask the user for bump type
Ask: "What type of bump? `patch` (0.x.y → 0.x.y+1), `minor` (0.x.y → 0.x+1.0), or `major` (0.x.y → x+1.0.0)?"

Wait for the user's response before proceeding.

### 4. Verify and finalize CHANGELOG.md

Read the **correct** CHANGELOG.md:
- Core: `CHANGELOG.md` (root)
- Packages: `packages/<name>/CHANGELOG.md`

**Verify** the `[Unreleased]` items against the git log from step 2:
- **Add** any commits that are missing from `[Unreleased]`
- **Remove** any items that were reverted or no longer apply
- **Fix** inaccurate descriptions

Then:
1. Replace `## [Unreleased]` with `## [X.Y.Z] — YYYY-MM-DD`
2. Add a new empty `## [Unreleased]` section above it

**Format:**
```markdown
## [Unreleased]

## [X.Y.Z] — YYYY-MM-DD

### Added
- New features (from `feat:` commits)

### Changed
- Changes to existing features (from `refactor:` commits)

### Fixed
- Bug fixes (from `fix:` commits)
```

Omit empty sections. Use concise, user-facing descriptions (not raw commit messages).

### 5. Bump version in package.json

For **core**:
// turbo
```
npm version <patch|minor|major> --no-git-tag-version
```

For **packages/**:
// turbo
```
cd packages/<name> && npm version <patch|minor|major> --no-git-tag-version
```

### 6. Build

For **core**:
// turbo
```
npm run build:core
```

For **packages/** that have a build script:
// turbo
```
cd packages/<name> && npm run build
```

Skip if the package has no build step (e.g. `code-grammars-all`).

If build fails, STOP and fix.

### 7. Commit and tag

For **core**:
```
git add -A
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

For **packages/**:
```
git add -A
git commit -m "release: @brainbank/<name>@X.Y.Z"
git tag @brainbank/<name>@X.Y.Z
git push && git push --tags
```

### 8. Publish to npm

For **core**:
```
npm publish
```

For **packages/**:
```
cd packages/<name> && npm publish --access public
```

> **Note**: `--access public` is required for scoped packages on first publish.

### 9. Confirm
Tell the user: "✅ Published `<package>@X.Y.Z` to npm."

---

## Multi-package publish order

When publishing `all` or multiple packages, publish in dependency order:
1. `brainbank` (core) — no deps on other packages
2. `@brainbank/code` — depends on `brainbank`
3. `@brainbank/git` — depends on `brainbank`
4. `@brainbank/docs` — depends on `brainbank`
5. `@brainbank/memory` — depends on `brainbank`

Bump and publish each one fully (steps 4-9) before moving to the next.