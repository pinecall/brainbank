# Chatbot with Deterministic Memory

A CLI chatbot that **automatically** extracts and stores memories after every conversation turn — no function calling, no relying on the model to "remember" to save.

### Structure

```
examples/chatbot/
├── ui.ts                ← ANSI colors, readline, formatting (shared)
├── chatbot.ts           ← OpenAI direct (default)
├── with-langchain.ts    ← LangChain integration
└── with-vercel-ai.ts    ← Vercel AI SDK integration
```

All variants use the same `ui.ts` helper and `@brainbank/memory` pipeline — only the LLM provider changes.

## Run

```bash
# OpenAI (default, zero extra deps)
OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts

# LangChain (install: npm i @langchain/openai)
OPENAI_API_KEY=sk-... npx tsx examples/chatbot/with-langchain.ts

# Vercel AI SDK (install: npm i ai @ai-sdk/openai — no Vercel key needed)
OPENAI_API_KEY=sk-... npx tsx examples/chatbot/with-vercel-ai.ts
```

## How it works

After every conversation turn, a **post-turn pipeline** runs automatically:

```
User message → LLM response (streaming)
                    │
        ┌── @brainbank/memory ──────────────┐
        │                                    │
        │  ① Extract facts + entities (LLM)  │
        │  ② Search existing memories         │
        │  ③ Dedup: ADD / UPDATE / NONE       │
        │  ④ Upsert entities (if enabled)     │
        │  ⑤ Execute operations               │
        └────────────────────────────────────┘
```

All steps use `gpt-4.1-nano` (cheapest model) — cost is negligible.

## Example Session

```
Session 1:
  🆕 First session — no memories yet
  You → My name is Berna, I prefer TypeScript
    💾 +memory: User's name is Berna
    💾 +memory: User prefers TypeScript

  You → I also like functional programming. We chose SQLite.
    ⏭  skip: functional programming (already captured)
    💾 +memory: Decided to use SQLite

Session 2:
  💾 3 memories loaded
     • User's name is Berna
     • User prefers TypeScript
     • Decided to use SQLite
  You → What do you know about me?
  Bot → You're Berna! You prefer TypeScript and functional programming,
        and you've chosen SQLite for your project.
```

## Framework Adapters

The `@brainbank/memory` package uses a simple `LLMProvider` interface:

```typescript
interface LLMProvider {
  generate(messages: ChatMessage[], options?: GenerateOptions): Promise<string>;
}
```

Each variant shows how to wrap a framework's LLM into this interface:

| File | Framework | Adapter pattern |
|------|-----------|-----------------|
| `chatbot.ts` | OpenAI (fetch) | Built-in `OpenAIProvider` |
| `with-langchain.ts` | LangChain | `ChatOpenAI.invoke()` → string |
| `with-vercel-ai.ts` | Vercel AI SDK | `generateText()` → string |
