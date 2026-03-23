# Chatbot with Deterministic Memory + Entity Graph

A CLI chatbot that **automatically** extracts memories and entities after every conversation turn — no function calling, no relying on the model to "remember" to save.

## Table of Contents

- [Structure](#structure)
- [Run](#run)
- [How It Works](#how-it-works)
- [Setup](#setup)
- [Example Session](#example-session)
- [Commands](#commands)
- [Real-Time Callbacks](#real-time-callbacks)
- [Framework Adapters](#framework-adapters)

## Structure

```
examples/chatbot/
├── lib/ui.ts            ← ANSI colors, readline, formatting (shared)
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

## How It Works

After every conversation turn, a **post-turn pipeline** runs automatically:

```
User message → LLM response (streaming)
                    │
        ┌── @brainbank/memory ──────────────┐
        │                                    │
        │  ① Extract facts + entities (LLM)  │
        │  ② Search existing memories         │
        │  ③ Dedup: ADD / UPDATE / NONE       │
        │  ④ Upsert entities + relationships  │
        │  ⑤ Execute operations               │
        └────────────────────────────────────┘
```

All steps use `gpt-4.1-nano` (cheapest model) — cost is negligible.

## Setup

Each chatbot variant initializes memory and entities like this:

```typescript
import { BrainBank } from 'brainbank';
import { Memory, EntityStore, OpenAIProvider } from '@brainbank/memory';

const brain = new BrainBank({ dbPath: './chatbot.db' });
await brain.initialize();

const llm = new OpenAIProvider({ model: 'gpt-4.1-nano' });

const entityStore = new EntityStore(brain, {
    onEntity: (op) => ui.entityEvent(op),  // real-time entity display
});

const memory = new Memory(brain, {
    llm,                                      // auto-shared with EntityStore
    entityStore,
    onOperation: (op) => ui.memoryOp(op.action, op.fact, op.reason),
});
```

> **Note:** Memory automatically shares its LLM with EntityStore for intelligent entity resolution (merging aliases like "TS" → "TypeScript").

## Example Session

```
Session 1:
  🆕 First session — no memories yet
  You → My name is Berna, I work at Pinecall
    💾 +memory: User's name is Berna
    💾 +memory: User works at Pinecall
    🔗 New entity: Berna (person)
    🔗 New entity: Pinecall (organization)
    ↔  Related: Berna → works_at → Pinecall

  You → Tell Juan to migrate payments to Stripe
    💾 +memory: Juan needs to migrate payments to Stripe
    🔗 New entity: Juan (person)
    🔗 New entity: Stripe (service)
    ↔  Related: Juan → migrating_to → Stripe

  entities
  🔗 4 entities:
     • Berna (person, 1x)
     • Pinecall (organization, 1x)
     • Juan (person, 1x)
     • Stripe (service, 1x)
  ↔  2 relationships:
     • Berna → works_at → Pinecall
     • Juan → migrating_to → Stripe

Session 2:
  💾 2 memories loaded
  🔗 4 entities, 2 relationships
  You → What do you know about our team?
  Bot → I know Berna works at Pinecall, and Juan is handling
        the migration to Stripe!
```

## Commands

| Command | Description |
|---------|-------------|
| `quit` | Exit the chatbot |
| `memories` | List all stored memories |
| `entities` | Show entity graph (entities + relationships) |

## Real-Time Callbacks

The chatbot uses two callbacks for real-time display:

**`onOperation`** — fired for each memory operation:
```typescript
onOperation: (op) => {
    // op.action: 'ADD' | 'UPDATE' | 'NONE'
    // op.fact: string
    // op.reason: string
}
```

**`onEntity`** — fired for each entity operation:
```typescript
onEntity: (op) => {
    // op.action: 'NEW' | 'UPDATED' | 'RELATED'
    // op.name: string — entity name
    // op.type?: string — entity type
    // op.detail?: string — relationship info
}
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
