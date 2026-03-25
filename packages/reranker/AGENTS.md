# AGENTS.md — @brainbank/reranker

Qwen3 cross-encoder reranker plugin for BrainBank. Downloads a ~640MB GGUF model on first use.
Uses `node-llama-cpp` for local inference — no API calls.

## Commands

- Build: `npx tsup` (from this directory)
- Test: `npm test` (integration only — downloads model, ~30s first run)

## Architecture

```
src/
├── qwen3-reranker.ts  ← Qwen3Reranker class implementing BrainBank's Reranker interface
└── index.ts           ← Public API barrel
```

- `rank(query, documents)` → returns scores 0-1 using yes/no logprobs
- Model auto-downloads to `~/.cache/brainbank-reranker/` on first call
- Implements `Reranker` interface: `{ rank(query, docs) → number[], close() }`

## Gotchas

- `node-llama-cpp` is a peer dependency — requires separate install + C++ toolchain
- First `rank()` call downloads ~640MB model — can timeout in CI without cache
- The model is loaded lazily (not in constructor) — first inference is slow
- `close()` MUST be called to free the native model from memory
