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
git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~20")..HEAD --oneline --no-merges
```
If `git describe` fails (no tags), use the last 20 commits.

Save this output — you'll use it to write the CHANGELOG entry.

### 3. Ask the user for bump type
Ask: "¿Qué tipo de bump? `patch` (0.2.2 → 0.2.3), `minor` (0.2.2 → 0.3.0), o `major` (0.2.2 → 1.0.0)?"

Wait for the user's response before proceeding.

### 4. Update CHANGELOG.md
Add a new entry at the TOP of the file (after the header), using this format:

```markdown
## [X.Y.Z] — YYYY-MM-DD

### Added
- New features (from `feat:` commits)

### Changed
- Changes to existing features (from `refactor:` commits)

### Fixed
- Bug fixes (from `fix:` commits)
```

Group the commits from step 2 into the appropriate categories.
Omit empty sections. Use concise, user-facing descriptions (not raw commit messages).

### 5. Bump version in package.json
```
npm version <patch|minor|major> --no-git-tag-version
```
Use the bump type from step 3. The `--no-git-tag-version` flag prevents auto-commit so we can commit everything together.

### 6. Build
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
