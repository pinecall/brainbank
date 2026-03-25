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

- `src/brainbank.ts` — The main orchestrator. All public API lives here.
- `src/indexers/base.ts` — The `Indexer` interface. Read this before writing any plugin.
- `src/core/collection.ts` — Universal KV store with hybrid search. Core primitive.
- `src/search/types.ts` — `SearchStrategy` interface. All search backends implement it.

## Code Style

- TypeScript strict — no `any` in new code, no `@ts-ignore`
- ESM only (`"type": "module"` in package.json)
- Imports use `.ts` extensions (`import { X } from './foo.ts'`)
- JSDoc on every exported function and class — concise, no `@param` spam
- Naming: `camelCase` functions/variables, `PascalCase` classes/interfaces, `kebab-case` files
- Error messages: `BrainBank: <context>. <what to do>.` (e.g. `BrainBank: Not initialized. Call await brain.initialize() before search().`)
- Never `console.log` in library code — use `this.emit('event', data)` on BrainBank
- Plugin pattern: factory function exports (e.g. `export function code(opts): Indexer`)

## Git Workflow

- Commits: `feat(scope): description` / `fix(scope): description` (Conventional Commits)
- Before commit: `npm test` must pass
- Keep commits small, focused, one logical change each

## Gotchas

- `close()` on BrainBank is **synchronous** (returns `void`, not `Promise`). Don't `await` it.
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
