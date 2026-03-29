/**
 * brainbank-csv — CSV Indexing Plugin
 *
 * Reads .csv files from a local directory and indexes each row as a
 * searchable item. No external APIs — everything runs locally.
 *
 * This is a complete example of how to build a BrainBank plugin package
 * that can be published to npm and installed by anyone.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin, PluginContext, SearchResult } from 'brainbank';
import { expose } from 'brainbank';

// ── Options ──────────────────────────────────────────

export interface CsvPluginOptions {
    /** Directory containing .csv files. Default: './data' */
    dir?: string;
    /** Plugin name (for multi-instance). Default: 'csv' */
    name?: string;
}

// ── Plugin Class ─────────────────────────────────────

class CsvPlugin implements Plugin {
    readonly name: string;
    private ctx!: PluginContext;
    private dir: string;

    constructor(opts: CsvPluginOptions = {}) {
        this.name = opts.name ?? 'csv';
        this.dir = opts.dir ?? './data';
    }

    async initialize(ctx: PluginContext): Promise<void> {
        this.ctx = ctx;
    }

    // ── IndexablePlugin ─────────────────────────────

    async index(): Promise<{ indexed: number; skipped: number; chunks: number }> {
        const store = this.ctx.collection('csv_data');
        const dataDir = path.resolve(this.ctx.config.repoPath, this.dir);

        if (!fs.existsSync(dataDir)) {
            return { indexed: 0, skipped: 0, chunks: 0 };
        }

        const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));
        let indexed = 0;
        let skipped = 0;

        for (const file of files) {
            const filePath = path.join(dataDir, file);
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            if (!raw) continue;

            const lines = raw.split('\n');
            const header = lines[0];
            const rows = lines.slice(1);

            // Remove old entries for this file before re-indexing
            const existing = store.list({ limit: 10000 }).filter(
                i => i.metadata.file === file
            );
            for (const entry of existing) store.remove(entry.id);

            // Index each row with its header for context
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i].trim();
                if (!row) continue;

                const content = `${header}\n${row}`;
                await store.add(content, {
                    tags: ['csv', file.replace('.csv', '')],
                    metadata: {
                        file,
                        row: i + 1,
                        path: filePath,
                    },
                });
                indexed++;
            }
        }

        return { indexed, skipped, chunks: indexed };
    }

    // ── SearchablePlugin ────────────────────────────

    async search(query: string, options?: { k?: number }): Promise<SearchResult[]> {
        const store = this.ctx.collection('csv_data');
        const hits = await store.search(query, { k: options?.k ?? 5 });
        return hits.map(h => ({
            type: 'collection' as const,
            score: h.score ?? 0,
            content: h.content,
            metadata: { source: 'csv', ...h.metadata },
        }));
    }

    // ── @expose Methods ─────────────────────────────

    @expose
    async searchCsv(query: string, k = 5): Promise<SearchResult[]> {
        return this.search(query, { k });
    }

    @expose
    csvStats(): { rows: number; files: string[] } {
        const items = this.ctx.collection('csv_data').list({ limit: 10000 });
        const files = [...new Set(items.map(i => i.metadata.file as string))];
        return { rows: items.length, files };
    }

    // ── WatchablePlugin ─────────────────────────────

    watchPatterns(): string[] {
        return ['**/*.csv'];
    }

    async onFileChange(filePath: string, event: 'create' | 'update' | 'delete'): Promise<boolean> {
        // Re-index the whole directory on any change
        await this.index();
        return true;
    }

    // ── Stats ───────────────────────────────────────

    stats(): Record<string, any> {
        return this.csvStats();
    }
}

// ── Factory Function ─────────────────────────────────

/** Create a CSV indexing plugin. */
export function csv(opts?: CsvPluginOptions): Plugin {
    return new CsvPlugin(opts);
}
