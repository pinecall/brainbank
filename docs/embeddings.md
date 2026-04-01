# Embeddings & Reranker

## Embedding Providers

| Provider | Import | Dims | Speed | Cost |
|----------|--------|------|-------|------|
| **Local (default)** | built-in | 384 | ⚡ 0ms | Free |
| **OpenAI** | `OpenAIEmbedding` | 1536 | ~100ms | $0.02/1M tokens |
| **Perplexity** | `PerplexityEmbedding` | 2560 / 1024 | ~100ms | $0.02/1M tokens |
| **Perplexity Context** | `PerplexityContextEmbedding` | 2560 / 1024 | ~100ms | $0.06/1M tokens |

---

## Auto-Resolution

BrainBank **auto-resolves** the embedding provider. Set it once → it's stored in `.brainbank/config.json` and DB → every future run uses the same provider automatically.

```bash
# CLI: interactive setup (recommended)
brainbank index .                            # prompts for embedding provider, saves to config.json

# CLI: explicit override (any command)
brainbank index . --embedding openai         # overrides provider for this run
brainbank hsearch "auth middleware"           # auto-resolves from config.json or DB
```

```typescript
// Programmatic: pass to constructor
const brain = new BrainBank({
  repoPath: '.',
  embeddingProvider: new OpenAIEmbedding(),  // stored in DB on first index
});
```

**MCP** — zero-config. Reads the provider from `config.json` > `BRAINBANK_EMBEDDING` env > DB `provider_key` > falls back to local.

> Priority on startup: explicit `embeddingProvider` > `--embedding` flag > `config.json` > `BRAINBANK_EMBEDDING` env > stored `provider_key` in DB > local WASM (default).

---

## Per-Plugin Override

Each plugin can use a different embedding provider with different dimensions:

```typescript
import { BrainBank, OpenAIEmbedding, PerplexityContextEmbedding } from 'brainbank';
import { code } from '@brainbank/code';
import { git } from '@brainbank/git';
import { docs } from '@brainbank/docs';

const brain = new BrainBank({ repoPath: '.' })       // default: local WASM (384d)
  .use(code({ embeddingProvider: new OpenAIEmbedding() }))              // code: OpenAI (1536d)
  .use(git())                                                           // git: local (384d)
  .use(docs({ embeddingProvider: new PerplexityContextEmbedding() }));  // docs: Perplexity (2560d)
```

> Each plugin creates its own HNSW index with the correct dimensions. Code plugins use shared HNSW (`getOrCreateSharedHnsw('code')`), git plugins share another (`getOrCreateSharedHnsw('git')`), and docs plugins share another (`getOrCreateSharedHnsw('docs')`).

---

## Provider Details

### Local (Default)

Built-in, zero config, runs via WASM (`@xenova/transformers`, all-MiniLM-L6-v2):

```typescript
// No import needed — it's the default
const brain = new BrainBank({ repoPath: '.' });
```

Downloads ~23MB model on first use, cached in `.model-cache/`. Batch size: 32 texts per inference call.

### OpenAI

```typescript
import { OpenAIEmbedding } from 'brainbank';

new OpenAIEmbedding();                        // uses OPENAI_API_KEY env var
new OpenAIEmbedding({
  model: 'text-embedding-3-large',            // default: text-embedding-3-small
  dims: 512,                                  // Matryoshka reduction (only 3-* models)
  apiKey: 'sk-...',
  baseUrl: 'https://my-proxy.com/v1/embeddings',
  timeout: 30_000,                            // default: 30s
});
```

Batch size: 100 texts per API call. Auto-retries on token limit errors (truncates to 8k then 6k chars).

### Perplexity (Standard)

Best for independent texts, queries, and code chunks:

```typescript
import { PerplexityEmbedding } from 'brainbank';

new PerplexityEmbedding();                    // uses PERPLEXITY_API_KEY env var
new PerplexityEmbedding({
  model: 'pplx-embed-v1-0.6b',               // smaller, faster (1024d)
  dims: 512,                                  // Matryoshka reduction
});
```

Returns base64-encoded signed int8 vectors, decoded to Float32Array internally.

### Perplexity (Contextualized)

Chunks share document context → better retrieval for related code/docs:

```typescript
import { PerplexityContextEmbedding } from 'brainbank';

new PerplexityContextEmbedding();             // uses PERPLEXITY_API_KEY env var
new PerplexityContextEmbedding({
  model: 'pplx-embed-context-v1-0.6b',       // smaller, faster (1024d)
  dims: 512,                                  // Matryoshka reduction
});
```

Input is `string[][]` (documents × chunks). `embed(text)` wraps as `[[text]]`. `embedBatch(texts)` splits into sub-documents at ~80k chars to stay under the 32k token/doc limit.

---

## Benchmarks

Real benchmarks on a production NestJS backend (1052 code chunks + git history):

### Indexing & Search Performance

| Provider | Dims | Index Time | Avg Search | Cost |
|----------|------|------------|------------|------|
| **Local WASM** | 384 | 87s | **8ms** | Free |
| **OpenAI** | 1536 | 106s | 202ms | $0.02/1M tok |
| **Perplexity** | 2560 | **66s** ⚡ | 168ms | $0.02/1M tok |
| **Perplexity Context** | 2560 | 78s | 135ms | $0.06/1M tok |

### Retrieval Quality

Tested with BrainBank's hybrid pipeline (Vector + BM25 → RRF):

| Benchmark | Metric | Score |
|-----------|--------|:-----:|
| **BEIR SciFact** (5,183 docs, 300 queries) | NDCG@10 | **0.761** |
| **Custom semantic** (127 docs, 20 queries) | R@5 | **83%** |

### Pipeline Progression

| Pipeline Stage | R@5 | Delta |
|----------------|:---:|-------|
| Vector-only (HNSW) | 57% | baseline |
| + BM25 (RRF fusion) | 78% | **+21pp** |
| + Qwen3 Reranker | 83% | **+5pp** |

> The hybrid pipeline improved R@5 by **+26pp over vector-only**, reducing misses from 6/20 to 1/20.

> [!WARNING]
> Switching embedding provider (e.g. local → OpenAI) changes vector dimensions. BrainBank will **refuse to initialize** if stored dimensions don't match. Use `initialize({ force: true })` and then `reembed()` to migrate.

---

## Reranker

BrainBank ships with an optional cross-encoder reranker using **Qwen3-Reranker-0.6B** via `node-llama-cpp`. Runs 100% locally — no API keys. **Disabled by default.**

```bash
npm install node-llama-cpp
```

### When to Use It

| Metric | Without Reranker | With Reranker |
|--------|-----------------|---------------|
| **Warm query** | ~480ms | ~5500ms |
| **Cold start** | ~7s | ~12s |
| **Memory** | — | +640MB (model) |
| **Quality** | Good (RRF) | Slightly better |

**Recommended:** Leave it disabled for interactive use (MCP, IDE). Enable for:

- Batch processing where latency doesn't matter
- Very large codebases (50k+ files) where false positives are costly
- Server environments with RAM to spare

### Enabling

```typescript
import { BrainBank, Qwen3Reranker } from 'brainbank';

const brain = new BrainBank({
  reranker: new Qwen3Reranker(),  // ~640MB model, auto-downloaded
});
```

```bash
# CLI
brainbank hsearch "auth middleware" --reranker qwen3
```

```jsonc
// .brainbank/config.json
{ "reranker": "qwen3" }
```

Model cached at `~/.cache/brainbank/models/`. Context size: 2048 tokens. Flash attention enabled with fallback.

### Position-Aware Score Blending

| Position | Retrieval (RRF) | Reranker | Rationale |
|----------|----------------|----------|----------|
| 1–3 | **75%** | 25% | Preserves exact keyword matches |
| 4–10 | **60%** | 40% | Balanced blend |
| 11+ | 40% | **60%** | Trust reranker for uncertain results |

### Custom Reranker

Implement the `Reranker` interface:

```typescript
import type { Reranker } from 'brainbank';

const myReranker: Reranker = {
  async rank(query: string, documents: string[]): Promise<number[]> {
    // Return relevance scores 0.0-1.0 for each document
  },
  async close() { /* optional cleanup */ },
};
```

---

## Re-embedding

When switching providers, use `reembed()` to regenerate vectors without re-indexing:

```typescript
const brain = new BrainBank({ embeddingProvider: new OpenAIEmbedding() });
await brain.initialize({ force: true });

const result = await brain.reembed({
  onProgress: (table, current, total) => console.log(`${table}: ${current}/${total}`),
});
// → { counts: { code: 1200, git: 500, docs: 80, kv: 45 }, total: 1825 }
```

```bash
brainbank reembed
```

| Full re-index | `reembed()` |
|---|---|
| Walks all files | **Skipped** |
| Parses git history | **Skipped** |
| Re-chunks documents | **Skipped** |
| Embeds text | ✓ |
| Replaces vectors | ✓ (atomic swap via temp table) |
| Rebuilds HNSW | ✓ |

---

## See Also

- [Configuration](config.md) — embedding keys in config.json
- [Indexing](indexing.md) — incremental indexing details
