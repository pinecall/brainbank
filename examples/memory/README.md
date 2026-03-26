# Memory Example

Interactive chatbot with **automatic long-term memory**: extracts facts and entities from every conversation turn.

## Run

```bash
# Default (native OpenAI fetch)
OPENAI_API_KEY=sk-... npx tsx examples/memory/memory.ts

# Vercel AI SDK
OPENAI_API_KEY=sk-... npx tsx examples/memory/memory.ts --llm vercel

# LangChain
OPENAI_API_KEY=sk-... npx tsx examples/memory/memory.ts --llm langchain
```

## Commands

| Command | Description |
|---------|-------------|
| `quit` | Exit |
| `memories` | List stored memories |
| `entities` | Show entity graph |
