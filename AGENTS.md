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

### Scope reducido (preferir siempre)
- Type-check: `npx tsc --noEmit`
- Test por nombre: `npm test -- --filter <nombre>`
- Test verbose: `npm test -- --verbose --filter <nombre>`

### Suite completa (solo si se pide)
- Unit tests: `npm test` (145 tests, ~7s)
- Integration: `npm run test:integration` (descarga modelo de embeddings, ~30s)
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

### Sin preguntar:
- Leer archivos, listar directorios
- `npx tsc --noEmit`
- `npm test -- --filter <nombre>`
- Crear archivos nuevos en directorios existentes
- Formatear código

### Preguntar primero:
- `npm install` / agregar dependencias
- `git commit` / `git push`
- Borrar archivos o directorios
- Modificar `tsconfig.json`, `tsup.config.ts`, `package.json`
- `npm run build` o suite de tests completa
- Modificar `src/db/database.ts` (schema changes)

### NUNCA sin aprobación:
- `npm publish`
- Modificar el schema SQLite sin revisión
- Borrar o renombrar exports públicos de `src/index.ts` (breaking change)
- Modificar `packages/mcp/` sin entender el protocolo MCP
- Si no estás seguro de la arquitectura: proponé un plan y esperá respuesta

## Notes

- Si encontrás que este AGENTS.md es incorrecto o está incompleto, proponé una actualización.
- Después de terminar un trabajo confirmado por el usuario, escribí una nota en `~/.berna/notes/{date}/{note}.md`.
