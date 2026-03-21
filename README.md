# 🧠 BrainBank

**Semantic knowledge bank for AI agents** — indexes code, documents, git history, conversations, and learned patterns into a single SQLite file with hybrid search (vector + BM25 + RRF).

BrainBank solves a specific problem: LLMs forget everything between sessions. BrainBank gives them a searchable long-term memory.

- **Modular** — `.use()` only the modules you need
- **Local** — embeddings run locally via WASM, no API keys
- **Portable** — everything lives in one `.brainbank/brainbank.db` file
- **Hybrid search** — vector (semantic) + BM25 (keyword) fused with RRF

---

## Quick Start

```bash
npm install brainbank
```

### Coding agent — code + git + memory

```typescript
import { BrainBank } from 'brainbank';
import { code } from 'brainbank/code';
import { git } from 'brainbank/git';
import { memory } from 'brainbank/memory';
import { conversations } from 'brainbank/conversations';

const brain = new BrainBank({ repoPath: '.' })
  .use(code())
  .use(git())
  .use(memory())
  .use(conversations());

await brain.index();                                    // index code + git
const context = await brain.getContext('add auth');      // system prompt context
```

### Non-coding agent — docs + conversations only

```typescript
import { BrainBank } from 'brainbank';
import { docs } from 'brainbank/docs';
import { conversations } from 'brainbank/conversations';

const brain = new BrainBank({ dbPath: './knowledge.db' })
  .use(docs())
  .use(conversations());

await brain.addCollection({ name: 'notes', path: '~/notes', pattern: '**/*.md' });
await brain.indexDocs();
```

### Conversation memory only

```typescript
import { BrainBank } from 'brainbank';
import { conversations } from 'brainbank/conversations';

const brain = new BrainBank({ dbPath: './memory.db' })
  .use(conversations());

await brain.remember({ title: 'Deployed v2', summary: 'Shipped auth rewrite...', decisions: ['JWT > sessions'] });
const memories = await brain.recall('authentication approach');
```

---

## Modules

BrainBank is composed of 5 independent modules. Enable only what you need:

| Module | Import | What it does |
|--------|--------|--------------|
| `code` | `brainbank/code` | Language-aware code chunking (30+ languages), HNSW index |
| `git` | `brainbank/git` | Git commit history, diffs, co-edit relationships |
| `docs` | `brainbank/docs` | Document collections (markdown, notes, wikis), heading-aware chunking |
| `conversations` | `brainbank/conversations` | Conversation digests with structured recall, short/long tier |
| `memory` | `brainbank/memory` | Agent learn/search patterns, auto-consolidation, strategy distillation |

Each module is a factory function:

```typescript
import { code } from 'brainbank/code';

code({ repoPath: '/my/repo' })   // options are optional
```

---

## CLI

```bash
# Index
brainbank index [path]                      # Index code + git history
brainbank collection add <path> --name docs # Add a document collection
brainbank collection list                   # List collections
brainbank collection remove <name>          # Remove a collection
brainbank docs [--collection <name>]        # Index document collections

# Search
brainbank search <query>                    # Semantic search (vector)
brainbank hsearch <query>                   # Hybrid search (best quality)
brainbank ksearch <query>                   # Keyword search (BM25, instant)
brainbank dsearch <query>                   # Document search

# Context
brainbank context <task>                    # Get formatted context for a task
brainbank context add <col> <path> <desc>   # Add context metadata
brainbank context list                      # List all context metadata

# Memory
brainbank memory learn --type api --task "add auth" --approach "JWT" --rate 0.9
brainbank memory search "authentication"    # Search learned patterns
brainbank memory consolidate                # Prune + deduplicate
brainbank remember --title "..." --summary "..." --tags "a,b"
brainbank recall <query>                    # Recall conversation memories

# Utility
brainbank stats                             # Index statistics
brainbank serve                             # Start MCP server (stdio)
```

Options: `--repo <path>`, `--force`, `--depth <n>`, `--collection <name>`, `--pattern <glob>`, `--context <desc>`.

---

## Document Collections

Register folders of documents. Files are chunked by heading structure (inspired by [qmd](https://github.com/tobi/qmd)):

```typescript
// Register
await brain.addCollection({
  name: 'docs',
  path: '~/project/docs',
  pattern: '**/*.md',         // default
  ignore: ['**/drafts/**'],
  context: 'Project documentation',
});

// Index (incremental — only changed files)
await brain.indexDocs();
await brain.indexDocs({ collections: ['docs'] });  // specific collection

// Search
const results = await brain.searchDocs('authentication', { collection: 'docs', k: 5 });

// Context metadata (helps LLM understand what documents are about)
brain.addContext('docs', '/api', 'REST API reference');
brain.addContext('docs', '/guides', 'Step-by-step tutorials');
```

---

## Search

Three search modes, from fastest to best quality:

| Mode | Method | Speed | Quality |
|------|--------|-------|---------|
| Keyword | `searchBM25(q)` | ⚡ instant | Good for exact terms |
| Vector | `search(q)` | ~50ms | Good for concepts |
| Hybrid | `hybridSearch(q)` | ~100ms | **Best** — catches both |

```typescript
// Hybrid search (recommended)
const results = await brain.hybridSearch('authentication middleware');

// Vector search with options
const results = await brain.search('JWT validation', {
  codeK: 10,     // max code results
  gitK: 5,       // max git results
  memoryK: 3,    // max memory results
  useMMR: true,  // diversity via Maximal Marginal Relevance
});

// Code-only or commit-only
const code = await brain.searchCode('parse JSON config', 8);
const commits = await brain.searchCommits('fix auth bug', 5);
```

### Score interpretation

| Score | Meaning |
|-------|---------|
| 0.8+ | Near-exact match |
| 0.5–0.8 | Strongly related |
| 0.3–0.5 | Somewhat related |
| <0.3 | Weak match |

---

## Agent Memory

```typescript
// Learn from a completed task
await brain.learn({
  taskType: 'api',
  task: 'Add rate limiting to /login',
  approach: 'Express middleware with redis store',
  successRate: 0.95,
  critique: 'Should have added tests first',
});

// Search patterns
const patterns = await brain.searchPatterns('rate limiting');

// Distill patterns into a strategy
const strategy = brain.distill('api');
// → { taskType: 'api', strategy: '...', confidence: 0.87 }
```

---

## Conversation Memory

```typescript
// Store a conversation digest
await brain.remember({
  title: 'Auth rewrite discussion',
  summary: 'Decided to migrate from sessions to JWT...',
  decisions: ['JWT over sessions', 'Redis for token blacklist'],
  filesChanged: ['src/auth.ts', 'src/middleware.ts'],
  patterns: ['middleware-first', 'test-driven'],
  tags: ['auth', 'refactor'],
});

// Recall relevant past conversations
const memories = await brain.recall('authentication approach');
for (const m of memories) {
  console.log(m.title, m.summary, m.score);
}

// List recent
const recent = brain.listMemories(10, 'short');

// Auto-promote old short-term → long-term
brain.consolidateMemories(20);  // keep 20 most recent as short-term
```

---

## Context Generation

```typescript
// Get formatted markdown context for system prompt injection
const context = await brain.getContext('add rate limiting to the API', {
  codeResults: 6,
  gitResults: 5,
  memoryResults: 4,
  affectedFiles: ['src/api/routes.ts'],
  useMMR: true,
});
// Returns sections: ## Relevant Code, ## Git History, ## Relevant Documents, ## Relevant Conversations
```

---

## MCP Server

BrainBank ships with an MCP-compatible server (stdio transport):

```bash
brainbank serve
```

Register in your AI tool config:

```json
{
  "mcpServers": {
    "brainbank": {
      "command": "npx",
      "args": ["brainbank", "serve"],
      "env": { "BRAINBANK_REPO": "/path/to/repo" }
    }
  }
}
```

---

## Configuration

```typescript
const brain = new BrainBank({
  repoPath: '.',                    // Repository root
  dbPath: '.brainbank/brainbank.db', // SQLite path
  gitDepth: 500,                    // Max commits to index
  maxFileSize: 512_000,             // Skip files > 500KB
  maxDiffBytes: 8192,               // Max diff per commit
  embeddingDims: 384,               // Vector dimensions
  maxElements: 2_000_000,           // HNSW capacity
  hnswM: 16,                        // HNSW connections/node
  hnswEfConstruction: 200,          // Build-time candidates
  hnswEfSearch: 50,                 // Query-time candidates
  embeddingProvider: customProvider, // Custom embeddings (default: local WASM)
});
```

Environment variables:
- `BRAINBANK_REPO` — repository path (default: `process.cwd()`)
- `BRAINBANK_DB` — database path (default: `.brainbank/brainbank.db`)
- `BRAINBANK_DEBUG` — show full stack traces

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   BrainBank Core                     │
│  .use(code)  .use(git)  .use(docs)  .use(memory)    │
│  .use(conversations)                                 │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ │
│  │ Code  │ │  Git  │ │ Docs  │ │Memory │ │ Conv  │ │
│  │Module │ │Module │ │Module │ │Module │ │Module │ │
│  └───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘ │
│      │         │         │         │         │      │
│  ┌───▼───┐ ┌───▼───┐ ┌───▼───┐ ┌───▼───┐ ┌───▼───┐ │
│  │ HNSW  │ │ HNSW  │ │ HNSW  │ │ HNSW  │ │ HNSW  │ │
│  │ Index │ │ Index │ │ Index │ │ Index │ │ Index │ │
│  └───────┘ └───────┘ └───────┘ └───────┘ └───────┘ │
│                                                      │
│  ┌──────────────────────────────────────────────────┐│
│  │         SQLite (.brainbank/brainbank.db)         ││
│  │  code_chunks │ git_commits │ doc_chunks │ ...    ││
│  │  FTS5 full-text │ vectors │ co_edits │ patterns  ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  ┌──────────────────────────────────────────────────┐│
│  │    Local Embedding (WASM, 384-dim, ≈0ms/query)   ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

### Data Flow

1. **Index** → Code/Git/Doc indexers parse files into chunks
2. **Embed** → Each chunk gets a 384-dim vector (local WASM)
3. **Store** → Chunks + vectors → SQLite, vectors → HNSW index
4. **Search** → Query vector → HNSW k-NN + BM25 keyword → RRF fusion
5. **Context** → Top results formatted as markdown for system prompts
6. **Learn** → Agent stores task outcomes → memory patterns → distilled strategies

### Storage Schema

| Table | What it stores |
|-------|---------------|
| `code_chunks` | Source code chunks (file, function, class, block) |
| `code_vectors` | Code HNSW embeddings |
| `git_commits` | Commit metadata and diffs |
| `git_vectors` | Commit HNSW embeddings |
| `commit_files` | Files changed per commit |
| `co_edits` | File co-edit relationships |
| `doc_chunks` | Document chunks |
| `doc_vectors` | Document HNSW embeddings |
| `collections` | Registered document collections |
| `path_contexts` | Context metadata per path |
| `memory_patterns` | Agent learned patterns |
| `memory_vectors` | Pattern HNSW embeddings |
| `conversation_memories` | Conversation digests |
| `conversation_vectors` | Conversation HNSW embeddings |
| `distilled_strategies` | Consolidated strategies |

---

## Project Structure

```
brainbank/
├── src/
│   ├── core/
│   │   ├── brainbank.ts       # Main orchestrator (.use() builder)
│   │   └── config.ts          # Config defaults + resolver
│   ├── modules/
│   │   ├── types.ts           # BrainBankModule interface
│   │   ├── code.ts            # Code indexing module
│   │   ├── git.ts             # Git history module
│   │   ├── docs.ts            # Document collections module
│   │   ├── conversations.ts   # Conversation memory module
│   │   └── memory.ts          # Agent memory module
│   ├── embeddings/            # Local WASM embedding provider
│   ├── indexers/              # Code chunker, git parser, doc parser
│   ├── memory/                # Pattern store, consolidator, conversation store
│   ├── query/                 # UnifiedSearch, BM25, RRF, context builder
│   ├── storage/               # SQLite database + schema
│   ├── vector/                # HNSW index + MMR
│   ├── integrations/          # CLI, MCP server
│   └── index.ts               # Public API barrel
├── test/
│   └── unit/                  # 87 unit tests
└── package.json
```

---

## License

MIT
