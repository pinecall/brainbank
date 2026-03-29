/**
 * Example: Notes Plugin for BrainBank
 *
 * Reads .txt files from a local directory and indexes them for semantic search.
 * No external APIs — everything runs locally.
 *
 * This example demonstrates:
 *   - Plugin lifecycle (initialize, index, search, close)
 *   - IndexablePlugin (joins brain.index())
 *   - SearchablePlugin (participates in brain.search() via RRF)
 *   - @expose decorator (injects methods onto brain)
 *   - Collection API (add, update, search, remove)
 *   - Idempotent indexing (skip unchanged files, update modified ones)
 *   - WatchablePlugin (auto-re-index on file changes)
 *   - Factory function export pattern
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin, PluginContext, SearchResult } from 'brainbank';
import { expose } from 'brainbank';

// ── Options ──────────────────────────────────────────

export interface NotesPluginOptions {
    /** Directory containing .txt files. Default: './notes' */
    dir?: string;
    /** Plugin name (for multi-instance). Default: 'notes' */
    name?: string;
}

// ── Plugin Class ─────────────────────────────────────

class NotesPlugin implements Plugin {
    readonly name: string;
    private ctx!: PluginContext;
    private dir: string;

    constructor(opts: NotesPluginOptions = {}) {
        this.name = opts.name ?? 'notes';
        this.dir = opts.dir ?? './notes';
    }

    // ── Lifecycle ────────────────────────────────────
    // Called by brain.initialize() — set up state, collections are auto-created.

    async initialize(ctx: PluginContext): Promise<void> {
        this.ctx = ctx;
    }

    // ── IndexablePlugin ─────────────────────────────
    // Implementing index() makes this plugin run during brain.index()

    async index(): Promise<{ indexed: number; skipped: number; chunks: number }> {
        const store = this.ctx.collection('notes');
        const notesDir = path.resolve(this.ctx.config.repoPath, this.dir);

        if (!fs.existsSync(notesDir)) {
            return { indexed: 0, skipped: 0, chunks: 0 };
        }

        const files = fs.readdirSync(notesDir).filter(f => f.endsWith('.txt'));
        let indexed = 0;
        let skipped = 0;

        for (const file of files) {
            const filePath = path.join(notesDir, file);
            const content = fs.readFileSync(filePath, 'utf-8').trim();
            if (!content) continue;

            // Idempotent: find existing entry for this file
            const existing = store.list({ limit: 1000 }).find(
                i => i.metadata.file === file
            );

            if (existing) {
                if (existing.content === content) {
                    skipped++;
                    continue; // Unchanged — skip
                }
                // Content changed — update (re-embeds)
                await store.update(existing.id, content);
                indexed++;
                continue;
            }

            // New file — add
            await store.add(content, {
                tags: ['note'],
                metadata: {
                    file,
                    path: filePath,
                    size: content.length,
                    modified: fs.statSync(filePath).mtimeMs,
                },
            });
            indexed++;
        }

        // Remove entries for deleted files
        const existingEntries = store.list({ limit: 10000 });
        for (const entry of existingEntries) {
            const file = entry.metadata.file as string;
            if (!files.includes(file)) {
                store.remove(entry.id);
            }
        }

        return { indexed, skipped, chunks: indexed };
    }

    // ── SearchablePlugin ────────────────────────────
    // Implementing search() merges results into brain.search() via RRF

    async search(query: string, options?: { k?: number }): Promise<SearchResult[]> {
        const store = this.ctx.collection('notes');
        const hits = await store.search(query, { k: options?.k ?? 5 });
        return hits.map(h => ({
            type: 'collection' as const,
            score: h.score ?? 0,
            content: h.content,
            metadata: { source: 'notes', ...h.metadata },
        }));
    }

    // ── @expose Methods ─────────────────────────────
    // Injected onto brain after initialize(): brain.searchNotes(), brain.listNotes()

    @expose
    async searchNotes(query: string, k = 5): Promise<SearchResult[]> {
        return this.search(query, { k });
    }

    @expose
    listNotes(): { file: string; size: number }[] {
        return this.ctx.collection('notes').list({ limit: 1000 }).map(i => ({
            file: i.metadata.file as string,
            size: i.content.length,
        }));
    }

    // ── WatchablePlugin ─────────────────────────────
    // Auto-re-index when .txt files change

    watchPatterns(): string[] {
        return ['**/*.txt'];
    }

    async onFileChange(filePath: string, event: 'create' | 'update' | 'delete'): Promise<boolean> {
        const store = this.ctx.collection('notes');
        const file = path.basename(filePath);

        // Remove old entry
        const existing = store.list({ limit: 1000 }).find(
            i => i.metadata.file === file
        );
        if (existing) store.remove(existing.id);

        // Re-add if not deleted
        if (event !== 'delete' && fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8').trim();
            if (content) {
                await store.add(content, {
                    tags: ['note'],
                    metadata: { file, path: filePath, size: content.length },
                });
            }
        }

        return true; // handled
    }

    // ── Stats ───────────────────────────────────────

    stats(): Record<string, number> {
        return { notes: this.ctx.collection('notes').count() };
    }
}

// ── Factory Function ─────────────────────────────────

/** Create a notes plugin. */
export function notes(opts?: NotesPluginOptions): Plugin {
    return new NotesPlugin(opts);
}
