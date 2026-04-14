/**
 * BrainBank — Code Indexer
 * 
 * Walks a repository, chunks source files semantically,
 * embeds each chunk, and stores in SQLite + HNSW.
 * Incremental: only re-indexes files that changed (by content hash).
 */

import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { CodeChunker } from '../parsing/chunker.js';
import { extractImports, extractImportPaths } from '../graph/import-extractor.js';
import { ImportResolver, isStdlib } from '../graph/import-resolver.js';
import { extractSymbols, extractCallRefs, type SymbolDef } from '../parsing/symbols.js';
import { SUPPORTED_EXTENSIONS, isIgnoredDir, isIgnoredFile } from 'brainbank';
import { vecToBuffer } from 'brainbank';
import type { EmbeddingProvider, ProgressCallback, IndexResult, CodeChunk } from 'brainbank';
import type { HNSWIndex } from 'brainbank';

/** Database handle from brainbank core. */
type Database = Parameters<import('brainbank').PluginContext['db']['prepare']> extends never[] ? any : import('brainbank').PluginContext['db'];

export interface CodeWalkerDeps {
    db: any;
    hnsw: HNSWIndex;
    vectorCache: Map<number, Float32Array>;
    embedding: EmbeddingProvider;
}

/** Loaded set of known files for import resolution. */
function loadKnownFiles(db: CodeWalkerDeps['db']): Set<string> {
    try {
        const rows = db.prepare('SELECT file_path FROM indexed_files').all() as { file_path: string }[];
        return new Set(rows.map((r: { file_path: string }) => r.file_path));
    } catch {
        return new Set<string>();
    }
}

export interface CodeIndexOptions {
    forceReindex?: boolean;
    onProgress?: ProgressCallback;
}

/** Number of files to embed in parallel. Tuned to saturate API latency without hitting rate limits. */
const CONCURRENCY = 5;

export class CodeWalker {
    private _chunker = new CodeChunker();
    private _deps: CodeWalkerDeps;
    private _repoPath: string;
    private _maxFileSize: number;
    private _isIgnored: ((path: string) => boolean) | null;

    constructor(repoPath: string, deps: CodeWalkerDeps, maxFileSize: number = 512_000, ignore?: string[]) {
        this._deps = deps;
        this._repoPath = repoPath;
        this._maxFileSize = maxFileSize;
        this._isIgnored = ignore?.length ? picomatch(ignore, { dot: true }) : null;
    }

    /** Index all supported files. Skips unchanged files (same content hash). */
    async index(options: CodeIndexOptions = {}): Promise<IndexResult> {
        const { forceReindex = false, onProgress } = options;
        const files = this._walkRepo(this._repoPath);
        let indexed = 0, skipped = 0, totalChunks = 0;

        // Build known file set for import resolution (from existing index + current walk)
        const knownFiles = loadKnownFiles(this._deps.db);
        for (const f of files) {
            knownFiles.add(path.relative(this._repoPath, f));
        }

        // ── Phase 1: Collect changed files (CPU-only, sequential) ──
        interface FileToIndex { filePath: string; rel: string; content: string; hash: string; fileIdx: number }
        const toIndex: FileToIndex[] = [];

        for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            const rel = path.relative(this._repoPath, filePath);

            let content: string;
            try { content = fs.readFileSync(filePath, 'utf-8'); }
            catch { continue; }

            const hash = this._hash(content);
            const existing = this._deps.db.prepare(
                'SELECT file_hash FROM indexed_files WHERE file_path = ?'
            ).get(rel) as { file_hash: string } | undefined;

            if (!forceReindex && existing?.file_hash === hash) {
                skipped++;
                continue;
            }

            toIndex.push({ filePath, rel, content, hash, fileIdx: i });
        }

        // ── Phase 2: Index changed files in concurrent batches ──
        for (let b = 0; b < toIndex.length; b += CONCURRENCY) {
            const batch = toIndex.slice(b, b + CONCURRENCY);

            // Report progress for each file in the batch (before embedding starts)
            for (const f of batch) {
                onProgress?.(f.rel, f.fileIdx + 1, files.length);
            }

            // Embed all files in this batch concurrently (API latency overlap)
            const results = await Promise.all(
                batch.map(f => this._indexFile(f.filePath, f.rel, f.content, f.hash, knownFiles)),
            );

            for (const chunkCount of results) {
                indexed++;
                totalChunks += chunkCount;
            }
        }

        // Linking pass: build chunk-to-chunk call edges from code_refs → code_symbols
        if (indexed > 0) {
            this._linkCallEdges();
        }

        // ── Phase 3: Remove orphaned files (deleted from disk but still in DB) ──
        const currentRelPaths = new Set(files.map(f => path.relative(this._repoPath, f)));
        const dbFiles = loadKnownFiles(this._deps.db);
        let removed = 0;

        for (const dbPath of dbFiles) {
            if (currentRelPaths.has(dbPath)) continue;
            // File exists in DB but not on disk — clean it up
            this._removeOldChunks(dbPath);
            this._removeOldGraph(dbPath);
            removed++;
        }

        return { indexed, skipped, chunks: totalChunks, removed };
    }

    /** Remove old chunks, chunk vectors, and HNSW entries for a file. */
    private _removeOldChunks(relPath: string): void {
        // Remove chunk-level HNSW vectors (keyed by code_chunks.id)
        const chunkRows = this._deps.db.prepare(
            'SELECT id FROM code_chunks WHERE file_path = ?'
        ).all(relPath) as { id: number }[];

        for (const row of chunkRows) {
            this._deps.hnsw.remove(row.id);
            this._deps.vectorCache.delete(row.id);
        }

        this._deps.db.prepare('DELETE FROM code_chunks WHERE file_path = ?').run(relPath);
        // code_vectors cascade-deletes when code_chunks are deleted (FK ON DELETE CASCADE)
        this._deps.db.prepare('DELETE FROM indexed_files WHERE file_path = ?').run(relPath);
    }

    /** Remove graph data (imports, symbols, refs) for a file. */
    private _removeOldGraph(relPath: string): void {
        this._deps.db.prepare('DELETE FROM code_imports WHERE file_path = ?').run(relPath);
        this._deps.db.prepare('DELETE FROM code_symbols WHERE file_path = ?').run(relPath);
        // code_refs cascade-deletes when code_chunks are deleted
    }

    /** Chunk, embed, and store a single file. Returns chunk count. */
    private async _indexFile(
        filePath: string, rel: string, content: string, hash: string, knownFiles: Set<string>,
    ): Promise<number> {
        const ext = path.extname(filePath).toLowerCase();
        const language = SUPPORTED_EXTENSIONS[ext] ?? 'text';
        const chunks = await this._chunker.chunk(rel, content, language);

        // Extract imports for contextual headers + import graph
        const imports = extractImports(content, language);
        const importsLine = imports.length > 0
            ? `Imports: ${imports.slice(0, 10).join(', ')}`
            : '';

        // Extract symbols from AST (if tree-sitter was used)
        const symbols = this._extractSymbolsSafe(content, rel, language);

        // Build contextual header for each chunk before embedding.
        // Prepending file/type/imports context dramatically improves retrieval
        // precision — the embedding captures WHERE the chunk lives, not just WHAT it contains.
        const chunkEmbeddingTexts = chunks.map(chunk => {
            const parts: string[] = [`File: ${rel}`];
            if (chunk.name) {
                parts.push(`${chunk.chunkType} ${chunk.name} (L${chunk.startLine}-${chunk.endLine})`);
            }
            if (importsLine) parts.push(importsLine);
            parts.push('---');
            parts.push(chunk.content);
            return parts.join('\n');
        });

        // ── Single embedBatch call for ALL vectors (chunks + synopsis) ──
        // Merging into one API call halves the round-trips per file.
        const fileEmbeddingText = `File: ${rel}\n${content}`;
        const allTexts = [...chunkEmbeddingTexts, fileEmbeddingText];
        const allVecs = await this._deps.embedding.embedBatch(allTexts);
        const chunkVecs = allVecs.slice(0, chunkEmbeddingTexts.length);
        const fileVec = allVecs[chunkEmbeddingTexts.length];

        // Collect old chunk IDs for HNSW cleanup (includes old synopsis)
        const oldChunkRows = this._deps.db.prepare(
            'SELECT id FROM code_chunks WHERE file_path = ?'
        ).all(rel) as { id: number }[];
        const oldChunkIds = oldChunkRows.map(r => r.id);

        // Transaction: delete old + insert new atomically (DB only — no HNSW)
        const newChunkIds: number[] = [];
        let synopsisId: number;
        this._deps.db.transaction(() => {
            // Remove old DB rows (code_vectors cascade-deletes with code_chunks)
            this._deps.db.prepare('DELETE FROM code_chunks WHERE file_path = ?').run(rel);
            this._removeOldGraph(rel);

            for (let ci = 0; ci < chunks.length; ci++) {
                const chunk = chunks[ci];
                const result = this._deps.db.prepare(
                    `INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(rel, chunk.chunkType, chunk.name ?? null, chunk.startLine, chunk.endLine, chunk.content, language, hash);

                const id = Number(result.lastInsertRowid);
                newChunkIds.push(id);

                // Store chunk-level vector
                this._deps.db.prepare(
                    'INSERT INTO code_vectors (chunk_id, embedding) VALUES (?, ?)'
                ).run(id, vecToBuffer(chunkVecs[ci]));
            }

            // Insert file-level vector as a special chunk (chunk_type='synopsis')
            const synResult = this._deps.db.prepare(
                `INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
                 VALUES (?, 'synopsis', ?, 1, ?, ?, ?, ?)`
            ).run(rel, rel.split('/').pop() ?? rel, chunks.length > 0 ? chunks[chunks.length - 1].endLine : 1, fileEmbeddingText, language, hash);

            synopsisId = Number(synResult.lastInsertRowid);

            this._deps.db.prepare(
                'INSERT INTO code_vectors (chunk_id, embedding) VALUES (?, ?)'
            ).run(synopsisId, vecToBuffer(fileVec));

            // Store import graph — resolved file paths + kind
            const importEdges = extractImportPaths(content, language);
            const resolver = new ImportResolver(knownFiles, language);
            const insertImport = this._deps.db.prepare(
                'INSERT OR IGNORE INTO code_imports (file_path, imports_path, import_kind, resolved) VALUES (?, ?, ?, ?)'
            );
            for (const edge of importEdges) {
                // Skip stdlib/builtin modules — they create noise edges
                if (isStdlib(edge.specifier, language)) continue;

                if (edge.isLocal) {
                    const resolved = resolver.resolve(edge.specifier, rel);
                    if (resolved) {
                        insertImport.run(rel, resolved, edge.kind, 1);
                    } else {
                        // Store unresolved with raw specifier for fallback
                        insertImport.run(rel, edge.specifier, edge.kind, 0);
                    }
                } else {
                    // External package — store raw specifier
                    insertImport.run(rel, edge.specifier, edge.kind, 0);
                }
            }

            // Store symbols
            const insertSymbol = this._deps.db.prepare(
                'INSERT INTO code_symbols (file_path, name, kind, line, chunk_id) VALUES (?, ?, ?, ?, ?)'
            );
            for (const sym of symbols) {
                // Link symbol to the chunk that contains it
                const chunkId = this._findChunkForLine(chunks, newChunkIds, sym.line);
                insertSymbol.run(rel, sym.name, sym.kind, sym.line, chunkId);
            }

            // Store call references per chunk
            const insertRef = this._deps.db.prepare(
                'INSERT INTO code_refs (chunk_id, symbol_name) VALUES (?, ?)'
            );
            for (let ci = 0; ci < chunks.length; ci++) {
                const callRefs = this._extractCallRefsSafe(content, chunks[ci], language);
                for (const ref of callRefs) {
                    insertRef.run(newChunkIds[ci], ref);
                }
            }

            // Upsert indexed_files (tracking only — no vector here)
            this._deps.db.prepare(
                'INSERT OR REPLACE INTO indexed_files (file_path, file_hash) VALUES (?, ?)'
            ).run(rel, hash);
        });

        // HNSW mutations AFTER successful commit
        for (const oldId of oldChunkIds) {
            this._deps.hnsw.remove(oldId);
            this._deps.vectorCache.delete(oldId);
        }
        for (let ci = 0; ci < newChunkIds.length; ci++) {
            this._deps.hnsw.add(chunkVecs[ci], newChunkIds[ci]);
            this._deps.vectorCache.set(newChunkIds[ci], chunkVecs[ci]);
        }
        // Add file-level vector to HNSW
        this._deps.hnsw.add(fileVec, synopsisId!);
        this._deps.vectorCache.set(synopsisId!, fileVec);

        return chunks.length;
    }

    /** Find the chunk_id that contains a given line number. */
    private _findChunkForLine(chunks: CodeChunk[], chunkIds: number[], line: number): number | null {
        for (let i = 0; i < chunks.length; i++) {
            if (line >= chunks[i].startLine && line <= chunks[i].endLine) {
                return chunkIds[i];
            }
        }
        return null;
    }

    /** Linking pass: build code_call_edges from code_refs → code_symbols. */
    private _linkCallEdges(): void {
        try {
            // Clear old edges (they'll be rebuilt from current refs/symbols)
            this._deps.db.prepare('DELETE FROM code_call_edges').run();

            // Pass 1: Exact name match (function → function)
            this._deps.db.prepare(`
                INSERT OR IGNORE INTO code_call_edges (caller_chunk_id, callee_chunk_id, symbol_name)
                SELECT cr.chunk_id, cs.chunk_id, cr.symbol_name
                FROM code_refs cr
                JOIN code_symbols cs ON cs.name = cr.symbol_name
                WHERE cs.chunk_id IS NOT NULL
                  AND cr.chunk_id != cs.chunk_id
            `).run();

            // Pass 2: Method suffix match (on_turn_end → TurnController.on_turn_end)
            // Handles the common case where call refs use short names but symbols
            // are stored as Class.method (Python, Java, TS methods)
            this._deps.db.prepare(`
                INSERT OR IGNORE INTO code_call_edges (caller_chunk_id, callee_chunk_id, symbol_name)
                SELECT cr.chunk_id, cs.chunk_id, cr.symbol_name
                FROM code_refs cr
                JOIN code_symbols cs ON cs.name LIKE '%.' || cr.symbol_name
                WHERE cs.chunk_id IS NOT NULL
                  AND cr.chunk_id != cs.chunk_id
                  AND cr.symbol_name NOT IN ('__init__', 'get', 'set', 'run', 'start', 'stop', 'close', 'open', 'read', 'write', 'send', 'init', 'new', 'create', 'update', 'delete', 'toString', 'valueOf', 'next', 'then', 'catch', 'push', 'pop', 'append', 'add', 'remove', 'len', 'str', 'int', 'print', 'format')
            `).run();
        } catch { /* table might not exist yet (pre-v3) */ }
    }

    /** Extract symbols from file, swallowing errors gracefully. */
    private _extractSymbolsSafe(content: string, rel: string, language: string): SymbolDef[] {
        try {
            const parser = this._chunker._ensureParser();
            const grammar = this._chunker.getCachedGrammar(language);
            if (!parser || !grammar) return [];
            parser.setLanguage(grammar.grammar);
            const tree = parser.parse(content);
            return extractSymbols(tree.rootNode, rel, language);
        } catch {
            return [];
        }
    }

    /** Extract call refs for a single chunk, swallowing errors gracefully. */
    private _extractCallRefsSafe(content: string, chunk: CodeChunk, language: string): string[] {
        try {
            const parser = this._chunker._ensureParser();
            const grammar = this._chunker.getCachedGrammar(language);
            if (!parser || !grammar) return [];
            parser.setLanguage(grammar.grammar);
            // Parse just the chunk content
            const chunkContent = content.split('\n')
                .slice(chunk.startLine - 1, chunk.endLine)
                .join('\n');
            const tree = parser.parse(chunkContent);
            return extractCallRefs(tree.rootNode, language);
        } catch {
            return [];
        }
    }

    // ── File Walker ─────────────────────────────────

    private _walkRepo(dir: string, files: string[] = []): string[] {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return files; }

        for (const entry of entries) {
            // Follow symlinks: isDirectory() is false for symlinks, resolve via statSync
            const entryPath = path.join(dir, entry.name);
            const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (() => { try { return fs.statSync(entryPath).isDirectory(); } catch { return false; } })());
            if (isDir) {
                if (isIgnoredDir(entry.name)) continue;
                // Check custom ignores against relative dir path
                if (this._isIgnored) {
                    const relDir = path.relative(this._repoPath, entryPath);
                    if (this._isIgnored(relDir) || this._isIgnored(relDir + '/')) continue;
                }
                this._walkRepo(entryPath, files);
            } else if (entry.isFile()) {
                if (isIgnoredFile(entry.name)) continue;
                const ext = path.extname(entry.name).toLowerCase();
                if (!(ext in SUPPORTED_EXTENSIONS)) continue;

                const full = path.join(dir, entry.name);
                // Check custom ignores against relative file path
                if (this._isIgnored) {
                    const rel = path.relative(this._repoPath, full);
                    if (this._isIgnored(rel)) continue;
                }

                try {
                    if (fs.statSync(full).size <= this._maxFileSize) {
                        files.push(full);
                    }
                } catch {}
            }
        }
        return files;
    }

    // ── FNV-1a Hash ─────────────────────────────────

    private _hash(content: string): string {
        let h = 2166136261;
        for (let i = 0; i < content.length; i++) {
            h ^= content.charCodeAt(i);
            h = (h * 16777619) >>> 0;
        }
        return h.toString(16);
    }
}
