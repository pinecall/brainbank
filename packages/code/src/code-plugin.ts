/**
 * @brainbank/code — Code Plugin
 * 
 * Language-aware code indexing for 20+ languages.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from '@brainbank/code';
 *   
 *   const brain = new BrainBank().use(code({ repoPath: '.' }));
 *   
 *   // Multi-repo: namespace to avoid key collisions
 *   brain
 *     .use(code({ repoPath: './frontend', name: 'code:frontend' }))
 *     .use(code({ repoPath: './backend',  name: 'code:backend' }));
 */

import type { Plugin, PluginContext, EmbeddingProvider, IndexResult, ProgressCallback, ReembedTable, SearchResult } from 'brainbank';
import type { HNSWIndex } from 'brainbank';
import { runPluginMigrations, sanitizeFTS, normalizeBM25, escapeLike } from 'brainbank';

import { CodeWalker } from './code-walker.js';
import { CodeVectorSearch } from './code-vector-search.js';
import { SqlCodeGraphProvider } from './sql-code-graph.js';
import { formatCodeResults, formatCodeGraph } from './code-context-formatter.js';
import { CODE_SCHEMA_VERSION, CODE_MIGRATIONS } from './code-schema.js';
import type { CodeChunkRow } from './code-vector-search.js';

// Re-export Database type locally for class property
type Database = PluginContext['db'];

export interface CodePluginOptions {
    /** Repository path to index. Default: '.' */
    repoPath?: string;
    /** Maximum file size in bytes. Default: from config */
    maxFileSize?: number;
    /** Glob patterns to ignore (e.g. sdk/**, *.generated.ts). Applied on top of built-in ignores. */
    ignore?: string[];
    /** Custom indexer name for multi-repo (e.g. 'code:frontend'). Default: 'code' */
    name?: string;
    /** Per-plugin embedding provider. Default: global embedding from BrainBank config. */
    embeddingProvider?: EmbeddingProvider;
}

/** Check if an error is an FTS5 query syntax error (expected, safe to ignore). */
function isFTSError(e: unknown): boolean {
    return e instanceof Error && /fts5|syntax error|parse error/i.test(e.message);
}

class CodePlugin implements Plugin {
    readonly name: string;
    private db!: Database;
    hnsw!: HNSWIndex;
    indexer!: CodeWalker;
    vecCache = new Map<number, Float32Array>();

    constructor(private opts: CodePluginOptions = {}) {
        this.name = opts.name ?? 'code';
    }

    async initialize(ctx: PluginContext): Promise<void> {
        this.db = ctx.db;
        runPluginMigrations(ctx.db.db, this.name, CODE_SCHEMA_VERSION, CODE_MIGRATIONS);
        const embedding = this.opts.embeddingProvider ?? ctx.embedding;

        // Use shared HNSW so all code indexers (code, code:frontend, etc.) share one index
        const shared = await ctx.getOrCreateSharedHnsw('code', undefined, embedding.dims);
        this.hnsw = shared.hnsw;
        this.vecCache = shared.vecCache;

        // Only load vectors once (first code indexer to initialize)
        if (shared.isNew) {
            ctx.loadVectors('code_vectors', 'chunk_id', this.hnsw, this.vecCache);
        }

        const repoPath = this.opts.repoPath ?? ctx.config.repoPath;
        this.indexer = new CodeWalker(repoPath, {
            db: ctx.db,
            hnsw: this.hnsw,
            vectorCache: this.vecCache,
            embedding,
        }, this.opts.maxFileSize ?? ctx.config.maxFileSize, this.opts.ignore);
    }

    async index(options: {
        forceReindex?: boolean;
        onProgress?: ProgressCallback;
    } = {}): Promise<IndexResult> {
        return this.indexer.index(options);
    }

    /** VectorSearchPlugin — create domain vector search strategy. */
    createVectorSearch() {
        return new CodeVectorSearch({
            db: this.db,
            hnsw: this.hnsw,
            vecs: this.vecCache,
        });
    }

    /** ContextFormatterPlugin — format code results with call graph. */
    formatContext(results: SearchResult[], parts: string[]): void {
        const codeHits = results.filter(r => r.type === 'code');
        if (codeHits.length === 0) return;

        const codeGraph = new SqlCodeGraphProvider(this.db);
        formatCodeResults(codeHits, parts, codeGraph);
        formatCodeGraph(codeHits, parts, codeGraph);
    }

    /** BM25SearchPlugin — FTS5 keyword search across code chunks. */
    searchBM25(query: string, k: number): SearchResult[] {
        const ftsQuery = sanitizeFTS(query);
        if (!ftsQuery) return [];

        const results: SearchResult[] = [];
        const seenIds = new Set<number>();

        try {
            const rows = this.db.prepare(`
                SELECT c.id, c.file_path, c.chunk_type, c.name, c.start_line, c.end_line,
                       c.content, c.language, bm25(fts_code, 5.0, 3.0, 1.0) AS score
                FROM fts_code f
                JOIN code_chunks c ON c.id = f.rowid
                WHERE fts_code MATCH ?
                ORDER BY score ASC
                LIMIT ?
            `).all(ftsQuery, k) as (CodeChunkRow & { score: number })[];

            for (const r of rows) {
                seenIds.add(r.id);
                results.push(this._toCodeResult(r, normalizeBM25(r.score), 'bm25'));
            }
        } catch (e) { if (!isFTSError(e)) throw e; }

        // File-path fallback
        this._searchCodeByPath(query, seenIds, results);

        return results;
    }

    /** Rebuild the FTS5 index from the content table. */
    rebuildFTS(): void {
        try {
            this.db.prepare("INSERT INTO fts_code(fts_code) VALUES('rebuild')").run();
        } catch { /* non-fatal */ }
    }

    /** Table descriptor for re-embedding code vectors from DB rows. */
    reembedConfig(): ReembedTable {
        return {
            name: 'code',
            textTable: 'code_chunks',
            vectorTable: 'code_vectors',
            idColumn: 'id',
            fkColumn: 'chunk_id',
            textBuilder: (r) => [
                `File: ${r.file_path}`,
                r.name ? `${r.chunk_type}: ${r.name}` : String(r.chunk_type),
                String(r.content),
            ].join('\n'),
        };
    }

    stats(): Record<string, number> {
        return {
            files:    (this.db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_chunks').get() as { c: number }).c,
            chunks:   (this.db.prepare('SELECT COUNT(*) as c FROM code_chunks').get() as { c: number }).c,
            hnswSize: this.hnsw.size,
        };
    }

    /** File-path fallback: match filenames via LIKE. */
    private _searchCodeByPath(rawQuery: string, seenIds: Set<number>, results: SearchResult[]): void {
        try {
            const words = rawQuery.replace(/[^a-zA-Z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 2);
            for (const word of words.slice(0, 3)) {
                const pathRows = this.db.prepare(`
                    SELECT id, file_path, chunk_type, name, start_line, end_line, content, language
                    FROM code_chunks
                    WHERE file_path LIKE ? ESCAPE '\\' AND chunk_type = 'file'
                    LIMIT 3
                `).all(`%${escapeLike(word)}%`) as CodeChunkRow[];

                for (const r of pathRows) {
                    if (seenIds.has(r.id)) continue;
                    seenIds.add(r.id);
                    results.push(this._toCodeResult(r, 0.6, 'bm25-path'));
                }
            }
        } catch (e) { if (!isFTSError(e)) throw e; }
    }

    /** Map a code_chunks row to a SearchResult. */
    private _toCodeResult(r: CodeChunkRow, score: number, searchType: string): SearchResult {
        return {
            type: 'code',
            score,
            filePath: r.file_path,
            content: r.content,
            metadata: {
                id: r.id,
                chunkType: r.chunk_type,
                name: r.name ?? undefined,
                startLine: r.start_line,
                endLine: r.end_line,
                language: r.language,
                searchType,
            },
        };
    }
}

/** Create a code indexing plugin. */
export function code(opts?: CodePluginOptions): Plugin {
    return new CodePlugin(opts);
}
