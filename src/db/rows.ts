/**
 * BrainBank — Database Row Types
 *
 * Typed interfaces for rows returned by SQLite queries.
 * Always cast query results to the matching row type for IDE
 * autocomplete and compile-time safety.
 *
 * Domain-specific row types (CodeChunkRow, GitCommitRow, etc.)
 * have been moved to their respective packages.
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

export interface EmbeddingMetaRow {
    value: string;
}

export interface VectorRow {
    id: number;
    embedding: Buffer;
}

export interface CountRow {
    c: number;
}
