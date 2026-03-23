# BrainBank Examples

Runnable examples demonstrating BrainBank's capabilities.

## Chatbot with Persistent Memory

A CLI chatbot that remembers conversations across sessions using a **hybrid memory strategy**:

1. **Context injection** — recent session summaries loaded into the system prompt at startup
2. **Function calling** — the model autonomously decides when to search/save memories via `recall_memory` and `save_fact` tools

### Features

- 🎨 ANSI colors (zero dependencies)
- ⚡ Streaming responses (SSE)
- 🔧 Tool calls displayed in real-time
- 💾 Auto-summarizes session on exit
- 🧠 Semantic search across all past sessions

### Run

```bash
OPENAI_API_KEY=sk-... npx tsx examples/chatbot.ts
```

### Architecture

```
┌─────────────────────────────────────────────────┐
│  System Prompt                                   │
│  ┌─────────────────────────────────────────┐    │
│  │ Recent session summaries (context injection)│    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  User message → GPT-4.1-nano                     │
│                    │                             │
│           ┌───────┴───────┐                     │
│           ▼               ▼                     │
│    recall_memory()   save_fact()                 │
│    (semantic search)  (persist to DB)            │
│           │               │                     │
│           ▼               ▼                     │
│       BrainBank Collections (SQLite)             │
│       ├── sessions (conversation summaries)      │
│       └── facts (user preferences, knowledge)   │
└─────────────────────────────────────────────────┘
```

### Memory Strategy Explained

The chatbot combines two established patterns from the LLM memory literature:

| Strategy | When | What |
|----------|------|------|
| **Context injection** | At startup | Last 5 session summaries → system prompt. Gives the model immediate access to recent context without a tool call. |
| **Function calling** | During chat | Model calls `recall_memory(query)` when it needs deeper context, or `save_fact(content)` when the user shares something worth remembering. |

**Why hybrid?**

- **Pure context injection** doesn't scale — 100 sessions won't fit in a prompt
- **Pure tool calling** misses recent context — the model might not search for what it should already know
- **Hybrid** gives the best of both: recent context is always available, older/deeper memories are searchable on demand

### Example Session

```
Session 1:
  🆕 First session — no memories yet
  You → Remember that I prefer functional programming and my name is Alex
    🔧 save_fact("Alex prefers functional programming") → Saved
    🔧 save_fact("User's name is Alex") → Saved
  Bot → Got it! I'll remember that, Alex.
  quit → 💾 Session saved

Session 2:
  💾 1 session(s), 2 fact(s) in memory
  You → What do you know about me?
    🔧 recall_memory("user preferences", facts) → score: 1.00
  Bot → You're Alex, and you prefer functional programming patterns!
```

---

## Collections Demo

Demonstrates BrainBank's dynamic key-value collections with semantic search:

- Creating collections (`decisions`, `investigations`)
- Storing rich content with tags and metadata
- Semantic search (find by meaning, not keywords)
- Metadata linking (connect decisions to files)
- Management operations (list, count, filter by tags)

### Run

```bash
npx tsx examples/collections.ts
```

### Expected output

```
── Search ──
  "why not postgres" → Use SQLite with WAL mode instead of PostgreSQL... (1.00)
  "express performance" → Migrate API from Express to Fastify... (1.00)
  "empty search results" → HNSW index empty after reembed... (1.00)

── Linked data ──
  Decision: Migrate API from Express to Fastify...
  Files: src/api/server.ts

── Collections ──
  Names: decisions, investigations
  Decisions: 2, Investigations: 1
  Tagged 'architecture': 2 items

✓ Done
```

---

## Creating Your Own Example

BrainBank examples follow a simple pattern:

```typescript
import { BrainBank } from '../src/index.ts';

const brain = new BrainBank({ dbPath: '/tmp/my-example.db' });
await brain.initialize();

const myCollection = brain.collection('my_data');
await myCollection.add('content to store', { tags: ['example'] });

const results = await myCollection.search('semantic query');
console.log(results);

await brain.close();
```

## License

MIT
