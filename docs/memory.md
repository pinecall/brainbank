# Memory

BrainBank has two memory systems for different use cases.

---

## Agent Memory (Patterns)

Built into the core `brainbank` package. Records what worked (and what didn't) across tasks, then distills patterns into reusable strategies.

```typescript
import { BrainBank, memory } from 'brainbank';

const brain = new BrainBank({ repoPath: '.' });
brain.use(memory());
await brain.initialize();

const mem = brain.plugin('memory');

// Record a learning pattern
await mem.learn({
  taskType: 'refactor',
  task: 'Extract auth logic into middleware',
  approach: 'Created Express middleware, moved JWT validation from routes',
  outcome: 'Reduced route handler size by 60%, improved testability',
  successRate: 0.95,
  critique: 'Should have added integration tests before refactoring',
});

// Search for similar patterns before starting a new task
const patterns = await mem.search('refactor database queries');

// Consolidate: prune old failures + merge duplicates
const { pruned, deduped } = mem.consolidate();

// Distill top patterns into a strategy
const strategy = mem.distill('refactor');
```

### How It Works

1. **Learn** — Records task, approach, outcome, and success rate. Embeds for semantic search.
2. **Search** — Finds similar successful patterns (filters by `successRate ≥ 0.5`).
3. **Consolidate** — Auto-runs every 50 patterns: prunes failures older than 90 days, deduplicates (cosine > 0.95).
4. **Distill** — Aggregates top patterns per task type into a single strategy text with confidence score.

---

## @brainbank/memory — Conversational Memory

A separate package that adds **deterministic memory extraction** to any LLM conversation. After every turn, it extracts facts, deduplicates against existing memories, and decides `ADD` / `UPDATE` / `NONE` — no function calling needed.

```bash
npm install @brainbank/memory
```

```typescript
import { BrainBank } from 'brainbank';
import { Memory, EntityStore, OpenAIProvider } from '@brainbank/memory';

const brain = new BrainBank({ dbPath: './memory.db' });
await brain.initialize();

const llm = new OpenAIProvider({ model: 'gpt-4.1-nano' });

// Opt-in entity extraction (knowledge graph)
const entityStore = new EntityStore(brain);

const memory = new Memory(brain, {
  llm,
  entityStore,
  onOperation: (op) => console.log(`${op.action}: ${op.fact}`),
});

// After every conversation turn
const result = await memory.process(userMessage, assistantResponse);
// result.operations → [{ fact, action: "ADD", reason }]
// result.entities   → { entitiesProcessed: 2, relationshipsProcessed: 1 }

// Build system prompt context
const context = memory.buildContext();
// → "## Memories\n- User's name is Berna\n\n## Known Entities\n- Berna (person, 3x)..."
```

### Features

- **Fact extraction** — atomic facts from every conversation turn
- **Deduplication** — semantic similarity + LLM decision (`ADD` / `UPDATE` / `NONE`)
- **Entity graph** — entities + relationships extracted from the same LLM call (zero extra cost)
- **LLM entity resolution** — merges aliases ("TS" → "TypeScript")
- **Framework-agnostic** — works with OpenAI, LangChain, Vercel AI SDK, or any LLM

### LLM Provider Support

| Framework | Adapter |
|-----------|--------|
| OpenAI | Built-in `OpenAIProvider` |
| LangChain | `ChatOpenAI.invoke()` → string |
| Vercel AI SDK | `generateText()` → string |
| Any LLM | Implement `{ generate(messages) → string }` |

> 📂 See [examples/memory](../examples/memory/) for a runnable demo.

> 📦 Full API docs: [packages/memory/README.md](../packages/memory/README.md)

---

## See Also

- [Collections](collections.md) — the KV store primitive both memory systems use
- [Custom Plugins](custom-plugins.md) — build agent memory plugins
- [MCP Server](mcp.md) — agent integration via MCP tools
