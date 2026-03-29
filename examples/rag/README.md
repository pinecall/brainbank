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
