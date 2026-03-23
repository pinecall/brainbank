# Chatbot with Deterministic Memory

A CLI chatbot that **automatically** extracts and stores memories after every conversation turn — no function calling, no relying on the model to "remember" to save.

Inspired by [mem0](https://github.com/mem0ai/mem0)'s deterministic memory pipeline.

## Run

```bash
OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts
```

## How it works

After every conversation turn, a **post-turn memory pipeline** runs automatically:

```
User message → LLM response (streaming)
                    │
                    ▼
        ┌── Memory Pipeline (runs every turn) ──┐
        │                                        │
        │  ① Extract atomic facts (LLM call)     │
        │     → ["Name is Berna", "Uses SQLite"]  │
        │                                        │
        │  ② Search existing memories (semantic)  │
        │     → find similar stored facts         │
        │                                        │
        │  ③ Deduplicate (LLM call)               │
        │     → ADD / UPDATE / NONE per fact      │
        │                                        │
        │  ④ Execute operations on BrainBank      │
        └────────────────────────────────────────┘
```

All 3 steps use `gpt-4.1-nano` (cheapest model) — extraction cost is negligible.

## Why not function calling?

| Approach | Problem |
|----------|---------|
| **Function calling** (`save_fact`) | Model decides *if* to save — it can forget, skip, or save the wrong thing |
| **Deterministic pipeline** (this) | Extraction runs on *every turn* — nothing gets missed |

The model never needs to decide what to save. A dedicated extraction prompt handles it.

## Deduplication

The pipeline doesn't blindly add facts. For each extracted fact, it:

1. **Searches** existing memories for similar entries
2. **Compares** the new fact with matches
3. **Decides**: `ADD` (new info), `UPDATE` (refine existing), or `NONE` (already captured)

```
Turn 1: "My name is Berna, I prefer TypeScript"
  💾 +memory: User's name is Berna
  💾 +memory: User prefers TypeScript

Turn 2: "I like functional programming. We chose SQLite."
  ⏭  skip: functional programming (already have TypeScript preference)
  💾 +memory: Decided to use SQLite for storage

Turn 3: "What do you know about me?"
  🔄 updated: Berna prefers TypeScript → Berna prefers TypeScript and functional programming
```

## Features

- 🎨 ANSI colors (zero dependencies)
- ⚡ Streaming responses (SSE)
- 💾 Automatic memory extraction after every turn
- 🔄 Deduplication with ADD/UPDATE/NONE
- 📋 Type `memories` to list all stored facts
- 🧠 System prompt rebuilt with latest memories each turn
