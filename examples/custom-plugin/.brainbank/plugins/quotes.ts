/**
 * CLI Quotes Plugin — auto-discovered from .brainbank/plugins/
 *
 * Reads a quotes.txt file (one quote per line) and indexes each quote
 * as a separate searchable item. Different from the programmatic notes
 * plugin — this one splits a single file into individual items.
 *
 * Test it:
 *   cd examples/custom-plugin
 *   cp -r sample-data/quotes.txt .
 *   brainbank index
 *   brainbank search "simplicity"
 *   brainbank kv search quotes "code quality"
 */

import type { Plugin, PluginContext, SearchResult } from 'brainbank';
import { expose } from 'brainbank';
import * as fs from 'node:fs';
import * as path from 'node:path';

class QuotesPlugin implements Plugin {
    readonly name = 'quotes';
    private ctx!: PluginContext;
    private file: string;

    constructor(file = './quotes.txt') {
        this.file = file;
    }

    async initialize(ctx: PluginContext): Promise<void> {
        this.ctx = ctx;
    }

    async index(): Promise<{ indexed: number; skipped: number; chunks: number }> {
        const store = this.ctx.collection('quotes');
        const filePath = path.resolve(this.ctx.config.repoPath, this.file);

        if (!fs.existsSync(filePath)) {
            return { indexed: 0, skipped: 0, chunks: 0 };
        }

        // Clear old quotes and re-index
        store.clear();

        const lines = fs.readFileSync(filePath, 'utf-8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0);

        let indexed = 0;

        for (const line of lines) {
            // Parse "Quote text — Author" format
            const parts = line.split(' — ');
            const quote = parts[0].trim();
            const author = parts[1]?.trim() ?? 'Unknown';

            await store.add(quote, {
                tags: ['quote', author.toLowerCase().replace(/\s+/g, '-')],
                metadata: { author, line: indexed + 1 },
            });
            indexed++;
        }

        return { indexed, skipped: 0, chunks: indexed };
    }

    async search(query: string, options?: { k?: number }): Promise<SearchResult[]> {
        const store = this.ctx.collection('quotes');
        const hits = await store.search(query, { k: options?.k ?? 5 });
        return hits.map(h => ({
            type: 'collection' as const,
            score: h.score ?? 0,
            content: `"${h.content}" — ${h.metadata.author}`,
            metadata: { source: 'quotes', ...h.metadata },
        }));
    }

    @expose
    async searchQuotes(query: string, k = 5): Promise<SearchResult[]> {
        return this.search(query, { k });
    }

    @expose
    quoteCount(): number {
        return this.ctx.collection('quotes').count();
    }

    watchPatterns(): string[] {
        return ['**/quotes.txt'];
    }

    async onFileChange(): Promise<boolean> {
        await this.index();
        return true;
    }

    stats() {
        return { quotes: this.ctx.collection('quotes').count() };
    }
}

export default new QuotesPlugin('./quotes.txt');
