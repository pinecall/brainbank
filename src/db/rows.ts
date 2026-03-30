/**
 * BrainBank — Database Row Types
 *
 * Type definitions for rows returned by SQLite queries.
 * Use these instead of `as any[]` to get IDE autocomplete and catch typos.
 *
 * Only covers the most-queried tables. For one-off queries in indexers,
 * `as any` is acceptable when the query is co-located with its usage.
 */

// ── KV Store ────────────────────────────────────────

export interface KvDataRow {
    id: number;
    collection: string;
    content: string;
    meta_json: string;
    tags_json: string;
    expires_at: number | null;
    created_at: number;
}

export interface KvVectorRow {
    data_id: number;
    embedding: Buffer;
}

// ── Code Chunks ─────────────────────────────────────

export interface CodeChunkRow {
    id: number;
    file_path: string;
    chunk_type: string;
    name: string | null;
    start_line: number;
    end_line: number;
    content: string;
    language: string;
}

// ── Git Commits ─────────────────────────────────────

export interface GitCommitRow {
    id: number;
    hash: string;
    short_hash: string;
    message: string;
    author: string;
    date: string;
    files_json: string;
    diff: string | null;
    additions: number;
    deletions: number;
    is_merge: number;
}

// ── Document Chunks ─────────────────────────────────

export interface DocChunkRow {
    id: number;
    collection: string;
    file_path: string;
    title: string | null;
    seq: number;
    content: string;
    hash: string;
}

// ── Collections ─────────────────────────────────────

export interface CollectionRow {
    name: string;
    path: string;
    pattern: string;
    ignore_json: string;
    context: string | null;
}

// ── Memory Patterns ─────────────────────────────────

export interface MemoryPatternRow {
    id: number;
    task_type: string;
    task: string;
    approach: string;
    outcome: string;
    success_rate: number;
    critique: string;
}

// ── Embedding Metadata ──────────────────────────────

export interface EmbeddingMetaRow {
    value: string;
}

// ── Import Graph ────────────────────────────────────

export interface ImportRow {
    imports_path?: string;
    file_path?: string;
    name?: string;
}

// ── Vector Tables ───────────────────────────────────

export interface VectorRow {
    id: number;
    embedding: Buffer;
}

// ── Scalar count result ─────────────────────────────

export interface CountRow {
    c: number;
}
