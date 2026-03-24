/**
 * BrainBank — Code Indexer
 * 
 * Walks a repository, chunks source files semantically,
 * embeds each chunk, and stores in SQLite + HNSW.
 * Incremental: only re-indexes files that changed (by content hash).
 */

import fs from 'node:fs';
import path from 'node:path';
import { CodeChunker } from './chunker.ts';
import { SUPPORTED_EXTENSIONS, IGNORE_DIRS, isIgnoredDir, isIgnoredFile } from './languages.ts';
import type { Database } from '../../db/database.ts';
import type { EmbeddingProvider, ProgressCallback, IndexResult } from '../../types.ts';
import type { HNSWIndex } from '../../providers/vector/hnsw.ts';

export interface CodeIndexerDeps {
    db: Database;
    hnsw: HNSWIndex;
    vectorCache: Map<number, Float32Array>;
    embedding: EmbeddingProvider;
}

export interface CodeIndexOptions {
    forceReindex?: boolean;
    onProgress?: ProgressCallback;
}

export class CodeIndexer {
    private _chunker = new CodeChunker();
    private _deps: CodeIndexerDeps;
    private _repoPath: string;
    private _maxFileSize: number;

    constructor(repoPath: string, deps: CodeIndexerDeps, maxFileSize: number = 512_000) {
        this._deps = deps;
        this._repoPath = repoPath;
        this._maxFileSize = maxFileSize;
    }

    /**
     * Index all supported files in the repository.
     * Skips unchanged files (same content hash).
     */
    async index(options: CodeIndexOptions = {}): Promise<IndexResult> {
        const { forceReindex = false, onProgress } = options;
        const files = this._walkRepo(this._repoPath);
        let indexed = 0, skipped = 0, totalChunks = 0;

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

            // Delete old chunks if re-indexing
            if (existing) {
                this._deps.db.prepare('DELETE FROM code_chunks WHERE file_path = ?').run(rel);
            }

            const ext = path.extname(filePath).toLowerCase();
            const language = SUPPORTED_EXTENSIONS[ext] ?? 'text';
            const chunks = await this._chunker.chunk(rel, content, language);

            for (const chunk of chunks) {
                // Build embedding text with file context
                const text = [
                    `File: ${rel}`,
                    chunk.name ? `${chunk.chunkType}: ${chunk.name}` : chunk.chunkType,
                    chunk.content,
                ].join('\n');

                const vec = await this._deps.embedding.embed(text);

                const result = this._deps.db.prepare(
                    `INSERT INTO code_chunks (file_path, chunk_type, name, start_line, end_line, content, language, file_hash)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(rel, chunk.chunkType, chunk.name ?? null, chunk.startLine, chunk.endLine, chunk.content, language, hash);

                const id = Number(result.lastInsertRowid);
                this._deps.db.prepare(
                    'INSERT INTO code_vectors (chunk_id, embedding) VALUES (?, ?)'
                ).run(id, Buffer.from(vec.buffer));

                this._deps.hnsw.add(vec, id);
                this._deps.vectorCache.set(id, vec);
                totalChunks++;
            }

            // Mark file as indexed
            this._deps.db.prepare(
                'INSERT OR REPLACE INTO indexed_files (file_path, file_hash) VALUES (?, ?)'
            ).run(rel, hash);
            indexed++;
        }

        return { indexed, skipped, chunks: totalChunks };
    }

    // ── File Walker ─────────────────────────────────

    private _walkRepo(dir: string, files: string[] = []): string[] {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return files; }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (isIgnoredDir(entry.name)) continue;
                this._walkRepo(path.join(dir, entry.name), files);
            } else if (entry.isFile()) {
                if (isIgnoredFile(entry.name)) continue;
                const ext = path.extname(entry.name).toLowerCase();
                if (!(ext in SUPPORTED_EXTENSIONS)) continue;

                const full = path.join(dir, entry.name);
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
