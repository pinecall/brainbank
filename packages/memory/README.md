# @brainbank/memory

Deterministic memory extraction, deduplication, and entity graph for LLM conversations. Framework-agnostic — works with any LLM provider.

After every conversation turn, automatically:

1. **Extract** atomic facts + entities + relationships via LLM call
2. **Search** existing memories for duplicates
3. **Decide** ADD / UPDATE / NONE per fact
4. **Upsert** entities and relationships into the knowledge graph
5. **Execute** the operations

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
const result = await memory.process(
  'My name is Berna, I prefer TypeScript',
  'Nice to meet you Berna!'
);
// result.operations → [
//   { fact: "User's name is Berna", action: "ADD", reason: "no similar memories" },
//   { fact: "User prefers TypeScript", action: "ADD", reason: "no similar memories" }
// ]

// Next turn — dedup kicks in
await memory.process(
  'I like TypeScript a lot',
  'TypeScript is great!'
);
// → operations: [{ fact: "User likes TypeScript", action: "NONE", reason: "already captured" }]

// Build system prompt context
const context = memory.buildContext();
// → "## Memories\n- User's name is Berna\n- User prefers TypeScript"

// Semantic search
const results = await memory.search('what language does user prefer');
```

## Entity Extraction (Knowledge Graph)

Opt-in entity and relationship extraction from the same LLM call — zero extra cost:

```typescript
import { Memory, EntityStore, OpenAIProvider } from '@brainbank/memory';

const entityStore = new EntityStore({
  entityCollection: brain.collection('entities'),
  relationCollection: brain.collection('relationships'),
});

const memory = new Memory(brain.collection('memories'), {
  llm: new OpenAIProvider({ model: 'gpt-4.1-nano' }),
  entityStore,  // opt-in — omit for facts-only mode
});

// Process extracts facts + entities + relationships in one LLM call
const result = await memory.process(
  'Tell Juan to migrate payments to Stripe before Friday',
  "I'll let Juan know about the Stripe migration deadline."
);
// result.operations → [{ fact: "deadline for Stripe migration is Friday", action: "ADD" }]
// result.entities   → { entitiesProcessed: 2, relationshipsProcessed: 1 }

// Query entities
const related = await entityStore.getRelated('Juan');
// → [{ source: "Juan", target: "Stripe", relation: "migrating_to" }]

// Build context includes entities
const context = memory.buildContext();
// → "## Memories\n- ...\n\n## Known Entities\n- Juan (person, 2x)\n- Stripe (service, 1x)\n\n## Relationships\n- Juan → migrating_to → Stripe"
```

### EntityStore API

| Method | Description |
|--------|-------------|
| `upsert(entity)` | Add or update entity (increments mention count) |
| `relate(source, target, relation, context?)` | Add a relationship |
| `findEntity(name)` | Search entities by name |
| `getRelated(entityName)` | Get all relationships for an entity |
| `listEntities()` | List all entities |
| `listRelationships()` | List all relationships |
| `entityCount()` | Total entity count |
| `relationCount()` | Total relationship count |
| `buildContext(entityName?)` | Build markdown context (all or specific entity) |
| `processExtraction(entities, relationships)` | Batch process from LLM response |

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
  entityStore: entityStore,  // optional — enables entity extraction
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
| `process(userMsg, assistantMsg)` | Full pipeline: extract → dedup → execute. Returns `ProcessResult` |
| `search(query, k?)` | Semantic search across memories |
| `recall(limit?)` | Get all memories (for system prompt injection) |
| `count()` | Total stored memories |
| `buildContext(limit?)` | Build markdown context (memories + entities if enabled) |
| `getEntityStore()` | Get the entity store instance (if enabled) |

## How it works

```
User message + Assistant response
          │
          ▼
  ┌─── Extract (LLM) ──────────┐
  │ Facts:                      │
  │  "User's name is X"         │
  │  "Prefers TypeScript"       │
  │ Entities:                   │
  │  X (person), TypeScript     │
  │ Relationships:              │
  │  X → prefers → TypeScript   │
  └──────────┬──────────────────┘
             │
     ┌───────┴───────┐
     ▼               ▼
  Facts           Entities
     │               │
     ▼               ▼
  ┌─ Dedup ──┐   ┌─ Upsert ─┐
  │ ADD      │   │ name     │
  │ UPDATE   │   │ type     │
  │ NONE     │   │ mentions │
  └──────────┘   │ relate   │
                 └──────────┘
```

## License

MIT
