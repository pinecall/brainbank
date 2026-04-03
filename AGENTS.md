# AGENTS.md

## Project Overview

BrainBank is a lightweight, pluggable semantic memory framework for AI agents — hybrid search (vector + BM25) in a single SQLite file. The core package (`brainbank`) provides the framework, CLI, Collection API, and search orchestration. All indexers ship as independent `@brainbank/*` packages.

Architecture: 4-layer modular plugin system with `.use()` builder pattern.
Stack: TypeScript (strict, ESM) · Node ≥18 · better-sqlite3 · hnswlib-node.

## Dev Environment

- Install: `npm install --legacy-peer-deps` (npm workspaces auto-link all `@brainbank/*` packages; `postinstall` script links local core for plugin resolution)
- Build: `npm run build` (builds core + all workspace packages)
- Build core only: `npm run build:core` (tsup — generates `dist/`)
- Dev CLI: `npm run dev` (runs `tsx src/cli/index.ts`)
- No `.env` file needed for development. Optional: `OPENAI_API_KEY` for OpenAI embeddings.
- Full setup guide: `docs/local-development.md` or run `/setup-local` workflow

## Commands

### Preferred (minimal scope)
- Type-check: `npx tsc --noEmit`
- Test by name: `npm test -- --filter <name>`
- Test verbose: `npm test -- --verbose --filter <name>`

### Full suite (only when requested)
- Unit tests: `npm test` (200 tests, ~11s)
- Integration: `npm run test:integration` (downloads embedding model, ~30s)
- Build: `npm run build:core`

## Project Structure

4-layer architecture. Imports only flow **downward** — never up.

```
Layer 0 — Foundation (no deps, imported by everyone)
├── types.ts         ← All shared types and interfaces
├── config.ts        ← Defaults + resolver (flattened from config/)
├── lib/             ← Pure functions: math, rrf, fts
└── db/              ← DatabaseAdapter interface, SQLiteAdapter (+ schema), metadata, migrations

Layer 1 — Infrastructure (depends on Layer 0 only)
├── providers/       ← Embeddings (local WASM, OpenAI), vector (HNSW), rerankers
└── search/          ← SearchStrategy implementations: vector/, keyword/, context/

Layer 2 — Domain (depends on Layers 0-1)
├── plugin.ts        ← Plugin + PluginContext + capability interfaces (flattened from plugins/)
├── services/        ← Collection, reembed, watch
└── lib/languages.ts ← Language detection + file filtering utilities

Layer 3 — Application (depends on everything below)
├── brainbank.ts     ← The main orchestrator
├── constants.ts     ← PLUGIN / HNSW typed constants
├── bootstrap/       ← (reserved for future system wiring)
├── engine/          ← Use cases: search-api, index-api
└── cli/             ← CLI commands/ and factory/ (dynamic plugin loading)
```

```
typings/
└── packages.d.ts    ← Type declarations for @brainbank/* packages (dev only)
```

```
packages/                ← All plugin implementations live here (NOT in src/)
├── code/            ← @brainbank/code — Code indexer (AST, import graph, symbols)
├── git/             ← @brainbank/git — Git history + co-edit analysis
├── docs/            ← @brainbank/docs — Document collection search
├── mcp/             ← @brainbank/mcp — MCP server
```

> **CRITICAL:** Plugin implementations live ONLY in `packages/`. The core `src/plugin.ts` defines the `Plugin` interface. `languages.ts` lives in `src/lib/`. **Never add plugin logic to `src/`.**

### Key Files
- `src/brainbank.ts` — The main orchestrator. All public API lives here.
- `src/plugin.ts` — `Plugin` + `PluginContext` + capability interfaces (`CoEditPlugin`).
- `src/constants.ts` — `PLUGIN` / `HNSW` typed constants. Single source of truth for string keys.
- `src/services/collection.ts` — Universal KV store with hybrid search. Core primitive.
- `src/search/context-builder.ts` — Builds formatted context blocks (delegates to `context/` formatters).
- `src/search/types.ts` — `SearchStrategy` interface. All search backends implement it.
- `src/brainbank.ts` — Main orchestrator with inline initialization (`_runInitialize`).
- `src/engine/search-api.ts` — Hybrid search orchestration (vector + keyword + RRF).
- `src/cli/factory/index.ts` — CLI factory (delegates to config-loader, plugin-loader, builtin-registration).
- `src/db/adapter.ts` — `DatabaseAdapter` interface + `PreparedStatement<T>` + `AdapterCapabilities` + core row types.
- `src/db/sqlite-adapter.ts` — `SQLiteAdapter`: better-sqlite3 implementation + core schema DDL.
- `src/db/metadata.ts` — `bumpVersion`/`getVersions` (index state) + `getEmbeddingMeta`/`setEmbeddingMeta` (provider tracking).
- `src/db/migrations.ts` — `runPluginMigrations`: per-plugin versioned schema migrations.
- `src/db/tracker.ts` — `IncrementalTracker` interface + `createTracker()` factory. Standardized add/update/delete detection for plugin indexing via shared `plugin_tracking` table.
- `typings/packages.d.ts` — Type declarations for `@brainbank/*` packages.

## Code Conventions

### Language
- **All code, comments, docs, and tests must be written in English.** No exceptions.

### TypeScript
- Strict mode — no `any` in new code, no `@ts-ignore`
- ESM only (`"type": "module"` in package.json)
- Imports use `.ts` extensions (`import { X } from './foo.ts'`)
- JSDoc on every exported function and class — concise, no `@param` spam
- Never `console.log` in library code — use `this.emit('event', data)` on BrainBank

### Naming
- `camelCase` — functions, variables, methods
- `PascalCase` — classes, interfaces, type aliases
- `kebab-case` — file names (e.g. `hnsw-index.ts`, `code-chunker.ts`)
- Files containing a class are named after the class in kebab-case: `VectorSearch` → `vector-search.ts`
- Files containing pure functions use descriptive kebab-case: `rrf.ts`, `fts.ts`, `math.ts`

### Import Rules (Critical)
- **Path aliases**: All cross-directory imports in `src/` use `@/` (configured in `tsconfig.json` and `tsup.config.ts`)
- **Same-directory**: Use `./` for files in the same directory
- **NEVER use `../`**: No relative parent imports. If you see `../` in src/, it's a bug.
- **Layer direction**: Imports only flow downward (Layer 3 → 2 → 1 → 0). Never import from a higher layer.
- **Separate packages** (`packages/*`): Import from `'brainbank'` peer dep, NOT `@/`. Use `.js` extensions for local imports.
- **CLI plugin loading**: `src/cli/factory.ts` uses dynamic `import('@brainbank/code')` etc. — this is the ONLY place where `@brainbank/*` packages are imported in core.

```typescript
// ✅ Correct — cross-directory with @/ (inside src/)
import { SQLiteAdapter } from '@/db/sqlite-adapter.ts';
import type { DatabaseAdapter } from '@/db/adapter.ts';
import { reciprocalRankFusion } from '@/lib/rrf.ts';

// ✅ Correct — same directory with ./
import { ContextBuilder } from './context-builder.ts';
import type { PluginRegistry } from './registry.ts';

// ✅ Correct — inside packages/*  (peer dep)
import type { Plugin, PluginContext } from 'brainbank';
import { CodeWalker } from './code-walker.js';

// ✅ Correct — CLI dynamic imports for optional plugins
const mod = await import('@brainbank/code');

// ❌ WRONG — never use ../
import { SQLiteAdapter } from '../db/sqlite-adapter.ts';
import type { SearchResult } from '../../types.ts';

// ❌ WRONG — never import plugin implementations in core
import { code } from '@/indexers/code/code-plugin.ts';
```

### Error Messages
- Format: `BrainBank: <context>. <what to do>.`
- Example: `BrainBank: Not initialized. Call await brain.initialize() before search().`
- Always reference `@brainbank/*` packages in install hints, not internal paths.

### Plugin Pattern
- Factory function exports: `export function code(opts): Plugin`
- All plugins implement the `Plugin` interface from `src/plugins/base.ts`
- Plugins are published as independent `@brainbank/*` npm packages
- Registered via `.use()` builder pattern on BrainBank
- **Generic access**: `brain.plugin<T>('name')` → returns `T | undefined`
- **Typed accessors**: `brain.docs` / `brain.git` → returns `Plugin | undefined`
- **Duck typing**: CLI uses `(brain.docs as any).addCollection()` since core doesn't depend on plugin types
- List: `brain.plugins` — returns all registered plugin names

- `brainbank.ts` is the ONLY file at `src/` root (besides `types.ts` and `index.ts`)
- `bootstrap/` handles system wiring — never imported by layers 0-2
- `api/` defines use cases (search-api, index-api) — never imported by layers 0-2
- `lib/` contains pure, stateless functions with zero side effects
- `search/types.ts` defines `SearchStrategy` — all search backends implement it
- `BrainBank` extends `EventEmitter` for progress/warning events (no callbacks)
- `close()` on BrainBank is **synchronous** (returns `void`, not `Promise`). Don't `await` it.

## Anti-Patterns

Things that are **never allowed** in this codebase:

```typescript
// ❌ Inline imports — all imports must be at the top of the file
function doSomething() {
    const { foo } = require('./foo');     // WRONG
    const { bar } = await import('./bar'); // WRONG (except in CLI for lazy loading)
}

// ❌ Relative parent imports — use @/ aliases
import { X } from '../types.ts';     // WRONG
import { X } from '../../lib/rrf.ts'; // WRONG

// ❌ any in new code
function process(data: any) { ... }  // WRONG — define a proper type

// ❌ console.log in library code
console.log('indexing done');  // WRONG — use this.emit('progress', ...)

// ❌ Importing from a higher layer
// In lib/ (Layer 0):
import { BrainBank } from '@/brainbank.ts'; // WRONG — Layer 0 cannot import Layer 3

// ❌ Plugin code in core — all plugin logic lives in packages/
import { CodeChunker } from '@/indexers/code/code-chunker.ts'; // WRONG — deleted
import { git } from '@/indexers/git/git-plugin.ts';            // WRONG — use @brainbank/git

// ❌ Backward compatibility — NEVER keep deprecated code "for compat"
// If something is replaced, DELETE the old code immediately.
// No aliases, no deprecated wrappers, no "kept for tests".
export { VectorSearch as MultiIndexSearch };  // WRONG — delete it
function legacySearch() { return newSearch(); } // WRONG — delete it

// ❌ Deprecated config fields
builtins?: ('code' | 'git' | 'docs')[];  // WRONG — use "plugins" field
```

**Size limits:**
- **Functions**: Max **40 lines**. If longer, extract helpers.
- **Files**: Max **300 lines**. If longer, split into focused modules.

**Exception**: Dynamic `import()` is allowed in `src/cli/` for lazy-loading optional `@brainbank/*` plugins.

## Git Workflow

- Commits: `feat(scope): description` / `fix(scope): description` (Conventional Commits)
- Before commit: `npm test` must pass
- Keep commits small, focused, one logical change each
- **Publishing**: Use `/publish` workflow — runs tests, updates CHANGELOG.md, bumps version, builds, and publishes to npm
- **Per-package changelogs**: Each package in `packages/` has its own `CHANGELOG.md`. Core changes go in root `CHANGELOG.md`.

> **⚠️ CHANGELOG is MANDATORY**: After **every** change, update `## [Unreleased]` in the appropriate `CHANGELOG.md` (root for core, `packages/*/CHANGELOG.md` for packages). **Do not commit without updating the changelog.** The `/publish` workflow verifies the items against git log, fixes inaccuracies, stamps `## [Unreleased]` → `## [X.Y.Z] — date`, and adds a fresh `## [Unreleased]` section.

## Gotchas

- `PluginContext` has no `repoPath` — use `ctx.config.repoPath`.
- `SearchResult` has no `.line` — use `r.metadata?.startLine`.
- Native deps (better-sqlite3, hnswlib-node) require `node-gyp`. If install fails, check C++ toolchain.
- HNSW indices are in-memory. Large repos use significant RAM during indexing.
- `npm run build` runs workspaces too. Use `npm run build:core` to build only the core package.
- The custom test runner (`test/run.ts`) discovers tests in `test/unit/` and `test/integration/`. Tests export `{ name, tests }` — not Jest/Vitest syntax.
- **tree-sitter lives in `@brainbank/code`** — the core package has NO tree-sitter dependency.
- **simple-git lives in `@brainbank/git`** — the core package has NO simple-git dependency.
- **Global CLI + separate packages**: When `brainbank` is installed globally, `@brainbank/code` etc. must also be installed globally in the same prefix for `import('@brainbank/code')` to resolve.
- **packages/ use `.js` extensions** for local imports (bundled by tsup), not `.ts` like `src/`.
- **CLI dynamic imports**: `src/cli/factory.ts` loads plugins with `await import('@brainbank/code')`. If a plugin is not installed, the CLI prints a warning and skips it.
- **`database.ts` is deleted** — all database access flows through `DatabaseAdapter` (interface) / `SQLiteAdapter` (implementation). Never import a concrete driver directly.

## Permissions

### Without asking:
- Read files, list directories
- `npx tsc --noEmit`
- `npm test -- --filter <name>`
- Create new files in existing directories
- Format code

### NEVER without approval:
- `git commit` / `git push` — **always** ask the user before committing or pushing
- `npm publish`
- Modify SQLite schema without review
- Delete or rename public exports from `src/index.ts` (breaking change)
- If unsure about architecture: propose a plan and wait for a response

## REMEMBER

- Please always update the README.md, ARCHITECTURE.md and the CHANGELOG.md when needed