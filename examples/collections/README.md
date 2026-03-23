# Collections Demo

Demonstrates BrainBank's dynamic key-value collections — the building block for agent memory.

## Run

```bash
npx tsx examples/collections/collections.ts
```

## What it shows

| Feature | Description |
|---------|-------------|
| **Creating collections** | `brain.collection('decisions')` — any name, created on-the-fly |
| **Semantic search** | `decisions.search('why not postgres')` — finds by meaning, not keywords |
| **Tags** | `{ tags: ['architecture'] }` — filter results by category |
| **Metadata linking** | `{ metadata: { files: ['src/api/server.ts'] } }` — connect memories to code |
| **TTL** | `{ ttl: '30d' }` — auto-expire entries after 30 days |
| **Management** | `list()`, `count()`, `trim()`, `prune()` |

## How collections work

```
brain.collection('decisions')
  │
  ├── .add(content, { tags, metadata, ttl })   ← store (auto-embedded)
  ├── .search(query, { k })                     ← semantic search
  ├── .list({ limit, tags })                    ← browse / filter
  ├── .count()                                  ← total items
  ├── .trim({ keep: N })                        ← keep N most recent
  └── .prune({ olderThan: '30d' })              ← remove expired
```

Collections are backed by BrainBank's SQLite database. Each `add()` automatically generates an embedding vector, so `search()` finds results by semantic similarity — not just keyword matching.

## Expected output

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

## Use cases

- **Conversation memory** — store summaries of past sessions for an AI agent
- **Architecture Decision Records** — track design decisions so the agent stays consistent
- **Error investigation journal** — log debugging sessions, find past solutions by symptom
- **User preferences** — remember facts the user shares across sessions
