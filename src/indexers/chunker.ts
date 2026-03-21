/**
 * BrainBank — Code Chunker
 * 
 * Language-aware code splitting into semantic blocks.
 * Detects functions, classes, and methods using regex + brace balancing.
 * Falls back to sliding window for unsupported languages.
 */

import type { CodeChunk } from '../types.ts';

// ── Configuration ───────────────────────────────────

export interface ChunkerConfig {
    /** Max lines per chunk. Default: 80 */
    maxLines?: number;
    /** Min lines for a detected block to be a chunk. Default: 3 */
    minLines?: number;
    /** Overlap between adjacent generic chunks. Default: 5 */
    overlap?: number;
}

// ── CodeChunker ─────────────────────────────────────

export class CodeChunker {
    private MAX: number;
    private MIN: number;
    private OVERLAP: number;

    constructor(config: ChunkerConfig = {}) {
        this.MAX = config.maxLines ?? 80;
        this.MIN = config.minLines ?? 3;
        this.OVERLAP = config.overlap ?? 5;
    }

    /**
     * Split file content into semantic chunks.
     * Small files (< maxLines) become a single chunk.
     * For JS/TS/Python: detects functions and classes.
     * For other languages: sliding window with overlap.
     */
    chunk(filePath: string, content: string, language: string): CodeChunk[] {
        const lines = content.split('\n');

        // Small file → single chunk
        if (lines.length <= this.MAX) {
            return [{
                filePath,
                chunkType: 'file',
                startLine: 1,
                endLine: lines.length,
                content: content.trim(),
                language,
            }];
        }

        switch (language) {
            case 'typescript':
            case 'javascript':
                return this._chunkJS(filePath, lines, language);
            case 'python':
                return this._chunkPython(filePath, lines, language);
            default:
                return this._chunkGeneric(filePath, lines, language);
        }
    }

    // ── JS / TS Strategy ────────────────────────────

    private _chunkJS(filePath: string, lines: string[], language: string): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const funcRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
        const constFuncRe = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/;
        const classRe = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;
        const arrowRe = /^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\S+)?\s*=>/;
        const interfaceRe = /^(?:export\s+)?(?:interface|type)\s+(\w+)/;

        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trim();
            const fm = line.match(funcRe) || line.match(constFuncRe) || line.match(arrowRe);
            const cm = line.match(classRe);
            const im = line.match(interfaceRe);

            if (fm || cm || im) {
                const name = fm?.[1] || cm?.[1] || im?.[1] || 'default';
                const type = cm ? 'class' : im ? 'interface' : 'function';
                const start = i;
                const end = this._findBlockEnd(lines, i);

                if (end - start >= this.MIN) {
                    if (end - start > this.MAX) {
                        chunks.push(...this._splitLarge(filePath, lines, start, end, name, type, language));
                    } else {
                        const content = lines.slice(start, end + 1).join('\n').trim();
                        chunks.push({
                            filePath,
                            chunkType: type,
                            name,
                            startLine: start + 1,
                            endLine: end + 1,
                            content,
                            language,
                        });
                    }
                    i = end + 1;
                    continue;
                }
            }
            i++;
        }

        // If we found semantic chunks, filter noise and return
        if (chunks.length > 0) {
            return chunks.filter(c => c.content.length > 20);
        }

        // Fallback to generic
        return this._chunkGeneric(filePath, lines, language);
    }

    // ── Python Strategy ─────────────────────────────

    private _chunkPython(filePath: string, lines: string[], language: string): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        let i = 0;

        while (i < lines.length) {
            const funcMatch = lines[i].match(/^(?:async\s+)?def\s+(\w+)/);
            const classMatch = lines[i].match(/^class\s+(\w+)/);

            if (funcMatch || classMatch) {
                const name = funcMatch?.[1] || classMatch?.[1]!;
                const type = classMatch ? 'class' : 'function';
                const start = i;
                const baseIndent = (lines[i].match(/^(\s*)/) ?? ['', ''])[1].length;

                let end = i + 1;
                while (end < lines.length) {
                    const line = lines[end];
                    if (line.trim() !== '') {
                        const indent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
                        if (indent <= baseIndent) break;
                    }
                    end++;
                }
                end = Math.min(end - 1, lines.length - 1);

                if (end - start >= this.MIN) {
                    const content = lines.slice(start, end + 1).join('\n').trim();
                    chunks.push({
                        filePath,
                        chunkType: type,
                        name,
                        startLine: start + 1,
                        endLine: end + 1,
                        content,
                        language,
                    });
                }
                i = end + 1;
                continue;
            }
            i++;
        }

        return chunks.length > 0 ? chunks : this._chunkGeneric(filePath, lines, language);
    }

    // ── Generic Strategy (sliding window) ───────────

    private _chunkGeneric(filePath: string, lines: string[], language: string): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const step = this.MAX - this.OVERLAP;

        for (let s = 0; s < lines.length; s += step) {
            const e = Math.min(s + this.MAX, lines.length);
            const content = lines.slice(s, e).join('\n').trim();
            if (content.length > 20) {
                chunks.push({
                    filePath,
                    chunkType: 'block',
                    startLine: s + 1,
                    endLine: e,
                    content,
                    language,
                });
            }
            if (e >= lines.length) break;
        }

        return chunks;
    }

    // ── Block End Detection (brace balance) ─────────

    private _findBlockEnd(lines: string[], start: number): number {
        let depth = 0;
        let foundOpen = false;

        for (let i = start; i < lines.length; i++) {
            for (const c of lines[i]) {
                if (c === '{') { depth++; foundOpen = true; }
                if (c === '}') depth--;
            }
            if (foundOpen && depth === 0) return i;
        }

        // No brace-balanced end found — take up to MAX lines
        return Math.min(start + this.MAX, lines.length - 1);
    }

    // ── Split Large Blocks ──────────────────────────

    private _splitLarge(
        filePath: string,
        lines: string[],
        start: number,
        end: number,
        name: string,
        type: string,
        language: string,
    ): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const step = this.MAX - this.OVERLAP;
        let part = 1;

        for (let s = start; s <= end; s += step) {
            const e = Math.min(s + this.MAX, end + 1);
            const content = lines.slice(s, e).join('\n').trim();
            chunks.push({
                filePath,
                chunkType: type,
                name: `${name} (part ${part++})`,
                startLine: s + 1,
                endLine: e,
                content,
                language,
            });
            if (e > end) break;
        }

        return chunks;
    }
}
