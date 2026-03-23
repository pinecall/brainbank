# Chatbot with Persistent Memory

A CLI chatbot that remembers conversations across sessions using a **hybrid memory strategy**:

1. **Context injection** — recent session summaries loaded into the system prompt at startup
2. **Function calling** — the model autonomously decides when to search/save memories

## Run

```bash
OPENAI_API_KEY=sk-... npx tsx examples/chatbot/chatbot.ts
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│  System Prompt                                    │
│  ┌──────────────────────────────────────────┐    │
│  │ Last 5 session summaries (auto-injected) │    │
│  └──────────────────────────────────────────┘    │
│                                                   │
│  User message → GPT-4.1-nano                      │
│                    │                              │
│           ┌───────┴───────┐                      │
│           ▼               ▼                      │
│    recall_memory()   save_fact()                  │
│    (semantic search)  (persist to DB)             │
│           │               │                      │
│           ▼               ▼                      │
│       BrainBank Collections (SQLite)              │
│       ├── sessions (conversation summaries)       │
│       └── facts (user preferences, knowledge)    │
└──────────────────────────────────────────────────┘
```

## Memory Strategy

| Strategy | When | What |
|----------|------|------|
| **Context injection** | At startup | Last 5 session summaries → system prompt |
| **Function calling** | During chat | `recall_memory(query)` for deep search, `save_fact(content)` to persist |

**Why hybrid?**

- **Pure context injection** doesn't scale — 100 sessions won't fit in a prompt
- **Pure function calling** misses recent context — the model might not search for what it should know
- **Hybrid** gives the best of both: recent context always available, deeper memories searchable on demand

## Features

- 🎨 ANSI colors (zero external dependencies)
- ⚡ Streaming responses via SSE
- 🔧 Tool calls displayed in real-time (dim gray)
- 💾 Auto-summarizes and saves session on exit
- 🧠 Semantic search across all past sessions and facts

## Example Session

```
Session 1:
  🆕 First session — no memories yet
  You → Remember my name is Berna and I prefer TypeScript
    🔧 save_fact("Berna's name is Berna") → Saved ✅
    🔧 save_fact("Berna prefers TypeScript over JavaScript") → Saved ✅
  quit → 💾 Session saved

Session 2:
  💾 1 session(s), 2 fact(s) in memory
  You → Do you remember who I am?
    🔧 recall_memory("who am I", sessions) → score: 1.00
  Bot → You're Berna, and you prefer TypeScript!
```
