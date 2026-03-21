/**
 * BrainBank — Document Indexer
 * 
 * Indexes generic document collections (markdown, text, etc.)
 * with heading-aware smart chunking, inspired by qmd.
 * 
 *   const indexer = new DocIndexer(db, embedding, hnsw, vecCache);
 *   await indexer.indexCollection('notes', '/path/to/notes', '**\/*.md');
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { glob } from 'node:fs/promises';
import type { Database } from '../storage/database.ts';
import type { EmbeddingProvider, VectorIndex } from '../types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';

// ── Break Point Scoring (qmd-inspired) ──────────────

interface BreakPoint {
    pos: number;      // character position
    score: number;    // break quality (higher = better)
}

const BREAK_SCORES: [RegExp, number][] = [
    [/^# /,      100],   // H1
    [/^## /,      90],   // H2
    [/^### /,     80],   // H3
    [/^#### /,    70],   // H4
    [/^##### /,   60],   // H5
    [/^###### /,  50],   // H6
    [/^```/,      80],   // Code fence
    [/^---$/,     60],   // Horizontal rule
    [/^\*\*\*$/,  60],   // Horizontal rule alt
    [/^$/,        20],   // Blank line (paragraph break)
    [/^[-*+] /,    5],   // List item
];

// ── Chunk Target ────────────────────────────────────

const TARGET_CHARS = 3000;       // ~900 tokens
const WINDOW_CHARS = 600;        // search window before cutoff
const MIN_CHUNK_CHARS = 200;     // don't create tiny chunks

// ── DocIndexer ──────────────────────────────────────

export class DocIndexer {
    constructor(
        private _db: Database,
        private _embedding: EmbeddingProvider,
        private _hnsw: HNSWIndex,
        private _vecCache: Map<number, Float32Array>,
    ) {}

    /**
     * Index all documents in a collection.
     * Incremental — skips unchanged files (by content hash).
     */
    async indexCollection(
        collection: string,
        dirPath: string,
        pattern: string = '**/*.md',
        options: {
            ignore?: string[];
            onProgress?: (file: string, current: number, total: number) => void;
        } = {},
    ): Promise<{ indexed: number; skipped: number; chunks: number }> {
        // Resolve absolute path
        const absDir = path.resolve(dirPath);
        if (!fs.existsSync(absDir)) {
            throw new Error(`Collection path does not exist: ${absDir}`);
        }

        // Find files matching pattern
        const files: string[] = [];
        for await (const entry of glob(pattern, { cwd: absDir })) {
            const fullPath = path.join(absDir, entry);
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) {
                // Check ignore patterns
                const shouldIgnore = options.ignore?.some(ig => {
                    const igRegex = new RegExp(ig.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
                    return igRegex.test(entry);
                });
                if (!shouldIgnore) {
                    files.push(entry); // relative path
                }
            }
        }

        let indexed = 0;
        let skipped = 0;
        let totalChunks = 0;

        for (let i = 0; i < files.length; i++) {
            const relPath = files[i];
            const absPath = path.join(absDir, relPath);

            options.onProgress?.(relPath, i + 1, files.length);

            // Read content and hash
            const content = fs.readFileSync(absPath, 'utf-8');
            const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);

            // Check if already indexed with same hash
            const existing = this._db.prepare(
                'SELECT id FROM doc_chunks WHERE collection = ? AND file_path = ? AND content_hash = ? LIMIT 1'
            ).get(collection, relPath, hash) as any;

            if (existing) {
                skipped++;
                continue;
            }

            // Remove old chunks for this file
            this._db.prepare(
                'DELETE FROM doc_chunks WHERE collection = ? AND file_path = ?'
            ).run(collection, relPath);

            // Extract title and chunk
            const title = this._extractTitle(content, relPath);
            const chunks = this._smartChunk(content);

            // Insert chunks
            const insertChunk = this._db.prepare(`
                INSERT INTO doc_chunks (collection, file_path, title, content, seq, pos, content_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            const chunkIds: number[] = [];

            this._db.transaction(() => {
                for (let seq = 0; seq < chunks.length; seq++) {
                    const chunk = chunks[seq];
                    const result = insertChunk.run(
                        collection, relPath, title, chunk.text, seq, chunk.pos, hash,
                    );
                    chunkIds.push(Number(result.lastInsertRowid));
                }
            });

            // Generate embeddings
            const texts = chunks.map(c => `title: ${title} | text: ${c.text}`);
            const embeddings = await this._embedding.embedBatch(texts);

            // Store vectors
            const insertVec = this._db.prepare(
                'INSERT OR REPLACE INTO doc_vectors (chunk_id, embedding) VALUES (?, ?)'
            );

            this._db.transaction(() => {
                for (let j = 0; j < chunkIds.length; j++) {
                    const buf = Buffer.from(embeddings[j].buffer);
                    insertVec.run(chunkIds[j], buf);
                    this._hnsw.add(embeddings[j], chunkIds[j]);
                    this._vecCache.set(chunkIds[j], embeddings[j]);
                }
            });

            indexed++;
            totalChunks += chunks.length;
        }

        return { indexed, skipped, chunks: totalChunks };
    }

    /**
     * Remove all indexed data for a collection.
     */
    removeCollection(collection: string): void {
        this._db.prepare('DELETE FROM doc_chunks WHERE collection = ?').run(collection);
        this._db.prepare('DELETE FROM collections WHERE name = ?').run(collection);
        this._db.prepare('DELETE FROM path_contexts WHERE collection = ?').run(collection);
    }

    // ── Smart Chunking ──────────────────────────────

    /**
     * Split document into chunks at natural markdown boundaries.
     * Uses heading-aware scoring like qmd.
     */
    private _smartChunk(text: string): { text: string; pos: number }[] {
        if (text.length <= TARGET_CHARS) {
            return [{ text, pos: 0 }];
        }

        const lines = text.split('\n');
        const breakPoints = this._findBreakPoints(lines);
        const chunks: { text: string; pos: number }[] = [];

        let chunkStart = 0;  // char position
        let lineStart = 0;   // line index

        while (chunkStart < text.length) {
            const remaining = text.length - chunkStart;
            if (remaining <= TARGET_CHARS + WINDOW_CHARS) {
                // Last chunk — take everything
                const lastText = text.slice(chunkStart).trim();
                if (lastText.length >= MIN_CHUNK_CHARS) {
                    chunks.push({ text: lastText, pos: chunkStart });
                } else if (chunks.length > 0) {
                    // Merge with previous chunk
                    chunks[chunks.length - 1].text += '\n' + lastText;
                } else {
                    chunks.push({ text: lastText, pos: chunkStart });
                }
                break;
            }

            // Find best break point in window
            const targetEnd = chunkStart + TARGET_CHARS;
            const windowStart = targetEnd - WINDOW_CHARS;

            let bestBreak = targetEnd;
            let bestScore = 0;

            for (const bp of breakPoints) {
                if (bp.pos <= chunkStart) continue;
                if (bp.pos > targetEnd + WINDOW_CHARS / 2) break;
                if (bp.pos < windowStart) continue;

                // Score decay: prefer closer break points
                const distance = Math.abs(bp.pos - targetEnd);
                const decay = 1 - (distance / WINDOW_CHARS) ** 2 * 0.7;
                const finalScore = bp.score * decay;

                if (finalScore > bestScore) {
                    bestScore = finalScore;
                    bestBreak = bp.pos;
                }
            }

            const chunkText = text.slice(chunkStart, bestBreak).trim();
            if (chunkText.length >= MIN_CHUNK_CHARS) {
                chunks.push({ text: chunkText, pos: chunkStart });
            }

            chunkStart = bestBreak;
        }

        return chunks;
    }

    /**
     * Find all potential break points in the document with scores.
     */
    private _findBreakPoints(lines: string[]): BreakPoint[] {
        const points: BreakPoint[] = [];
        let charPos = 0;
        let inCodeBlock = false;

        for (const line of lines) {
            // Track code fences
            if (line.trimStart().startsWith('```')) {
                inCodeBlock = !inCodeBlock;
                if (!inCodeBlock) {
                    // End of code block is a good break point
                    points.push({ pos: charPos + line.length + 1, score: 80 });
                }
                charPos += line.length + 1;
                continue;
            }

            // Skip break points inside code blocks
            if (inCodeBlock) {
                charPos += line.length + 1;
                continue;
            }

            // Score this line as a potential break point
            for (const [pattern, score] of BREAK_SCORES) {
                if (pattern.test(line.trim())) {
                    points.push({ pos: charPos, score });
                    break;
                }
            }

            charPos += line.length + 1;
        }

        return points;
    }

    /**
     * Extract document title from first heading or filename.
     */
    private _extractTitle(content: string, filePath: string): string {
        const match = content.match(/^#{1,3}\s+(.+)$/m);
        if (match) return match[1].trim();
        return path.basename(filePath, path.extname(filePath));
    }
}
