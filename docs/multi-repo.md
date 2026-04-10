# Multi-Repository Indexing

BrainBank can index multiple repositories into a **single shared database**. Useful for monorepos, microservices, or projects split across multiple Git repositories.

## How It Works

When you point BrainBank at a directory that contains multiple Git repositories (subdirectories with `.git/`), the CLI **auto-detects** them and creates namespaced plugin instances:

```bash
~/projects/
├── webapp-frontend/   # .git/
├── webapp-backend/    # .git/
└── webapp-shared/     # .git/
```

```bash
brainbank index ~/projects --depth 200
```

```
━━━ BrainBank Index ━━━
  Repo: /Users/you/projects
  Multi-repo: found 3 git repos: webapp-frontend, webapp-backend, webapp-shared
  CODE:WEBAPP-BACKEND [0/1075] ...
  CODE:WEBAPP-FRONTEND [0/719] ...
  GIT:WEBAPP-SHARED [0/200] ...

  Code: 2107 indexed, 4084 chunks
  Git:  600 indexed (200 per repo)
  Co-edit pairs: 1636
```

All code, git history, and co-edit relationships go into **one** `.brainbank/data/brainbank.db` at the parent directory. But each namespaced plugin gets its own **per-repo SQLite database** for domain tables:

```
.brainbank/data/
├── brainbank.db        # Root DB: KV, embedding_meta, index_state
├── webapp-backend.db   # code:webapp-backend + git:webapp-backend domain tables
└── webapp-frontend.db  # code:webapp-frontend + git:webapp-frontend domain tables
```

Search returns results across all repositories in one unified result set.

---

## Detection Logic

`builtin-registration.ts` checks for a root `.git/` directory. If absent, it scans immediate subdirectories for `.git/` folders (excluding dot-directories and `node_modules`). Each detected sub-repo gets namespaced plugin instances for plugins in the `MULTI_REPO_PLUGINS` set (`code` and `git` by default).

### Selecting Specific Repos

By default, **all** detected git subdirectories are indexed. To index only specific repos, add a `repos` whitelist to your `.brainbank/config.json`:

```json
{
  "repos": ["webapp-backend", "webapp-frontend"],
  "plugins": ["code", "git"]
}
```

- **`repos` is set** → only those subdirs are indexed (explicit whitelist)
- **`repos` is omitted** → all `.git/` children are auto-detected (default behavior)

---

## Namespaced Plugins

Each sub-repository gets its own namespaced plugin instances:

| Sub-repo | Code plugin | Git plugin | Plugin DB |
|----------|------------|------------|-----------|
| `webapp-frontend/` | `code:webapp-frontend` | `git:webapp-frontend` | `webapp-frontend.db` |
| `webapp-backend/` | `code:webapp-backend` | `git:webapp-backend` | `webapp-backend.db` |
| `webapp-shared/` | `code:webapp-shared` | `git:webapp-shared` | `webapp-shared.db` |

### HNSW Sharing

Same-type plugins share a single HNSW vector index for efficient memory usage and unified search:

| Plugin type | HNSW key | File | Sharing |
|-------------|----------|------|---------|
| All `code:*` | `'code:webapp-frontend'`, `'code:webapp-backend'` | `hnsw-code:webapp-frontend.index`, etc. | **Per-repo isolated** — each code plugin gets its own |
| All `git:*` | `'git'` | `hnsw-git.index` | **Shared** — all git repos in one index |
| All `docs:*` | `'docs'` | `hnsw-docs.index` | **Shared** — all doc collections in one index |
| KV | `'kv'` | `hnsw-kv.index` | **Shared** — all collections |

Code plugins use their full name as the HNSW key (`this.name`), giving each repo its own isolated HNSW index. Git and docs use a literal string key, so all instances share one index.

Only the first `code:*` plugin that initializes loads vectors (when `isNew === true`). Subsequent same-type plugins find the shared HNSW already populated and skip `loadVectors()`.

---

## File Path Prefixing

In multi-repo, `CompositeVectorSearch` and `CompositeBM25Search` automatically prefix result `filePaths` with the sub-repo name:

```
DB stores:  "src/auth/login.ts"                  (unprefixed)
Results:    "webapp-backend/src/auth/login.ts"    (prefixed by plugin name)
```

This enables path-prefix filtering (`pathPrefix: 'webapp-backend/'`) and ensures deduplication works correctly across repos. The code context formatter strips the prefix for DB lookups and re-adds it to output.

---

## Programmatic API

```typescript
import { BrainBank } from 'brainbank';
import { code } from '@brainbank/code';
import { git } from '@brainbank/git';

const brain = new BrainBank({ repoPath: '~/projects' })
  .use(code({ name: 'code:frontend', repoPath: '~/projects/webapp-frontend' }))
  .use(code({ name: 'code:backend',  repoPath: '~/projects/webapp-backend' }))
  .use(git({ name: 'git:frontend',   repoPath: '~/projects/webapp-frontend' }))
  .use(git({ name: 'git:backend',    repoPath: '~/projects/webapp-backend' }));

await brain.initialize();
await brain.index();

// Cross-repo search — returns results from both, prefixed with sub-repo names
const results = await brain.hybridSearch('authentication guard');
// r.filePath = "webapp-backend/src/auth/guard.ts"
// r.filePath = "webapp-frontend/src/guards/auth.guard.ts"
```

### Plugin Registry Behavior

```typescript
brain.has('code');              // true — prefix match finds code:frontend + code:backend
brain.has('code:frontend');     // true — exact match
brain.plugin('code');           // returns first code:* plugin found (code:frontend)
brain.plugins;
// → ['code:frontend', 'code:backend', 'git:frontend', 'git:backend']
```

---

## Per-Plugin Embedding Overrides

In multi-repo, you can override embeddings per plugin type via `config.json`. The CLI applies the config's `embedding` field to ALL instances of that plugin type:

```jsonc
{
  "code": { "embedding": "openai" },       // all code:* plugins use OpenAI (1536d)
  "git":  { "embedding": "local" },        // all git:* plugins use local (384d)
  "docs": { "embedding": "perplexity-context" }  // all docs:* use Perplexity (2560d)
}
```

Ignore patterns from `config.code.ignore` + `--ignore` flag are merged and applied to ALL code plugins.

---

## Hot-Reload in Multi-Process

After `brainbank index` updates a sub-repo, the MCP server (or another process) detects staleness via `index_state`:

```
index_state table:
  name              version   writer_pid
  code:webapp-backend  3        12345     ← bumped after indexing
  code:webapp-frontend 1        12345
  git                  5        12345
```

`ensureFresh()` compares each entry against `_loadedVersions`. For stale entries, `_reloadIndex(name)` calls `reloadHnsw()` with the correct vector table discovered from the plugin's `reembedConfig()`.

---

## MCP Multi-Workspace

The MCP server's `WorkspacePool` treats each unique `repo` path as a separate workspace. A multi-repo project at `/projects` is one workspace:

```typescript
// Same workspace — unified search across all sub-repos
brainbank_context({ task: "login form", repo: "/Users/you/projects" })
```

For separate projects, they get separate BrainBank instances in the pool:

```typescript
brainbank_context({ task: "API routes", repo: "/Users/you/other-project" })
// → Different WorkspacePool entry
```

Pool eviction is based on total `brain.memoryHint()` across all workspaces. A multi-repo workspace with 3 sub-repos and Perplexity Context (2560d) uses more RAM than a single-repo workspace with local embeddings (384d).

---

## See Also

- [Getting Started](getting-started.md) — single-repo indexing
- [Configuration](config.md) — per-plugin embedding config, `repos` whitelist
- [MCP Server](mcp.md) — multi-workspace pool details
- [Architecture](architecture.md) — per-repo DB isolation, HNSW sharing strategy
