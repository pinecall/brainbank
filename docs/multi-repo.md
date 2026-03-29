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

## Namespaced Plugins

Each sub-repository gets its own namespaced plugin instances (e.g., `code:frontend`, `git:backend`). Same-type plugins share a single HNSW vector index for efficient memory usage and unified search.

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

---

## MCP Multi-Workspace

The MCP server maintains a pool of BrainBank instances — one per unique `repo` path:

```typescript
// Agent working in one workspace
brainbank_search({ query: "login form", repo: "/Users/you/projects" })

// Agent switches to a different project — new instance auto-created
brainbank_search({ query: "API routes", repo: "/Users/you/other-project" })
```

Instances are cached in memory after first initialization (~480ms), so subsequent queries are fast.

---

## See Also

- [Getting Started](getting-started.md) — single-repo indexing
- [Configuration](config.md) — per-plugin embedding config
- [MCP Server](mcp.md) — multi-workspace MCP setup
