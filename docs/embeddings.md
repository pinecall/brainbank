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

BrainBank **auto-resolves** the embedding provider. Set it once → it's stored in the DB → every future run uses the same provider automatically.

```bash
# CLI: set on first index
brainbank index . --embedding openai        # stores provider_key=openai in DB
brainbank index .                            # auto-resolves openai from DB
brainbank hsearch "auth middleware"           # uses the same provider
```

```typescript
// Programmatic: pass to constructor
const brain = new BrainBank({
  repoPath: '.',
  embeddingProvider: new OpenAIEmbedding(),  // stored in DB on first index
});
```

**MCP** — zero-config. Reads the provider from the DB automatically.

> Priority on startup: explicit `embeddingProvider` in config > stored `provider_key` in DB > local WASM (default).

---

## Per-Plugin Override

Each plugin can use a different embedding provider:

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

> Each plugin creates its own HNSW index with the correct dimensions.

---

## Provider Details

### Local (Default)

Built-in, zero config, runs via WASM:

```typescript
// No import needed — it's the default
const brain = new BrainBank({ repoPath: '.' });
```

### OpenAI

```typescript
import { OpenAIEmbedding } from 'brainbank';

new OpenAIEmbedding();                        // uses OPENAI_API_KEY env var
new OpenAIEmbedding({
  model: 'text-embedding-3-large',
  dims: 512,                                  // Matryoshka reduction
  apiKey: 'sk-...',
  baseUrl: 'https://my-proxy.com/v1/embeddings',
});
```

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

- **Fastest indexing:** Perplexity standard — 38% faster than OpenAI
- **Fastest search (API):** Perplexity Context — 33% faster than OpenAI
- **Fastest search (total):** Local WASM — no network latency
- **Best context awareness:** Perplexity Context — finds semantically related chunks others miss

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

### BrainBank vs QMD

Compared against [QMD](https://github.com/tobi/qmd) (embeddinggemma 768d + query expansion). Same corpus, same 20 queries:

| Metric | BrainBank | QMD |
|--------|:---------:|:---:|
| **R@5** | **83%** | 65% |
| **R@3** | **63%** | 53% |
| **MRR** | **0.57** | 0.45 |
| **Misses** | **1/20** | 6/20 |

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

Model cached at `~/.cache/brainbank/models/`.

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
// → { code: 1200, git: 500, docs: 80, kv: 45, total: 1837 }
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
| Replaces vectors | ✓ |
| Rebuilds HNSW | ✓ |

---

## See Also

- [Configuration](config.md) — embedding keys in config.json
- [Indexing](indexing.md) — incremental indexing details
