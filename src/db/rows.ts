/**
 * BrainBank — Database Row Types
 *
 * Typed interfaces for rows returned by SQLite queries.
 * Always cast query results to the matching row type for IDE
 * autocomplete and compile-time safety.
 */


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


export interface DocChunkRow {
    id: number;
    collection: string;
    file_path: string;
    title: string | null;
    seq: number;
    content: string;
    content_hash: string;
}


export interface CollectionRow {
    name: string;
    path: string;
    pattern: string;
    ignore_json: string;
    context: string | null;
}



export interface EmbeddingMetaRow {
    value: string;
}


export interface ImportRow {
    imports_path?: string;
    file_path?: string;
    name?: string;
}


export interface VectorRow {
    id: number;
    embedding: Buffer;
}


export interface CountRow {
    c: number;
}
