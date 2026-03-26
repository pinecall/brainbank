/**
 * 📊 BrainBank RAG Evaluator
 *
 * Measures retrieval quality using queries that test SEMANTIC relevance,
 * not keyword matching. Queries cross document boundaries and test
 * whether the retriever understands relationships between concepts.
 *
 * Run:
 *   PERPLEXITY_API_KEY=pplx-... npx tsx examples/rag/eval.ts --docs ~/path/to/docs
 */

import { BrainBank } from '../../src/index.ts';
import { docs, summaryEnrichment, noneEnrichment } from '../../src/indexers/docs/docs-plugin.ts';
import { PerplexityContextEmbedding } from '../../src/providers/embeddings/perplexity-context-embedding.ts';
import type { SearchResult } from '../../src/types.ts';

// ─── ANSI ───────────────────────────────────────────

const c = {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
    red: '\x1b[31m', blue: '\x1b[34m', magenta: '\x1b[35m',
};

// ─── Golden Dataset ─────────────────────────────────
//
// Queries are designed to test SEMANTIC understanding, not keyword overlap.
// Each query describes a concept or relationship that should lead to specific docs
// without directly naming them.

interface GoldenQuery {
    /** Natural language question — NOT containing doc titles or keywords from filenames. */
    query: string;
    /** Substrings to match against filePath (case-insensitive). Any match = hit. */
    expectedFiles: string[];
    /** What this query tests. */
    category: string;
}

const GOLDEN: GoldenQuery[] = [
    // ── Cross-document relationship queries ──────────
    // These queries describe concepts that span multiple docs.
    // A hit means at least ONE expectedFile was found.

    // Data flow: Redis → Workers → Notifications → WebSocket
    {
        query: 'when a new job is created, how does the user get notified in real time?',
        expectedFiles: ['Notifications Architecture With Redis', 'Redis Tenant Message Streams and Workers'],
        category: 'cross-doc',
    },
    // Auth + database: how tenant isolation works at the data layer
    {
        query: 'how is sensitive patient data isolated between different organizations?',
        expectedFiles: ['Multi-Tenant PHI PII'],
        category: 'cross-doc',
    },
    // Frontend state + backend events: how the UI stays in sync
    {
        query: 'how does the frontend react when backend data changes without refreshing the page?',
        expectedFiles: ['Real Time Messaging System'],
        category: 'cross-doc',
    },
    // XState + Jobs: state machine driving business logic
    {
        query: 'what drives the lifecycle transitions of a job offer from creation to completion?',
        expectedFiles: ['XState Driving Job Offer Lifecycle'],
        category: 'cross-doc',
    },
    // Swagger + architecture: how frontend and backend stay consistent
    {
        query: 'how does the team ensure frontend API calls match the backend contract?',
        expectedFiles: ['Swagger Spec-first'],
        category: 'cross-doc',
    },

    // ── Semantic (no keywords from filename) ────────
    // Queries use paraphrases that should NOT keyword-match the filenames.

    // "see logs and trace errors" → logging + observability
    {
        query: 'how can developers see logs and trace errors in production?',
        expectedFiles: ['Logging', 'Observability'],
        category: 'semantic',
    },
    // "colors, fonts, visual design" → theming
    {
        query: 'how are colors, fonts, and visual design kept consistent across the app?',
        expectedFiles: ['Theming Sass', 'sass scss Guidelines'],
        category: 'semantic',
    },
    // "cloud, deployed" → Azure + CI/CD
    {
        query: 'where does the application run in the cloud and how is it deployed?',
        expectedFiles: ['azure', 'CI-CD'],
        category: 'semantic',
    },
    // "schema changes" → migrations
    {
        query: 'how are database schema changes managed safely over time?',
        expectedFiles: ['Database Migrations'],
        category: 'semantic',
    },
    // "translated into different languages" → localization
    {
        query: 'how is the application translated into different languages?',
        expectedFiles: ['Localization-Workflow'],
        category: 'semantic',
    },
    // "file uploads, downloads" → storage
    {
        query: 'how are file uploads, downloads, and attachments handled?',
        expectedFiles: ['Storage System'],
        category: 'semantic',
    },
    // "password resets, confirmations" → emailing
    {
        query: 'how does the system send email notifications like password resets or confirmations?',
        expectedFiles: ['Emailing'],
        category: 'semantic',
    },
    // "verify code quality" → QA + sonarqube
    {
        query: 'what processes exist to verify code quality before shipping?',
        expectedFiles: ['QA-Guidelines', 'SONARQUBE'],
        category: 'semantic',
    },

    // ── Broad system-level queries ──────────────────

    {
        query: 'give me a high-level overview of the entire system architecture',
        expectedFiles: ['full_stack_architecture_outline', 'architectural overview'],
        category: 'broad',
    },
    {
        query: 'what technologies and frameworks does this project use?',
        expectedFiles: ['full_stack_architecture_outline'],
        category: 'broad',
    },
    {
        query: 'what user roles exist and what can each one do?',
        expectedFiles: ['user_roles'],
        category: 'broad',
    },

    // ── Edge cases ──────────────────────────────────
    // Specific concepts that only appear in one doc.

    {
        query: 'how does the job event interceptor log state transitions?',
        expectedFiles: ['Job Event Logging With Interceptors'],
        category: 'specific',
    },
    {
        query: 'what security measures protect the system from common attacks?',
        expectedFiles: ['security-policy', 'threat-modeling-guide'],
        category: 'specific',
    },
    {
        query: 'how does the system synchronize data with external health record systems via HL7?',
        expectedFiles: ['EMR_request_sync_HL7'],
        category: 'specific',
    },
    {
        query: 'how can an admin configure options that apply to their whole organization?',
        expectedFiles: ['Settings System'],
        category: 'specific',
    },
];

// ─── Metrics ────────────────────────────────────────

interface QueryResult {
    query: string;
    category: string;
    expectedFiles: string[];
    /** 1-indexed rank positions where expected files were found. */
    foundAt: number[];
    /** Filenames of top results for debugging. */
    topResults: string[];
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
    return Math.min(found, totalExpected) / totalExpected;
}

// ─── Run Evaluation ─────────────────────────────────

async function main() {
    const docsIdx = process.argv.indexOf('--docs');
    if (docsIdx === -1 || !process.argv[docsIdx + 1]) {
        console.error(`${c.red}Usage: npx tsx examples/rag/eval.ts --docs <path> [--enrichment none|summary]${c.reset}`);
        process.exit(1);
    }
    const docsPath = process.argv[docsIdx + 1];

    if (!process.env.PERPLEXITY_API_KEY) {
        console.error(`${c.yellow}⚠  Set PERPLEXITY_API_KEY${c.reset}`);
        process.exit(1);
    }

    // Parse enrichment strategy
    const enrichIdx = process.argv.indexOf('--enrichment');
    const enrichName = enrichIdx !== -1 ? process.argv[enrichIdx + 1] : 'none';
    const enrichment = enrichName === 'summary' ? summaryEnrichment() : noneEnrichment();

    const pplxEmbed = new PerplexityContextEmbedding();
    const dbPath = '/tmp/brainbank-rag-eval.db';
    const brain = new BrainBank({
        dbPath,
        embeddingProvider: pplxEmbed,
        embeddingDims: pplxEmbed.dims,
    });
    brain.use(docs({ enrichment }));
    await brain.initialize();

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
    console.log(`${c.dim}  Enrichment: ${enrichment.name}${c.reset}`);
    console.log(`${c.dim}  Queries: ${GOLDEN.length} (${[...new Set(GOLDEN.map(g => g.category))].join(', ')})${c.reset}\n`);

    // Run queries
    const results: QueryResult[] = [];
    const K_MAX = 10;

    for (let i = 0; i < GOLDEN.length; i++) {
        const g = GOLDEN[i];
        process.stdout.write(`\r${c.dim}  [${i + 1}/${GOLDEN.length}] ${g.query.slice(0, 50)}...${c.reset}      `);

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

    // Metrics by category
    const categories = [...new Set(GOLDEN.map(g => g.category))];
    const pad = (s: string, n: number) => s.padEnd(n);
    const pct = (v: number) => `${(v * 100).toFixed(0)}%`.padStart(5);
    const flt = (v: number) => v.toFixed(2).padStart(5);

    const tableRows: { category: string; queries: number; recall3: number; recall5: number; mrr: number }[] = [];

    for (const cat of categories) {
        const catResults = results.filter(r => r.category === cat);
        const recall3 = catResults.reduce((s, r) => s + recallAtK(r.foundAt, 3, r.expectedFiles.length), 0) / catResults.length;
        const recall5 = catResults.reduce((s, r) => s + recallAtK(r.foundAt, 5, r.expectedFiles.length), 0) / catResults.length;
        const mrr = catResults.reduce((s, r) => s + computeMRR(r.foundAt), 0) / catResults.length;
        tableRows.push({ category: cat, queries: catResults.length, recall3, recall5, mrr });
    }

    // Overall
    const overall3 = results.reduce((s, r) => s + recallAtK(r.foundAt, 3, r.expectedFiles.length), 0) / results.length;
    const overall5 = results.reduce((s, r) => s + recallAtK(r.foundAt, 5, r.expectedFiles.length), 0) / results.length;
    const overallMRR = results.reduce((s, r) => s + computeMRR(r.foundAt), 0) / results.length;

    // Print table
    console.log(`${c.bold}  ${'Category'.padEnd(14)} ${'#'.padStart(3)} ${'R@3'.padStart(5)} ${'R@5'.padStart(5)} ${'MRR'.padStart(5)}${c.reset}`);
    console.log(`${c.dim}  ${'─'.repeat(14)} ${'───'} ${'─────'} ${'─────'} ${'─────'}${c.reset}`);

    for (const row of tableRows) {
        const r3c = row.recall3 >= 0.8 ? c.green : row.recall3 >= 0.5 ? c.yellow : c.red;
        const r5c = row.recall5 >= 0.8 ? c.green : row.recall5 >= 0.5 ? c.yellow : c.red;
        console.log(
            `  ${pad(row.category, 14)} ${String(row.queries).padStart(3)} ` +
            `${r3c}${pct(row.recall3)}${c.reset} ${r5c}${pct(row.recall5)}${c.reset} ${flt(row.mrr)}`
        );
    }

    console.log(`${c.dim}  ${'─'.repeat(14)} ${'───'} ${'─────'} ${'─────'} ${'─────'}${c.reset}`);
    const o3c = overall3 >= 0.8 ? c.green : overall3 >= 0.5 ? c.yellow : c.red;
    const o5c = overall5 >= 0.8 ? c.green : overall5 >= 0.5 ? c.yellow : c.red;
    console.log(
        `${c.bold}  ${pad('Overall', 14)} ${String(results.length).padStart(3)} ` +
        `${o3c}${pct(overall3)}${c.reset} ${o5c}${pct(overall5)}${c.reset} ${flt(overallMRR)}${c.reset}`
    );

    // Show per-query detail
    console.log(`\n${c.bold}  Per-query results:${c.reset}`);
    for (const r of results) {
        const hit = r.foundAt.length >= r.expectedFiles.length;
        const icon = hit ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
        const ranks = r.foundAt.length > 0 ? `@${r.foundAt.join(',')}` : 'miss';
        console.log(`  ${icon} ${c.dim}[${r.category}]${c.reset} "${r.query.slice(0, 60)}" → ${ranks}`);
        if (!hit) {
            console.log(`${c.red}     expected: ${r.expectedFiles.join(', ')}${c.reset}`);
            console.log(`${c.dim}     got: ${r.topResults.join(', ')}${c.reset}`);
        }
    }

    console.log();

    brain.close();
    try { (await import('node:fs')).unlinkSync(dbPath); } catch { /* ok */ }
}

main().catch(err => {
    console.error(`${c.red}Error: ${err.message}${c.reset}`);
    process.exit(1);
});
