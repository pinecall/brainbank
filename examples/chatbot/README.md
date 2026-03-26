# Chatbot Examples

Interactive chatbot demos showcasing BrainBank's memory and RAG capabilities.

## Features

- **Long-term memory** — automatic fact extraction after every turn (`@brainbank/memory`)
- **Entity graph** — extracts entities and relationships from conversations
- **Docs RAG** — (optional) index a docs folder and answer questions from it
- **Streaming** — real-time response streaming

## Variants

| File | LLM Integration | Dependencies |
|------|----------------|--------------|
| `chatbot.ts` | OpenAI API (direct fetch) | None |
| `with-vercel-ai.ts` | Vercel AI SDK | `ai`, `@ai-sdk/openai` |
| `with-langchain.ts` | LangChain | `@langchain/openai` |

All three variants support the same commands and features.

## Usage

### Memory only

```bash
OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts
```

### Memory + Docs RAG

```bash
OPENAI_API_KEY=sk-... \
PERPLEXITY_API_KEY=pplx-... \
npx tsx examples/chatbot/chatbot.ts --docs ~/path/to/your/docs
```

The `--docs` flag indexes all `.md` files in the folder using **Perplexity Contextualized Embeddings** for high-quality document retrieval. The chatbot then includes relevant docs in its system prompt for every response.

> You can also set `BRAINBANK_DOCS=/path/to/docs` env var instead of `--docs`.

## Commands

| Command | Description |
|---------|-------------|
| `quit` | Exit the chatbot |
| `memories` | List all stored memories |
| `entities` | Show entity graph |
| `docs <query>` | Search indexed docs directly |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Always | OpenAI API key for chat + memory extraction |
| `PERPLEXITY_API_KEY` | With `--docs` | Perplexity API key for docs embeddings |
| `BRAINBANK_DOCS` | Optional | Default docs path (alternative to `--docs`) |
