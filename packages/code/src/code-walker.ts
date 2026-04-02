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
import { CodeChunker } from './code-chunker.js';
import { extractImports, extractImportPaths } from './import-extractor.js';
import { ImportResolver, isStdlib } from './import-resolver.js';
import { extractSymbols, extractCallRefs, type SymbolDef } from './symbol-extractor.js';
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

        for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            const rel = path.relative(this._repoPath, filePath);
            onProgress?.(rel, i + 1, files.length);

            let content: string;
            try { content = fs.readFileSync(filePath, 'utf-8'); }
            catch { continue; }

            const hash = this._hash(content);
            const existing = this._deps.db.prepare(
                'SELECT file_hash FROM indexed_files WHERE file_path = ?'
            ).get(rel) as any;

            if (!forceReindex && existing?.file_hash === hash) {
                skipped++;
                continue;
            }

            const chunkCount = await this._indexFile(filePath, rel, content, hash, knownFiles);
            indexed++;
            totalChunks += chunkCount;
        }

        // Linking pass: build chunk-to-chunk call edges from code_refs → code_symbols
        if (indexed > 0) {
            this._linkCallEdges();
        }

        return { indexed, skipped, chunks: totalChunks };
    }

    /** Remove old chunks and their HNSW vectors for a file. */
    private _removeOldChunks(relPath: string): void {
        const oldChunks = this._deps.db.prepare(
            'SELECT id FROM code_chunks WHERE file_path = ?'
        ).all(relPath) as any[];

        if (oldChunks.length > 0) {
            for (const { id } of oldChunks) {
                this._deps.hnsw.remove(id);
                this._deps.vectorCache.delete(id);
            }
            this._deps.db.prepare('DELETE FROM code_chunks WHERE file_path = ?').run(relPath);
        }
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

        // Extract imports for enriched embeddings + import graph
        const imports = extractImports(content, language);
        const importsLine = imports.length > 0
            ? `Imports: ${imports.slice(0, 10).join(', ')}`
            : '';

        // Build enriched embedding text
        const embeddingTexts = chunks.map(chunk => {
            const parts = [`File: ${rel}`];
            if (importsLine) parts.push(importsLine);
            // Add parent class context for methods
            if (chunk.chunkType === 'method' && chunk.name?.includes('.')) {
                const className = chunk.name.split('.')[0];
                parts.push(`Class: ${className}`);
            }
            parts.push(chunk.name ? `${chunk.chunkType}: ${chunk.name}` : chunk.chunkType);
            parts.push(chunk.content);
            return parts.join('\n');
        });

        const vecs = await this._deps.embedding.embedBatch(embeddingTexts);

        // Extract symbols from AST (if tree-sitter was used)
        const symbols = this._extractSymbolsSafe(content, rel, language);

        // Collect HNSW mutations to apply AFTER the DB transaction commits.
        // If the transaction rolls back, HNSW stays consistent with the DB.
        const hnswToRemove: number[] = [];
        const hnswToAdd: { id: number; vec: Float32Array }[] = [];

        // Collect old chunk IDs for HNSW cleanup (before the transaction deletes them)
        const oldChunks = this._deps.db.prepare(
            'SELECT id FROM code_chunks WHERE file_path = ?'
        ).all(rel) as any[];
        for (const { id } of oldChunks) {
            hnswToRemove.push(id);
        }

        // Transaction: delete old + insert new atomically (DB only — no HNSW)
        this._deps.db.transaction(() => {
            // Remove old DB rows
            this._deps.db.prepare('DELETE FROM code_chunks WHERE file_path = ?').run(rel);
            this._removeOldGraph(rel);

            const chunkIds: number[] = [];

            for (let ci = 0; ci < chunks.length; ci++) {
                const chunk = chunks[ci];
                const result = this._deps.db.prepare(
                    `INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(rel, chunk.chunkType, chunk.name ?? null, chunk.startLine, chunk.endLine, chunk.content, language, hash);

                const id = Number(result.lastInsertRowid);
                chunkIds.push(id);
                this._deps.db.prepare(
                    'INSERT INTO code_vectors (chunk_id, embedding) VALUES (?, ?)'
                ).run(id, vecToBuffer(vecs[ci]));

                hnswToAdd.push({ id, vec: vecs[ci] });
            }

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
                const chunkId = this._findChunkForLine(chunks, chunkIds, sym.line);
                insertSymbol.run(rel, sym.name, sym.kind, sym.line, chunkId);
            }

            // Store call references per chunk
            const insertRef = this._deps.db.prepare(
                'INSERT INTO code_refs (chunk_id, symbol_name) VALUES (?, ?)'
            );
            for (let ci = 0; ci < chunks.length; ci++) {
                const callRefs = this._extractCallRefsSafe(content, chunks[ci], language);
                for (const ref of callRefs) {
                    insertRef.run(chunkIds[ci], ref);
                }
            }

            this._deps.db.prepare(
                'INSERT OR REPLACE INTO indexed_files (file_path, file_hash) VALUES (?, ?)'
            ).run(rel, hash);
        });

        // HNSW mutations AFTER successful commit — keeps HNSW consistent with DB
        for (const id of hnswToRemove) {
            this._deps.hnsw.remove(id);
            this._deps.vectorCache.delete(id);
        }
        for (const { id, vec } of hnswToAdd) {
            this._deps.hnsw.add(vec, id);
            this._deps.vectorCache.set(id, vec);
        }

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
            if (entry.isDirectory()) {
                if (isIgnoredDir(entry.name)) continue;
                // Check custom ignores against relative dir path
                if (this._isIgnored) {
                    const relDir = path.relative(this._repoPath, path.join(dir, entry.name));
                    if (this._isIgnored(relDir) || this._isIgnored(relDir + '/')) continue;
                }
                this._walkRepo(path.join(dir, entry.name), files);
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
