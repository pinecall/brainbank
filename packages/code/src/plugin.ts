/**
 * @brainbank/code — Code Plugin
 * 
 * Language-aware code indexing for 20+ languages.
 * 
 *   import { BrainBank } from 'brainbank';
 *   import { code } from '@brainbank/code';
 *   
 *   const brain = new BrainBank().use(code({ repoPath: '.' }));
 */

import type { Plugin, PluginContext, ContextFieldDef, ExpanderManifestItem, EmbeddingProvider, IndexResult, ProgressCallback, ReembedTable, SearchResult } from 'brainbank';
import type { HNSWIndex } from 'brainbank';
import { runPluginMigrations, sanitizeFTS, normalizeBM25, escapeLike } from 'brainbank';
import picomatch from 'picomatch';

import { CodeWalker } from './indexing/walker.js';
import { CodeVectorSearch } from './search/vector-search.js';
import { SqlCodeGraphProvider, type ChunkManifestItem } from './graph/provider.js';
import { formatCodeContext } from './formatting/context-formatter.js';
import { CODE_SCHEMA_VERSION, CODE_MIGRATIONS } from './schema.js';
import type { CodeChunkRow } from './search/vector-search.js';

// Re-export Database type locally for class property
type Database = PluginContext['db'];

export interface CodePluginOptions {
    /** Repository path to index. Default: '.' */
    repoPath?: string;
    /** Maximum file size in bytes. Default: from config */
    maxFileSize?: number;
    /** Glob patterns to ignore (e.g. sdk/**, *.generated.ts). Applied on top of built-in ignores. */
    ignore?: string[];
    /** Glob patterns to include (e.g. src/**, lib/**). When set, only matching files are indexed. Ignore still applies on top. */
    include?: string[];
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
        this.name = 'code';
    }

    async initialize(ctx: PluginContext): Promise<void> {
        this.db = ctx.db;
        runPluginMigrations(ctx.db, this.name, CODE_SCHEMA_VERSION, CODE_MIGRATIONS);
        const embedding = this.opts.embeddingProvider ?? ctx.embedding;

        // HNSW index for code vector search
        const shared = await ctx.getOrCreateSharedHnsw(this.name, undefined, embedding.dims);
        this.hnsw = shared.hnsw;
        this.vecCache = shared.vecCache;

        // Load chunk-level vectors for this repo's HNSW (keyed by code_chunks.id)
        if (shared.isNew) {
            this._loadChunkVectors(ctx.db);
        }

        const repoPath = this.opts.repoPath ?? ctx.config.repoPath;
        this.indexer = new CodeWalker(repoPath, {
            db: ctx.db,
            hnsw: this.hnsw,
            vectorCache: this.vecCache,
            embedding,
        }, this.opts.maxFileSize ?? ctx.config.maxFileSize, this.opts.ignore, this.opts.include);
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

    /** Load chunk-level vectors from code_vectors → HNSW (keyed by code_chunks.id). */
    private _loadChunkVectors(db: { prepare(sql: string): { all(...p: unknown[]): unknown[]; iterate(...p: unknown[]): IterableIterator<unknown> } }): void {
        const rows = db.prepare(`
            SELECT v.chunk_id, v.embedding
            FROM code_vectors v
        `).iterate() as IterableIterator<{ chunk_id: number; embedding: Buffer }>;

        for (const row of rows) {
            const vec = new Float32Array(
                row.embedding.buffer.slice(
                    row.embedding.byteOffset,
                    row.embedding.byteOffset + row.embedding.byteLength,
                ),
            );
            this.hnsw.add(vec, row.chunk_id);
            this.vecCache.set(row.chunk_id, vec);
        }
    }

    /** ContextFieldPlugin — declare available context fields. */
    contextFields(): ContextFieldDef[] {
        return [
            { name: 'lines',    type: 'boolean', default: false, description: 'Prefix each code line with its source line number (e.g. 127| code)' },
            { name: 'callTree', type: 'object',  default: true,  description: 'Include call tree expansion. Pass { depth: N } to control depth (default: 2)' },
            { name: 'imports',  type: 'boolean', default: true,  description: 'Include dependency/import summary section' },
            { name: 'symbols',  type: 'boolean', default: false, description: 'Append symbol index (all functions, classes, interfaces) for matched files' },
            { name: 'compact',  type: 'boolean', default: false, description: 'Show only function/class signatures, skip bodies' },
        ];
    }

    /** ContextFormatterPlugin — format code results as unified workflow trace. */
    formatContext(results: SearchResult[], parts: string[], fields: Record<string, unknown>): void {
        const codeHits = results.filter(r => r.type === 'code');
        if (codeHits.length === 0) return;

        const codeGraph = new SqlCodeGraphProvider(this.db);

        formatCodeContext(codeHits, parts, codeGraph, undefined, fields);
    }

    /** ExpandablePlugin — build lightweight manifest for expander (excludes already-matched content). */
    buildManifest(excludeFilePaths: string[], excludeIds: number[], resultFilePaths: string[] = []): ExpanderManifestItem[] {
        const graph = new SqlCodeGraphProvider(this.db);

        // Query import graph for 1-hop neighbors of search result files
        const priorityFilePaths = resultFilePaths.length > 0
            ? graph.fetchImportNeighbors(resultFilePaths)
                .filter(fp => !excludeFilePaths.includes(fp))  // Don't prioritize already-excluded
            : [];

        const chunks = graph.fetchChunkManifest(excludeFilePaths, excludeIds, priorityFilePaths);
        return chunks.map(c => ({
            id: c.id,
            filePath: c.filePath,
            name: c.name,
            chunkType: c.chunkType,
            lines: `L${c.startLine}-L${c.endLine}`,
            priority: (c as ChunkManifestItem & { priority?: boolean }).priority,
        }));
    }

    /** ExpandablePlugin — resolve expanded chunk IDs back to SearchResults. */
    resolveChunks(ids: number[]): SearchResult[] {
        const graph = new SqlCodeGraphProvider(this.db);
        const chunks = graph.fetchChunksByIds(ids);
        return chunks.map(c => ({
            type: 'code' as const,
            score: -1, // marker: expansion-sourced, not search-ranked
            filePath: c.filePath,
            content: c.content,
            metadata: {
                id: c.id,
                chunkType: c.chunkType,
                name: c.name,
                startLine: c.startLine,
                endLine: c.endLine,
                language: c.language,
                filePath: c.filePath,
                expandedBy: 'expander',
            },
        }));
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
            textBuilder: (r: Record<string, unknown>) => `File: ${r.file_path}\n${r.chunk_type} ${r.name ?? 'anonymous'}\n---\n${r.content}`,
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

    // ── FileResolvablePlugin ────────────────────────────

    /** Resolve file paths, directories, globs, or fuzzy basenames to full SearchResults. */
    resolveFiles(patterns: string[]): SearchResult[] {
        const allResults: SearchResult[] = [];
        const seenPaths = new Set<string>();

        for (const pattern of patterns) {
            let chunks: CodeChunkRow[];

            if (pattern.includes('*')) {
                // Tier 3: Glob — fetch all paths, filter with picomatch
                chunks = this._resolveGlob(pattern);
            } else if (pattern.endsWith('/')) {
                // Tier 2: Directory — all files under prefix
                chunks = this._resolveDirectory(pattern);
            } else {
                // Tier 1: Exact match
                chunks = this._fetchFileChunks(pattern);
                // Tier 4: Fuzzy fallback (basename match)
                if (chunks.length === 0) {
                    chunks = this._resolveFuzzy(pattern);
                }
            }

            // Group by file and build results, dedup across patterns
            for (const result of this._chunksToFileResults(chunks)) {
                const fp = result.filePath as string;
                if (seenPaths.has(fp)) continue;
                seenPaths.add(fp);
                allResults.push(result);
            }
        }

        return allResults;
    }

    /** Tier 1: Exact file path match. */
    private _fetchFileChunks(filePath: string): CodeChunkRow[] {
        return this.db.prepare(
            `SELECT id, file_path, chunk_type, name, start_line, end_line, content, language
             FROM code_chunks WHERE file_path = ? AND chunk_type != 'synopsis'
             ORDER BY start_line`,
        ).all(filePath) as CodeChunkRow[];
    }

    /** Tier 2: Directory prefix (trailing /). */
    private _resolveDirectory(prefix: string): CodeChunkRow[] {
        return this.db.prepare(
            `SELECT id, file_path, chunk_type, name, start_line, end_line, content, language
             FROM code_chunks WHERE file_path LIKE ? AND chunk_type != 'synopsis'
             ORDER BY file_path, start_line`,
        ).all(`${prefix}%`) as CodeChunkRow[];
    }

    /** Tier 3: Glob pattern (picomatch). */
    private _resolveGlob(pattern: string): CodeChunkRow[] {
        const allPaths = this.db.prepare(
            `SELECT DISTINCT file_path FROM code_chunks`,
        ).all() as { file_path: string }[];

        const matcher = picomatch(pattern);
        const matched = allPaths
            .map(r => r.file_path)
            .filter(fp => matcher(fp));

        if (matched.length === 0) return [];

        const placeholders = matched.map(() => '?').join(',');
        return this.db.prepare(
            `SELECT id, file_path, chunk_type, name, start_line, end_line, content, language
             FROM code_chunks WHERE file_path IN (${placeholders}) AND chunk_type != 'synopsis'
             ORDER BY file_path, start_line`,
        ).all(...matched) as CodeChunkRow[];
    }

    /** Tier 4: Fuzzy basename match (fallback when exact fails). */
    private _resolveFuzzy(basename: string): CodeChunkRow[] {
        return this.db.prepare(
            `SELECT id, file_path, chunk_type, name, start_line, end_line, content, language
             FROM code_chunks
             WHERE (file_path LIKE ? OR file_path = ?) AND chunk_type != 'synopsis'
             ORDER BY file_path, start_line
             LIMIT 200`,
        ).all(`%/${basename}`, basename) as CodeChunkRow[];
    }

    /** Group chunks by file_path and build one SearchResult per file. */
    private _chunksToFileResults(chunks: CodeChunkRow[]): SearchResult[] {
        if (chunks.length === 0) return [];

        // Group by file_path
        const byFile = new Map<string, CodeChunkRow[]>();
        for (const c of chunks) {
            const group = byFile.get(c.file_path) ?? [];
            group.push(c);
            byFile.set(c.file_path, group);
        }

        return [...byFile.entries()].map(([filePath, fileChunks]) => ({
            type: 'code' as const,
            score: 1.0, // max score — user explicitly requested this file
            filePath,
            content: fileChunks.map(c => c.content).join('\n'),
            metadata: {
                id: fileChunks[0].id,
                chunkIds: fileChunks.map(c => c.id),
                chunkType: 'file' as const,
                name: filePath.split('/').pop() ?? '',
                startLine: fileChunks[0].start_line,
                endLine: fileChunks[fileChunks.length - 1].end_line,
                language: fileChunks[0].language,
                searchType: 'file-resolve',
            },
        }));
    }
}

/** Create a code indexing plugin. */
export function code(opts?: CodePluginOptions): Plugin {
    return new CodePlugin(opts);
}
