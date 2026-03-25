# AGENTS.md — @brainbank/memory

Deterministic memory extraction and deduplication for LLM conversations.
Standalone package — `brainbank` core is an optional peer dependency.

## Commands

- Build: `npx tsup` (from this directory)
- Tests: run from root with `npm test -- --filter memory`

## Architecture

```
src/
├── memory.ts    ← Memory class: process() extracts facts, buildContext() for prompts
├── entities.ts  ← EntityStore: entity/relationship graph with traversal
├── llm.ts       ← LLMProvider interface + built-in OpenAIProvider
├── prompts.ts   ← System prompts for extraction and dedup
└── index.ts     ← Public API barrel
```

- `Memory.process(userMsg, assistantMsg)` → extracts facts via LLM, deduplicates against existing
- `EntityStore` is optional — tracks entities and relationships mentioned in conversations
- Works with any LLM: implement `{ generate(messages) → string }`

## Code Style

- Imports use `.js` extensions (NOT `.ts`) — this package builds independently
- No direct dependency on `brainbank` core — uses it optionally for persistence

## Gotchas

- LLM calls are made during `process()` — costs money if using OpenAI
- The extraction prompt in `prompts.ts` is carefully tuned — small changes cause regressions
