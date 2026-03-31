/**
 * @brainbank/docs — Document Indexer
 * 
 * Indexes generic document collections (markdown, text, etc.)
 * with heading-aware smart chunking, inspired by qmd.
 * 
 *   const indexer = new DocsIndexer(db, embedding, hnsw, vecCache);
 *   await indexer.indexCollection('notes', '/path/to/notes', '**\/*.md');
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type { EmbeddingProvider } from 'brainbank';
import type { HNSWIndex } from 'brainbank';

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


/** Ignored output/vendor directories when walking docs. */
const IGNORED_DOC_DIRS = new Set([
    'node_modules', '.git', '.hg', '.svn',
    'dist', 'build', 'out', 'coverage', '.next',
    '__pycache__', '.tox', '.venv', 'venv',
    'vendor', 'target', '.cache', '.turbo',
]);

// ── DocsIndexer ──────────────────────────────────────

export class DocsIndexer {
    constructor(
        private _db: any,
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
        const absDir = path.resolve(dirPath);
        if (!fs.existsSync(absDir)) {
            throw new Error(`Collection path does not exist: ${absDir}`);
        }

        const files = this._walkFiles(absDir, pattern, options.ignore);
        let indexed = 0, skipped = 0, totalChunks = 0;

        for (let i = 0; i < files.length; i++) {
            const relPath = files[i];
            options.onProgress?.(relPath, i + 1, files.length);

            const absPath = path.join(absDir, relPath);
            const content = fs.readFileSync(absPath, 'utf-8');
            const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);

            if (this._isUnchanged(collection, relPath, hash)) {
                skipped++;
                continue;
            }

            this._removeOldChunks(collection, relPath);
            const chunkCount = await this._indexFile(collection, relPath, content, hash);
            indexed++;
            totalChunks += chunkCount;
        }

        return { indexed, skipped, chunks: totalChunks };
    }

    /** Walk directory tree and collect matching files. */
    private _walkFiles(absDir: string, pattern: string, ignore?: string[]): string[] {
        const patternExt = pattern.match(/\.(\w+)$/)?.[1];
        const files: string[] = [];

        const walk = (dir: string, base: string): void => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
            catch { return; }
            for (const e of entries) {
                const rel = base ? `${base}/${e.name}` : e.name;
                if (e.isDirectory()) {
                    if (IGNORED_DOC_DIRS.has(e.name)) continue;
                    walk(path.join(dir, e.name), rel);
                } else if (e.isFile()) {
                    if (this._isIgnoredFile(rel, ignore)) continue;
                    const ext = path.extname(e.name).slice(1);
                    if (!patternExt || ext === patternExt) files.push(rel);
                }
            }
        };
        walk(absDir, '');
        return files;
    }

    /** Check if a file matches any ignore patterns (glob syntax). */
    private _isIgnoredFile(relPath: string, ignore?: string[]): boolean {
        if (!ignore) return false;
        return ignore.some(ig => {
            // Escape regex-special chars, then convert glob syntax
            const regex = ig
                .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (not * ?)
                .replace(/\*\*/g, '\x00')              // placeholder for **
                .replace(/\*/g, '[^/]*')               // * = anything except /
                .replace(/\?/g, '.')                    // ? = any single char
                .replace(/\x00/g, '.*');                // ** = anything including /
            return new RegExp(`^${regex}$`).test(relPath);
        });
    }

    /** Check if all chunks for a file match the current hash and have vectors. */
    private _isUnchanged(collection: string, relPath: string, hash: string): boolean {
        const existing = this._db.prepare(
            `SELECT dc.id, dc.content_hash, dv.chunk_id AS has_vector
             FROM doc_chunks dc
             LEFT JOIN doc_vectors dv ON dv.chunk_id = dc.id
             WHERE dc.collection = ? AND dc.file_path = ?`
        ).all(collection, relPath) as any[];

        return existing.length > 0 &&
            existing.every((c: any) => c.content_hash === hash && c.has_vector != null);
    }

    /** Remove old chunks and their HNSW vectors for a file. */
    private _removeOldChunks(collection: string, relPath: string): void {
        const oldChunks = this._db.prepare(
            'SELECT id FROM doc_chunks WHERE collection = ? AND file_path = ?'
        ).all(collection, relPath) as any[];

        for (const old of oldChunks) {
            this._hnsw.remove(old.id);
            this._vecCache.delete(old.id);
        }
        this._db.prepare(
            'DELETE FROM doc_chunks WHERE collection = ? AND file_path = ?'
        ).run(collection, relPath);
    }

    /** Index a single file: chunk, embed, store in DB + HNSW. */
    private async _indexFile(
        collection: string, relPath: string, content: string, hash: string,
    ): Promise<number> {
        const title = this._extractTitle(content, relPath);
        const chunks = this._smartChunk(content);

        // Embed FIRST — if this throws, no orphaned rows are left in DB
        const texts = chunks.map(c => `title: ${title} | text: ${c.text}`);
        const embeddings = await this._embedding.embedBatch(texts);

        const insertChunk = this._db.prepare(`
            INSERT INTO doc_chunks (collection, file_path, title, content, seq, pos, content_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const insertVec = this._db.prepare(
            'INSERT OR REPLACE INTO doc_vectors (chunk_id, embedding) VALUES (?, ?)'
        );

        // Single transaction: chunks + vectors atomically (no partial state)
        const chunkIds: number[] = [];
        this._db.transaction(() => {
            for (let seq = 0; seq < chunks.length; seq++) {
                const result = insertChunk.run(
                    collection, relPath, title, chunks[seq].text, seq, chunks[seq].pos, hash,
                );
                const id = Number(result.lastInsertRowid);
                chunkIds.push(id);
                insertVec.run(id, Buffer.from(embeddings[seq].buffer));
            }
        });

        // HNSW mutations AFTER successful commit
        for (let j = 0; j < chunkIds.length; j++) {
            this._hnsw.add(embeddings[j], chunkIds[j]);
            this._vecCache.set(chunkIds[j], embeddings[j]);
        }

        return chunks.length;
    }

    /** Remove all indexed data for a collection. */
    removeCollection(collection: string): void {
        const chunks = this._db.prepare(
            'SELECT id FROM doc_chunks WHERE collection = ?'
        ).all(collection) as any[];
        for (const chunk of chunks) {
            this._hnsw.remove(chunk.id);
            this._vecCache.delete(chunk.id);
        }

        this._db.prepare('DELETE FROM doc_chunks WHERE collection = ?').run(collection);
        this._db.prepare('DELETE FROM collections WHERE name = ?').run(collection);
        this._db.prepare('DELETE FROM path_contexts WHERE collection = ?').run(collection);
    }

    // ── Smart Chunking ──────────────────────────────

    /** Split document into chunks at natural markdown boundaries. */
    private _smartChunk(text: string): { text: string; pos: number }[] {
        if (text.length <= TARGET_CHARS) {
            return [{ text, pos: 0 }];
        }

        const lines = text.split('\n');
        const breakPoints = this._findBreakPoints(lines);
        const chunks: { text: string; pos: number }[] = [];
        let chunkStart = 0;

        while (chunkStart < text.length) {
            const remaining = text.length - chunkStart;
            if (remaining <= TARGET_CHARS + WINDOW_CHARS) {
                this._flushRemainder(text, chunkStart, chunks);
                break;
            }

            const bestBreak = this._findBestBreak(chunkStart, breakPoints);
            const chunkText = text.slice(chunkStart, bestBreak).trim();
            if (chunkText.length >= MIN_CHUNK_CHARS) {
                chunks.push({ text: chunkText, pos: chunkStart });
            }
            chunkStart = bestBreak;
        }

        return chunks;
    }

    /** Handle the last chunk: merge if too small, otherwise push. */
    private _flushRemainder(
        text: string, chunkStart: number, chunks: { text: string; pos: number }[],
    ): void {
        const lastText = text.slice(chunkStart).trim();
        if (lastText.length >= MIN_CHUNK_CHARS) {
            chunks.push({ text: lastText, pos: chunkStart });
        } else if (chunks.length > 0) {
            chunks[chunks.length - 1].text += '\n' + lastText;
        } else {
            chunks.push({ text: lastText, pos: chunkStart });
        }
    }

    /** Find the best break position within the target window. */
    private _findBestBreak(chunkStart: number, breakPoints: BreakPoint[]): number {
        const targetEnd = chunkStart + TARGET_CHARS;
        const windowStart = targetEnd - WINDOW_CHARS;

        let bestBreak = targetEnd;
        let bestScore = 0;

        for (const bp of breakPoints) {
            if (bp.pos <= chunkStart) continue;
            if (bp.pos > targetEnd + WINDOW_CHARS / 2) break;
            if (bp.pos < windowStart) continue;

            const distance = Math.abs(bp.pos - targetEnd);
            const decay = 1 - (distance / WINDOW_CHARS) ** 2 * 0.7;
            const finalScore = bp.score * decay;

            if (finalScore > bestScore) {
                bestScore = finalScore;
                bestBreak = bp.pos;
            }
        }

        return bestBreak;
    }

    /** Find all potential break points in the document with scores. */
    private _findBreakPoints(lines: string[]): BreakPoint[] {
        const points: BreakPoint[] = [];
        let charPos = 0;
        let inCodeBlock = false;

        for (const line of lines) {
            if (line.trimStart().startsWith('```')) {
                inCodeBlock = !inCodeBlock;
                if (!inCodeBlock) {
                    points.push({ pos: charPos + line.length + 1, score: 80 });
                }
                charPos += line.length + 1;
                continue;
            }

            if (inCodeBlock) {
                charPos += line.length + 1;
                continue;
            }

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

    /** Extract document title from first heading or filename. */
    private _extractTitle(content: string, filePath: string): string {
        const match = content.match(/^#{1,3}\s+(.+)$/m);
        if (match) return match[1].trim();
        return path.basename(filePath, path.extname(filePath));
    }
}
