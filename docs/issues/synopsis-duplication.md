# Synopsis Chunks: Full-File Duplication & Embedding Truncation

## Problem

Every indexed file gets a `synopsis` chunk that contains the **entire file raw content** prepended with `File: path\n`. This creates two issues:

### 1. Storage Duplication (~2x)

The synopsis duplicates all chunk content, roughly doubling DB storage:

| chunk_type | total storage | count |
|------------|--------------|-------|
| synopsis   | **1,567 KB** | 150   |
| function   | 609 KB       | 392   |
| method     | 660 KB       | 684   |
| class      | 94 KB        | 116   |
| interface  | 31 KB        | 117   |

**Synopsis alone is 53% of all stored content.** For the 10 largest files, the synopsis is a ~1:1 duplicate of the combined chunks:

```
webhooks.py:     synopsis=88KB, chunks=88KB (1.0x duplicate)
handler.py:      synopsis=83KB, chunks=77KB (1.1x)
client/handler:  synopsis=78KB, chunks=80KB (1.0x)
manager.py:      synopsis=49KB, chunks=46KB (1.1x)
```

### 2. Embedding Truncation = Wasted Tokens

Embedding models have token limits:
- `text-embedding-3-small` (OpenAI): 8,191 tokens
- `sonar-embed` (Perplexity): ~8K tokens  
- Most models: ≤ 8K tokens ≈ ~32KB of code

Files like `webhooks.py` (88KB) get **truncated to ~36% of content**. The last 56KB is never represented in the vector. The embedding only captures the file's imports and first few functions — the rest is invisible to HNSW search.

## Current Implementation

In [`packages/code/src/indexing/walker.ts`](file:///Users/berna/brainbank/packages/code/src/indexing/walker.ts):

```typescript
// Line 206: Embeds the ENTIRE file content
const fileEmbeddingText = `File: ${rel}\n${content}`;

// Line 242-246: Stores it as a synopsis chunk with full raw content
const synResult = db.prepare(
    `INSERT INTO code_chunks (..., content, ...) VALUES (..., ?, ...)`
).run(rel, ..., fileEmbeddingText, ...);
```

The synopsis serves as a **file-level anchor** in HNSW: broad queries like *"how does Twilio transport work"* match the file vector, then chunk-level results provide precision. Search queries filter it out with `chunk_type != 'synopsis'`, so users never see it — but it influences which files rank highest.

## Proposed Solutions

### Option A: Skeleton Synopsis (Recommended)

Replace the full-file content with a **structural skeleton** — imports + function/class signatures only. This captures the file's "shape" without duplicating code:

```typescript
// Instead of:
const fileEmbeddingText = `File: ${rel}\n${content}`;

// Generate:
const skeleton = buildSkeleton(rel, content, language, chunks);
// → "File: webhooks.py
//    Imports: fastapi, twilio, asyncio, ...
//    class TwilioWebhooks:
//      async handle_incoming_call(request) -> Response
//      async handle_status_callback(request) -> Response
//      async media_stream(websocket) -> None
//    function validate_twilio_signature(request) -> bool
//    ..."
```

**Files to modify:**
- [`packages/code/src/indexing/walker.ts`](file:///Users/berna/brainbank/packages/code/src/indexing/walker.ts) — `_indexFile()` method, line ~206
- **New:** `packages/code/src/indexing/skeleton.ts` — `buildSkeleton()` pure function

**Pros:** ~95% storage reduction for synopsis, embedding captures full file structure (no truncation), richer semantic signal  
**Cons:** Requires re-index (`brainbank index --force`)

### Option B: Chunk-Aggregated Vector (No Storage)

Instead of storing a synopsis chunk, compute the file-level vector as the **mean of all chunk vectors** — no extra content stored at all:

```typescript
// After embedding all chunks:
const fileVec = meanVector(chunkVecs); // weighted average
// Store in HNSW with a synthetic label, no DB row
```

**Files to modify:**
- [`packages/code/src/indexing/walker.ts`](file:///Users/berna/brainbank/packages/code/src/indexing/walker.ts) — `_indexFile()`, remove synopsis INSERT
- [`packages/code/src/plugin.ts`](file:///Users/berna/brainbank/packages/code/src/plugin.ts) — `stats()`, adjust count

**Pros:** Zero extra storage, zero extra API calls, no truncation  
**Cons:** Averaged vectors are less precise than purpose-built embeddings, loses import/structure context

### Option C: Capped Synopsis (Quick Fix)

Keep the current approach but **truncate content** to the embedding model's token limit (~8K tokens ≈ 32KB):

```typescript
const MAX_SYNOPSIS = 32_000; // ~8K tokens
const fileEmbeddingText = `File: ${rel}\n${content.slice(0, MAX_SYNOPSIS)}`;
// Store only the truncated version
```

**Files to modify:**
- [`packages/code/src/indexing/walker.ts`](file:///Users/berna/brainbank/packages/code/src/indexing/walker.ts) — `_indexFile()`, line ~206

**Pros:** Trivial change, reduces worst-case storage from 90KB → 32KB  
**Cons:** Still duplicates content, truncation is arbitrary (cuts mid-function), doesn't fix the fundamental problem

## Recommendation

**Option A (Skeleton)** is the best long-term solution. It:
1. Reduces synopsis storage by ~95% (1.5MB → ~75KB for 150 files)
2. Fits within embedding token limits — no truncation
3. Provides richer file-level semantics (structure > raw code)
4. The skeleton data is already available from the chunker (function names, classes, imports)

The skeleton builder is a pure function — easy to test and iterate on. Implementation estimate: ~2 hours + re-index.

## Impact

- **DB size**: ~1.5MB saving (from 22.9MB → 21.4MB) for pinecall. Larger repos benefit proportionally.
- **Embedding quality**: File-level vectors capture full structure instead of truncated prefix.
- **Migration**: Requires `brainbank index --force` to rebuild synopsis chunks.
- **Schema**: No changes needed — same `code_chunks` table, same `chunk_type = 'synopsis'`.
