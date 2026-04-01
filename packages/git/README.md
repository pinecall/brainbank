# @brainbank/git

Git history indexing plugin for [BrainBank](https://github.com/pinecall/brainbank). Indexes commit messages, diffs, and file change patterns. Computes co-edit relationships to suggest files that tend to change together.

## Install

```bash
# Global install (CLI + programmatic)
npm i -g brainbank @brainbank/git

# Or as a project dependency
npm i @brainbank/git
```

## Quick Start

```typescript
import { BrainBank } from 'brainbank';
import { git } from '@brainbank/git';

const brain = new BrainBank({ dbPath: '.brainbank/db' })
  .use(git({ depth: 500 }));

await brain.initialize();
await brain.index({ modules: ['git'] });

// Search commit history by meaning
const results = await brain.search('authentication refactor');
```

## Multi-Repo

Index multiple repositories into one shared database:

```typescript
const brain = new BrainBank({ dbPath: '.brainbank/db' })
  .use(git({ repoPath: './frontend', name: 'git:frontend' }))
  .use(git({ repoPath: './backend',  name: 'git:backend' }));
```

## API

### `git(options?): Plugin`

Factory function — creates a git indexing plugin.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repoPath` | `string` | config | Repository root to index |
| `depth` | `number` | `500` | Max commits to index |
| `maxDiffBytes` | `number` | `8192` | Max diff size per commit (truncated beyond) |
| `name` | `string` | `'git'` | Plugin name for multi-repo (e.g. `'git:frontend'`) |
| `embeddingProvider` | `EmbeddingProvider` | global | Per-plugin embedding override |

### `GitIndexer`

Core indexing engine. Parses git log, computes diffs, embeds commit content, and stores in SQLite + HNSW.

**Key behaviors:**
- **Incremental** — only processes new commits not already in the database
- **Zombie cleanup** — detects commits with data but missing vectors, re-indexes them
- **Co-edit computation** — analyzes which files change together across commits
- **Diff truncation** — large diffs are truncated to `maxDiffBytes` for embedding quality

### `CoEditAnalyzer`

Suggests files that historically change together based on git commit co-occurrence.

```typescript
// After indexing
const gitPlugin = brain.plugin('git');
const coEdits = gitPlugin.suggestCoEdits('src/auth/login.ts', 5);
// → [{ file: 'src/auth/middleware.ts', count: 12 },
//    { file: 'src/auth/session.ts', count: 8 }]
```

### Embedded Commit Format

Each commit is embedded as enriched text for better semantic matching:

```
Commit: feat(auth): add JWT token rotation
Author: Jane Doe
Date: 2024-03-15
Files: src/auth/token.ts, src/auth/middleware.ts
Changes:
<truncated diff>
```

## How It Works

```
Repository → git log → parse commits → filter new
    → extract diffs + file stats → embed commit text
    → store in SQLite + HNSW
    → compute co-edit pairs from file co-occurrence
```

## Peer Dependencies

- `brainbank` >= 0.7.0

## Plugin Capabilities

`@brainbank/git` implements the following capability interfaces, discovered by the core at runtime:

| Interface | What it does |
|-----------|-------------|
| `IndexablePlugin` | Participates in `brain.index()` — commit parsing + embedding |
| `VectorSearchPlugin` | Provides `GitVectorSearch` for semantic commit search |
| `BM25SearchPlugin` | Provides FTS5 keyword search against `fts_commits` |
| `ContextFormatterPlugin` | Formats git history + co-edit suggestions for `brain.getContext()` |
| `MigratablePlugin` | Owns its schema — `git_commits`, `commit_files`, `co_edits`, `git_vectors`, `fts_commits` |
| `ReembeddablePlugin` | Participates in `brain.reembed()` |
| `CoEditPlugin` | Suggests files that tend to change together |

## License

MIT
