/**
 * BrainBank — Chunk Enrichment Strategies
 *
 * Enrich doc chunk text before embedding with document-level context.
 * The enriched text is used ONLY for embedding — the stored content stays raw.
 *
 *   import { summaryEnrichment } from 'brainbank/docs';
 *   brain.use(docs({ enrichment: summaryEnrichment() }));
 */

/** Context passed to enrichment strategies for each chunk. */
export interface ChunkContext {
    /** Document title (from first heading or filename). */
    title: string;
    /** Relative file path (e.g. "operations/swagger.md"). */
    filePath: string;
    /** Parent folder name (e.g. "operations"). */
    folder: string;
    /** Raw chunk text content. */
    content: string;
    /** First ~500 chars of the full document (intro/summary). */
    docSummary: string;
    /** All headings extracted from the full document. */
    headings: string[];
    /** Chunk sequence index (0-based). */
    seq: number;
    /** Total number of chunks in this document. */
    totalChunks: number;
}

/** Enriches chunk text before embedding with document-level context. */
export interface ChunkEnrichment {
    readonly name: string;
    /** Build the text that will be embedded. Raw content stays in DB unchanged. */
    enrich(ctx: ChunkContext): string;
}

// ── Built-in Strategies ──────────────────────────────

/** No enrichment — embeds "title: X | text: Y" (current default behavior). */
export function noneEnrichment(): ChunkEnrichment {
    return {
        name: 'none',
        enrich(ctx: ChunkContext): string {
            return `title: ${ctx.title} | text: ${ctx.content}`;
        },
    };
}

/**
 * Summary enrichment — prepends document-level context before the chunk.
 *
 * Embedding text becomes:
 *   Document: "Notifications Architecture With Redis"
 *   Path: backend/notifications.md
 *   Sections: Overview, Redis Pub/Sub Flow, Worker Processing
 *   ---
 *   [chunk content]
 *
 * This helps embeddings capture cross-document relationships:
 * - A chunk about "Redis message routing" now also embeds "notifications"
 * - A chunk about "HL7 sync" now also embeds its folder "vendor"
 */
export function summaryEnrichment(): ChunkEnrichment {
    return {
        name: 'summary',
        enrich(ctx: ChunkContext): string {
            const parts: string[] = [];

            parts.push(`Document: "${ctx.title}"`);

            if (ctx.folder && ctx.folder !== '.') {
                parts.push(`Path: ${ctx.filePath}`);
            }

            if (ctx.headings.length > 0) {
                parts.push(`Sections: ${ctx.headings.join(', ')}`);
            }

            if (ctx.seq === 0 && ctx.totalChunks > 1) {
                parts.push(`(Part 1 of ${ctx.totalChunks})`);
            } else if (ctx.totalChunks > 1) {
                parts.push(`(Part ${ctx.seq + 1} of ${ctx.totalChunks})`);
            }

            // For non-first chunks, add a brief document intro
            if (ctx.seq > 0 && ctx.docSummary) {
                const intro = ctx.docSummary.slice(0, 200).trim();
                parts.push(`Context: ${intro}...`);
            }

            parts.push('---');
            parts.push(ctx.content);

            return parts.join('\n');
        },
    };
}
