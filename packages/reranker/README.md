# @brainbank/reranker

Local cross-encoder reranker plugin for [BrainBank](https://github.com/pinecall/brainbank). Runs **Qwen3-Reranker-0.6B** on-device via `node-llama-cpp` — no API keys, no network calls.

## Why rerank?

Vector search returns results by embedding similarity, but embeddings can miss nuance. A cross-encoder reads the **query + document together** and scores relevance directly — typically improving precision by 15–30% on code search.

```
Without reranker:  query → vector search → results (good)
With reranker:     query → vector search → rerank top-K → results (better)
```

## Install

```bash
npm install @brainbank/reranker node-llama-cpp
```

> `node-llama-cpp` is a peer dependency. The GGUF model (~640MB) auto-downloads on first use and is cached at `~/.cache/brainbank/models/`.

## Usage

### With the CLI

```bash
brainbank hsearch "auth middleware" --reranker qwen3
```

### Programmatic

```typescript
import { BrainBank } from 'brainbank';
import { code } from 'brainbank/code';
import { Qwen3Reranker } from '@brainbank/reranker';

const brain = new BrainBank({ repoPath: '.' })
  .use(code());

await brain.initialize();

const reranker = new Qwen3Reranker();

const results = await brain.hybridSearch('authentication guard', {
  reranker,
  maxResults: 10,
});

// Done? Release the model from memory
await reranker.close();
```

### Options

```typescript
new Qwen3Reranker({
  modelUri: 'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/...', // custom model
  cacheDir: '~/.cache/brainbank/models/',                       // cache location
  contextSize: 2048,                                            // context window
});
```

## How it works

1. **Lazy loading** — model loads on first `rank()` call, not at import
2. **Flash attention** — 20× less VRAM than standard attention
3. **Deduplication** — identical documents scored once
4. **Truncation** — oversized documents are truncated by the tokenizer, not naively cut

## Requirements

- Node.js ≥ 18
- ~640MB disk for the model (auto-downloaded)
- Works on macOS (Metal), Linux (CUDA/CPU), Windows (CPU)

## License

MIT
