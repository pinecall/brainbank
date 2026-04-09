# BrainBank UI — Plan Completo

## 1. Análisis del Schema Existente

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        BRAINBANK DATABASE SCHEMA                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─── CORE ──────────────┐    ┌─── CODE PLUGIN ──────────────────────┐ │
│  │ schema_version         │    │ code_chunks (id, file_path, type,    │ │
│  │ plugin_versions        │    │   name, start/end_line, content,     │ │
│  │ embedding_meta         │    │   language, file_hash)               │ │
│  │ index_state            │    │          │                           │ │
│  │ plugin_tracking        │    │          ├──→ code_vectors (chunk_id,│ │
│  │                        │    │          │      embedding BLOB)      │ │
│  │ kv_data ──→ kv_vectors │    │          ├──→ code_refs (chunk_id,   │ │
│  │      └──→ fts_kv       │    │          │      symbol_name)        │ │
│  └────────────────────────┘    │          └──→ code_symbols (name,    │ │
│                                │                kind, line, chunk_id) │ │
│                                │                                      │ │
│                                │ indexed_files (file_path, file_hash) │ │
│                                │ code_imports (file→imports, kind,    │ │
│                                │   resolved)                          │ │
│                                │ code_call_edges (caller→callee,      │ │
│                                │   symbol_name)                       │ │
│                                │ fts_code (FTS5)                      │ │
│                                └──────────────────────────────────────┘ │
│                                                                         │
│  ┌─── GIT PLUGIN ────────────┐  ┌─── DOCS PLUGIN ───────────────────┐ │
│  │ git_commits (hash, msg,   │  │ collections (name, path, pattern)  │ │
│  │   author, date, diff,     │  │          │                         │ │
│  │   additions, deletions)   │  │ doc_chunks (collection, file_path, │ │
│  │          │                │  │   title, content, seq)             │ │
│  │          ├──→ git_vectors │  │          │                         │ │
│  │          ├──→ commit_files│  │          └──→ doc_vectors           │ │
│  │          └──→ fts_commits │  │ path_contexts                      │ │
│  │                           │  │ fts_docs (FTS5)                    │ │
│  │ co_edits (file_a↔file_b, │  └─────────────────────────────────────┘ │
│  │   count)                  │                                          │
│  └───────────────────────────┘                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. Arquitectura: UI ↔ Daemon ↔ BrainBank

```
┌──────────────────────┐         ┌──────────────────────────────┐
│   brainbank-ui       │         │   brainbank daemon           │
│   (React + Vite)     │  HTTP   │   (Node.js HTTP server)      │
│                      │◄───────►│                              │
│  localhost:5173      │  JSON   │  localhost:8181               │
│                      │   API   │                              │
│  ┌────────────────┐  │         │  ┌────────────────────────┐  │
│  │ Dashboard      │  │         │  │ /api/explore/*         │  │
│  │ Code Explorer  │  │         │  │ /api/search/*          │  │
│  │ Graph Viewer   │  │         │  │ /api/graph/*           │  │
│  │ Search Console │  │         │  │ /api/git/*             │  │
│  │ Git Timeline   │  │         │  │ /api/docs/*            │  │
│  │ Docs Browser   │  │         │  │ /api/collections/*     │  │
│  │ SQL Console    │  │         │  │ /api/vectors/*         │  │
│  │ Vector Space   │  │         │  │ /api/sql (read-only)   │  │
│  │ Context Lab    │  │         │  │ /api/ai/query          │  │
│  └────────────────┘  │         │  │ /context (existing)    │  │
│                      │         │  │ /index   (existing)    │  │
│                      │         │  │ /health  (existing)    │  │
└──────────────────────┘         │  └────────────────────────┘  │
                                 │              │               │
                                 │  ┌───────────▼────────────┐  │
                                 │  │  BrainBank Core        │  │
                                 │  │  + WorkspacePool       │  │
                                 │  │  + SQLite (WAL mode)   │  │
                                 │  │  + HNSW indices        │  │
                                 │  │  + Embedding provider  │  │
                                 │  └────────────────────────┘  │
                                 └──────────────────────────────┘
```

## 3. Nuevas API Routes del Daemon

```
┌─────────────────────────────────────────────────────────────────┐
│                    HTTP API EXPANSION                            │
├──────────────────────────────┬──────────────────────────────────┤
│  EXPLORE (browse indexed     │  SEARCH (all modalities)         │
│  data like a database)       │                                  │
│                              │  POST /api/search/vector         │
│  GET /api/explore/files      │    → { query, k, minScore }      │
│    → paginated file list     │    ← SearchResult[]              │
│    ?lang=typescript           │                                  │
│    ?path=src/services/        │  POST /api/search/bm25           │
│    ?sort=chunks_desc         │    → { query, k, sources }       │
│                              │    ← SearchResult[]              │
│  GET /api/explore/files/:fp  │                                  │
│    → file detail + chunks    │  POST /api/search/hybrid          │
│    + symbols + imports       │    → { query, k, sources }       │
│                              │    ← SearchResult[] (RRF fused)  │
│  GET /api/explore/chunks/:id │                                  │
│    → chunk detail + vector   │  POST /api/search/similar         │
│    + calls + callers         │    → { chunkId } or { text }     │
│                              │    ← nearest neighbors           │
│  GET /api/explore/symbols    │                                  │
│    ?name=AuthService         │  POST /api/search/natural         │
│    ?kind=class               │    → { question }                │
│    ?file=src/auth/*          │    ← LLM-powered answer          │
│                              │       with source citations      │
├──────────────────────────────┼──────────────────────────────────┤
│  GRAPH (relationships)       │  GIT (history & patterns)         │
│                              │                                  │
│  POST /api/graph/imports     │  GET /api/git/commits             │
│    → { files: [...] }        │    ?page=1&limit=50              │
│    ← { nodes, edges }       │    ?author=*&search=*            │
│    (d3-compatible format)    │                                  │
│                              │  GET /api/git/commits/:hash       │
│  POST /api/graph/calltree    │    → commit detail + files       │
│    → { seedChunkIds }        │    + diff                        │
│    ← CallTreeNode[]          │                                  │
│                              │  GET /api/git/file-history/:fp    │
│  POST /api/graph/coedits     │    ← commits that touched file   │
│    → { file }                │                                  │
│    ← [{ file, count }]      │  GET /api/git/co-edits/:fp        │
│                              │    ← files that change together  │
│  GET /api/graph/hotspots     │                                  │
│    ← files by connectivity   │  GET /api/git/heatmap             │
│    (in-degree + out-degree)  │    ← file change frequency       │
│                              │       over time                  │
├──────────────────────────────┼──────────────────────────────────┤
│  VECTORS (embedding space)   │  SQL CONSOLE                     │
│                              │                                  │
│  GET /api/vectors/meta       │  POST /api/sql                    │
│    ← { provider, dims, cnt } │    → { query: "SELECT..." }      │
│                              │    ← { columns, rows, time }     │
│  POST /api/vectors/project   │    (read-only, 5s timeout,       │
│    → { table, method, k }    │     EXPLAIN whitelisted)         │
│    method: tsne | umap | pca │                                  │
│    ← [{ id, x, y, label }]  │  GET /api/sql/schema              │
│    (2D projection for viz)   │    ← all tables + columns        │
│                              │       + row counts               │
│  POST /api/vectors/compare   │                                  │
│    → { ids: [1, 2] }        │  GET /api/sql/explain              │
│    ← cosine similarity      │    → { query }                    │
│                              │    ← query plan                  │
├──────────────────────────────┼──────────────────────────────────┤
│  COLLECTIONS (KV store)      │  CONTEXT LAB                     │
│                              │                                  │
│  GET /api/collections        │  POST /api/context/preview        │
│    ← names + counts          │    → { task, sources, path,      │
│                              │         pruner?, reranker? }     │
│  GET /api/collections/:name  │    ← { context, debug: {         │
│    ?page=1&limit=20          │         vectorHits, bm25Hits,    │
│    ← items                   │         rrfScores, callTree,     │
│                              │         pruneDropped } }         │
│  POST /api/collections/:name │    (same as /context but with    │
│    /search                   │     full debug trace)            │
│    → { query, k, mode }     │                                  │
│    ← items with scores      │  POST /api/context/diff            │
│                              │    → { task, configA, configB }  │
│                              │    ← side-by-side context output │
└──────────────────────────────┴──────────────────────────────────┘
```

## 4. UI Layout — Main Window

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  🧠 BrainBank Studio          ┌─ servicehub-backend ▾ ┐   ● Connected :8181   │
├─────────┬───────────────────────────────────────────────────────────────────────┤
│         │                                                                       │
│  📊     │  ┌─ Dashboard ───────────────────────────────────────────────────┐    │
│ Dashboard│  │                                                              │    │
│         │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │    │
│  📁     │  │  │  1,243   │  │   487    │  │   12     │  │  2,560   │    │    │
│ Code    │  │  │  Files   │  │ Commits  │  │  Docs    │  │  Dims    │    │    │
│ Explorer│  │  │  8,421   │  │          │  │  85      │  │ pplx-ctx │    │    │
│         │  │  │  chunks  │  │          │  │  chunks  │  │          │    │    │
│  🔍     │  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │    │
│ Search  │  │                                                              │    │
│ Console │  │  ┌─ Language Breakdown ──────┐  ┌─ Storage ───────────────┐ │    │
│         │  │  │ ████████████░░ TS   892   │  │ DB:     124.5 MB       │ │    │
│  🌐     │  │  │ ██████░░░░░░░ PY   312   │  │ HNSW:    48.2 MB       │ │    │
│ Import  │  │  │ ███░░░░░░░░░░ GO    39   │  │ Vectors: 8,421 code    │ │    │
│ Graph   │  │  │                           │  │          487 git       │ │    │
│         │  │  └───────────────────────────┘  │          85 docs       │ │    │
│  📞     │  │                                  └─────────────────────── │ │    │
│ Call    │  │  ┌─ Recent Activity ─────────────────────────────────────┐ │    │
│ Graph   │  │  │ 2m ago   ✓ code indexed  12 files, 89 chunks        │ │    │
│         │  │  │ 15m ago  ✓ git  indexed  3 new commits              │ │    │
│  📜     │  │  │ 1h ago   ✓ docs indexed  wiki: 2 files changed     │ │    │
│ Git     │  │  └──────────────────────────────────────────────────────┘ │    │
│ Timeline│  │                                                              │    │
│         │  │  ┌─ Hotspots (most connected files) ────────────────────┐  │    │
│  📄     │  │  │ src/auth/auth.module.ts          in:12  out:8  █████ │  │    │
│ Docs    │  │  │ src/users/users.service.ts       in:9   out:6  ████  │  │    │
│         │  │  │ src/common/base.entity.ts         in:23  out:2  ███   │  │    │
│  🗃️     │  │  └──────────────────────────────────────────────────────┘  │    │
│ KV      │  └───────────────────────────────────────────────────────────┘    │
│ Collect.│                                                                       │
│         │                                                                       │
│  🔮     │                                                                       │
│ Vector  │                                                                       │
│ Space   │                                                                       │
│         │                                                                       │
│  🧪     │                                                                       │
│ Context │                                                                       │
│ Lab     │                                                                       │
│         │                                                                       │
│  💻     │                                                                       │
│ SQL     │                                                                       │
│ Console │                                                                       │
│         │                                                                       │
├─────────┤                                                                       │
│ ⚙ Conf  │                                                                       │
└─────────┴───────────────────────────────────────────────────────────────────────┘
```

## 5. Code Explorer View

```
┌─────────┬───────────────────────────────────────────────────────────────────────┐
│         │  📁 Code Explorer                                    🔍 Filter...     │
│  ...    ├───────────────────────┬───────────────────────────────────────────────┤
│         │  File Tree            │  src/auth/auth.service.ts                      │
│         │                       │  TypeScript · 8 chunks · 234 lines             │
│         │  ▾ 📂 src/            │  Last indexed: 2m ago (hash: a3f8c2)           │
│         │    ▾ 📂 auth/         ├───────────────────────────────────────────────┤
│         │      📄 auth.module   │  ┌─ Chunks ──────────────────────────────┐    │
│         │      📄 auth.service ◄│  │                                       │    │
│         │      📄 auth.guard    │  │  #1  class AuthService         L5-89  │    │
│         │      📄 jwt.strategy  │  │  #2  method .validateUser     L12-28  │    │
│         │    ▾ 📂 users/        │  │  #3  method .login            L30-42  │    │
│         │      📄 users.service │  │  #4  method .register         L44-58  │    │
│         │      📄 users.control │  │  #5  method .changePassword   L60-78  │    │
│         │      📄 users.entity  │  │  #6  interface AuthPayload    L82-86  │    │
│         │    ▾ 📂 common/       │  │  #7  synopsis (file-level)    L1-89   │    │
│         │      📄 base.entity   │  │                                       │    │
│         │      📄 config.service│  └───────────────────────────────────────┘    │
│         │    📂 database/       │                                                │
│         │                       │  ┌─ Chunk Detail: #2 method .validateUser ──┐ │
│         │  ─────────────────    │  │                                          │ │
│         │  Files: 1,243         │  │  ```typescript                           │ │
│         │  Languages: 5         │  │  async validateUser(email: string,       │ │
│         │  Total chunks: 8,421  │  │    password: string): Promise<any> {     │ │
│         │                       │  │    const user = await this.userRepo      │ │
│         │  ┌─ Filters ────────┐ │  │      .findOne({ where: { email } });    │ │
│         │  │ Lang: All      ▾ │ │  │    if (!user) return null;              │ │
│         │  │ Type: All      ▾ │ │  │    const isValid = await bcrypt         │ │
│         │  │ Path: src/     ▾ │ │  │      .compare(password, user.password); │ │
│         │  │ Min chunks: 0  ▾ │ │  │    return isValid ? user : null;        │ │
│         │  └──────────────────┘ │  │  }                                      │ │
│         │                       │  │  ```                                     │ │
│         │                       │  │                                          │ │
│         │                       │  │  ┌─ Symbols ───────┐ ┌─ Calls ────────┐ │ │
│         │                       │  │  │ validateUser     │ │ findOne()      │ │ │
│         │                       │  │  │  method L12      │ │ compare()      │ │ │
│         │                       │  │  └─────────────────┘ └────────────────┘ │ │
│         │                       │  │                                          │ │
│         │                       │  │  ┌─ Called By ─────────────────────────┐ │ │
│         │                       │  │  │ auth.controller.ts → login()       │ │ │
│         │                       │  │  │ auth.guard.ts → canActivate()      │ │ │
│         │                       │  │  └────────────────────────────────────┘ │ │
│         │                       │  │                                          │ │
│         │                       │  │  ┌─ Imports ──────────────────────────┐ │ │
│         │                       │  │  │ → @nestjs/common                   │ │ │
│         │                       │  │  │ → @nestjs/jwt                      │ │ │
│         │                       │  │  │ → bcrypt                           │ │ │
│         │                       │  │  │ → ./users.service.ts  [resolved ✓] │ │ │
│         │                       │  │  └────────────────────────────────────┘ │ │
│         │                       │  │                                          │ │
│         │                       │  │  [🔮 View Embedding] [🌐 Show Graph]    │ │
│         │                       │  │  [📞 Call Tree]      [🔍 Find Similar]  │ │
│         │                       │  └──────────────────────────────────────────┘ │
└─────────┴───────────────────────┴───────────────────────────────────────────────┘
```

## 6. Import Graph Visualizer (D3 Force-Directed)

```
┌─────────┬───────────────────────────────────────────────────────────────────────┐
│         │  🌐 Import Graph         Seed: auth.service.ts     Depth: 2  Hops ▾  │
│  ...    ├───────────────────────────────────────────────────────────────────────┤
│         │                                                                       │
│         │                    ┌──────────────┐                                   │
│         │            ┌──────│ auth.guard.ts │──────┐                            │
│         │            │      └──────────────┘      │                            │
│         │            │ imports                     │ imports                    │
│         │            ▼                             ▼                            │
│         │  ┌──────────────────┐          ┌─────────────────┐                   │
│         │  │  jwt.strategy.ts │─────────►│ auth.service.ts │◄─── SEED          │
│         │  └──────────────────┘ imports  └────────┬────────┘                   │
│         │                                         │                            │
│         │                    ┌────────────────────┼────────────────┐            │
│         │                    │ imports            │ imports        │ imports    │
│         │                    ▼                    ▼                ▼            │
│         │           ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│         │           │ users.service│  │  bcrypt       │  │ @nestjs/jwt  │      │
│         │           └──────┬───────┘  │  (external)   │  │  (external)  │      │
│         │                  │          └──────────────┘  └──────────────┘      │
│         │                  │ imports                                           │
│         │                  ▼                                                   │
│         │           ┌──────────────┐                                           │
│         │           │ users.entity │                                           │
│         │           └──────────────┘                                           │
│         │                                                                       │
│         ├───────────────────────────────────────────────────────────────────────┤
│         │  Legend:  ──► static  ···► type  ═══► dynamic   ○ external  ● local  │
│         │                                                                       │
│         │  ┌─ Graph Stats ──────────────────────────────────────────────────┐  │
│         │  │ Nodes: 8  │  Edges: 11  │  Upstream: 3  │  Downstream: 4      │  │
│         │  │ Hub files: users.entity (in:23), base.entity (in:18)           │  │
│         │  └────────────────────────────────────────────────────────────────┘  │
└─────────┴───────────────────────────────────────────────────────────────────────┘
```

## 7. Search Console

```
┌─────────┬───────────────────────────────────────────────────────────────────────┐
│         │  🔍 Search Console                                                    │
│  ...    ├───────────────────────────────────────────────────────────────────────┤
│         │                                                                       │
│         │  ┌─────────────────────────────────────────────────────────────────┐  │
│         │  │ 🔍  authentication middleware token validation                  │  │
│         │  └─────────────────────────────────────────────────────────────────┘  │
│         │                                                                       │
│         │  Mode: ● Hybrid  ○ Vector  ○ BM25  ○ Natural Language (LLM)          │
│         │                                                                       │
│         │  Sources:  [code: 10▾] [git: 5▾] [docs: 3▾] [errors: 0▾]            │
│         │  Min Score: [0.25 ▾]   Reranker: [none ▾]   Path: [________]         │
│         │                                                                       │
│         │  ─── Results (12 found, 8 above threshold) ── 48ms ─────────────     │
│         │                                                                       │
│         │  ┌─ #1 ─────────────── CODE 94% ──── vector+bm25 ─────────────────┐ │
│         │  │  📄 src/auth/auth.service.ts                                     │ │
│         │  │  method `AuthService.validateUser` (L12-28)                      │ │
│         │  │  ┌──────────────────────────────────────────────────────────┐    │ │
│         │  │  │ async validateUser(email: string, password: string) {   │    │ │
│         │  │  │   const user = await this.userRepo.findOne({...});      │    │ │
│         │  │  │   if (!user) return null;                               │    │ │
│         │  │  │   const isValid = await bcrypt.compare(password, ...);  │    │ │
│         │  │  │   return isValid ? user : null;                         │    │ │
│         │  │  │ }                                                       │    │ │
│         │  │  └──────────────────────────────────────────────────────────┘    │ │
│         │  │  Vector: 0.91  BM25: 0.87  RRF: 0.0328                          │ │
│         │  │  [📞 Call Tree] [🔮 Embedding] [🌐 Graph] [📋 Copy]            │ │
│         │  └──────────────────────────────────────────────────────────────────┘ │
│         │                                                                       │
│         │  ┌─ #2 ─────────────── COMMIT 88% ── vector ──────────────────────┐ │
│         │  │  📜 [a3f8c2d] feat: add authentication with JWT tokens          │ │
│         │  │  Author: Jane Doe · 2024-03-15 · +45 -3                         │ │
│         │  │  Files: src/auth/auth.service.ts, src/auth/jwt.strategy.ts       │ │
│         │  │  ```diff                                                         │ │
│         │  │  + export class AuthService {                                    │ │
│         │  │  +   async validateUser(email, password) {...}                   │ │
│         │  │  ```                                                             │ │
│         │  └──────────────────────────────────────────────────────────────────┘ │
│         │                                                                       │
│         │  ┌─ #3 ─────────────── DOC 82% ─── hybrid ────────────────────────┐ │
│         │  │  📄 wiki/auth-guide.md · [project-docs]                         │ │
│         │  │  "Authentication Guide — How to configure JWT..."               │ │
│         │  └──────────────────────────────────────────────────────────────────┘ │
│         │                                                                       │
│         │  ┌─ Debug Panel (expandable) ──────────────────────────────────────┐ │
│         │  │  Query vector dims: 2560                                        │ │
│         │  │  Embed time: 12ms  HNSW search: 3ms  BM25: 2ms  RRF: 1ms      │ │
│         │  │  Vector candidates: 48  BM25 candidates: 23  Fused: 12         │ │
│         │  │  [View raw scores] [Export JSON] [Compare with BM25-only]       │ │
│         │  └──────────────────────────────────────────────────────────────────┘ │
└─────────┴───────────────────────────────────────────────────────────────────────┘
```

## 8. Vector Space Visualizer (2D Projection)

```
┌─────────┬───────────────────────────────────────────────────────────────────────┐
│         │  🔮 Vector Space             Method: t-SNE ▾   Color: language ▾     │
│  ...    ├───────────────────────────────────────────────────────────────────────┤
│         │                                                                       │
│         │     ·  · ·                                          Legend:           │
│         │    · ·● · ·              · ·                        ● typescript      │
│         │   · · ● ● · ·          ·● · ·                      ● python          │
│         │    · ● ● · ·          · ● ● · ·                    ● go              │
│         │     · · ·  ·           · ● · ·                     ○ git commits     │
│         │      · ·                · ·                         ◇ docs chunks    │
│         │                                                                       │
│         │              ○ ○                                                       │
│         │            ○ ○ ○ ○           ◇ ◇                                     │
│         │           ○ ○ ○ ○ ○        ◇ ◇ ◇                                    │
│         │            ○ ○ ○ ○          ◇ ◇                                      │
│         │              ○ ○                                                       │
│         │                                                                       │
│         │    ┌─ Hover: src/auth/auth.service.ts #2 ──────────────────────┐     │
│         │    │ method validateUser · cosine to query: 0.91               │     │
│         │    │ Nearest: jwt.strategy.ts#1 (0.89), auth.guard.ts#3 (0.87)│     │
│         │    └───────────────────────────────────────────────────────────┘     │
│         │                                                                       │
│         │  ┌─ Controls ──────────────────────────────────────────────────────┐ │
│         │  │ Table: [code_vectors ▾]  Sample: [1000 ▾]  Perplexity: [30 ▾]  │ │
│         │  │ ☐ Show query vector    ☑ Show cluster labels    ☐ 3D mode      │ │
│         │  │ Search: [____________] → highlights matching points             │ │
│         │  └──────────────────────────────────────────────────────────────────┘ │
└─────────┴───────────────────────────────────────────────────────────────────────┘
```

## 9. Context Lab (Debug & Compare Context Builds)

```
┌─────────┬───────────────────────────────────────────────────────────────────────┐
│         │  🧪 Context Lab — Debug context pipeline step by step                 │
│  ...    ├───────────────────────────────────────────────────────────────────────┤
│         │                                                                       │
│         │  Task: [implement password reset flow with email verification     ]  │
│         │                                                                       │
│         │  Sources: code:[20] git:[5] docs:[3]   Path: [src/auth/________]     │
│         │  Pruner: [none ▾]   Reranker: [none ▾]   MMR λ: [0.7 ▾]             │
│         │                                                                       │
│         │  [▶ Build Context]  [⚡ Compare A/B]                                  │
│         │                                                                       │
│         │  ┌─ Pipeline Trace ────────────────────────────────────────────────┐ │
│         │  │                                                                  │ │
│         │  │  Step 1: Embed query ─────────────────────── 15ms               │ │
│         │  │  ├─ Provider: perplexity-context (2560d)                        │ │
│         │  │  └─ Vector norm: 1.0000                                         │ │
│         │  │                                                                  │ │
│         │  │  Step 2: Vector search ──────────────────── 4ms                 │ │
│         │  │  ├─ HNSW candidates: 120                                        │ │
│         │  │  ├─ Above minScore (0.25): 34                                   │ │
│         │  │  ├─ Synopsis matches: 8 files                                   │ │
│         │  │  ├─ Chunk matches: 26 chunks across 12 files                    │ │
│         │  │  └─ Cross-level boost: 5 files got 1.4x                        │ │
│         │  │                                                                  │ │
│         │  │  Step 3: BM25 search ───────────────────── 2ms                  │ │
│         │  │  ├─ FTS query: "password" "reset" "flow" "email"                │ │
│         │  │  └─ Matches: 18 chunks across 9 files                           │ │
│         │  │                                                                  │ │
│         │  │  Step 4: RRF fusion ────────────────────── <1ms                 │ │
│         │  │  ├─ Union: 15 unique files                                      │ │
│         │  │  ├─ Density penalty: 2 files (jobs.service.ts 1/15=7%)          │ │
│         │  │  └─ Top 10 by RRF score                                         │ │
│         │  │                                                                  │ │
│         │  │  Step 5: Path filter (src/auth/) ────────── <1ms                │ │
│         │  │  └─ 6 of 10 pass filter                                         │ │
│         │  │                                                                  │ │
│         │  │  Step 6: Call tree expansion ─────────────── 8ms                │ │
│         │  │  ├─ Seeds: 14 chunk IDs                                         │ │
│         │  │  ├─ Callees discovered: 9 chunks in 5 files                     │ │
│         │  │  ├─ Filtered (test files): 2                                    │ │
│         │  │  └─ Filtered (infra files): 1                                   │ │
│         │  │                                                                  │ │
│         │  │  Step 7: Format output ──────────────────── 1ms                 │ │
│         │  │  └─ Total: 3,421 chars (≈850 tokens)                            │ │
│         │  │                                                                  │ │
│         │  └──────────────────────────────────────────────────────────────────┘ │
│         │                                                                       │
│         │  ┌─ Output Preview ────────────────────────────────────────────────┐ │
│         │  │ # Context for: "implement password reset flow..."               │ │
│         │  │ ## Code Context                                                  │ │
│         │  │ ### src/auth/auth.service.ts                                     │ │
│         │  │ **method `changePassword` (L60-78)** — 94% match                │ │
│         │  │ ```typescript                                                    │ │
│         │  │ // src/auth/auth.service.ts L60-78                               │ │
│         │  │ async changePassword(userId, oldPass, newPass) {...}             │ │
│         │  │ ```                                                              │ │
│         │  │ ...                                                              │ │
│         │  └──────────────────────────────────────────────────────────────────┘ │
└─────────┴───────────────────────────────────────────────────────────────────────┘
```

## 10. SQL Console

```
┌─────────┬───────────────────────────────────────────────────────────────────────┐
│         │  💻 SQL Console (read-only)                                           │
│  ...    ├───────────────────────────────────────────────────────────────────────┤
│         │                                                                       │
│         │  ┌─ Schema Browser ──────┐  ┌─ Query Editor ──────────────────────┐  │
│         │  │                        │  │                                      │  │
│         │  │ ▾ 📋 code_chunks (8421)│  │  SELECT                             │  │
│         │  │   id INTEGER PK        │  │    cc.file_path,                    │  │
│         │  │   file_path TEXT       │  │    cc.name,                         │  │
│         │  │   chunk_type TEXT      │  │    COUNT(cr.symbol_name) as calls   │  │
│         │  │   name TEXT            │  │  FROM code_chunks cc                │  │
│         │  │   start_line INTEGER   │  │  JOIN code_refs cr ON cr.chunk_id   │  │
│         │  │   end_line INTEGER     │  │    = cc.id                          │  │
│         │  │   content TEXT         │  │  WHERE cc.chunk_type = 'method'     │  │
│         │  │   language TEXT        │  │  GROUP BY cc.id                     │  │
│         │  │   file_hash TEXT       │  │  ORDER BY calls DESC               │  │
│         │  │                        │  │  LIMIT 20;                          │  │
│         │  │ ▸ 📋 code_vectors (8421│  │                                      │  │
│         │  │ ▸ 📋 code_imports (3200│  │         [▶ Run]  [📋 Format]        │  │
│         │  │ ▸ 📋 code_symbols (2100│  └──────────────────────────────────────┘  │
│         │  │ ▸ 📋 code_refs (15400) │                                           │
│         │  │ ▸ 📋 code_call_edges   │  ┌─ Results ─── 23 rows · 4ms ────────┐  │
│         │  │ ▸ 📋 git_commits (487) │  │                                      │  │
│         │  │ ▸ 📋 commit_files      │  │ file_path              │ name │calls│  │
│         │  │ ▸ 📋 co_edits          │  │────────────────────────┼──────┼─────│  │
│         │  │ ▸ 📋 doc_chunks (85)   │  │ src/auth/auth.service  │login │  12 │  │
│         │  │ ▸ 📋 kv_data           │  │ src/users/users.service│findAl│   9 │  │
│         │  │ ▸ 📋 indexed_files     │  │ src/db/query.builder   │exec  │   8 │  │
│         │  │ ▸ 📋 embedding_meta    │  │ ...                    │      │     │  │
│         │  │                        │  │                                      │  │
│         │  │ ── Saved Queries ──    │  │  [📥 Export CSV] [📋 Copy] [📊 Chart]│  │
│         │  │ ▸ Most called funcs    │  └──────────────────────────────────────┘  │
│         │  │ ▸ Orphan files         │                                           │
│         │  │ ▸ Dead imports         │  ┌─ Presets ────────────────────────────┐ │
│         │  │ ▸ Large chunks         │  │ [Most called] [Dead code] [Orphans]  │ │
│         │  │ ▸ Hub files            │  │ [Hot files]  [Import cycles] [Stats] │ │
│         │  └────────────────────────┘  └──────────────────────────────────────┘  │
└─────────┴───────────────────────────────────────────────────────────────────────┘
```

## 11. Git Timeline + Co-Edit Heatmap

```
┌─────────┬───────────────────────────────────────────────────────────────────────┐
│         │  📜 Git Timeline                        Author: All ▾  Search: [___] │
│  ...    ├───────────────────────────────────────────────────────────────────────┤
│         │                                                                       │
│         │  ┌─ Timeline ──────────────────────────────────────────────────────┐ │
│         │  │                                                                  │ │
│         │  │  ● [a3f8c2d] feat: add JWT authentication          Jane · 2h    │ │
│         │  │  │  Files: auth.service.ts, jwt.strategy.ts (+45 -3)            │ │
│         │  │  │                                                               │ │
│         │  │  ● [b7e1d4a] fix: harden token validation          Jane · 5h    │ │
│         │  │  │  Files: auth.service.ts, api.ts (+12 -3)                     │ │
│         │  │  │                                                               │ │
│         │  │  ● [c9f2a3b] refactor: database class pattern      Bob · 1d     │ │
│         │  │  │  Files: db.ts (+28 -15)                                      │ │
│         │  │  │                                                               │ │
│         │  │  ● [d1e4f5c] test: add API unit tests              Alice · 2d   │ │
│         │  │     Files: api.test.ts (+18 -0)                                 │ │
│         │  │                                                                  │ │
│         │  └──────────────────────────────────────────────────────────────────┘ │
│         │                                                                       │
│         │  ┌─ Co-Edit Heatmap ───────────────────────────────────────────────┐ │
│         │  │              auth.svc  api.ts  jwt.str  db.ts  users.svc       │ │
│         │  │ auth.svc        —       ██      ██       ░       █             │ │
│         │  │ api.ts          ██       —       █       ░       █             │ │
│         │  │ jwt.str         ██       █       —       ░       ░             │ │
│         │  │ db.ts            ░       ░       ░       —       █             │ │
│         │  │ users.svc        █       █       ░       █       —             │ │
│         │  │                                                                  │ │
│         │  │  ██ = 5+ co-edits    █ = 2-4    ░ = 1    — = self              │ │
│         │  └──────────────────────────────────────────────────────────────────┘ │
│         │                                                                       │
│         │  ┌─ File Churn (last 30 days) ─────────────────────────────────────┐ │
│         │  │ auth.service.ts    ████████████████  16 commits                  │ │
│         │  │ api.ts             ██████████        10 commits                  │ │
│         │  │ users.service.ts   ████████           8 commits                  │ │
│         │  │ db.ts              ████               4 commits                  │ │
│         │  └──────────────────────────────────────────────────────────────────┘ │
└─────────┴───────────────────────────────────────────────────────────────────────┘
```

## 12. Plan de Implementación

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         IMPLEMENTATION PLAN                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  PHASE 1: HTTP API Expansion (brainbank core)                     ~2 days       │
│  ─────────────────────────────────────────────                                  │
│  ├─ Extend HttpServer with /api/* router                                        │
│  ├─ /api/explore/* — file browser, chunk detail, symbols                        │
│  ├─ /api/search/* — vector, bm25, hybrid, similar                               │
│  ├─ /api/graph/* — import graph (D3 format), call tree                          │
│  ├─ /api/git/* — commits, file history, co-edits                                │
│  ├─ /api/sql — read-only SQL execution with timeout                             │
│  ├─ /api/vectors/* — meta, project (t-SNE/PCA), compare                         │
│  ├─ /api/stats — full dashboard stats                                           │
│  └─ CORS headers for localhost:5173                                             │
│                                                                                  │
│  PHASE 2: brainbank-ui scaffold                                   ~1 day        │
│  ──────────────────────────────────                                             │
│  ├─ Vite + React + TypeScript + TailwindCSS                                     │
│  ├─ React Router (sidebar navigation)                                           │
│  ├─ API client layer (fetch wrapper, types)                                     │
│  ├─ Global state: selected workspace, connection status                         │
│  └─ Dark theme (code editors need dark bg)                                      │
│                                                                                  │
│  PHASE 3: Core views                                              ~3 days       │
│  ───────────────────                                                            │
│  ├─ Dashboard (stats cards, language chart, activity log)                        │
│  ├─ Code Explorer (file tree + chunk list + detail panel)                        │
│  ├─ Search Console (multi-mode search + debug panel)                            │
│  ├─ SQL Console (CodeMirror editor + results table)                             │
│  └─ Git Timeline (commit list + co-edit heatmap)                                │
│                                                                                  │
│  PHASE 4: Visualization                                           ~2 days       │
│  ──────────────────────                                                         │
│  ├─ Import Graph (D3 force-directed with zoom/pan)                              │
│  ├─ Call Tree (interactive collapsible tree)                                     │
│  ├─ Vector Space (Canvas 2D scatter with t-SNE projection)                      │
│  └─ Co-Edit Heatmap (D3 matrix visualization)                                  │
│                                                                                  │
│  PHASE 5: Advanced features                                       ~2 days       │
│  ──────────────────────────                                                     │
│  ├─ Context Lab (pipeline trace + A/B comparison)                               │
│  ├─ Natural Language query (LLM-powered SQL generation)                         │
│  ├─ Collection Manager (CRUD for KV collections)                                │
│  ├─ Docs Browser (markdown preview + search)                                    │
│  └─ Export/Share (JSON, CSV, shareable links)                                   │
│                                                                                  │
│  TECH STACK:                                                                    │
│  ├─ UI:    React 19 + Vite + TailwindCSS + shadcn/ui                            │
│  ├─ Code:  CodeMirror 6 (SQL editor, code preview, syntax highlight)            │
│  ├─ Graph: D3.js (force-directed, matrix, scatter)                              │
│  ├─ State: Zustand (lightweight)                                                │
│  ├─ Icons: Lucide                                                               │
│  └─ Build: Vite → static files (can be served by daemon itself)                 │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 13. SQL Presets Útiles para Developers

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  DEVELOPER POWER QUERIES (built-in presets)                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  🔥 Most Called Functions (hub detection)                                        │
│  SELECT cs.name, cs.kind, cs.file_path, COUNT(cr.chunk_id) as callers           │
│  FROM code_symbols cs                                                            │
│  JOIN code_refs cr ON cr.symbol_name = cs.name                                   │
│  GROUP BY cs.name ORDER BY callers DESC LIMIT 20                                │
│                                                                                  │
│  💀 Dead Code (symbols never referenced)                                         │
│  SELECT cs.name, cs.kind, cs.file_path FROM code_symbols cs                     │
│  WHERE cs.name NOT IN (SELECT symbol_name FROM code_refs)                       │
│  AND cs.kind IN ('function','method') ORDER BY cs.file_path                     │
│                                                                                  │
│  🔄 Import Cycles                                                                │
│  SELECT a.file_path, a.imports_path FROM code_imports a                          │
│  JOIN code_imports b ON a.file_path = b.imports_path                            │
│  AND a.imports_path = b.file_path WHERE a.resolved = 1                          │
│                                                                                  │
│  📐 Largest Chunks (complexity indicators)                                       │
│  SELECT file_path, name, chunk_type, (end_line - start_line) as lines           │
│  FROM code_chunks WHERE chunk_type != 'synopsis'                                │
│  ORDER BY lines DESC LIMIT 20                                                   │
│                                                                                  │
│  🕸️ Orphan Files (imported by nobody)                                            │
│  SELECT DISTINCT f.file_path FROM indexed_files f                               │
│  LEFT JOIN code_imports ci ON ci.imports_path = f.file_path AND ci.resolved=1   │
│  WHERE ci.file_path IS NULL ORDER BY f.file_path                                │
│                                                                                  │
│  📊 Unresolved Imports (missing dependencies)                                    │
│  SELECT file_path, imports_path, import_kind FROM code_imports                  │
│  WHERE resolved = 0 AND import_kind != 'type'                                   │
│  ORDER BY file_path                                                              │
│                                                                                  │
│  👥 Co-Edit Clusters (files that ALWAYS change together)                         │
│  SELECT file_a, file_b, count FROM co_edits                                     │
│  WHERE count >= 5 ORDER BY count DESC                                           │
│                                                                                  │
│  📈 Most Active Files (git churn)                                                │
│  SELECT cf.file_path, COUNT(*) as commits                                       │
│  FROM commit_files cf GROUP BY cf.file_path ORDER BY commits DESC LIMIT 20      │
│                                                                                  │
│  🧩 Language Distribution per Directory                                          │
│  SELECT substr(file_path, 1, instr(file_path||'/', '/')) as dir,                │
│    language, COUNT(*) as files FROM code_chunks                                  │
│  WHERE chunk_type = 'synopsis' GROUP BY dir, language                            │
│                                                                                  │
│  🔍 Chunks Without Vectors (indexing gaps)                                       │
│  SELECT cc.id, cc.file_path, cc.name FROM code_chunks cc                        │
│  LEFT JOIN code_vectors cv ON cv.chunk_id = cc.id                               │
│  WHERE cv.chunk_id IS NULL AND cc.chunk_type != 'synopsis'                      │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 14. Resumen de lo que hay que hacer en el Daemon

El daemon actual (`src/services/http-server.ts`) tiene 3 rutas. Necesitamos expandirlo a ~25 rutas. La estrategia:

```
src/services/http-server.ts          ← Router principal, CORS
src/services/api/explore.ts          ← /api/explore/* (files, chunks, symbols)
src/services/api/search.ts           ← /api/search/* (vector, bm25, hybrid)
src/services/api/graph.ts            ← /api/graph/* (imports, calltree, coedits)
src/services/api/git.ts              ← /api/git/* (commits, history, heatmap)
src/services/api/vectors.ts          ← /api/vectors/* (meta, project, compare)
src/services/api/sql.ts              ← /api/sql (read-only, timeout, whitelist)
src/services/api/stats.ts            ← /api/stats (dashboard data)
src/services/api/collections.ts      ← /api/collections/* (KV CRUD)
src/services/api/context-debug.ts    ← /api/context/preview (pipeline trace)
```

Cada módulo recibe el `BrainBank` instance del pool y accede directamente al `DatabaseAdapter` + HNSW + plugins para servir los datos. El SQL console usa `db.prepare(query).all()` con un timeout wrapper y whitelist de `SELECT` only.

¿Empezamos por la Phase 1 (HTTP API expansion)?
  💰 $2.4515 this turn
  docs ◇ me encanto, pero espera, es mucho, queiro crearlo en un package distinto, asi que el HTTP daemon lo vamos a tener que organizar de manera que le podamnos inyectar cosas desde uen package neuvo @brainbank/{algo-nuevo-aca}
    ·
    · Me tenes que dar instrucciones para un LLM de coding que no concode nada, armarlo por fases y susb fases, donde estan los archivo relevantes para crear todo esto para caada una de las secciones,  y como coenctarlo con los endpoints ui
    ·

  ┌─ 💭 thinking ──────────────────────────
  │ The user wants me to create a detailed implementation plan for another LLM (coding assistant) that doesn't know the codebase. They want:
  │
  │ 1. A new package structure that can inject API routes into the existing HTTP daemon
  │ 2. Phase-by-phase instructions with sub-phases
  │ 3. References to specific files and line numbers
  │ 4. How to connect everything
  │
  │ Let me think about the architecture:
  │
  │ - The existing HTTP daemon is at `src/services/http-server.ts`
  │ - We need a way for a new package `@brainbank/studio` (or similar) to register routes
  │
  │
  │ - I notice the daemon already has a plugin-like pattern with `WebhookServer` that lets plugins register routes, so I can extend `HttpServer` to accept route registrations from packages and plan this out with exact file references and line numbers.
  └─────────────────────────────────────────

# BrainBank Studio — Instrucciones completas para implementación

## Arquitectura del package

```
brainbank/                          ← monorepo existente
├── src/services/http-server.ts     ← daemon existente (MODIFICAR)
├── packages/
│   ├── code/                       ← existente
│   ├── git/                        ← existente
│   ├── docs/                       ← existente
│   ├── mcp/                        ← existente
│   └── studio/                     ← NUEVO PACKAGE
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsup.config.ts
│       └── src/
│           ├── index.ts            ← public API
│           ├── router.ts           ← route registration
│           ├── api/
│           │   ├── explore.ts      ← /api/explore/*
│           │   ├── search.ts       ← /api/search/*
│           │   ├── graph.ts        ← /api/graph/*
│           │   ├── git.ts          ← /api/git/*
│           │   ├── vectors.ts      ← /api/vectors/*
│           │   ├── sql.ts          ← /api/sql
│           │   ├── stats.ts        ← /api/stats
│           │   ├── collections.ts  ← /api/collections/*
│           │   └── context-debug.ts← /api/context/*
│           └── types.ts            ← shared types
│
└── apps/
    └── studio-ui/                  ← NUEVO: frontend React
        ├── package.json
        ├── vite.config.ts
        ├── index.html
        └── src/
            ├── main.tsx
            ├── App.tsx
            ├── api/                ← fetch client
            ├── views/              ← page components
            └── components/         ← shared UI
```

---

## FASE 0: Hacer el Daemon extensible

**Objetivo**: El `HttpServer` actual tiene routes hardcodeadas. Necesitamos que packages externos puedan registrar routes.

### Archivos relevantes a LEER primero

```
LEER COMPLETO:
- src/services/http-server.ts        (288 líneas) ← el daemon actual
- src/services/webhook-server.ts      (101 líneas) ← patrón de registro de routes
- src/brainbank.ts                    (604 líneas) ← clase principal, líneas 53-68 (estado)
- src/cli/commands/daemon.ts          (101 líneas) ← cómo se inicia el daemon
- src/cli/factory/index.ts            (66 líneas)  ← cómo se crea un BrainBank

LEER PARCIAL:
- src/db/adapter.ts                   (líneas 53-80) ← interfaz DatabaseAdapter
- src/plugin.ts                       (líneas 85-93) ← interfaz Plugin base
- src/types.ts                        (líneas 41-88) ← BrainBankConfig, ResolvedConfig
```

### Sub-fase 0.1: Definir interfaz ApiRouter en core

**Archivo a CREAR**: `src/services/api-router.ts`

```
CONTEXTO: El HttpServer actual (src/services/http-server.ts líneas 188-213)
rutea requests con un switch(req.url). Necesitamos un sistema donde packages
externos registren handlers por path prefix.

CREAR src/services/api-router.ts con:

1. Interface ApiRoute:
   - method: 'GET' | 'POST'
   - path: string (e.g. '/api/explore/files')
   - handler: (body: unknown, params: Record<string,string>,
               brain: BrainBank) => Promise<unknown>

2. Interface ApiRouterPlugin:
   - name: string
   - routes: ApiRoute[]

3. Tipo PathParams: extraído de URL con regex groups

El handler recibe el BrainBank instance ya resuelto del pool
(el router se encarga de extraer `repo` del body y llamar al pool).
```

### Sub-fase 0.2: Modificar HttpServer para aceptar ApiRouterPlugins

**Archivo a MODIFICAR**: `src/services/http-server.ts`

```
CONTEXTO: HttpServer actualmente tiene:
- constructor (líneas 133-141) que recibe HttpServerOptions
- _handleRequest (líneas 188-213) con switch(req.url)
- _handleContext (líneas 230-257)
- _handleIndex (líneas 259-268)

MODIFICAR:

1. En HttpServerOptions (línea 113), agregar:
   apiPlugins?: ApiRouterPlugin[]

2. Almacenar _apiRoutes: Map<string, ApiRoute & { plugin: string }>
   en el constructor, construido desde apiPlugins

3. En _handleRequest (línea 188), ANTES del switch:
   - Parsear path params: /api/explore/files/src%2Fauth.ts → { fp: 'src/auth.ts' }
   - Buscar match en _apiRoutes por method + path prefix
   - Si match: extraer repo del body, pool.get(repo), llamar handler
   - Si no match: caer al switch existente (backward compatible)

4. Agregar CORS headers en TODAS las responses:
   res.setHeader('Access-Control-Allow-Origin', '*')
   res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
   res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

   Manejar OPTIONS preflight: if method === 'OPTIONS' → 204

IMPORTANTE: Las 3 rutas existentes (/health, /context, /index)
NO deben romperse. Son backward-compatible.
```

### Sub-fase 0.3: Exportar desde core

**Archivo a MODIFICAR**: `src/index.ts`

```
AGREGAR al final (después de línea 151):

export type { ApiRoute, ApiRouterPlugin } from './services/api-router.ts';
```

### Sub-fase 0.4: Modificar daemon CLI para cargar studio plugin

**Archivo a MODIFICAR**: `src/cli/commands/daemon.ts`

```
CONTEXTO: startForeground() (líneas 26-59) crea HttpServer.

MODIFICAR startForeground():
1. Intentar import('@brainbank/studio') dinámicamente (try/catch)
2. Si existe, llamar su función registerRoutes() que devuelve ApiRouterPlugin[]
3. Pasarlos a HttpServer como apiPlugins

Patrón: mismo que packages/mcp/src/mcp-server.ts usa import dinámico
para plugins opcionales.
```

---

## FASE 1: Package @brainbank/studio — API Backend

### Sub-fase 1.1: Scaffold del package

**Archivos a CREAR**:

`packages/studio/package.json`:
```
Copiar estructura de packages/docs/package.json como modelo.
name: "@brainbank/studio"
peerDependencies: brainbank >= 0.7.0
NO dependencies adicionales (usa todo de brainbank core)
```

`packages/studio/tsconfig.json`:
```
Copiar de packages/docs/tsconfig.json exacto.
```

`packages/studio/tsup.config.ts`:
```
Copiar de packages/docs/tsup.config.ts.
external: ['brainbank']
```

`packages/studio/src/types.ts`:
```
Types compartidos entre api handlers y el frontend.
Definir interfaces para todas las responses de la API.
```

`packages/studio/src/index.ts`:
```
export { registerStudioRoutes } from './router.ts';
export type { ... } from './types.ts';
```

`packages/studio/src/router.ts`:
```
import type { ApiRouterPlugin } from 'brainbank';
import { exploreRoutes } from './api/explore.ts';
import { searchRoutes } from './api/search.ts';
// ... etc

export function registerStudioRoutes(): ApiRouterPlugin {
    return {
        name: 'studio',
        routes: [
            ...exploreRoutes,
            ...searchRoutes,
            ...graphRoutes,
            ...gitRoutes,
            ...vectorRoutes,
            ...sqlRoutes,
            ...statsRoutes,
            ...collectionsRoutes,
            ...contextDebugRoutes,
        ],
    };
}
```

### Sub-fase 1.2: API — Stats (más simple, empezar acá)

**Archivo a CREAR**: `packages/studio/src/api/stats.ts`

```
CONTEXTO: Este endpoint agrega toda la metadata del workspace.

LEER PARA IMPLEMENTAR:
- src/brainbank.ts líneas 287-299 → brain.stats() existente
- src/db/metadata.ts líneas 80-100 → getEmbeddingMeta()
- src/db/sqlite-adapter.ts líneas 18-100 → schema tables

CREAR 1 route:

GET /api/stats
  → Llama brain.stats() + agrega:
    - embedding meta (provider, dims, providerKey)
    - row counts per table (query sqlite_master + COUNT(*))
    - db file size (fs.statSync)
    - hnsw memory hint (brain.memoryHint())
    - plugin names (brain.plugins)
    - collection names (brain.listCollectionNames())

  Response: {
    plugins: string[],
    embedding: { provider, dims, key },
    tables: { name: string, rows: number }[],
    storage: { dbSizeMB: number, hnswMemoryMB: number },
    pluginStats: Record<string, Record<string, number|string>>,
    collections: { name: string, count: number }[],
  }
```

### Sub-fase 1.3: API — Explore (file browser)

**Archivo a CREAR**: `packages/studio/src/api/explore.ts`

```
CONTEXTO: Permite navegar los archivos y chunks indexados como un file browser.

LEER PARA IMPLEMENTAR:
- packages/code/src/code-schema.ts     ← tablas code_chunks, code_vectors, etc.
- packages/code/src/code-vector-search.ts líneas 19-31 ← CodeChunkRow type
- packages/code/src/sql-code-graph.ts  líneas 58-123 ← SqlCodeGraphProvider
- packages/code/src/import-graph.ts    líneas 29-50 ← DependencyNode/Edge types

QUERIES SQL que necesitas:

  -- Listar archivos paginados
  SELECT DISTINCT file_path, language,
    COUNT(*) as chunk_count,
    MIN(start_line) as first_line,
    MAX(end_line) as last_line
  FROM code_chunks
  WHERE chunk_type != 'synopsis'
  GROUP BY file_path
  ORDER BY file_path
  LIMIT ? OFFSET ?

  -- Filtrar por lenguaje
  ...WHERE language = ?...

  -- Filtrar por path prefix
  ...WHERE file_path LIKE ? || '%' ESCAPE '\'...

  -- Detalle de un archivo: todos sus chunks
  SELECT * FROM code_chunks
  WHERE file_path = ? AND chunk_type != 'synopsis'
  ORDER BY start_line

  -- Symbols de un archivo
  SELECT * FROM code_symbols WHERE file_path = ?

  -- Imports de un archivo
  SELECT * FROM code_imports WHERE file_path = ?

  -- Detalle de un chunk por ID
  SELECT * FROM code_chunks WHERE id = ?

  -- Calls from chunk (qué funciones llama)
  SELECT symbol_name FROM code_refs WHERE chunk_id = ?

  -- Called by chunk (quién llama a los symbols de este chunk)
  SELECT DISTINCT cc.file_path, cc.name, cr.symbol_name
  FROM code_refs cr
  JOIN code_chunks cc ON cc.id = cr.chunk_id
  WHERE cr.symbol_name IN (
    SELECT name FROM code_symbols WHERE chunk_id = ?
  )

CREAR routes:

GET /api/explore/files
  ?page=1 &limit=50 &lang=typescript &path=src/ &sort=chunks_desc
  ← { files: [...], total: number, page: number }

GET /api/explore/files/:filePath
  (filePath es URL-encoded)
  ← { file: { path, language, chunks: [...], symbols: [...], imports: [...] } }

GET /api/explore/chunks/:id
  ← { chunk: { ...all fields }, calls: string[], calledBy: [...],
      hasVector: boolean }

GET /api/explore/symbols
  ?name=Auth* &kind=class &file=src/*
  ← { symbols: [...], total: number }
```

### Sub-fase 1.4: API — Search

**Archivo a CREAR**: `packages/studio/src/api/search.ts`

```
CONTEXTO: Expone las 3 modalidades de search + "find similar".

LEER PARA IMPLEMENTAR:
- src/brainbank.ts líneas 250-271 → search(), hybridSearch(), searchBM25()
- src/engine/search-api.ts         ← SearchAPI completo
- src/search/types.ts              ← SearchOptions
- src/types.ts líneas 200-294      ← SearchResult union type

CREAR routes:

POST /api/search/vector
  body: { query: string, k?: number, minScore?: number,
          sources?: Record<string,number> }
  → brain.search(query, { sources, minScore })
  ← { results: SearchResult[], timing: { embedMs, searchMs, totalMs } }

POST /api/search/bm25
  body: { query, k?, sources? }
  → brain.searchBM25(query, { sources })
  ← { results, timing }

POST /api/search/hybrid
  body: { query, k?, sources?, minScore? }
  → brain.hybridSearch(query, { sources, minScore })
  ← { results, timing }

POST /api/search/similar
  body: { chunkId: number } OR { text: string }
  → Si chunkId: leer vector de code_vectors, hacer hnsw.search()
  → Si text: embed(text), hacer hnsw.search()
  ← { results: { id, filePath, name, score }[] }

NOTA sobre timing: envolver cada call en performance.now()
para reportar latencia al UI.
```

### Sub-fase 1.5: API — Graph

**Archivo a CREAR**: `packages/studio/src/api/graph.ts`

```
CONTEXTO: Devuelve grafos en formato D3-compatible (nodes + edges arrays).

LEER PARA IMPLEMENTAR:
- packages/code/src/import-graph.ts    ← buildDependencyGraph(), buildCallTree()
- packages/code/src/sql-code-graph.ts  ← SqlCodeGraphProvider
- packages/code/src/co-edit-analyzer.ts ← CoEditAnalyzer (en git package)

IMPORTANTE: El handler necesita acceso al DB del plugin code.
Pattern: brain.plugin('code') → acceder al db interno.
Pero el plugin no expone db directamente.

SOLUCIÓN: Los queries SQL corren contra brain._db (el DatabaseAdapter
del core). Las tablas code_chunks, code_imports, etc. viven ahí.
El handler recibe `brain` y hace brain._db... PERO _db es private.

ALTERNATIVA MEJOR: Agregar un método público a BrainBank:
  get db(): DatabaseAdapter { return this._db; }
  (solo para read — el UI nunca escribe)

O mejor: el sql.ts handler ya necesita esto. Hacerlo una vez.

AGREGAR a src/brainbank.ts (línea ~286, nuevo método público):
  /** Read-only database access for admin/debug tools. */
  get database(): DatabaseAdapter {
      this._requireInit('database');
      return this._db;
  }

CREAR routes:

POST /api/graph/imports
  body: { files: string[], maxNodes?: number }
  → Instanciar SqlCodeGraphProvider(brain.database)
  → .buildDependencyGraph(new Set(files))
  ← { nodes: DependencyNode[], edges: DependencyEdge[] }

  Formato D3: nodes necesitan { id, group, ... }
              edges necesitan { source, target, ... }

POST /api/graph/calltree
  body: { seedChunkIds: number[] }
  → SqlCodeGraphProvider(brain.database).buildCallTree(seedChunkIds)
  ← CallTreeNode[] (ya es recursivo/tree)

POST /api/graph/coedits
  body: { file: string, limit?: number }
  → SQL: SELECT * FROM co_edits WHERE file_a = ? OR file_b = ? ...
  ← { suggestions: { file, count }[] }

GET /api/graph/hotspots
  → SQL:
    SELECT file_path,
      (SELECT COUNT(*) FROM code_imports WHERE imports_path = f.file_path
       AND resolved=1) as in_degree,
      (SELECT COUNT(*) FROM code_imports WHERE file_path = f.file_path
       AND resolved=1) as out_degree
    FROM indexed_files f
    ORDER BY (in_degree + out_degree) DESC LIMIT 50
  ← { hotspots: { filePath, inDegree, outDegree }[] }
```

### Sub-fase 1.6: API — Git

**Archivo a CREAR**: `packages/studio/src/api/git.ts`

```
CONTEXTO: Navegar commits, file history, co-edits.

LEER PARA IMPLEMENTAR:
- packages/git/src/git-schema.ts       ← tablas git_commits, commit_files, co_edits
- packages/git/src/git-vector-search.ts líneas 11-24 ← GitCommitRow type
- packages/git/src/git-plugin.ts líneas 163-171 ← fileHistory()
- packages/git/src/co-edit-analyzer.ts  ← suggest()

CREAR routes:

GET /api/git/commits
  ?page=1 &limit=50 &author=Jane &search=auth &since=2024-01-01
  → SQL contra git_commits con filtros dinámicos
  ← { commits: GitCommitRow[], total, page }

GET /api/git/commits/:hash
  → SELECT * FROM git_commits WHERE hash = ? OR short_hash = ?
  → SELECT file_path FROM commit_files WHERE commit_id = ?
  ← { commit: {...}, files: string[] }

GET /api/git/file-history/:filePath
  ?limit=20
  → Misma query que git-plugin.ts fileHistory() (línea 165-171)
  ← { history: { shortHash, message, author, date, additions, deletions }[] }

GET /api/git/co-edits/:filePath
  ?limit=10
  → SQL contra co_edits table
  ← { coEdits: { file, count }[] }

GET /api/git/heatmap
  → SQL:
    SELECT cf.file_path, COUNT(*) as commits,
      MAX(gc.timestamp) as last_change
    FROM commit_files cf
    JOIN git_commits gc ON gc.id = cf.commit_id
    GROUP BY cf.file_path
    ORDER BY commits DESC LIMIT 100
  ← { heatmap: { filePath, commits, lastChange }[] }

GET /api/git/co-edit-matrix
  ?files=src/auth/auth.service.ts,src/auth/jwt.strategy.ts,...
  → Para cada par de files, query co_edits count
  ← { matrix: { fileA, fileB, count }[] }
```

### Sub-fase 1.7: API — SQL Console

**Archivo a CREAR**: `packages/studio/src/api/sql.ts`

```
CONTEXTO: SQL Console read-only. SEGURIDAD es crítica.

LEER PARA IMPLEMENTAR:
- src/db/adapter.ts líneas 53-80    ← DatabaseAdapter interface
- src/db/sqlite-adapter.ts          ← prepare(), exec()

CREAR routes:

POST /api/sql
  body: { query: string, params?: unknown[] }

  VALIDACIÓN (OBLIGATORIA):
  1. Trim + uppercase el query
  2. RECHAZAR si no empieza con SELECT o WITH o EXPLAIN
  3. RECHAZAR si contiene: INSERT, UPDATE, DELETE, DROP, ALTER,
     CREATE, ATTACH, DETACH, PRAGMA (excepto PRAGMA table_info)
  4. TIMEOUT: envolver en Promise.race con 5 segundos
  5. LIMIT: Si no tiene LIMIT, agregar LIMIT 1000

  Ejecución:
  → const stmt = brain.database.prepare(query)
  → const rows = stmt.all(...(params ?? []))
  → Extraer column names del primer row

  ← {
    columns: string[],
    rows: unknown[][],
    rowCount: number,
    truncated: boolean,  // true si se aplicó LIMIT forzado
    timeMs: number
  }

GET /api/sql/schema
  → Query sqlite_master para todas las tablas
  → Para cada tabla: PRAGMA table_info(tabla)
  → Para cada tabla: SELECT COUNT(*)
  ← { tables: { name, columns: { name, type, pk }[], rows: number }[] }

POST /api/sql/explain
  body: { query: string }
  → EXPLAIN QUERY PLAN + query
  ← { plan: string[] }
```

### Sub-fase 1.8: API — Vectors

**Archivo a CREAR**: `packages/studio/src/api/vectors.ts`

```
CONTEXTO: Metadata de embeddings + proyección 2D para visualización.

LEER PARA IMPLEMENTAR:
- src/db/metadata.ts líneas 80-100   ← getEmbeddingMeta()
- src/lib/math.ts                     ← cosineSimilarity, normalize
- src/providers/vector/hnsw-index.ts  ← HNSWIndex

CREAR routes:

GET /api/vectors/meta
  → getEmbeddingMeta(brain.database)
  → COUNT de cada tabla de vectores
  ← { provider, dims, providerKey,
      counts: { code: N, git: N, docs: N, kv: N } }

POST /api/vectors/project
  body: { table: 'code'|'git'|'docs'|'kv',
          sample?: number, method?: 'pca'|'random' }

  NOTA: t-SNE/UMAP requieren librerías pesadas. Para V1, implementar
  solo PCA (se puede hacer con math puro) o random-projection.

  PCA simple (2D):
  1. Leer N vectores de la tabla (sample, default 500)
  2. Centrar (restar media)
  3. Computar 2 componentes principales via power iteration
  4. Proyectar cada vector a 2D
  5. Devolver con metadata (id, label, filePath)

  ← { points: { id, x, y, label, filePath?, language? }[],
      method: string, sampleSize: number }

POST /api/vectors/compare
  body: { ids: [number, number], table: 'code'|'git'|'docs' }
  → Leer ambos vectors de la tabla
  → cosineSimilarity(a, b)
  ← { similarity: number, dimsA: number, dimsB: number }

POST /api/vectors/nearest
  body: { id: number, table: 'code', k?: number }
  → Leer vector del id
  → hnsw.search(vector, k)
  → Enriquecer resultados con metadata
  ← { neighbors: { id, score, filePath, name }[] }
```

### Sub-fase 1.9: API — Collections

**Archivo a CREAR**: `packages/studio/src/api/collections.ts`

```
CONTEXTO: CRUD para KV collections (ya existe en brainbank core).

LEER PARA IMPLEMENTAR:
- src/brainbank.ts líneas 197-214    ← collection(), listCollectionNames()
- src/services/collection.ts          ← Collection class completa
- src/services/kv-service.ts          ← KVService

CREAR routes:

GET /api/collections
  → brain.listCollectionNames()
  → Para cada: brain.collection(name).count()
  ← { collections: { name, count }[] }

GET /api/collections/:name
  ?page=1 &limit=20
  → brain.collection(name).list({ limit, offset })
  ← { items: CollectionItem[], total: number }

POST /api/collections/:name/search
  body: { query, k?, mode? }
  → brain.collection(name).search(query, { k, mode })
  ← { results: CollectionItem[] }

POST /api/collections/:name/add
  body: { content, metadata?, tags?, ttl? }
  → brain.collection(name).add(content, { metadata, tags, ttl })
  ← { id: number }

DELETE /api/collections/:name
  → brain.deleteCollection(name)
  ← { ok: true }
```

### Sub-fase 1.10: API — Context Debug

**Archivo a CREAR**: `packages/studio/src/api/context-debug.ts`

```
CONTEXTO: Ejecuta getContext() pero devuelve TODOS los pasos intermedios.

LEER PARA IMPLEMENTAR:
- src/search/context-builder.ts       ← ContextBuilder.build()
- src/engine/search-api.ts            ← SearchAPI
- src/search/vector/composite-vector-search.ts
- src/lib/rrf.ts                      ← reciprocalRankFusion
- src/lib/prune.ts                    ← pruneResults

NOTA: Para debug mode, necesitamos una versión de getContext()
que devuelva pasos intermedios. Hay 2 opciones:

OPCIÓN A (simple): Llamar cada paso por separado desde el handler.
  1. brain.search(task, options) → vectorResults
  2. brain.searchBM25(task, options) → bm25Results
  3. brain.getContext(task, options) → finalContext
  Devolver todo junto.

OPCIÓN B (instrumentado): Agregar un modo debug al ContextBuilder.
  Más trabajo pero más preciso.

PARA V1: Usar opción A.

CREAR routes:

POST /api/context/preview
  body: { task, sources?, pathPrefix?, pruner?, reranker?,
          minScore?, useMMR?, mmrLambda? }

  1. const t0 = performance.now()
  2. vectorResults = await brain.search(task, options)
  3. const t1 = performance.now()
  4. bm25Results = await brain.searchBM25(task, options)
  5. const t2 = performance.now()
  6. hybridResults = await brain.hybridSearch(task, options)
  7. const t3 = performance.now()
  8. context = await brain.getContext(task, options)
  9. const t4 = performance.now()

  ← {
    context: string,              // final formatted output
    debug: {
      vectorResults: SearchResult[],
      bm25Results: SearchResult[],
      hybridResults: SearchResult[],
      timing: {
        vectorMs: t1-t0,
        bm25Ms: t2-t1,
        hybridMs: t3-t2,
        formatMs: t4-t3,
        totalMs: t4-t0,
      },
      stats: {
        vectorCandidates: vectorResults.length,
        bm25Candidates: bm25Results.length,
        hybridFused: hybridResults.length,
        contextChars: context.length,
        contextTokensEstimate: Math.round(context.length / 4),
      }
    }
  }
```

---

## FASE 2: Frontend — brainbank-ui

### Sub-fase 2.1: Scaffold del proyecto

```
CREAR apps/studio-ui/ como proyecto Vite + React + TypeScript

Comandos:
  cd apps/
  npm create vite@latest studio-ui -- --template react-ts
  cd studio-ui
  npm install
  npm install -D tailwindcss @tailwindcss/vite
  npm install lucide-react
  npm install @tanstack/react-query    ← data fetching + cache
  npm install zustand                   ← state management
  npm install react-router-dom          ← routing
  npm install codemirror @codemirror/lang-sql @codemirror/lang-javascript
  npm install d3                        ← grafos

vite.config.ts:
  proxy /api → http://localhost:8181/api (el daemon)

Estructura:
  src/
  ├── main.tsx
  ├── App.tsx                ← Router + Layout
  ├── api/
  │   └── client.ts          ← fetch wrapper, types importados de @brainbank/studio
  ├── stores/
  │   └── workspace.ts       ← zustand: selected repo, connection status
  ├── views/
  │   ├── Dashboard.tsx
  │   ├── CodeExplorer.tsx
  │   ├── SearchConsole.tsx
  │   ├── ImportGraph.tsx
  │   ├── CallTree.tsx
  │   ├── GitTimeline.tsx
  │   ├── VectorSpace.tsx
  │   ├── ContextLab.tsx
  │   ├── SqlConsole.tsx
  │   ├── Collections.tsx
  │   └── DocsViewer.tsx
  ├── components/
  │   ├── Layout.tsx          ← sidebar + header + main area
  │   ├── Sidebar.tsx
  │   ├── CodeBlock.tsx       ← syntax highlighted code
  │   ├── SearchResult.tsx    ← reusable result card
  │   ├── ChunkDetail.tsx
  │   ├── FileTree.tsx
  │   └── ScoreBar.tsx        ← visual score indicator
  └── lib/
      ├── format.ts           ← formatters (bytes, dates, scores)
      └── colors.ts           ← language → color mapping
```

### Sub-fase 2.2: API Client

**Archivo**: `apps/studio-ui/src/api/client.ts`

```
IMPLEMENTAR:

const BASE = '/api';  // proxied by vite to localhost:8181

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Typed methods:
export const studio = {
  stats: () => api<StatsResponse>('/stats'),

  explore: {
    files: (params) => api<FilesResponse>(`/explore/files?${qs(params)}`),
    file: (fp) => api<FileDetailResponse>(`/explore/files/${enc(fp)}`),
    chunk: (id) => api<ChunkDetailResponse>(`/explore/chunks/${id}`),
    symbols: (params) => api<SymbolsResponse>(`/explore/symbols?${qs(params)}`),
  },

  search: {
    vector: (body) => api<SearchResponse>('/search/vector', { method:'POST', body:JSON.stringify(body) }),
    bm25: (body) => api<SearchResponse>('/search/bm25', { method:'POST', body:JSON.stringify(body) }),
    hybrid: (body) => api<SearchResponse>('/search/hybrid', { method:'POST', body:JSON.stringify(body) }),
    similar: (body) => api<SimilarResponse>('/search/similar', { method:'POST', body:JSON.stringify(body) }),
  },

  graph: { ... },
  git: { ... },
  sql: { ... },
  vectors: { ... },
  collections: { ... },
  context: { ... },
};

// Response types — importar de @brainbank/studio/types
// o definir manualmente si el package no está linkado
```

### Sub-fase 2.3: Layout + Dashboard

```
IMPLEMENTAR Layout.tsx:
- Sidebar fija a la izquierda (iconos + labels, colapsable)
- Header con workspace selector + connection indicator
- Main area con React Router outlet

Dashboard.tsx:
- useQuery('stats') → api.stats()
- 4 stat cards (files, commits, docs, dims)
- Language breakdown bar chart (CSS bars, no lib needed)
- Recent activity (from index_state table — necesita nuevo endpoint simple)
- Hotspots table (top connected files)
```

### Sub-fase 2.4: Code Explorer view

```
IMPLEMENTAR CodeExplorer.tsx:

LEFT PANEL (1/3 width):
- FileTree component (virtual list for performance)
- useQuery para /api/explore/files con paginación
- Click file → load detail

RIGHT PANEL (2/3 width):
- File header (path, language, chunk count, lines)
- Chunk list (clickable cards)
- Click chunk → expand detail:
  - CodeBlock con syntax highlight
  - Symbols table
  - "Calls" list (outgoing references)
  - "Called By" list (incoming references)
  - Imports
  - Action buttons: [View Embedding] [Show Graph] [Find Similar]

COMPONENTES REUTILIZABLES:
- CodeBlock.tsx: usar <pre><code> con clases CSS para highlight mínimo
  (o CodeMirror readonly si se quiere syntax highlight real)
- ChunkDetail.tsx: la tarjeta expandible con toda la info del chunk
```

### Sub-fase 2.5: Search Console view

```
IMPLEMENTAR SearchConsole.tsx:

TOP: Search input (large, centered)
BELOW INPUT: Mode selector (radio: Hybrid/Vector/BM25/Natural Language)
BELOW MODE: Source sliders (code: 0-50, git: 0-20, docs: 0-20)
BELOW SOURCES: Advanced options (minScore, path filter)

RESULTS: Lista de SearchResult cards
  - CodeResult: green badge, file path, chunk name, code preview
  - CommitResult: blue badge, hash, message, author, files
  - DocumentResult: purple badge, title, collection, content preview

CADA RESULT tiene:
  - Score bar visual (0-100%)
  - Expandable code block
  - Action buttons: [Call Tree] [Embedding] [Graph] [Copy]

DEBUG PANEL (toggleable, bottom):
  - Query vector dims
  - Timing breakdown
  - Raw scores (vector, bm25, rrf)
  - Candidate counts
```

### Sub-fase 2.6: Import Graph view (D3)

```
IMPLEMENTAR ImportGraph.tsx:

INPUT: File selector (autocomplete from indexed_files)
CONTROLS: Depth slider (1-3), direction radio (both/forward/reverse)

GRAPH AREA (D3 force-directed):
- Nodes: circles, colored by type (seed=red, downstream=blue, upstream=green)
- Edges: lines with arrows, styled by import kind
- Click node → show detail sidebar
- Zoom/pan enabled
- Node labels on hover

La data viene de POST /api/graph/imports

D3 setup:
  - forceSimulation with forceLink, forceManyBody, forceCenter
  - SVG con <g> para zoom transform
  - Drag behavior en nodes
```

### Sub-fase 2.7: SQL Console view

```
IMPLEMENTAR SqlConsole.tsx:

LEFT SIDEBAR (narrow):
- Schema browser: collapsible table list
- Click table → show columns + types
- Preset queries (clickable, loads into editor)

MAIN AREA:
- CodeMirror editor con SQL language support
- Run button (Ctrl+Enter shortcut)
- Results table below (virtualized for large results)
- Export buttons (CSV, JSON)

Presets:
  Hardcodear las 10 queries de la sección 13 del plan original.
  Cada una es un { name, description, query } que se carga en el editor.
```

### Sub-fase 2.8: Git Timeline view

```
IMPLEMENTAR GitTimeline.tsx:

TOP: Filters (author, search text, date range)

TIMELINE: Vertical list de commits
- Cada commit: dot + line + card
- Card: hash, message, author, date, +/-
- Expandable: file list + diff preview

BELOW TIMELINE:
- Co-Edit Heatmap (matrix visualization)
  POST /api/git/co-edit-matrix con los top 20 files
  Render como tabla con celdas coloreadas por count

- File Churn chart (horizontal bars)
  GET /api/git/heatmap
```

### Sub-fase 2.9: Vector Space view

```
IMPLEMENTAR VectorSpace.tsx:

CONTROLS: Table selector, sample size, method (PCA)

CANVAS: 2D scatter plot
- Usar HTML Canvas (no SVG — performance con 1000+ points)
- Points colored by language or type
- Hover → tooltip con chunk info
- Click → detail panel
- Optional: draw query vector as highlighted point

La proyección 2D se calcula server-side via POST /api/vectors/project
```

### Sub-fase 2.10: Context Lab view

```
IMPLEMENTAR ContextLab.tsx:

INPUT: Task description (textarea)
CONTROLS: Sources, path filter, pruner, reranker, MMR settings

OUTPUT (split view):
LEFT: Pipeline trace (step-by-step, timing, counts)
RIGHT: Formatted context preview (markdown rendered)

POST /api/context/preview → muestra todo

Optional A/B mode:
  Dos columnas, cada una con sus propios settings
  Compara output lado a lado
```

---

## FASE 3: Integración y polish

### Sub-fase 3.1: Servir UI estática desde el daemon

```
MODIFICAR src/services/http-server.ts:

Agregar capacidad de servir archivos estáticos.
Si existe apps/studio-ui/dist/, servir index.html + assets.

En _handleRequest:
  if (req.url no empieza con /api/ y no es /health /context /index):
    servir static file desde el directorio de la UI
    fallback a index.html (SPA routing)

Así el daemon en puerto 8181 sirve TANTO la API como la UI.
No hace falta Vite en producción.
```

### Sub-fase 3.2: Docs Viewer view

```
IMPLEMENTAR DocsViewer.tsx:

LEFT: Collection list → file list per collection
RIGHT: Markdown rendered preview + search within

Usa /api/explore/ queries adaptadas para doc_chunks table
(o endpoints dedicados en /api/docs/)
```

### Sub-fase 3.3: Call Tree view

```
IMPLEMENTAR CallTree.tsx:

INPUT: Seleccionar archivo o chunk seed
TREE: Collapsible tree visualization
  - Cada nodo: function name, file, "called by" annotation
  - Click → expand/collapse children
  - Click file path → jump to Code Explorer

POST /api/graph/calltree
```

---

## Resumen de orden de implementación

```
PRIORIDAD  FASE    QUÉ                              DÓNDE
────────── ─────── ───────────────────────────────── ─────────────────────
   1       0.1-0.4 Daemon extensible                 src/services/
   2       1.1     Package scaffold                  packages/studio/
   3       1.2     API Stats                         packages/studio/src/api/
   4       1.7     API SQL Console                   packages/studio/src/api/
   5       1.3     API Explore                       packages/studio/src/api/
   6       1.4     API Search                        packages/studio/src/api/
   7       2.1-2.2 UI scaffold + API client          apps/studio-ui/
   8       2.3     Dashboard view                    apps/studio-ui/src/views/
   9       2.7     SQL Console view                  apps/studio-ui/src/views/
  10       2.4     Code Explorer view                apps/studio-ui/src/views/
  11       2.5     Search Console view               apps/studio-ui/src/views/
  12       1.5     API Graph                         packages/studio/src/api/
  13       2.6     Import Graph view (D3)            apps/studio-ui/src/views/
  14       1.6     API Git                           packages/studio/src/api/
  15       2.8     Git Timeline view                 apps/studio-ui/src/views/
  16       1.8     API Vectors                       packages/studio/src/api/
  17       2.9     Vector Space view                 apps/studio-ui/src/views/
  18       1.10    API Context Debug                 packages/studio/src/api/
  19       2.10    Context Lab view                  apps/studio-ui/src/views/
  20       1.9     API Collections                   packages/studio/src/api/
  21       3.1     Static serve from daemon          src/services/
  22       3.2-3.3 Docs + Call Tree views            apps/studio-ui/src/views/
