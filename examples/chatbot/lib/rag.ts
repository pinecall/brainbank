/**
 * RAG helpers — index docs + build context for chatbot examples.
 * Zero dependencies beyond BrainBank core.
 */

import { BrainBank } from '../../../src/index.ts';
import { PerplexityContextEmbedding } from '../../../src/providers/embeddings/perplexity-context-embedding.ts';
import type { SearchResult } from '../../../src/types.ts';
import { c } from './ui.ts';

/** Parse --docs flag from CLI args. */
export function parseDocsPath(): string | undefined {
    const idx = process.argv.indexOf('--docs');
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    return process.env.BRAINBANK_DOCS || undefined;
}

/** Create a PerplexityContextEmbedding for docs-aware RAG. */
export function createDocsEmbedding(): PerplexityContextEmbedding {
    if (!process.env.PERPLEXITY_API_KEY) {
        console.error('⚠  Set PERPLEXITY_API_KEY for docs RAG');
        process.exit(1);
    }
    return new PerplexityContextEmbedding();
}

/** Index docs from the given path. Returns chunk count. */
export async function indexDocs(brain: BrainBank, docsPath: string): Promise<number> {
    const docsPlugin = brain.indexer('docs') as any;
    if (!docsPlugin) return 0;

    // Register collection (skip deprecated folder)
    docsPlugin.addCollection({
        name: 'project-docs',
        path: docsPath,
        pattern: '**/*.md',
        ignore: ['**/deprecated/**', '**/scratchpad/**'],
        context: 'Project documentation — architecture, backend, frontend, database, security, operations guides.',
    });

    console.log(`${c.dim}  📚 Indexing docs from ${docsPath}...${c.reset}`);

    const results = await docsPlugin.indexCollections({
        onProgress: (_col: string, file: string, cur: number, total: number) => {
            process.stdout.write(`\r${c.dim}  📚 [${cur}/${total}] ${file.slice(0, 50)}${c.reset}      `);
        },
    });

    const stats = results['project-docs'];
    const chunks = stats?.chunks ?? 0;
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    console.log(`${c.green}  📚 ${chunks} doc chunks indexed (${stats?.indexed ?? 0} files)${c.reset}`);

    return chunks;
}

/** Search docs and format top results as context for the system prompt. */
export async function buildRAGContext(brain: BrainBank, query: string, k: number = 3): Promise<string> {
    const docsPlugin = brain.indexer('docs') as any;
    if (!docsPlugin) return '';

    const results: SearchResult[] = await docsPlugin.search(query, { k, minScore: 0.2 });
    if (results.length === 0) return '';

    const sections = results.map((r, i) => {
        const title = (r.metadata as any)?.title || r.filePath?.split('/').pop() || 'Doc';
        const score = (r.score * 100).toFixed(0);
        return `### ${i + 1}. ${title} (${score}% match)\n${r.content.slice(0, 800)}`;
    });

    return `## Relevant Documentation\n\n${sections.join('\n\n')}`;
}

/** Search docs directly and display results. */
export async function searchDocs(brain: BrainBank, query: string): Promise<void> {
    const docsPlugin = brain.indexer('docs') as any;
    if (!docsPlugin) {
        console.log(`${c.yellow}  No docs indexed. Use --docs <path>${c.reset}`);
        return;
    }

    const results: SearchResult[] = await docsPlugin.search(query, { k: 5, minScore: 0.15 });
    if (results.length === 0) {
        console.log(`${c.dim}  No docs matched "${query}"${c.reset}`);
        return;
    }

    console.log(`\n${c.blue}  📚 ${results.length} doc results for "${query}":${c.reset}`);
    for (const r of results) {
        const title = (r.metadata as any)?.title || r.filePath?.split('/').pop() || 'Doc';
        const score = (r.score * 100).toFixed(0);
        const preview = r.content.slice(0, 120).replace(/\n/g, ' ');
        console.log(`${c.dim}     [${score}%] ${title}${c.reset}`);
        console.log(`${c.dim}           ${preview}...${c.reset}`);
    }
    console.log();
}
