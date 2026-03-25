---
description: Bump version, update CHANGELOG, build, and publish to npm
---

# /publish workflow

Run this when the user says `/publish` or asks to release a new version.

## Steps

### 1. Ensure tests pass
// turbo
```
npm test
```
If tests fail, STOP and fix them first.

### 2. Check what changed since last version
```
git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~50")..HEAD --oneline --no-merges
```
If `git describe` fails (no tags), use the last 50 commits.
Save this output — you'll need it to verify the CHANGELOG.

### 3. Ask the user for bump type
Ask: "What type of bump? `patch` (0.x.y → 0.x.y+1), `minor` (0.x.y → 0.x+1.0), or `major` (0.x.y → x+1.0.0)?"

Wait for the user's response before proceeding.

### 4. Verify and finalize CHANGELOG.md

Read `CHANGELOG.md`. There should be a `## [Unreleased]` section maintained by agents during development.

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
```
npm version <patch|minor|major> --no-git-tag-version
```
Use the bump type from step 3.

### 6. Build
// turbo
```
npm run build:core
```
If build fails, STOP and fix.

### 7. Commit and tag
```
git add -A
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

### 8. Publish to npm
```
npm publish
```

### 9. Confirm
Tell the user: "✅ Published `brainbank@X.Y.Z` to npm."
