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
Save this output — you'll use it to write the CHANGELOG entry.

### 3. Ask the user for bump type
Ask: "¿Qué tipo de bump? `patch` (0.x.y → 0.x.y+1), `minor` (0.x.y → 0.x+1.0), o `major` (0.x.y → x+1.0.0)?"

Wait for the user's response before proceeding.

### 4. Update CHANGELOG.md
Read the current `CHANGELOG.md` and check its state:

**If there's a `## [Unreleased]` section:**
- Replace `## [Unreleased]` with `## [X.Y.Z] — YYYY-MM-DD`
- Review the items — add any missing commits from step 2 that aren't already listed
- Remove any items that were reverted or superseded

**If there's NO `## [Unreleased]` section:**
- Generate a new entry from the commits in step 2
- Insert it after the header (before existing versions)

**Format:**
```markdown
## [X.Y.Z] — YYYY-MM-DD

### Added
- New features (from `feat:` commits)

### Changed
- Changes to existing features (from `refactor:` commits)

### Fixed
- Bug fixes (from `fix:` commits)
```

Group commits into categories. Omit empty sections. Use concise, user-facing descriptions (not raw commit messages). After the new version entry, add an empty `## [Unreleased]` section for future changes.

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

---

## CHANGELOG Convention

- **During development**: no need to touch CHANGELOG. Just use Conventional Commits.
- **Before publish**: the workflow generates/finalizes the CHANGELOG entry automatically.
- **Optional**: if you want to track "what's coming" mid-development, add items under `## [Unreleased]`. The workflow will stamp it with the version when publishing.
