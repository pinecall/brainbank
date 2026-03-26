# RAG Benchmarks

Evaluate BrainBank retrieval quality with your own docs or standard IR datasets.

## Custom Dataset Eval

Test retrieval against YOUR documentation with hand-picked golden queries:

```bash
PERPLEXITY_API_KEY=pplx-... npx tsx test/benchmarks/rag/eval.ts --docs ~/path/to/docs
```

### Flags

| Flag | Description |
|---|---|
| `--docs <path>` | Path to markdown docs folder (required) |
| `--reranker` | Enable Qwen3 reranker (downloads 640MB model on first use) |

### What it measures

- **R@3 / R@5** — Recall at rank 3/5 (did the expected doc appear?)
- **MRR** — Mean Reciprocal Rank (how high did the first hit rank?)
- **Per-category breakdown** — cross-doc, semantic, broad, specific

### Customizing queries

Edit the `GOLDEN` array in `eval.ts` to match your docs. Each entry needs:
- `query` — natural language question
- `expectedFiles` — substring matches against file paths
- `category` — grouping label

## BEIR Standard Benchmark

Industry-standard IR benchmark (same as OpenAI, Cohere, Voyage use):

```bash
PERPLEXITY_API_KEY=pplx-... npx tsx test/benchmarks/rag/beir-eval.ts --dataset scifact
```

### Datasets

| Dataset | Docs | Queries | BM25 Baseline |
|---|---|---|---|
| `scifact` | 5.2k | 300 | 0.665 |
| `nfcorpus` | 3.6k | 323 | 0.325 |
| `fiqa` | 57k | 648 | 0.236 |

### What it measures

- **NDCG@10** — how well results are ranked (the gold standard IR metric)
- **Recall@10** — coverage of relevant docs
- **MRR** — first relevant result position

Datasets are downloaded and cached at `/tmp/beir-cache/`.
