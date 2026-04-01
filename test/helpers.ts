/**
 * BrainBank — Shared Test Helpers
 * 
 * Common imports, mocks, and utilities used across test files.
 * Import once at the top of each test file instead of per-spec.
 */

import { BrainBank } from '../src/brainbank.ts';
import { SQLiteAdapter } from '../src/db/sqlite-adapter.ts';
import type { DatabaseAdapter } from '../src/db/adapter.ts';
import { HNSWIndex } from '../src/providers/vector/hnsw-index.ts';
import { runPluginMigrations } from '../src/db/migrations.ts';

import { OpenAIEmbedding } from '../src/providers/embeddings/openai-embedding.ts';
import { PerplexityEmbedding, decodeBase64Int8 } from '../src/providers/embeddings/perplexity-embedding.ts';
import { PerplexityContextEmbedding } from '../src/providers/embeddings/perplexity-context-embedding.ts';
import { Collection } from '../src/services/collection.ts';
import { resolveConfig, DEFAULTS } from '../src/config.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';
import { reciprocalRankFusion } from '../src/lib/rrf.ts';
import { searchMMR } from '../src/search/vector/mmr.ts';
import {
    cosineSimilarity, cosineSimilarityFull,
    normalize, euclideanDistance,
} from '../src/lib/math.ts';
import {
    getLanguage, isSupported, isIgnoredDir, isIgnoredFile,
    SUPPORTED_EXTENSIONS, IGNORE_DIRS,
} from '../src/lib/languages.ts';

// Plugins — loaded from @brainbank/* packages
import { code } from '@brainbank/code';
import { git } from '@brainbank/git';
import { docs } from '@brainbank/docs';


import type { EmbeddingProvider, Reranker } from '../src/types.ts';

// ── Mock Embedding Provider ─────────────────────────

/** Creates a deterministic mock embedding provider (384-dim, all 0.1). */
export function mockEmbedding(dims = 384): EmbeddingProvider {
    return {
        dims,
        async embed(_: string) { return new Float32Array(dims).fill(0.1); },
        async embedBatch(txts: string[]) { return txts.map(() => new Float32Array(dims).fill(0.1)); },
        async close() {},
    };
}

// ── Hash Embedding Provider ─────────────────────────

/**
 * Creates a deterministic hash-based embedding provider.
 * Produces unique vectors per input text using FNV-1a hashing.
 * Used in integration tests to exercise real search paths
 * without downloading ML models.
 */
export function hashEmbedding(dims = 384): EmbeddingProvider {
    function embed(text: string): Float32Array {
        const vec = new Float32Array(dims);
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        for (let i = 0; i < dims; i++) {
            h ^= (h >>> 13);
            h = Math.imul(h, 0x5bd1e995) >>> 0;
            vec[i] = (h / 0xFFFFFFFF) * 2 - 1;
        }
        let norm = 0;
        for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm);
        for (let i = 0; i < dims; i++) vec[i] /= norm;
        return vec;
    }
    return {
        dims,
        embed: async (t: string) => embed(t),
        embedBatch: async (ts: string[]) => ts.map(t => embed(t)),
        close: async () => {},
    };
}

/** Creates a unique temp DB path. */
export function tmpDb(label: string): string {
    return `/tmp/brainbank-${label}-${Date.now()}.db`;
}

/**
 * Create domain tables (code, git, docs) in a test DB.
 * Runs the same migration SQL that plugins use, so tests
 * work without loading actual plugins.
 */
export function createDomainSchema(db: DatabaseAdapter): void {
    // Code tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS code_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL,
            chunk_type TEXT NOT NULL, name TEXT, start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL, content TEXT NOT NULL, language TEXT NOT NULL,
            file_hash TEXT, indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS code_vectors (chunk_id INTEGER PRIMARY KEY REFERENCES code_chunks(id) ON DELETE CASCADE, embedding BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS indexed_files (file_path TEXT PRIMARY KEY, file_hash TEXT NOT NULL, indexed_at INTEGER NOT NULL DEFAULT (unixepoch()));
        CREATE TABLE IF NOT EXISTS code_imports (file_path TEXT NOT NULL, imports_path TEXT NOT NULL, PRIMARY KEY (file_path, imports_path));
        CREATE TABLE IF NOT EXISTS code_symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS code_refs (chunk_id INTEGER NOT NULL REFERENCES code_chunks(id) ON DELETE CASCADE, symbol_name TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_cc_file ON code_chunks(file_path);
        CREATE INDEX IF NOT EXISTS idx_ci_imports ON code_imports(imports_path);
        CREATE INDEX IF NOT EXISTS idx_cs_name ON code_symbols(name);
        CREATE INDEX IF NOT EXISTS idx_cs_file ON code_symbols(file_path);
        CREATE INDEX IF NOT EXISTS idx_cr_symbol ON code_refs(symbol_name);
        CREATE INDEX IF NOT EXISTS idx_cr_chunk ON code_refs(chunk_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_code USING fts5(file_path, name, content, content='code_chunks', content_rowid='id', tokenize='porter unicode61');
        CREATE TRIGGER IF NOT EXISTS trg_fts_code_insert AFTER INSERT ON code_chunks BEGIN INSERT INTO fts_code(rowid, file_path, name, content) VALUES (new.id, new.file_path, COALESCE(new.name, ''), new.content); END;
        CREATE TRIGGER IF NOT EXISTS trg_fts_code_delete AFTER DELETE ON code_chunks BEGIN INSERT INTO fts_code(fts_code, rowid, file_path, name, content) VALUES ('delete', old.id, old.file_path, COALESCE(old.name, ''), old.content); END;
    `);
    // Git tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS git_commits (
            id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT UNIQUE NOT NULL,
            short_hash TEXT NOT NULL, message TEXT NOT NULL, author TEXT NOT NULL,
            date TEXT NOT NULL, timestamp INTEGER NOT NULL, files_json TEXT NOT NULL,
            diff TEXT, additions INTEGER DEFAULT 0, deletions INTEGER DEFAULT 0, is_merge INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS commit_files (commit_id INTEGER NOT NULL REFERENCES git_commits(id), file_path TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS co_edits (file_a TEXT NOT NULL, file_b TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (file_a, file_b));
        CREATE TABLE IF NOT EXISTS git_vectors (commit_id INTEGER PRIMARY KEY REFERENCES git_commits(id) ON DELETE CASCADE, embedding BLOB NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_cf_path ON commit_files(file_path);
        CREATE INDEX IF NOT EXISTS idx_gc_ts ON git_commits(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_gc_hash ON git_commits(hash);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_commits USING fts5(message, author, diff, content='git_commits', content_rowid='id', tokenize='porter unicode61');
        CREATE TRIGGER IF NOT EXISTS trg_fts_commits_insert AFTER INSERT ON git_commits BEGIN INSERT INTO fts_commits(rowid, message, author, diff) VALUES (new.id, new.message, new.author, COALESCE(new.diff, '')); END;
        CREATE TRIGGER IF NOT EXISTS trg_fts_commits_delete AFTER DELETE ON git_commits BEGIN INSERT INTO fts_commits(fts_commits, rowid, message, author, diff) VALUES ('delete', old.id, old.message, old.author, COALESCE(old.diff, '')); END;
    `);
    // Docs tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, path TEXT NOT NULL, pattern TEXT NOT NULL DEFAULT '**/*.md', ignore_json TEXT NOT NULL DEFAULT '[]', context TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
        CREATE TABLE IF NOT EXISTS doc_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL REFERENCES collections(name) ON DELETE CASCADE, file_path TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL, indexed_at INTEGER NOT NULL DEFAULT (unixepoch()));
        CREATE TABLE IF NOT EXISTS doc_vectors (chunk_id INTEGER PRIMARY KEY REFERENCES doc_chunks(id) ON DELETE CASCADE, embedding BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS path_contexts (collection TEXT NOT NULL, path TEXT NOT NULL, context TEXT NOT NULL, PRIMARY KEY (collection, path));
        CREATE INDEX IF NOT EXISTS idx_dc_collection ON doc_chunks(collection);
        CREATE INDEX IF NOT EXISTS idx_dc_file ON doc_chunks(file_path);
        CREATE INDEX IF NOT EXISTS idx_dc_hash ON doc_chunks(content_hash);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs USING fts5(title, content, file_path, collection, content='doc_chunks', content_rowid='id', tokenize='porter unicode61');
        CREATE TRIGGER IF NOT EXISTS trg_fts_docs_insert AFTER INSERT ON doc_chunks BEGIN INSERT INTO fts_docs(rowid, title, content, file_path, collection) VALUES (new.id, new.title, new.content, new.file_path, new.collection); END;
        CREATE TRIGGER IF NOT EXISTS trg_fts_docs_delete AFTER DELETE ON doc_chunks BEGIN INSERT INTO fts_docs(fts_docs, rowid, title, content, file_path, collection) VALUES ('delete', old.id, old.title, old.content, old.file_path, old.collection); END;
    `);
}

// ── Re-exports ──────────────────────────────────────

export {
    BrainBank,
    SQLiteAdapter,
    HNSWIndex,
    runPluginMigrations,

    OpenAIEmbedding,
    PerplexityEmbedding,
    PerplexityContextEmbedding,
    decodeBase64Int8,
    Collection,
    resolveConfig,
    DEFAULTS,
    SCHEMA_VERSION,
    reciprocalRankFusion,
    searchMMR,
    cosineSimilarity,
    cosineSimilarityFull,
    normalize,
    euclideanDistance,
    getLanguage,
    isSupported,
    isIgnoredDir,
    isIgnoredFile,
    SUPPORTED_EXTENSIONS,
    IGNORE_DIRS,
    // Plugins
    code,
    git,
    docs,

};

export type { EmbeddingProvider, Reranker };

