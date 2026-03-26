# RAG Example

**Docs-augmented chatbot** using [Perplexity Context Embeddings](https://docs.perplexity.ai/api-reference/embeddings) + memory + entities.

## Run

```bash
# Default (native OpenAI fetch)
OPENAI_API_KEY=sk-... PERPLEXITY_API_KEY=pplx-... \
  npx tsx examples/rag/rag.ts --docs ~/path/to/docs

# With Vercel AI SDK
OPENAI_API_KEY=sk-... PERPLEXITY_API_KEY=pplx-... \
  npx tsx examples/rag/rag.ts --docs ~/path/to/docs --llm vercel

# With LangChain
OPENAI_API_KEY=sk-... PERPLEXITY_API_KEY=pplx-... \
  npx tsx examples/rag/rag.ts --docs ~/path/to/docs --llm langchain
```

## Commands

| Command | Description |
|---------|-------------|
| `quit` | Exit |
| `memories` | List stored memories |
| `entities` | Show entity graph |
| `docs <query>` | Search docs + generate answer |
| *(any text)* | Chat with RAG context injected |

## RAG Evaluator

Measure retrieval quality over a golden dataset:

```bash
PERPLEXITY_API_KEY=pplx-... npx tsx examples/rag/eval.ts --docs ~/path/to/docs
```

Output: Recall@3, Recall@5, MRR per category with miss analysis.
