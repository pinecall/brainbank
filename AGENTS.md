# AGENTS.md

## Project Overview

BrainBank is a pluggable semantic memory library for AI agents — hybrid search (vector + BM25) in a single SQLite file. Ships as an npm package (`brainbank`) with built-in code, git, and docs indexers, plus a CLI and MCP server.

Architecture: 4-layer modular plugin system with `.use()` builder pattern.
Stack: TypeScript (strict, ESM) · Node ≥18 · better-sqlite3 · hnswlib-node · tree-sitter.

## Dev Environment

- Install: `npm install` (native deps: better-sqlite3, hnswlib-node, tree-sitter — requires C++ toolchain)
- Dev CLI: `npm run dev` (runs `tsx src/cli/index.ts`)
- Build: `npm run build:core` (tsup — generates `dist/`)
- No `.env` file needed for development. Optional: `OPENAI_API_KEY` for OpenAI embeddings.

## Commands

### Preferred (minimal scope)
- Type-check: `npx tsc --noEmit`
- Test by name: `npm test -- --filter <name>`
- Test verbose: `npm test -- --verbose --filter <name>`

### Full suite (only when requested)
- Unit tests: `npm test` (146 tests, ~7s)
- Integration: `npm run test:integration` (downloads embedding model, ~30s)
- Build: `npm run build:core`

## Project Structure

4-layer architecture. Imports only flow **downward** — never up.

```
Layer 0 — Foundation (no deps, imported by everyone)
├── types.ts         ← All shared types and interfaces
├── lib/             ← Pure functions: math, rrf, fts
├── config/          ← Defaults, resolver
└── db/              ← SQLite schema, database wrapper

Layer 1 — Infrastructure (depends on Layer 0 only)
├── providers/       ← Embeddings (local WASM, OpenAI), vector (HNSW)
└── search/          ← SearchStrategy implementations: vector/, keyword/

Layer 2 — Domain (depends on Layers 0-1)
├── indexers/        ← Plugins: code/, git/, docs/, memory/, notes/
│   └── base.ts      ← Indexer interface (the plugin contract)
└── services/        ← Reembed, watch

Layer 3 — Orchestration (depends on everything below)
├── brainbank.ts     ← THE main orchestrator, sole root-level file
├── core/            ← Internal orchestration: collection, search-api,
│                      context-builder, initializer, index-api, registry
└── cli/             ← CLI commands and factory
```

```
packages/
├── mcp/             ← MCP server (separate package)
├── memory/          ← Conversational memory (separate package)
└── reranker/        ← Qwen3 reranker (separate package)
```

### Key Files
- `src/brainbank.ts` — The main orchestrator. All public API lives here.
- `src/indexers/base.ts` — The `Indexer` interface. Read this before writing any plugin.
- `src/core/collection.ts` — Universal KV store with hybrid search. Core primitive.
- `src/search/types.ts` — `SearchStrategy` interface. All search backends implement it.
- `src/packages.d.ts` — Type declarations for `@brainbank/*` packages (reranker, memory, mcp).

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
- **Path aliases**: All cross-directory imports use `@/` (configured in `tsconfig.json` and `tsup.config.ts`)
- **Same-directory**: Use `./` for files in the same directory
- **NEVER use `../`**: No relative parent imports. If you see `../` in src/, it's a bug.
- **Layer direction**: Imports only flow downward (Layer 3 → 2 → 1 → 0). Never import from a higher layer.

```typescript
// ✅ Correct — cross-directory with @/
import { Database } from '@/db/database.ts';
import type { SearchResult } from '@/types.ts';
import { reciprocalRankFusion } from '@/lib/rrf.ts';

// ✅ Correct — same directory with ./
import { ContextBuilder } from './context-builder.ts';
import type { IndexerRegistry } from './registry.ts';

// ❌ WRONG — never use ../
import { Database } from '../db/database.ts';
import type { SearchResult } from '../../types.ts';
```

### Error Messages
- Format: `BrainBank: <context>. <what to do>.`
- Example: `BrainBank: Not initialized. Call await brain.initialize() before search().`

### Plugin Pattern
- Factory function exports: `export function code(opts): Indexer`
- All plugins implement the `Indexer` interface from `src/indexers/base.ts`
- Registered via `.use()` builder pattern on BrainBank

### Architecture Rules
- `brainbank.ts` is the ONLY file at `src/` root (besides `types.ts`, `index.ts`, `packages.d.ts`)
- `core/` is internal orchestration — never imported by layers 0-2
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
```

**Exception**: Dynamic `import()` is allowed in `src/cli/` for lazy-loading heavy dependencies (e.g. tree-sitter) that shouldn't slow down CLI startup.

## Git Workflow

- Commits: `feat(scope): description` / `fix(scope): description` (Conventional Commits)
- Before commit: `npm test` must pass
- Keep commits small, focused, one logical change each
- **Publishing**: Use `/publish` workflow — runs tests, updates CHANGELOG.md, bumps version, builds, and publishes to npm
- **CHANGELOG**: After each change, update `## [Unreleased]` in `CHANGELOG.md` with what you did. This way any agent can see what's new even before publishing. The `/publish` workflow verifies the items against git log, fixes inaccuracies, stamps `## [Unreleased]` → `## [X.Y.Z] — date`, and adds a fresh `## [Unreleased]` section.

## Gotchas

- `IndexerContext` has no `repoPath` — use `ctx.config.repoPath`.
- `SearchResult` has no `.line` — use `r.metadata?.startLine`.
- Native deps (better-sqlite3, hnswlib-node) require `node-gyp`. If install fails, check C++ toolchain.
- HNSW indices are in-memory. Large repos use significant RAM during indexing.
- `npm run build` runs workspaces too. Use `npm run build:core` to build only the core package.
- The custom test runner (`test/run.ts`) discovers tests in `test/unit/` and `test/integration/`. Tests export `{ name, tests }` — not Jest/Vitest syntax.

## Permissions

### Without asking:
- Read files, list directories
- `npx tsc --noEmit`
- `npm test -- --filter <name>`
- Create new files in existing directories
- Format code

### Ask first:
- `npm install` / add dependencies
- `git commit` / `git push`
- Delete files or directories
- Modify `tsconfig.json`, `tsup.config.ts`, `package.json`
- `npm run build` or full test suite
- Modify `src/db/database.ts` (schema changes)

### NEVER without approval:
- `npm publish`
- Modify SQLite schema without review
- Delete or rename public exports from `src/index.ts` (breaking change)
- Modify `packages/mcp/` without understanding the MCP protocol
- If unsure about architecture: propose a plan and wait for a response

## Notes

- If you find this AGENTS.md is incorrect or incomplete, propose an update.
- After finishing work confirmed by the user, write a note at `~/.berna/notes/{date}/{note}.md`.
