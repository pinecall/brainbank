# Local Development Setup

How to set up BrainBank for local development on a fresh machine.

## Prerequisites

- **Node.js ≥18** (nvm recommended)
- **C++ toolchain** for native deps (`better-sqlite3`, `hnswlib-node`)
  - macOS: `xcode-select --install`
  - Linux: `build-essential`, `python3`

---

## Setup

### 1. Install dependencies

```bash
npm install --legacy-peer-deps
```

This single command:
- Installs root deps (`better-sqlite3`, `hnswlib-node`, `tsup`, `tsx`, etc.)
- Auto-symlinks all `@brainbank/*` workspace packages in `node_modules/`
- Runs `postinstall` → creates `node_modules/brainbank` symlink to local root

> **Why `--legacy-peer-deps`?** Tree-sitter packages in `@brainbank/code` have conflicting peer deps that don't affect functionality.

### 2. Build

```bash
npm run build
```

This runs:
1. `rm -rf dist && tsup` — builds core (ESM + DTS)
2. `npm run build --workspaces --if-present` — builds all `@brainbank/*` packages

> **⚠️ Build order matters.** Core must build first because packages depend on `brainbank` peer dep. The `build` script handles this automatically. If building individually, always run `npm run build:core` before any `cd packages/* && npm run build`.

### 3. Link the CLI globally

```bash
npm link
```

This creates a global `brainbank` command pointing to your local `dist/cli.js`. Every subsequent `npm run build:core` updates the CLI automatically — no reinstall needed.

The workspace packages are also linked globally by npm:

```
Global symlinks:
  brainbank        → /path/to/brainbank/dist/cli.js
  @brainbank/code  → /path/to/brainbank/packages/code
  @brainbank/git   → /path/to/brainbank/packages/git
  @brainbank/docs  → /path/to/brainbank/packages/docs
  @brainbank/mcp   → /path/to/brainbank/packages/mcp
```

---

## Day-to-day commands

```bash
# Rebuild core only (fast — ~2s)
npm run build:core

# Rebuild core + all packages
npm run build

# Dev mode (runs CLI directly via tsx, no build needed)
npm run dev -- index .
npm run dev -- context "auth flow"

# Type check
npx tsc --noEmit

# Unit tests (230 tests, ~10s)
npm test

# Filter by name
npm test -- --filter reembed

# Integration tests (downloads embedding model, ~30s)
npm run test:integration
```

---

## How workspaces work

The project uses **npm workspaces** (`"workspaces": ["packages/*"]`).

| What | How |
|------|-----|
| `@brainbank/code`, `git`, `docs`, `mcp` | Auto-symlinked by npm to `node_modules/@brainbank/*` |
| `brainbank` peer dep in plugins | `postinstall` script → symlink `node_modules/brainbank` to repo root |
| Plugin builds | `npm run build` runs `tsup` in each workspace via `--workspaces` |
| Global CLI | `npm link` → global bin points to local `dist/cli.js` |

### Why the postinstall symlink?

In npm workspaces, workspace packages auto-symlink. But `brainbank` itself is the **root** package, not a workspace member. When plugins declare `peerDependencies: { "brainbank": ">=0.7.0" }`, npm would fetch the published version from the registry. The `postinstall` script replaces that with a symlink to the local root so plugins always build and run against the dev version:

```bash
rm -rf node_modules/brainbank && ln -s .. node_modules/brainbank
```

### Why `rm -rf dist` in build scripts?

The `postinstall` symlink creates a **circular reference**: `node_modules/brainbank → ..` (repo root). When `tsup` generates DTS output, TypeScript resolves `brainbank` through this symlink and follows `"types": "dist/index.d.ts"`. If that file exists from a prior build, TS throws `TS5055: Cannot write file because it would overwrite input file`. Pre-deleting `dist/` avoids this.

---

## Troubleshooting

### `TS5055: Cannot write file 'dist/index.d.ts'`

Stale `.d.ts` from a previous build conflicts with the postinstall symlink. Fix:
```bash
rm -rf dist && npm run build:core
```
This is already handled by the `build:core` script, but can happen if you run `npx tsup` directly.

### `npm install` shows peer dep conflicts

Use `--legacy-peer-deps`. Tree-sitter packages have conflicting peer deps that don't affect functionality.

### `does not provide an export named 'X'`

Plugin dist was built before core was rebuilt. Fix:
```bash
npm run build
```

### Native deps fail to compile

Ensure C++ toolchain:
- macOS: `xcode-select --install`
- If `node-gyp` errors persist: `npm install -g node-gyp`

### `brainbank` CLI shows old behavior

The global `brainbank` command may point to an npm-published version instead of your local dev build. Fix:
```bash
npm uninstall -g brainbank
npm link
```

Verify: `ls -la $(which brainbank)` — should show a symlink to your repo's `dist/cli.js`.
