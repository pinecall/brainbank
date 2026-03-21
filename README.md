# 🧠 BrainBank

**Semantic knowledge bank for AI agents** — indexes code, documents, git history, learned patterns, and conversations into a single SQLite file with hybrid search (vector + BM25 + RRF).

BrainBank solves a specific problem: LLMs forget everything between sessions. BrainBank gives them a searchable long-term memory. It chunks your codebase into semantic blocks, indexes any document collection (markdown, notes, docs), embeds commits and diffs, stores what worked (and what didn't), and remembers past conversations — all queryable via vector search, keyword search, or both fused with Reciprocal Rank Fusion. Features are modular — enable only what you need. No API keys needed — embeddings run locally via WASM. The entire knowledge base lives in one `.brainbank/brainbank.db` file.

---

## Features

| Feature | What it does |
|---------|-------------|
| **Modular Features** | Enable only what you need — `code`, `git`, `documents`, `conversations`, `patterns`. A chat bot doesn't need code indexing |
| **Code Indexing** | Language-aware chunking for 30+ languages (TS, Python, Go, Rust, …). Detects functions, classes, and blocks. Incremental — only re-indexes changed files |
| **Document Collections** | Index any folder of markdown/text files (notes, docs, wikis). Heading-aware smart chunking inspired by [qmd](https://github.com/tobi/qmd) |
| **Git History** | Embeds commit messages + diffs. Computes file co-edit relationships ("files that change together") |
| **Agent Memory** | Stores what worked (and what didn't). Searchable learned patterns with success rates |
| **Conversation Memory** | Stores structured conversation digests with hybrid recall (vector + BM25) |
| **Context Metadata** | Attach descriptions to collections and paths — helps the LLM understand _what_ a search result is |
| **Vector Search** | HNSW approximate nearest neighbor with MMR diversity. Sub-millisecond queries |
| **BM25 Keyword Search** | Full-text search via SQLite FTS5 with Porter stemming. Instant keyword matching |
| **Hybrid Search** | Vector + BM25 fused with Reciprocal Rank Fusion. Best of both worlds |
| **Context Builder** | Produces formatted markdown from search results — ready for LLM system prompts |
| **MCP Server** | 11 tools via stdio — works with Antigravity, Claude Desktop, Cursor, and any MCP client |
| **CLI** | `brainbank index`, `brainbank search`, `brainbank hsearch`, `brainbank ksearch`, `brainbank context`, `brainbank stats`, `brainbank learn`, `brainbank remember`, `brainbank recall`, `brainbank serve` |
| **Zero API calls** | Embeddings run locally via WASM (all-MiniLM-L6-v2, 384 dims). No OpenAI key needed |

---

## Quick Start

### Install

```bash
npm install brainbank
```

### TypeScript API

```typescript
import { BrainBank } from 'brainbank';

// Full coding agent (default — code + git + patterns + conversations)
const brain = new BrainBank({ repoPath: '.' });

// 1. Index the repository
await brain.index();

// 2. Search across code, git, and memory
const results = await brain.search('authentication middleware');

// 3. Get formatted context for a task
const context = await brain.getContext('add rate limiting to the API');
// → Returns markdown with relevant code, git history, co-edits, and patterns

// 4. Store what you learned
await brain.learn({
    taskType: 'api',
    task: 'Add JWT authentication to /login endpoint',
    approach: 'Used middleware pattern with token validation + refresh',
    successRate: 0.95,
    critique: 'Should have added rate limiting from the start',
});

brain.close();
```

### Non-Coding Agent (docs + conversations only)

```typescript
import { BrainBank } from 'brainbank';

// Only documents + conversations — no code indexer, no git
const brain = new BrainBank({
    dbPath: './knowledge.db',
    features: { code: false, git: false, documents: true, conversations: true, patterns: false },
});

// Add a document collection
await brain.addCollection({ name: 'docs', path: '~/docs', pattern: '**/*.md' });
await brain.indexDocs();

// Search documents
const results = await brain.searchDocs('authentication setup');

// Store conversation memory
await brain.remember({
    title: 'User asked about OAuth setup',
    summary: 'Explained OAuth2 flow with refresh tokens',
    decisions: ['Use PKCE for public clients'],
    tags: ['auth', 'oauth'],
});

brain.close();
```

### CLI

```bash
# Index the current repo
brainbank index .

# Semantic search
brainbank search "error handling patterns"

# Get context for a task
brainbank context "refactor the database layer to use connection pooling"

# Show stats
brainbank stats

# Store a pattern
brainbank learn --type refactor --task "extract auth module" --approach "moved to middleware" --rate 0.9

# Start MCP server
brainbank serve
```

---

## MCP Server (Antigravity / Claude / Cursor)

BrainBank ships with a built-in MCP server that exposes 11 tools over stdio transport. This is the primary integration path for AI coding assistants.

### Connect to Google Antigravity

Add to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "brainbank": {
      "command": "npx",
      "args": ["tsx", "/path/to/brainbank/src/integrations/mcp-server.ts"],
      "env": {
        "BRAINBANK_REPO": "/path/to/your/repository"
      }
    }
  }
}
```

Then refresh the MCP servers page in Antigravity. The 11 tools will appear automatically.

### Connect to Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "brainbank": {
      "command": "npx",
      "args": ["tsx", "/path/to/brainbank/src/integrations/mcp-server.ts"],
      "env": {
        "BRAINBANK_REPO": "/path/to/your/repository"
      }
    }
  }
}
```

### MCP Tools Reference

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `brainbank_search` | Semantic search across code, commits, and patterns | `query`, `codeK`, `gitK`, `memoryK`, `minScore` |
| `brainbank_hybrid_search` | **Best quality** — vector + BM25 fused with RRF | `query`, `codeK`, `gitK`, `memoryK` |
| `brainbank_keyword_search` | Instant BM25 keyword search (no embeddings) | `query`, `codeK`, `gitK`, `memoryK` |
| `brainbank_context` | Formatted markdown context for a task | `task`, `affectedFiles`, `codeResults`, `gitResults` |
| `brainbank_index` | Index/re-index the repository | `forceReindex`, `gitDepth` |
| `brainbank_learn` | Store a learned pattern | `taskType`, `task`, `approach`, `successRate`, `critique` |
| `brainbank_stats` | Knowledge base statistics | — |
| `brainbank_history` | Git history for a file | `filePath`, `limit` |
| `brainbank_coedits` | Files that change together | `filePath`, `limit` |
| `brainbank_remember` | Store a conversation memory digest | `title`, `summary`, `decisions`, `filesChanged`, `patterns`, `tags` |
| `brainbank_recall` | Recall relevant past conversations | `query`, `k`, `mode` |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BRAINBANK_REPO` | Repository path to index | `process.cwd()` |
| `BRAINBANK_DB` | SQLite database path | `.brainbank/brainbank.db` |
| `BRAINBANK_DEBUG` | Show full stack traces | — |

---

## API Reference

### `new BrainBank(config?)`

Create a new BrainBank instance. Initialization is lazy — the database and HNSW indices are created on the first operation. Only enabled features are initialized.

```typescript
const brain = new BrainBank({
    repoPath: '/path/to/repo',       // Default: '.'
    dbPath: '.brainbank/brainbank.db',     // Default: '.brainbank/brainbank.db'
    features: {                      // Selectively enable/disable subsystems
        code: true,                  // Code indexing (30+ languages). Default: true
        git: true,                   // Git history indexing. Default: true
        documents: false,            // Document collections. Default: false
        conversations: true,         // Conversation memory. Default: true
        patterns: true,              // Agent memory patterns. Default: true
    },
    gitDepth: 500,                   // Max commits to index. Default: 500
    maxFileSize: 512_000,            // Skip files larger than this (bytes). Default: 500KB
    maxDiffBytes: 8192,              // Truncate diffs larger than this. Default: 8KB
    embeddingDims: 384,              // Embedding dimensions. Default: 384
    hnswM: 16,                       // HNSW connections per node. Default: 16
    hnswEfConstruction: 200,         // Build-time search depth. Default: 200
    hnswEfSearch: 50,                // Query-time search depth. Default: 50
    maxElements: 2_000_000,          // Max HNSW elements. Default: 2M
    embeddingProvider: customProvider // Optional: plug your own embeddings
});
```

### Feature Presets

```typescript
// Full (coding agent) — default
new BrainBank({ repoPath: '.' });

// Non-coding agent (docs + conversations)
new BrainBank({
    dbPath: './knowledge.db',
    features: { code: false, git: false, documents: true, conversations: true, patterns: false },
});

// Conversation memory only
new BrainBank({
    dbPath: './memory.db',
    features: { code: false, git: false, documents: false, conversations: true, patterns: false },
});

// Code + docs (no git, no memory)
new BrainBank({
    repoPath: '.',
    features: { code: true, git: false, documents: true, conversations: false, patterns: false },
});
```

Calling a method for a disabled feature throws a clear error:

```typescript
const brain = new BrainBank({ features: { code: false } });
await brain.indexCode(); // Error: 'indexCode' requires the 'code' feature
```

### Indexing

```typescript
// Index code + git in one call (incremental)
const result = await brain.index({
    forceReindex: false,             // Force re-index unchanged files
    gitDepth: 500,                   // Number of commits to process
    onProgress: (stage, msg) => console.log(`[${stage}] ${msg}`),
});
// → { code: { indexed: 142, skipped: 0, chunks: 1847 },
//     git:  { indexed: 312, skipped: 0 } }

// Index only code
await brain.indexCode({ forceReindex: true });

// Index only git
await brain.indexGit({ depth: 100 });
```

### Search

```typescript
// Unified search across everything
const results = await brain.search('error handling patterns', {
    codeK: 6,      // Max code results
    gitK: 5,       // Max git results
    memoryK: 4,    // Max pattern results
    minScore: 0.25, // Minimum similarity threshold
    useMMR: true,   // Diversity via Maximum Marginal Relevance
});

// Search code only
const codeResults = await brain.searchCode('authentication middleware');

// Search commits only
const gitResults = await brain.searchCommits('fix auth bug');
```

### Hybrid Search (Best Quality)

Combines **vector (semantic)** + **BM25 (keyword)** searches and fuses them with **Reciprocal Rank Fusion**. This catches both exact keyword matches and conceptual similarities.

```typescript
// Hybrid search — parallel vector + BM25 → RRF fusion
const best = await brain.hybridSearch('rate limiting middleware', {
    codeK: 8,
    gitK: 5,
    memoryK: 4,
});

// BM25 keyword-only search (no embeddings needed, instant)
const keywords = brain.searchBM25('express-rate-limit Redis');

// Rebuild FTS indices after bulk operations
brain.rebuildFTS();
```

**When to use which:**

| Method | Speed | Quality | When to use |
|--------|-------|---------|-------------|
| `search()` | ~50ms | Semantic | Conceptual queries ("how does auth work?") |
| `searchBM25()` | <1ms | Keyword | Exact terms ("express-rate-limit", "JWT") |
| `hybridSearch()` | ~50ms | Best | General queries — always use this by default |
| `searchDocs()` | ~50ms | Semantic | Search document collections only |

Each result contains:

```typescript
interface SearchResult {
    type: 'code' | 'commit' | 'pattern' | 'document';
    score: number;           // 0.0 to 1.0
    filePath?: string;       // For code/document results
    content: string;         // The actual text
    context?: string;        // Context description (for document results)
    metadata: Record<string, any>;  // Type-specific metadata
}
```

### Context

```typescript
// Get formatted markdown context for LLM injection
const markdown = await brain.getContext('add rate limiting to the API', {
    codeResults: 6,
    gitResults: 5,
    memoryResults: 4,
    affectedFiles: ['src/server.ts', 'src/middleware.ts'], // Improves co-edit suggestions
    minScore: 0.25,
    useMMR: true,
    mmrLambda: 0.7,   // 0 = max diversity, 1 = max relevance
});
```

The output is clean markdown with sections (only for enabled features):

- **Relevant Code** — grouped by file, with code blocks and line numbers
- **Related Git History** — commit messages, authors, diff snippets
- **Co-Edit Patterns** — files that historically change together
- **Learned Patterns** — past approaches with success rates
- **Relevant Documents** — chunks from indexed document collections
- **Relevant Conversations** — past conversation summaries

### Agent Memory

```typescript
// Store what you learned
const id = await brain.learn({
    taskType: 'api',                               // Category
    task: 'Add JWT authentication',                 // What
    approach: 'Middleware pattern with refresh tokens', // How
    outcome: 'Working auth with 15min access tokens',  // Result
    successRate: 0.95,                               // 0.0 to 1.0
    critique: 'Should have added rate limiting',     // Lesson
});

// Find similar patterns
const patterns = await brain.searchPatterns('authentication', 4);
// → [{ taskType: 'api', task: '...', approach: '...', successRate: 0.95, score: 0.87 }]

// Consolidate memory (prune old failures + merge duplicates)
brain.consolidate();
// → { pruned: 3, deduped: 1 }

// Distill patterns into a strategy
const strategy = brain.distill('api');
// → { taskType: 'api', strategy: '...', confidence: 0.91 }
```

### Conversation Memory

Store structured conversation digests so the agent remembers past discussions:

```typescript
// Store what happened in this conversation
const id = await brain.remember({
    title: 'Added BM25 hybrid search',
    summary: 'Implemented FTS5 full-text search with Porter stemming and RRF fusion',
    decisions: ['Use FTS5 over Lunr', 'RRF with k=60'],
    filesChanged: ['query/bm25.ts', 'query/rrf.ts', 'core/schema.ts'],
    patterns: ['Triggers auto-sync FTS on insert/delete'],
    openQuestions: ['Should we add LLM re-ranking?'],
    tags: ['search', 'bm25', 'hybrid'],
});

// Recall relevant past conversations (hybrid search by default)
const memories = await brain.recall('search improvements');
// → [{ title: 'Added BM25...', summary: '...', decisions: [...], score: 0.89 }]

// List recent memories
const recent = brain.listMemories(10);

// Consolidate: promote old short-term memories to long-term (compresses)
brain.consolidateMemories(20);
// → { promoted: 5 }
```

**Memory tiers:**

| Tier | What's kept | When |
|------|-----------|------|
| `short` | Full digest (all fields) | Last ~20 conversations |
| `long` | Title + summary + decisions + patterns only | Older conversations |

### Document Collections

Index any directory of markdown/text files — perfect for non-coding agents that need to search docs, notes, or wikis.

```typescript
// Register a collection
await brain.addCollection({
    name: 'docs',
    path: '~/project/docs',
    pattern: '**/*.md',
    ignore: ['**/node_modules/**'],
    context: 'Project documentation',  // Helps the LLM understand results
});

// Index all registered collections (incremental)
const result = await brain.indexDocs();
// → { docs: { indexed: 42, skipped: 0, chunks: 128 } }

// Index specific collections only
await brain.indexDocs({ collections: ['docs'] });

// Search documents
const results = await brain.searchDocs('authentication setup', {
    collection: 'docs',  // Optional: filter by collection
    k: 8,                // Max results
});

// List / remove collections
const collections = brain.listCollections();
await brain.removeCollection('docs');
```

**Smart chunking** — documents are split at natural markdown boundaries using heading-aware break points (inspired by [qmd](https://github.com/tobi/qmd)). Headings, code fences, and horizontal rules score higher as break points. Chunks target ~3000 chars (~900 tokens) with a search window to find the best split.

### Context Metadata

Attach descriptions to collections and paths — the LLM sees this alongside search results:

```typescript
// Collection-level context (set in addCollection)
await brain.addCollection({ name: 'api', path: '~/docs/api', context: 'REST API reference' });

// Path-level context (more specific)
brain.addContext('api', '/auth', 'Authentication endpoints — OAuth2 + JWT');
brain.addContext('api', '/billing', 'Stripe billing integration');

// Remove context
brain.removeContext('api', '/auth');

// List all contexts
const contexts = brain.listContexts();
```

### Query Utilities

```typescript
// Git history for a file
const history = await brain.fileHistory('src/auth.ts', 20);

// Files that change together
const coEdits = brain.coEdits('src/auth.ts', 5);
// → [{ file: 'src/middleware.ts', count: 12 }, { file: 'test/auth.test.ts', count: 8 }]

// Statistics (only shows enabled features)
const stats = brain.stats();
// → { code: { files: 142, chunks: 1847, hnswSize: 1847 },
//     git:  { commits: 312, filesTracked: 89, coEdits: 156, hnswSize: 312 },
//     memory: { patterns: 23, avgSuccess: 0.82, hnswSize: 23 },
//     documents: { collections: 2, documents: 42, chunks: 128, hnswSize: 128 },
//     conversations: { total: 15, short: 10, long: 5 } }
```

### Events

BrainBank extends `EventEmitter`:

```typescript
brain.on('initialized', ({ features }) => console.log('Ready', features));
brain.on('indexed', ({ code, git }) => console.log(`Indexed ${code?.indexed} files`));
brain.on('docsIndexed', (results) => console.log('Docs indexed', results));
brain.on('learned', ({ id, pattern }) => console.log(`Learned pattern #${id}`));
brain.on('remembered', ({ id, digest }) => console.log(`Remembered conversation #${id}`));
```

### Lifecycle

```typescript
await brain.initialize();   // Explicit init (usually auto-called)
brain.isInitialized;         // Check state
brain.config;                // Read resolved config
brain.close();               // Close DB, release resources
```

---

## Custom Embedding Provider

By default, BrainBank uses `all-MiniLM-L6-v2` via `@xenova/transformers` (WASM, runs locally, no API key). To use a different model:

```typescript
import type { EmbeddingProvider } from 'brainbank';

class OpenAIEmbedding implements EmbeddingProvider {
    readonly dims = 1536;

    async embed(text: string): Promise<Float32Array> {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
        });
        const data = await res.json();
        return new Float32Array(data.data[0].embedding);
    }

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map(t => this.embed(t)));
    }

    async close(): Promise<void> {}
}

const brain = new BrainBank({
    embeddingProvider: new OpenAIEmbedding(),
    embeddingDims: 1536,
});
```

---

## How It Works

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      BrainBank API                       │
│  index() · search() · getContext() · learn()             │
│  addCollection() · indexDocs() · searchDocs()            │
│  remember() · recall() · addContext()                    │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│  Code    │   Git    │  Doc     │  Agent   │ Conversation │
│  Indexer │  Indexer │  Indexer │  Memory  │ Memory       │
├──────────┴──────────┴──────────┴──────────┴─────────────┤
│         Unified Search (MMR) + Context Builder           │
│          + BM25 (FTS5) + Rank Fusion (RRF)               │
├────────────────────────┬─────────────────────────────────┤
│   HNSW Index ×5        │      SQLite (WAL, FTS5)         │
│ (code/git/mem/doc/conv)│      (21 tables, schema v4)     │
├────────────────────────┴─────────────────────────────────┤
│       Embedding Provider (WASM / API) [modular]          │
│  Features: code · git · documents · conversations ·      │
│            patterns — each independently toggleable       │
└──────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Index** → Walk repo → Chunk files semantically → Embed each chunk → Store in SQLite + HNSW + FTS5
2. **Search** → Embed query → HNSW search in each index → Apply MMR diversity → Merge + sort
3. **Hybrid** → Run vector + BM25 in parallel → Reciprocal Rank Fusion → Deduplicate → Re-rank
4. **Docs** → Walk collection dirs → Smart markdown chunk (heading-aware) → Embed → Store in SQLite + HNSW + FTS5
5. **Context** → Run search across all enabled features → Group results by type → Format as markdown → Return
6. **Learn** → Store pattern → Embed task text → Add to memory HNSW + FTS5 → Auto-consolidate

### Storage

Everything lives in a single SQLite file (default: `.brainbank/brainbank.db`) with WAL mode enabled. Schema v4 — 21 tables:

| Table | Purpose |
|-------|---------|
| `code_chunks` | Indexed code fragments |
| `code_vectors` | Embedding vectors for code |
| `indexed_files` | File hash tracking for incremental indexing |
| `git_commits` | Commit metadata + diffs |
| `commit_files` | Files changed per commit |
| `co_edits` | File co-occurrence matrix |
| `git_vectors` | Embedding vectors for commits |
| `memory_patterns` | Learned agent patterns |
| `memory_vectors` | Embedding vectors for patterns |
| `distilled_strategies` | Aggregated strategies per task type |
| `collections` | Registered document collections (name, path, pattern) |
| `doc_chunks` | Indexed document fragments |
| `doc_vectors` | Embedding vectors for documents |
| `path_contexts` | Context metadata for collections/paths |
| `conversation_memories` | Structured conversation digests |
| `conversation_vectors` | Embedding vectors for conversations |
| `schema_version` | Schema migration tracking |
| `fts_code` | FTS5 full-text index for code chunks |
| `fts_commits` | FTS5 full-text index for git commits |
| `fts_patterns` | FTS5 full-text index for memory patterns |
| `fts_docs` | FTS5 full-text index for document chunks |
| `fts_conversations` | FTS5 full-text index for conversation memories |

### Code Chunking

BrainBank uses **language-aware chunking** that detects semantic boundaries:

- **TypeScript/JavaScript**: Detects `function`, `class`, `const/let/var`, arrow functions, method definitions
- **Python**: Detects `def`, `class`, `async def`
- **Generic fallback**: Sliding window (configurable max/min lines) for all 30+ other languages

Small files (≤ `maxLines`) are stored as a single chunk. This keeps the index dense and search relevant.

### Vector Search

- **Engine**: [hnswlib-node](https://github.com/yoshoku/hnswlib-node) — C++ HNSW implementation with Node.js bindings
- **Diversity**: Maximum Marginal Relevance (MMR) balances relevance and diversity via tunable λ parameter
- **Five indices**: Separate HNSW for code, git, memory, documents, and conversations — avoids cross-domain interference. Only enabled features create indices.
- **Persistence**: Vectors stored in SQLite, loaded into HNSW on init. Survives restarts.

### Incremental Indexing

Files are hashed (FNV-1a) and compared against stored hashes. Only changed files are re-chunked, re-embedded, and re-indexed. Running `brainbank index` on an already-indexed repo is nearly instant.

---

## Supported Languages

The chunker supports semantic detection for TypeScript, JavaScript, and Python. All other languages use the generic sliding window approach.

Full list of indexed file extensions:

`.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` `.py` `.go` `.rs` `.java` `.kt` `.kts` `.swift` `.c` `.cpp` `.h` `.hpp` `.cs` `.rb` `.php` `.lua` `.r` `.scala` `.clj` `.ex` `.exs` `.erl` `.hs` `.ml` `.mli` `.fs` `.fsx` `.dart` `.v` `.zig` `.nim` `.jl` `.md` `.mdx` `.txt` `.json` `.yaml` `.yml` `.toml` `.xml` `.html` `.css` `.scss` `.sql` `.sh` `.bash` `.zsh` `.fish` `.ps1` `.dockerfile` `.tf` `.proto` `.graphql` `.svelte` `.vue`

---

## Testing

```bash
# Run unit tests (no network, no model download)
npx tsx test/run.ts

# Filter by name
npx tsx test/run.ts --filter math

# Verbose mode (show each assertion)
npx tsx test/run.ts --verbose

# Include integration tests (downloads embedding model)
npx tsx test/run.ts --integration
```

Test suites: Math • Languages • Chunker • Schema & Database • Config • HNSW • MMR • BM25 • RRF • Conversations • BrainBank Orchestrator

---

## Project Structure

```
brainbank/
├── src/
│   ├── index.ts                    # Public API barrel
│   ├── types.ts                    # All TypeScript interfaces
│   ├── core/
│   │   ├── brainbank.ts            # Main orchestrator (modular init)
│   │   ├── config.ts               # Configuration + feature flags resolver
│   │   └── schema.ts               # SQLite schema v4 (21 tables)
│   ├── storage/
│   │   └── database.ts             # SQLite wrapper (WAL, transactions)
│   ├── embeddings/
│   │   ├── math.ts                 # Cosine similarity, normalize, distance
│   │   ├── provider.ts             # EmbeddingProvider interface
│   │   └── local.ts                # @xenova/transformers WASM provider
│   ├── vector/
│   │   ├── hnsw.ts                 # HNSW index (hnswlib-node)
│   │   ├── mmr.ts                  # Maximum Marginal Relevance
│   │   └── index.ts                # VectorIndex interface
│   ├── indexers/
│   │   ├── languages.ts            # Extension registry, ignore patterns
│   │   ├── chunker.ts              # Language-aware code splitting
│   │   ├── code-indexer.ts         # File walker + incremental indexer
│   │   ├── git-indexer.ts          # Git history + co-edit computation
│   │   └── doc-indexer.ts          # Document collection indexer (heading-aware chunking)
│   ├── memory/
│   │   ├── pattern-store.ts        # Agent learning (store + search)
│   │   ├── consolidator.ts         # Prune + deduplicate patterns
│   │   ├── strategy-distiller.ts   # Aggregate patterns → strategies
│   │   └── conversation-store.ts   # Conversation memory (remember/recall)
│   ├── query/
│   │   ├── search.ts               # Unified vector search across indices
│   │   ├── bm25.ts                 # BM25 full-text search (FTS5)
│   │   ├── rrf.ts                  # Reciprocal Rank Fusion
│   │   ├── context-builder.ts      # Markdown context builder
│   │   └── co-edits.ts             # Co-edit suggestions
│   └── integrations/
│       ├── mcp-server.ts           # MCP server (11 tools, stdio)
│       └── cli.ts                  # CLI (10 commands)
├── test/
│   ├── run.ts                      # Test runner
│   └── unit/                       # 87 tests, 11 suites
│       ├── math.test.ts
│       ├── languages.test.ts
│       ├── chunker.test.ts
│       ├── schema.test.ts
│       ├── config.test.ts
│       ├── hnsw.test.ts
│       ├── mmr.test.ts
│       ├── bm25.test.ts
│       ├── rrf.test.ts
│       ├── conversations.test.ts
│       └── brainbank.test.ts
├── package.json
├── .gitignore
└── tsconfig.json
```

---

## Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `better-sqlite3` | SQLite database (WAL mode, fast, sync) | Native |
| `hnswlib-node` | HNSW approximate nearest neighbor search | Native |
| `@xenova/transformers` | Local embedding model (WASM, no API key) | ~50MB first run |
| `simple-git` | Git log/diff access | Pure JS |
| `@modelcontextprotocol/sdk` | MCP server protocol | Pure JS |
| `zod` | Schema validation for MCP tools | Pure JS |

---

## Roadmap

- [x] **Modular features** — Enable/disable code, git, docs, conversations, patterns independently
- [x] **Document collections** — Index any folder of markdown/text with heading-aware chunking
- [x] **Context metadata** — Path-level descriptions for search result provenance
- [ ] **Query expansion** — LLM-powered query variations for better recall
- [ ] **LLM re-ranking** — Cross-encoder for top-K re-scoring (Qwen3-Reranker)
- [ ] **More embedding providers** — OpenAI, Cohere, Ollama, VoyageAI
- [ ] **Watch mode** — Auto-index on file changes (fs.watch)
- [ ] **Multi-repo** — Index multiple repositories into one brain
- [ ] **Web UI** — Browse the knowledge base, visualize co-edits

---

## License

MIT
