# Local Development Setup

How to set up BrainBank for local development on a fresh machine.

## Prerequisites

- **Node.js ≥18** (use whatever version you prefer via nvm or otherwise)
- **C++ toolchain** for native deps (`better-sqlite3`, `hnswlib-node`)
  - macOS: `xcode-select --install`
  - Linux: `build-essential`, `python3`

---

## Setup (2 steps)

### 1. Install all dependencies

```bash
npm install --legacy-peer-deps
```

This single command:
- Installs root dependencies (`better-sqlite3`, `hnswlib-node`, `tsup`, `tsx`, etc.)
- Auto-symlinks all `@brainbank/*` workspace packages in `node_modules/`
- Runs `postinstall` to symlink `node_modules/brainbank` → local root (so plugins resolve the local dev build, not the npm-published version)

> **Why `--legacy-peer-deps`?** The `@brainbank/code` package has tree-sitter peer dep conflicts. This flag resolves them without errors.

### 2. Build everything

```bash
npm run build
```

Builds the core (`tsup`) and all workspace packages (`npm run build --workspaces --if-present`).

---

## Verification

```bash
# Type check (zero errors expected)
npx tsc --noEmit

# Unit tests (~200 tests)
npm test

# Integration tests (downloads embedding model, ~30s)
npm run test:integration
```

---

## How it works

The project uses **npm workspaces** (`"workspaces": ["packages/*"]` in root `package.json`). This means:

| What | How |
|------|-----|
| `@brainbank/code`, `git`, `docs`, `memory`, `mcp` | Auto-symlinked by npm to `node_modules/@brainbank/*` |
| `brainbank` peer dep in plugins | Resolved by `postinstall` script → symlink to local root |
| Plugin builds | `npm run build` runs `tsup` in each workspace via `--workspaces` |

### Why the postinstall script?

In npm workspaces, workspace packages auto-symlink. But `brainbank` itself is the **root** package, not a workspace member. When plugins declare `peerDependencies: { "brainbank": ">=0.7.0" }`, npm fetches the published version from the registry. The `postinstall` script replaces that with a symlink to the local root so plugins always build and run against the dev version.

---

## Troubleshooting

### `npm install` shows peer dep conflicts

Use `--legacy-peer-deps`. The tree-sitter packages in `@brainbank/code` have conflicting peer deps that don't affect functionality.

### `does not provide an export named 'X'`

The plugin dist was built before the core was rebuilt. Fix:
```bash
npm run build
```

### Native deps fail to build

Ensure you have a C++ toolchain:
- macOS: `xcode-select --install`
- If `node-gyp` errors persist: `npm install -g node-gyp`
