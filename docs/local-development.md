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

### 2. Link the CLI globally

```bash
npm link
```

This creates a global `brainbank` command pointing to `bin/brainbank.ts`. The CLI runs TypeScript source directly via `tsx` — **no build step needed**.

The workspace packages are also linked globally by npm:

```
Global symlinks:
  brainbank        → /path/to/brainbank/bin/brainbank.ts
  @brainbank/code  → /path/to/brainbank/packages/code
  @brainbank/git   → /path/to/brainbank/packages/git
  @brainbank/docs  → /path/to/brainbank/packages/docs
  @brainbank/mcp   → /path/to/brainbank/packages/mcp
```

That's it. No build step required — edit source and run immediately.

---

## Source-first architecture

All `package.json` files (root + packages) point `main`/`exports` directly to `src/index.ts`. Node resolves TypeScript source at runtime via `tsx`. No `dist/` needed during development.

```
node_modules/@brainbank/code → ../../packages/code → src/index.ts
node_modules/@brainbank/git  → ../../packages/git  → src/index.ts
node_modules/@brainbank/docs → ../../packages/docs → src/index.ts
node_modules/@brainbank/mcp  → ../../packages/mcp  → src/mcp-server.ts
node_modules/brainbank       → ..                  → src/index.ts
```

The `bin/brainbank.ts` shim uses `#!/usr/bin/env node --import tsx` to register the TypeScript loader before imports execute. Every edit to any `.ts` file takes effect immediately — no rebuild cycle.

> **Building is only needed for `npm publish`.** The `prepublishOnly` script runs `tsup` to generate `dist/` for the npm registry.

---

## Day-to-day commands

```bash
# Run CLI directly (source, no build)
brainbank index .
brainbank context "auth flow"

# Type check
npx tsc --noEmit

# Unit tests (~267 tests, ~9s)
npm test

# Filter by name
npm test -- --filter reembed

# Integration tests (downloads embedding model, ~30s)
npm run test:integration

# Build for publishing only
npm run build        # core + all packages
npm run build:core   # core only
```

---

## How workspaces work

The project uses **npm workspaces** (`"workspaces": ["packages/*"]`).

| What | How |
|------|-----|
| `@brainbank/code`, `git`, `docs`, `mcp` | Auto-symlinked by npm to `node_modules/@brainbank/*` |
| `brainbank` peer dep in plugins | `postinstall` script → symlink `node_modules/brainbank` to repo root |
| Resolution | All packages point `main`/`exports` to `src/index.ts` — source-first |
| Global CLI | `npm link` → global bin points to `bin/brainbank.ts` (tsx) |

### Why the postinstall symlink?

In npm workspaces, workspace packages auto-symlink. But `brainbank` itself is the **root** package, not a workspace member. When plugins declare `peerDependencies: { "brainbank": ">=0.7.0" }`, npm would fetch the published version from the registry. The `postinstall` script replaces that with a symlink to the local root so plugins always resolve against the dev source:

```bash
rm -rf node_modules/brainbank && ln -s .. node_modules/brainbank
```

### Import extensions in packages

Packages use `.js` extensions for local imports (e.g., `from './git-plugin.js'`). This is intentional — `tsx` resolves `.js` → `.ts` automatically at runtime, and `tsup` expects `.js` extensions when building for npm publish.

---

## Troubleshooting

### `npm install` shows peer dep conflicts

Use `--legacy-peer-deps`. Tree-sitter packages have conflicting peer deps that don't affect functionality.

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

Verify: `ls -la $(which brainbank)` — should show a symlink to your repo's `bin/brainbank.ts`.

### `TS5055: Cannot write file 'dist/index.d.ts'`

Only happens when running `tsup` for publishing. Stale `.d.ts` from a previous build conflicts with the postinstall symlink. Fix:
```bash
rm -rf dist && npm run build:core
```
This is already handled by the `build:core` script, but can happen if you run `npx tsup` directly.
