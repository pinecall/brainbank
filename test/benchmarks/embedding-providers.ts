/**
 * BrainBank — Embedding Provider Benchmark
 *
 * Compares search quality and speed across all 4 embedding providers:
 *   1. Local WASM (384d, free)
 *   2. OpenAI text-embedding-3-small (1536d)
 *   3. Perplexity standard pplx-embed-v1-4b (2560d)
 *   4. Perplexity contextualized pplx-embed-context-v1-4b (2560d)
 *
 * Each provider gets its own temp DB so the existing indexed DB is preserved.
 *
 * Usage: npx tsx test/benchmarks/embedding-providers.ts <repo-path>
 */

import { BrainBank } from '../../src/core/orchestration/brainbank.ts';
import { code } from '../../src/indexers/code/code-plugin.ts';
import { git } from '../../src/indexers/git/git-plugin.ts';
import { OpenAIEmbedding } from '../../src/providers/embeddings/openai-embedding.ts';
import { PerplexityEmbedding } from '../../src/providers/embeddings/perplexity-embedding.ts';
import { PerplexityContextEmbedding } from '../../src/providers/embeddings/perplexity-context-embedding.ts';
import type { EmbeddingProvider, SearchResult } from '../../src/types.ts';
import fs from 'fs';

const REPO_PATH = process.argv[2] || '/Users/berna/aurora/servicehub-backend';

const QUERIES = [
    'authentication middleware',
    'database connection pool',
    'error handling strategy',
    'WebSocket real-time events',
    'user permissions and roles',
];

interface ProviderConfig {
    name: string;
    create: () => EmbeddingProvider | undefined;
    dims?: number;
}

const providers: ProviderConfig[] = [
    {
        name: 'Local WASM (384d)',
        create: () => undefined, // default
    },
    {
        name: 'OpenAI small (1536d)',
        create: () => new OpenAIEmbedding(),
        dims: 1536,
    },
    {
        name: 'Perplexity 4b (2560d)',
        create: () => new PerplexityEmbedding(),
        dims: 2560,
    },
    {
        name: 'Perplexity Context 4b (2560d)',
        create: () => new PerplexityContextEmbedding(),
        dims: 2560,
    },
];

interface BenchResult {
    provider: string;
    indexTimeMs: number;
    chunks: number;
    queries: { query: string; timeMs: number; top3: string[] }[];
    avgSearchMs: number;
}

async function benchProvider(config: ProviderConfig): Promise<BenchResult> {
    const label = config.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const dbPath = `/tmp/brainbank-bench-${label}.db`;

    // Clean previous run
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }

    const embeddingProvider = config.create();
    const opts: Record<string, unknown> = {
        repoPath: REPO_PATH,
        dbPath,
    };
    if (embeddingProvider) {
        opts.embeddingProvider = embeddingProvider;
        if (config.dims) opts.embeddingDims = config.dims;
    }

    const brain = new BrainBank(opts as any);
    brain.use(code({ repoPath: REPO_PATH }));
    brain.use(git({ repoPath: REPO_PATH }));

    // ── Index ────────────────────────────────────
    const indexStart = Date.now();
    await brain.initialize();
    await brain.index();
    const indexTimeMs = Date.now() - indexStart;

    const stats = brain.stats();
    const chunks = stats.code?.chunks ?? 0;

    // ── Search ───────────────────────────────────
    const queries: BenchResult['queries'] = [];

    for (const query of QUERIES) {
        const start = Date.now();
        const results: SearchResult[] = await brain.hybridSearch(query, { codeK: 5 });
        const timeMs = Date.now() - start;

        const top3 = results.slice(0, 3).map(r => {
            const score = (r.score * 100).toFixed(0) + '%';
            const meta = r.metadata as Record<string, unknown> | undefined;
            const source = meta?.file
                ? `${meta.file}:${meta?.startLine ?? '?'}`
                : r.content.slice(0, 60);
            return `[${score}] ${source}`;
        });

        queries.push({ query, timeMs, top3 });
    }

    const avgSearchMs = Math.round(queries.reduce((s, q) => s + q.timeMs, 0) / queries.length);

    brain.close();

    // Clean up temp DB
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }

    return { provider: config.name, indexTimeMs, chunks, queries, avgSearchMs };
}

async function main() {
    console.log(`\n━━━ BrainBank Embedding Provider Benchmark ━━━`);
    console.log(`  Repo: ${REPO_PATH}`);
    console.log(`  Queries: ${QUERIES.length}`);
    console.log();

    const results: BenchResult[] = [];

    for (const config of providers) {
        console.log(`⏳ ${config.name} ...`);
        try {
            const result = await benchProvider(config);
            results.push(result);
            console.log(`  ✓ Indexed ${result.chunks} chunks in ${(result.indexTimeMs / 1000).toFixed(1)}s — avg search ${result.avgSearchMs}ms`);
        } catch (err: any) {
            console.log(`  ✗ ${err.message}`);
        }
    }

    // ── Summary Table ────────────────────────────
    console.log('\n━━━ Results ━━━\n');
    console.log('| Provider | Chunks | Index Time | Avg Search |');
    console.log('|----------|--------|------------|------------|');
    for (const r of results) {
        console.log(`| ${r.provider.padEnd(30)} | ${String(r.chunks).padStart(6)} | ${(r.indexTimeMs / 1000).toFixed(1).padStart(8)}s | ${String(r.avgSearchMs).padStart(8)}ms |`);
    }

    // ── Per-Query Comparison ─────────────────────
    console.log('\n━━━ Search Quality Comparison ━━━\n');
    for (const query of QUERIES) {
        console.log(`\n  Query: "${query}"`);
        console.log('  ' + '─'.repeat(60));

        for (const r of results) {
            const q = r.queries.find(q => q.query === query);
            if (!q) continue;
            console.log(`  ${r.provider} (${q.timeMs}ms):`);
            for (const hit of q.top3) {
                console.log(`    ${hit}`);
            }
        }
    }

    console.log('\n━━━ Done ━━━\n');
}

main().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
