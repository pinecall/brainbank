# @brainbank/memory

Deterministic memory extraction and deduplication for LLM conversations. Inspired by [mem0](https://github.com/mem0ai/mem0)'s pipeline.

After every conversation turn, automatically:

1. **Extract** atomic facts via LLM call
2. **Search** existing memories for duplicates
3. **Decide** ADD / UPDATE / NONE per fact
4. **Execute** the operations

No function calling. No relying on the model to "remember" to save.

## Install

```bash
npm install @brainbank/memory
```

## Quick Start

```typescript
import { BrainBank } from 'brainbank';
import { Memory, OpenAIProvider } from '@brainbank/memory';

const brain = new BrainBank({ dbPath: './memory.db' });
await brain.initialize();

const memory = new Memory(brain.collection('memories'), {
  llm: new OpenAIProvider({ model: 'gpt-4.1-nano' }),
});

// After every conversation turn — deterministic, automatic
const ops = await memory.process(
  'My name is Berna, I prefer TypeScript',
  'Nice to meet you Berna!'
);
// ops → [
//   { fact: "User's name is Berna", action: "ADD", reason: "no similar memories" },
//   { fact: "User prefers TypeScript", action: "ADD", reason: "no similar memories" }
// ]

// Next turn — dedup kicks in
await memory.process(
  'I like TypeScript a lot',
  'TypeScript is great!'
);
// → [{ fact: "User likes TypeScript", action: "NONE", reason: "already captured" }]

// Build system prompt context
const context = memory.buildContext();
// → "## Memories\n- User's name is Berna\n- User prefers TypeScript"

// Semantic search
const results = await memory.search('what language does user prefer');
```

## Framework Integration

The `LLMProvider` interface is framework-agnostic. Bring your own LLM:

### LangChain

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { Memory } from '@brainbank/memory';
import type { LLMProvider } from '@brainbank/memory';

const model = new ChatOpenAI({ model: 'gpt-4.1-nano' });

const llm: LLMProvider = {
  generate: async (messages, opts) => {
    const res = await model.invoke(messages);
    return res.content as string;
  }
};

const memory = new Memory(store, { llm });
```

### Vercel AI SDK

```typescript
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { Memory } from '@brainbank/memory';
import type { LLMProvider } from '@brainbank/memory';

const llm: LLMProvider = {
  generate: async (messages) => {
    const { text } = await generateText({
      model: openai('gpt-4.1-nano'),
      messages,
    });
    return text;
  }
};

const memory = new Memory(store, { llm });
```

### Anthropic / Other Providers

```typescript
const llm: LLMProvider = {
  generate: async (messages) => {
    // Call any LLM API that takes messages and returns a string
    const response = await yourLLMClient.chat(messages);
    return response.text;
  }
};
```

## Custom Storage

The `MemoryStore` interface matches BrainBank collections, but you can implement your own:

```typescript
import type { MemoryStore } from '@brainbank/memory';

const store: MemoryStore = {
  add: async (content, opts) => { /* store in your DB */ },
  search: async (query, opts) => { /* semantic search */ },
  list: (opts) => { /* return recent items */ },
  remove: async (id) => { /* delete by ID */ },
  count: () => { /* return total */ },
};

const memory = new Memory(store, { llm });
```

## Options

```typescript
new Memory(store, {
  llm: provider,            // required — LLM provider
  maxFacts: 5,              // max facts to extract per turn (default: 5)
  maxMemories: 50,          // max existing memories to load for dedup (default: 50)
  dedupTopK: 3,             // similar memories to compare against (default: 3)
  extractPrompt: '...',     // custom extraction prompt
  dedupPrompt: '...',       // custom dedup prompt
  onOperation: (op) => {    // callback for each operation
    console.log(`${op.action}: ${op.fact}`);
  },
});
```

## API

| Method | Description |
|--------|-------------|
| `process(userMsg, assistantMsg)` | Run the full pipeline: extract → dedup → execute. Returns `MemoryOperation[]` |
| `search(query, k?)` | Semantic search across memories |
| `recall(limit?)` | Get all memories (for system prompt injection) |
| `count()` | Total stored memories |
| `buildContext(limit?)` | Build a markdown section for system prompt injection |

## How it works

```
User message + Assistant response
          │
          ▼
  ┌─── Extract (LLM) ───┐
  │ "User's name is X"   │
  │ "Prefers TypeScript"  │
  └──────────┬───────────┘
             │ for each fact:
             ▼
  ┌─── Search (semantic) ─┐
  │ Find similar existing  │
  │ memories (top-K)       │
  └──────────┬────────────┘
             │
             ▼
  ┌─── Dedup (LLM) ──────┐
  │ Compare new vs existing│
  │ → ADD / UPDATE / NONE  │
  └──────────┬────────────┘
             │
     ┌───────┼───────┐
     ▼       ▼       ▼
    ADD   UPDATE   NONE
  (store) (replace) (skip)
```

## License

MIT
