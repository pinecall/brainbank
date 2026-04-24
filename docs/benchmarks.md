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
PERPLEXITY_API_KEY=pplx-... npx tsx test/benchmarks/rag/beir-eval.ts --dataset scifact

# Other supported datasets
PERPLEXITY_API_KEY=pplx-... npx tsx test/benchmarks/rag/beir-eval.ts --dataset nfcorpus
PERPLEXITY_API_KEY=pplx-... npx tsx test/benchmarks/rag/beir-eval.ts --dataset fiqa
```

---

## Custom RAG Evaluation (Semantic Document Retrieval)

A 20-query evaluation designed to measure the impact of each pipeline stage on retrieval quality. Tested on the [Pinecall.io](https://pinecall.io) internal documentation corpus (127 markdown files).

**Key constraint**: None of the queries contain keywords from document filenames or titles — this tests pure semantic understanding.

### Pipeline Progression

Shows the incremental impact of each technique BrainBank adds:

| Pipeline Stage | R@3 | R@5 | MRR | Misses | Delta |
|---|:---:|:---:|:---:|:---:|---|
| Vector-only (HNSW) | 45% | 57% | 0.54 | 6/20 | baseline |
| **+ BM25 (RRF fusion)** | 55% | 78% | 0.55 | 2/20 | **+21pp R@5** |

> The hybrid search pipeline improved R@5 by **+21 percentage points** over vector-only retrieval, reducing misses from 6 to 2.

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
| **OR-mode BM25** | Strips stop words, matches any keyword | Finds docs with specific terms that vector misses |
| **RRF fusion** | Merges vector + BM25 ranked lists | Docs appearing in both lists get boosted — R@5: 57% → 78% |
| **File-level dedup** | Keeps best-scoring chunk per file | Prevents one doc from eating multiple result slots |
| **BM25 title weight 10×** | Boosts title column in FTS5 | Doc titles are the strongest relevance signal |

---

## Head-to-Head: BrainBank vs QMD

[QMD](https://github.com/tobi/qmd) is a local-first markdown search engine that runs entirely on-device — embedding, query expansion, and reranking all via GGUF models. We benchmarked both engines on the same corpus and queries to compare cloud vs local retrieval quality.

> [!NOTE]
> These benchmarks were run when BrainBank still included an optional Qwen3 reranker (since removed). The reranker columns are preserved for historical reference. BrainBank's current pipeline terminates at RRF fusion.

### Setup

| | BrainBank | QMD |
|---|---|---|
| **Embeddings** | Perplexity Context (2560d, API) | embeddinggemma-300M (768d, local GGUF) |
| **Keyword** | FTS5 BM25 | FTS5 BM25 |
| **Fusion** | RRF (k=60) | RRF + query expansion (fine-tuned 1.7B) |
| **Reranker** | Qwen3-0.6B (optional) | Qwen3-0.6B (optional) |
| **Privacy** | Cloud API calls | 100% local |

### Results (69 docs, 20 semantic queries)

| Metric | BrainBank | BB + Reranker | QMD | QMD + Reranker |
|---|:---:|:---:|:---:|:---:|
| **R@3** | 55% | 63% | 43% | 53% |
| **R@5** | 78% | **83%** | 50% | 65% |
| **MRR** | 0.55 | **0.57** | 0.53 | 0.45 |
| **Misses** | 2/20 | **1/20** | 4/20 | 6/20 |

### Per-Category R@5

| Category | # | BrainBank + RR | QMD + RR |
|---|:---:|:---:|:---:|
| cross-doc | 5 | **70%** | 40% |
| semantic | 8 | **94%** | 81% |
| broad | 3 | 83% | **83%** |
| specific | 4 | **75%** | 50% |

> BrainBank wins overall (+18pp R@5), but QMD with reranker is competitive on semantic (81%) and broad (83%) categories — impressive for a fully local pipeline with no API calls.

### Key Insights

- **Embedding quality is the biggest differentiator** — Perplexity Context (2560d) vs embeddinggemma (768d) explains most of the gap on cross-doc and abstract queries
- **Query expansion helps but can't compensate** — QMD's fine-tuned 1.7B expansion model generates good `lex:/vec:/hyde:` variations, but the underlying embedding model limits recall
- **Reranker is the great equalizer** — boosted QMD's broad queries from 17% → 83% and overall R@5 from 50% → 65%
- **QMD wins on privacy** — zero data leaves the machine, zero API cost

---

## Test Environment

- **Embeddings**: Perplexity Context (`pplx-embed-v1`, 2560 dimensions)
- **Vector Index**: HNSW (hnswlib-node, in-memory)
- **Keyword Search**: FTS5 (SQLite built-in)
- **Fusion**: Reciprocal Rank Fusion (k=60)
- **Storage**: Single SQLite file (better-sqlite3)
- **Machine**: Apple Silicon (M-series)

---

## TODO

Planned benchmarks not yet implemented:

- [ ] **Code + graph evaluation** — measure retrieval improvement from import graph expansion and symbol cross-references
- [ ] BEIR full suite (MS MARCO, Natural Questions, HotpotQA)
- [ ] Large-scale stress test (50k+ files)

- [ ] Memory usage profiling (RAM vs chunk count)
- [ ] Collection search latency at scale (10k+ items)
- [ ] Incremental re-index speed (% of changed files)
- [ ] Embedding provider comparison on BEIR (Local vs OpenAI vs Perplexity)
