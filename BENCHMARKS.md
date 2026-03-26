# BrainBank Benchmarks

Retrieval quality benchmarks for BrainBank's hybrid search pipeline.

All tests run with **Perplexity Context Embeddings** (`pplx-embed-v1`, 2560d) stored in a single SQLite file — no external vector database, no Elasticsearch, no Docker.

---

## BEIR Standard Benchmark

[BEIR](https://github.com/beir-cellar/beir) is the industry-standard benchmark for evaluating information retrieval systems, measuring **NDCG@10** across diverse retrieval tasks.

### SciFact (Fact Verification)

- **Corpus**: 5,183 scientific abstracts  
- **Queries**: 300 expert-written scientific claims  
- **Task**: Find abstracts that support or refute each claim

| Metric | BrainBank (Hybrid) | BM25 Baseline |
|---|:---:|:---:|
| **NDCG@10** | **0.761** | 0.665 |
| **Recall@10** | **0.879** | — |
| **MRR** | **0.732** | — |

> BrainBank's hybrid pipeline (Vector + BM25 → RRF) scores **+9.6pp above BM25** on SciFact using Perplexity Context embeddings.

### How to Reproduce

```bash
# SciFact (~13 min indexing, ~45s search)
PERPLEXITY_API_KEY=pplx-... npx tsx examples/rag/beir-eval.ts --dataset scifact

# With Qwen3 reranker (downloads ~640MB model on first run)
PERPLEXITY_API_KEY=pplx-... npx tsx examples/rag/beir-eval.ts --dataset scifact --reranker

# Other supported datasets
PERPLEXITY_API_KEY=pplx-... npx tsx examples/rag/beir-eval.ts --dataset nfcorpus
PERPLEXITY_API_KEY=pplx-... npx tsx examples/rag/beir-eval.ts --dataset fiqa
```

---

## Custom RAG Evaluation (Semantic Document Retrieval)

A 20-query evaluation designed to measure the impact of each pipeline stage on retrieval quality. Tested on a real-world documentation corpus (127 markdown files from a production healthcare SaaS platform).

**Key constraint**: None of the queries contain keywords from document filenames or titles — this tests pure semantic understanding.

### Pipeline Progression

Shows the incremental impact of each technique BrainBank adds:

| Pipeline Stage | R@3 | R@5 | MRR | Misses | Delta |
|---|:---:|:---:|:---:|:---:|---|
| Vector-only (HNSW) | 45% | 57% | 0.54 | 6/20 | baseline |
| **+ BM25 (RRF fusion)** | 55% | 78% | 0.55 | 2/20 | **+21pp R@5** |
| **+ Qwen3 Reranker** | 63% | 83% | 0.57 | 1/20 | **+5pp R@5** |

> The hybrid search pipeline improved R@5 by **+26 percentage points** over vector-only retrieval, reducing misses from 6 to 1.

### Per-Category Breakdown (Full Pipeline)

| Category | # | R@3 | R@5 | MRR | What it tests |
|---|:-:|:---:|:---:|:---:|---|
| cross-doc | 5 | 50% | 70% | 0.57 | Queries spanning multiple documents |
| semantic | 8 | 75% | **94%** | 0.66 | Paraphrased, zero keyword overlap |
| broad | 3 | 67% | 83% | 0.51 | System-level overview queries |
| specific | 4 | 50% | 75% | 0.42 | Edge cases, niche terminology |
| **Overall** | **20** | **63%** | **83%** | **0.57** | |

### What Each Technique Contributes

| Technique | What it does | Measured Impact |
|---|---|---|
| **OR-mode BM25** | Strips stop words, matches any keyword | Finds docs with specific terms (Swagger, SONARQUBE) that vector misses |
| **RRF fusion** | Merges vector + BM25 ranked lists | Docs appearing in both lists get boosted — R@5: 57% → 78% |
| **File-level dedup** | Keeps best-scoring chunk per file | Prevents one doc from eating multiple result slots |
| **BM25 title weight 10×** | Boosts title column in FTS5 | Doc titles are the strongest relevance signal |
| **Qwen3 Reranker** | Cross-encoder rescoring on top-k | Promotes semantically relevant docs — R@5: 78% → 83% |

### How to Reproduce

```bash
# Custom eval on your own docs
PERPLEXITY_API_KEY=pplx-... npx tsx examples/rag/eval.ts --docs ~/path/to/docs

# With Qwen3 reranker
PERPLEXITY_API_KEY=pplx-... npx tsx examples/rag/eval.ts --docs ~/path/to/docs --reranker
```

---

## Test Environment

- **Embeddings**: Perplexity Context (`pplx-embed-v1`, 2560 dimensions)
- **Reranker**: Qwen3-Reranker-0.6B (Q8_0 GGUF, ~640MB, local via node-llama-cpp)
- **Vector Index**: HNSW (hnswlib-node, in-memory)
- **Keyword Search**: FTS5 (SQLite built-in)
- **Fusion**: Reciprocal Rank Fusion (k=60)
- **Storage**: Single SQLite file (better-sqlite3)
- **Machine**: Apple Silicon (M-series)

---

*Last updated: March 2026*
