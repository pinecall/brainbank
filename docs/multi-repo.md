# Multi-Repository Indexing

BrainBank can index multiple repositories into a **single shared database**. Useful for monorepos, microservices, or projects split across multiple Git repositories.

## How It Works

When you point BrainBank at a directory that contains multiple Git repositories (subdirectories with `.git/`), the CLI **auto-detects** them and creates namespaced plugins:

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

All code, git history, and co-edit relationships go into **one** `.brainbank/brainbank.db` at the parent directory. Search returns results across all repositories:

```bash
brainbank hsearch "cancel job confirmation" --repo ~/projects
# → Results from frontend, backend, and shared utilities
```

---

## Detection Logic

The CLI's `builtin-registration.ts` checks for a root `.git/` directory. If absent, it scans immediate subdirectories for `.git/` folders (excluding dot-directories and `node_modules`). Each detected sub-repo gets namespaced plugin instances for any plugin in the `MULTI_REPO_PLUGINS` set (currently `code` and `git`, extensible at runtime).

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

This is much cleaner than using ignore patterns to exclude entire sub-repos.

---

## Namespaced Plugins

Each sub-repository gets its own namespaced plugin instances:

| Sub-repo | Code plugin | Git plugin |
|----------|------------|------------|
| `webapp-frontend/` | `code:webapp-frontend` | `git:webapp-frontend` |
| `webapp-backend/` | `code:webapp-backend` | `git:webapp-backend` |
| `webapp-shared/` | `code:webapp-shared` | `git:webapp-shared` |

Same-type plugins share a single HNSW vector index for efficient memory usage and unified search:
- All `code:*` plugins share `_sharedHnsw['code']` → persisted as `hnsw-code.index`
- All `git:*` plugins share `_sharedHnsw['git']` → persisted as `hnsw-git.index`

Only the first plugin to initialize (where `isNew === true`) calls `loadVectors()`. Subsequent same-type plugins skip the load since the shared index is already populated.

---

## Programmatic API

```typescript
import { BrainBank } from 'brainbank';
import { code } from '@brainbank/code';
import { git } from '@brainbank/git';

const brain = new BrainBank({ repoPath: '~/projects' })
  .use(code({ name: 'code:frontend', repoPath: '~/projects/webapp-frontend' }))
  .use(code({ name: 'code:backend', repoPath: '~/projects/webapp-backend' }))
  .use(git({ name: 'git:frontend', repoPath: '~/projects/webapp-frontend' }))
  .use(git({ name: 'git:backend', repoPath: '~/projects/webapp-backend' }));

await brain.initialize();
await brain.index();

// Cross-repo search
const results = await brain.hybridSearch('authentication guard');
// → Results from both frontend and backend
```

### Plugin Registry Behavior

```typescript
brain.has('code');                   // true — prefix match
brain.has('code:frontend');          // true — exact match
brain.plugin('code');               // returns first code:* plugin
brain.plugins;                      // ['code:frontend', 'code:backend', 'git:frontend', 'git:backend']
```

---

## Per-Plugin Embedding Overrides

In multi-repo, you can override embeddings per plugin — the CLI reads from `config.json`:

```jsonc
{
  "code": { "embedding": "openai" },       // all code:* plugins use OpenAI
  "git":  { "embedding": "local" },        // all git:* plugins use local
  "docs": { "embedding": "perplexity-context" }
}
```

The CLI also merges ignore patterns: `config[pluginName].ignore` + `--ignore` flag apply to all code plugins.

---

## MCP Multi-Workspace

The MCP server manages workspace lifecycle via `WorkspacePool` — a memory-aware pool with automatic eviction. Each unique `repo` path gets its own BrainBank instance:

```typescript
// Agent working in one workspace
brainbank_context({ task: "login form", repo: "/Users/you/projects" })

// Agent switches to a different project — new instance auto-created
brainbank_context({ task: "API routes", repo: "/Users/you/other-project" })
```

Instances are cached in memory after first initialization (~480ms). The pool evicts idle workspaces based on memory pressure (`BRAINBANK_MAX_MEMORY_MB`, default 2GB) and inactivity TTL (`BRAINBANK_TTL_MINUTES`, default 30 min). Active operations are tracked — the pool never evicts a workspace with in-flight queries.

---

## See Also

- [Getting Started](getting-started.md) — single-repo indexing
- [Configuration](config.md) — per-plugin embedding config
- [MCP Server](mcp.md) — multi-workspace MCP setup
