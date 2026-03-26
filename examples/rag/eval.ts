/**
 * 📊 BrainBank RAG Evaluator
 *
 * Measures retrieval quality over a golden dataset of queries.
 * Metrics: Recall@3, Recall@5, MRR (Mean Reciprocal Rank).
 *
 * Run:
 *   PERPLEXITY_API_KEY=pplx-... npx tsx examples/rag/eval.ts --docs ~/path/to/docs
 */

import { BrainBank } from '../../src/index.ts';
import { docs } from '../../src/indexers/docs/docs-plugin.ts';
import { PerplexityContextEmbedding } from '../../src/providers/embeddings/perplexity-context-embedding.ts';
import type { SearchResult } from '../../src/types.ts';

// ─── ANSI ───────────────────────────────────────────

const c = {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
    red: '\x1b[31m', blue: '\x1b[34m',
};

// ─── Golden Dataset ─────────────────────────────────

interface GoldenQuery {
    query: string;
    /** Substrings to match against filePath (case-insensitive). */
    expectedFiles: string[];
    category: string;
}

const GOLDEN: GoldenQuery[] = [
    // Backend
    { query: 'how does authentication work', expectedFiles: ['Passport and JWT Auth'], category: 'backend' },
    { query: 'notifications architecture with redis', expectedFiles: ['Notifications Architecture'], category: 'backend' },
    { query: 'job lifecycle and offer statuses', expectedFiles: ['Job and Offer Statuses'], category: 'backend' },
    { query: 'redis tenant message streams', expectedFiles: ['Redis Tenant Message Streams'], category: 'backend' },
    { query: 'backend logging with winston', expectedFiles: ['Backend Logging With Winston'], category: 'backend' },
    { query: 'XState driving job offer transitions', expectedFiles: ['XState Driving Job Offer'], category: 'backend' },
    { query: 'how does the storage system work', expectedFiles: ['Storage System'], category: 'backend' },
    { query: 'emailing service', expectedFiles: ['Emailing'], category: 'backend' },

    // Frontend
    { query: 'Vue paradigm standards', expectedFiles: ['Vue Paradigm Standards'], category: 'frontend' },
    { query: 'Pinia persistent state management', expectedFiles: ['Pinia Persistent State'], category: 'frontend' },
    { query: 'localization workflow i18n', expectedFiles: ['Localization-Workflow'], category: 'frontend' },
    { query: 'Aurora theming with sass scss', expectedFiles: ['Aurora Theming Sass'], category: 'frontend' },

    // Database
    { query: 'database migrations typeorm', expectedFiles: ['Database Migrations'], category: 'database' },
    { query: 'multi-tenant PHI PII handling', expectedFiles: ['Multi-Tenant PHI PII'], category: 'database' },
    { query: 'database seeding', expectedFiles: ['Database Seeding'], category: 'database' },

    // Operations
    { query: 'full stack architecture outline', expectedFiles: ['full_stack_architecture_outline'], category: 'operations' },
    { query: 'Aurora CI/CD workflow', expectedFiles: ['CI-CD-Workflow'], category: 'operations' },
    { query: 'swagger spec first development policy', expectedFiles: ['Swagger Spec-first'], category: 'operations' },
    { query: 'Azure CLI guide', expectedFiles: ['Azure CLI Guide'], category: 'operations' },
    { query: 'release tagging process', expectedFiles: ['AuroraReleaseTagging'], category: 'operations' },

    // Security
    { query: 'security policy', expectedFiles: ['security-policy'], category: 'security' },
    { query: 'threat modeling guide', expectedFiles: ['threat-modeling-guide'], category: 'security' },

    // Features
    { query: 'real time messaging system', expectedFiles: ['Real Time Messaging'], category: 'features' },
    { query: 'settings system configuration', expectedFiles: ['Settings System'], category: 'features' },
    { query: 'date time timezone handling', expectedFiles: ['DateTimeTimezoneHandling'], category: 'features' },
];

// ─── Metrics ────────────────────────────────────────

interface QueryResult {
    query: string;
    category: string;
    expectedFiles: string[];
    foundAt: number[];     // rank positions where expected files were found (1-indexed)
    topResults: string[];  // filenames of top results for debugging
}

function fileMatches(filePath: string, pattern: string): boolean {
    return filePath.toLowerCase().includes(pattern.toLowerCase());
}

function computeMRR(foundAt: number[]): number {
    if (foundAt.length === 0) return 0;
    return 1 / Math.min(...foundAt);
}

function recallAtK(foundAt: number[], k: number, totalExpected: number): number {
    const found = foundAt.filter(pos => pos <= k).length;
    return found / totalExpected;
}

// ─── Run Evaluation ─────────────────────────────────

async function main() {
    const docsIdx = process.argv.indexOf('--docs');
    if (docsIdx === -1 || !process.argv[docsIdx + 1]) {
        console.error(`${c.red}Usage: npx tsx examples/rag/eval.ts --docs <path>${c.reset}`);
        process.exit(1);
    }
    const docsPath = process.argv[docsIdx + 1];

    if (!process.env.PERPLEXITY_API_KEY) {
        console.error(`${c.yellow}⚠  Set PERPLEXITY_API_KEY${c.reset}`);
        process.exit(1);
    }

    // Initialize BrainBank with Perplexity Context embeddings
    const pplxEmbed = new PerplexityContextEmbedding();
    const dbPath = '/tmp/brainbank-rag-eval.db';
    const brain = new BrainBank({
        dbPath,
        embeddingProvider: pplxEmbed,
        embeddingDims: pplxEmbed.dims,
    });
    brain.use(docs());
    await brain.initialize();

    // Index docs
    const docsPlugin = brain.indexer('docs') as any;
    docsPlugin.addCollection({
        name: 'eval-docs',
        path: docsPath,
        pattern: '**/*.md',
        ignore: ['**/deprecated/**', '**/scratchpad/**'],
    });

    console.log(`\n${c.bold}${c.cyan}━━━ RAG Evaluation ━━━${c.reset}`);
    console.log(`${c.dim}  Indexing docs from ${docsPath}...${c.reset}`);

    await docsPlugin.indexCollections({
        onProgress: (_col: string, file: string, cur: number, total: number) => {
            process.stdout.write(`\r${c.dim}  📚 [${cur}/${total}] ${file.slice(0, 50)}${c.reset}      `);
        },
    });
    process.stdout.write('\r' + ' '.repeat(80) + '\r');

    const st = docsPlugin.stats();
    console.log(`${c.green}  ✓ ${st.chunks} chunks from ${st.documents} files${c.reset}`);
    console.log(`${c.dim}  Provider: Perplexity Context (${pplxEmbed.dims}d)${c.reset}`);
    console.log(`${c.dim}  Queries: ${GOLDEN.length}${c.reset}\n`);

    // Run queries
    const results: QueryResult[] = [];
    const K_MAX = 10;

    for (let i = 0; i < GOLDEN.length; i++) {
        const g = GOLDEN[i];
        process.stdout.write(`\r${c.dim}  Running [${i + 1}/${GOLDEN.length}] ${g.query.slice(0, 40)}...${c.reset}      `);

        const hits: SearchResult[] = await docsPlugin.search(g.query, { k: K_MAX, minScore: 0.05 });

        const foundAt: number[] = [];
        for (const expected of g.expectedFiles) {
            for (let rank = 0; rank < hits.length; rank++) {
                if (fileMatches(hits[rank].filePath ?? '', expected)) {
                    foundAt.push(rank + 1);
                    break;
                }
            }
        }

        results.push({
            query: g.query,
            category: g.category,
            expectedFiles: g.expectedFiles,
            foundAt,
            topResults: hits.slice(0, 5).map(h => h.filePath?.split('/').pop() ?? '?'),
        });
    }
    process.stdout.write('\r' + ' '.repeat(80) + '\r');

    // Compute metrics by category
    const categories = [...new Set(GOLDEN.map(g => g.category))];
    const table: { category: string; queries: number; recall3: number; recall5: number; mrr: number }[] = [];

    for (const cat of categories) {
        const catResults = results.filter(r => r.category === cat);
        const recall3 = catResults.reduce((sum, r) => sum + recallAtK(r.foundAt, 3, r.expectedFiles.length), 0) / catResults.length;
        const recall5 = catResults.reduce((sum, r) => sum + recallAtK(r.foundAt, 5, r.expectedFiles.length), 0) / catResults.length;
        const mrr = catResults.reduce((sum, r) => sum + computeMRR(r.foundAt), 0) / catResults.length;
        table.push({ category: cat, queries: catResults.length, recall3, recall5, mrr });
    }

    // Overall
    const overall3 = results.reduce((sum, r) => sum + recallAtK(r.foundAt, 3, r.expectedFiles.length), 0) / results.length;
    const overall5 = results.reduce((sum, r) => sum + recallAtK(r.foundAt, 5, r.expectedFiles.length), 0) / results.length;
    const overallMRR = results.reduce((sum, r) => sum + computeMRR(r.foundAt), 0) / results.length;

    // Print table
    const pad = (s: string, n: number) => s.padEnd(n);
    const pct = (v: number) => `${(v * 100).toFixed(0)}%`.padStart(5);
    const flt = (v: number) => v.toFixed(2).padStart(5);

    console.log(`${c.bold}  ${'Category'.padEnd(14)} ${'#'.padStart(3)} ${'R@3'.padStart(5)} ${'R@5'.padStart(5)} ${'MRR'.padStart(5)}${c.reset}`);
    console.log(`${c.dim}  ${'─'.repeat(14)} ${'───'} ${'─────'} ${'─────'} ${'─────'}${c.reset}`);

    for (const row of table) {
        const r3color = row.recall3 >= 0.8 ? c.green : row.recall3 >= 0.5 ? c.yellow : c.red;
        const r5color = row.recall5 >= 0.8 ? c.green : row.recall5 >= 0.5 ? c.yellow : c.red;
        console.log(
            `  ${pad(row.category, 14)} ${String(row.queries).padStart(3)} ` +
            `${r3color}${pct(row.recall3)}${c.reset} ${r5color}${pct(row.recall5)}${c.reset} ${flt(row.mrr)}`
        );
    }

    console.log(`${c.dim}  ${'─'.repeat(14)} ${'───'} ${'─────'} ${'─────'} ${'─────'}${c.reset}`);
    const o3color = overall3 >= 0.8 ? c.green : overall3 >= 0.5 ? c.yellow : c.red;
    const o5color = overall5 >= 0.8 ? c.green : overall5 >= 0.5 ? c.yellow : c.red;
    console.log(
        `${c.bold}  ${pad('Overall', 14)} ${String(results.length).padStart(3)} ` +
        `${o3color}${pct(overall3)}${c.reset} ${o5color}${pct(overall5)}${c.reset} ${flt(overallMRR)}${c.reset}`
    );

    // Show misses
    const misses = results.filter(r => r.foundAt.length < r.expectedFiles.length);
    if (misses.length > 0) {
        console.log(`\n${c.yellow}  ⚠  ${misses.length} queries with misses:${c.reset}`);
        for (const m of misses) {
            console.log(`${c.dim}     "${m.query}" → expected: ${m.expectedFiles.join(', ')}${c.reset}`);
            console.log(`${c.dim}       got: ${m.topResults.join(', ')}${c.reset}`);
        }
    } else {
        console.log(`\n${c.green}  ✓ All queries found their expected docs!${c.reset}`);
    }

    console.log();

    // Cleanup
    brain.close();
    try { (await import('node:fs')).unlinkSync(dbPath); } catch { /* ok */ }
}

main().catch(err => {
    console.error(`${c.red}Error: ${err.message}${c.reset}`);
    process.exit(1);
});
