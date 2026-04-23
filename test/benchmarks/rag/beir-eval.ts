/**
 * 📊 BrainBank — BEIR Standard Benchmark
 *
 * Evaluates BrainBank against BEIR (Benchmarking Information Retrieval),
 * the industry-standard benchmark used by OpenAI, Cohere, Voyage, Google.
 *
 * Datasets are downloaded from the BEIR public mirror and cached locally.
 * Measures NDCG@10, Recall@10, and MRR — same metrics published by all providers.
 *
 * Usage:
 *   PERPLEXITY_API_KEY=pplx-... npx tsx test/benchmarks/rag/beir-eval.ts --dataset scifact
 *   PERPLEXITY_API_KEY=pplx-... npx tsx test/benchmarks/rag/beir-eval.ts --dataset nfcorpus
 *
 * Supported datasets: scifact, nfcorpus, fiqa
 */

import { BrainBank, PerplexityContextEmbedding } from '../../../src/index.ts';
import type { SearchResult } from '../../../src/index.ts';
import { docs } from '@brainbank/docs';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

// ─── ANSI ───────────────────────────────────────────

const c = {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
    red: '\x1b[31m', blue: '\x1b[34m', magenta: '\x1b[35m',
};

// ─── BEIR Dataset Config ────────────────────────────

interface BeirDataset {
    name: string;
    url: string;
    bm25Baseline: number; // Published NDCG@10 for BM25
}

const DATASETS: Record<string, BeirDataset> = {
    scifact: {
        name: 'SciFact',
        url: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip',
        bm25Baseline: 0.665,
    },
    nfcorpus: {
        name: 'NFCorpus',
        url: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip',
        bm25Baseline: 0.325,
    },
    fiqa: {
        name: 'FiQA-2018',
        url: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/fiqa.zip',
        bm25Baseline: 0.236,
    },
};

// ─── Dataset Download & Cache ───────────────────────

const CACHE_DIR = '/tmp/beir-cache';

async function downloadDataset(dataset: BeirDataset): Promise<string> {
    const datasetDir = join(CACHE_DIR, dataset.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const corpusFile = join(datasetDir, 'corpus.jsonl');

    if (existsSync(corpusFile)) {
        console.log(`${c.dim}  Using cached dataset: ${datasetDir}${c.reset}`);
        return datasetDir;
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`${c.dim}  Downloading ${dataset.name} from BEIR...${c.reset}`);

    const zipPath = join(CACHE_DIR, `${dataset.name.toLowerCase()}.zip`);

    // Download zip
    const resp = await fetch(dataset.url);
    if (!resp.ok) throw new Error(`Failed to download: ${resp.status}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    writeFileSync(zipPath, buffer);

    // Unzip using system unzip (available on macOS)
    const { execSync } = await import('node:child_process');
    execSync(`unzip -o -q "${zipPath}" -d "${CACHE_DIR}"`, { stdio: 'pipe' });

    // BEIR zips extract to a folder matching the dataset key
    // Find the extracted folder
    const extractedDirs = readdirSync(CACHE_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    // Look for the extracted dataset folder
    for (const dir of extractedDirs) {
        const candidate = join(CACHE_DIR, dir, 'corpus.jsonl');
        if (existsSync(candidate) && dir !== datasetDir.split('/').pop()) {
            // Rename to our canonical name
            const src = join(CACHE_DIR, dir);
            if (src !== datasetDir) {
                const { renameSync } = await import('node:fs');
                try { renameSync(src, datasetDir); } catch { /* already exists */ }
            }
            break;
        }
    }

    // Cleanup zip
    try { rmSync(zipPath); } catch { /* ok */ }

    if (!existsSync(corpusFile)) {
        throw new Error(`Dataset extraction failed. Expected ${corpusFile}`);
    }

    console.log(`${c.green}  ✓ Downloaded and cached${c.reset}`);
    return datasetDir;
}

// ─── BEIR File Parsers ──────────────────────────────

interface BeirDoc {
    id: string;
    title: string;
    text: string;
}

interface BeirQuery {
    id: string;
    text: string;
}

/** query_id → { doc_id → relevance_score } */
type Qrels = Map<string, Map<string, number>>;

async function parseCorpus(datasetDir: string): Promise<BeirDoc[]> {
    const filePath = join(datasetDir, 'corpus.jsonl');
    const docs: BeirDoc[] = [];

    const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        docs.push({ id: obj._id, title: obj.title ?? '', text: obj.text ?? '' });
    }
    return docs;
}

async function parseQueries(datasetDir: string): Promise<BeirQuery[]> {
    const filePath = join(datasetDir, 'queries.jsonl');
    const queries: BeirQuery[] = [];

    const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        queries.push({ id: obj._id, text: obj.text ?? '' });
    }
    return queries;
}

async function parseQrels(datasetDir: string): Promise<Qrels> {
    const filePath = join(datasetDir, 'qrels', 'test.tsv');
    const qrels: Qrels = new Map();

    const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });
    let isHeader = true;
    for await (const line of rl) {
        if (isHeader) { isHeader = false; continue; }
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const [queryId, docId, scoreStr] = parts;
        const score = parseInt(scoreStr, 10);
        if (score <= 0) continue; // Only positive relevance

        if (!qrels.has(queryId)) qrels.set(queryId, new Map());
        qrels.get(queryId)!.set(docId, score);
    }
    return qrels;
}

// ─── IR Metrics ─────────────────────────────────────

/** Discounted Cumulative Gain at position k. */
function dcg(relevances: number[], k: number): number {
    let sum = 0;
    for (let i = 0; i < Math.min(relevances.length, k); i++) {
        sum += (Math.pow(2, relevances[i]) - 1) / Math.log2(i + 2);
    }
    return sum;
}

/** Normalized DCG at position k. */
function ndcgAtK(retrievedDocIds: string[], qrel: Map<string, number>, k: number): number {
    // Actual DCG from retrieved order
    const actualRels = retrievedDocIds.slice(0, k).map(id => qrel.get(id) ?? 0);
    const actualDCG = dcg(actualRels, k);

    // Ideal DCG — sort all relevant docs by score descending
    const idealRels = [...qrel.values()].sort((a, b) => b - a);
    const idealDCG = dcg(idealRels, k);

    if (idealDCG === 0) return 0;
    return actualDCG / idealDCG;
}

function recallAtK(retrievedDocIds: string[], qrel: Map<string, number>, k: number): number {
    const relevant = new Set(qrel.keys());
    const found = retrievedDocIds.slice(0, k).filter(id => relevant.has(id)).length;
    return relevant.size > 0 ? found / relevant.size : 0;
}

function mrr(retrievedDocIds: string[], qrel: Map<string, number>): number {
    for (let i = 0; i < retrievedDocIds.length; i++) {
        if (qrel.has(retrievedDocIds[i])) return 1 / (i + 1);
    }
    return 0;
}

// ─── Corpus → Temp Files ────────────────────────────

function writeCorpusAsFiles(corpusDocs: BeirDoc[], dir: string): void {
    mkdirSync(dir, { recursive: true });
    for (const doc of corpusDocs) {
        const title = doc.title ? `# ${doc.title}\n\n` : '';
        const content = `${title}${doc.text}`;
        writeFileSync(join(dir, `${doc.id}.md`), content, 'utf-8');
    }
}

// ─── Main ───────────────────────────────────────────

async function main() {
    const datasetIdx = process.argv.indexOf('--dataset');
    const datasetKey = datasetIdx !== -1 ? process.argv[datasetIdx + 1] : null;

    if (!datasetKey || !DATASETS[datasetKey]) {
        console.error(`${c.red}Usage: npx tsx examples/rag/beir-eval.ts --dataset <${Object.keys(DATASETS).join('|')}>${c.reset}`);
        process.exit(1);
    }

    if (!process.env.PERPLEXITY_API_KEY) {
        console.error(`${c.yellow}⚠  Set PERPLEXITY_API_KEY${c.reset}`);
        process.exit(1);
    }

    const dataset = DATASETS[datasetKey];

    console.log(`\n${c.bold}${c.cyan}━━━ BEIR Evaluation: ${dataset.name} ━━━${c.reset}`);

    // 1. Download / cache dataset
    const datasetDir = await downloadDataset(dataset);

    // 2. Parse dataset
    console.log(`${c.dim}  Parsing dataset...${c.reset}`);
    const [corpus, queries, qrels] = await Promise.all([
        parseCorpus(datasetDir),
        parseQueries(datasetDir),
        parseQrels(datasetDir),
    ]);

    // Filter queries that have relevance judgments
    const evalQueries = queries.filter(q => qrels.has(q.id));

    console.log(`${c.dim}  Corpus: ${corpus.length.toLocaleString()} docs${c.reset}`);
    console.log(`${c.dim}  Queries: ${evalQueries.length} with relevance judgments${c.reset}`);

    // 3. Write corpus as temp markdown files
    const tempDocsDir = `/tmp/beir-docs-${datasetKey}`;
    if (!existsSync(join(tempDocsDir, `${corpus[0]?.id}.md`))) {
        console.log(`${c.dim}  Writing corpus as markdown files...${c.reset}`);
        writeCorpusAsFiles(corpus, tempDocsDir);
    }

    // 4. Initialize BrainBank
    const dbPath = `/tmp/brainbank-beir-${datasetKey}.db`;
    try { rmSync(dbPath); } catch { /* ok */ }

    const pplxEmbed = new PerplexityContextEmbedding();
    const brain = new BrainBank({
        dbPath,
        embeddingProvider: pplxEmbed,
        embeddingDims: pplxEmbed.dims,
    });
    brain.use(docs());
    await brain.initialize();

    const docsPlugin = brain.plugin('docs') as any;
    docsPlugin.addCollection({
        name: `beir-${datasetKey}`,
        path: tempDocsDir,
        pattern: '**/*.md',
    });

    // 6. Index
    console.log(`${c.dim}  Indexing ${corpus.length.toLocaleString()} docs...${c.reset}`);
    const indexStart = Date.now();
    await docsPlugin.indexCollections({
        onProgress: (_col: string, file: string, cur: number, total: number) => {
            if (cur % 100 === 0 || cur === total) {
                process.stdout.write(`\r${c.dim}  📚 [${cur}/${total}]${c.reset}      `);
            }
        },
    });
    const indexTime = ((Date.now() - indexStart) / 1000).toFixed(1);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');

    const st = docsPlugin.stats();
    console.log(`${c.green}  ✓ Indexed ${st.chunks} chunks in ${indexTime}s${c.reset}`);
    console.log(`${c.dim}  Pipeline: Hybrid (Vector + BM25 → RRF)${c.reset}`);
    console.log(`${c.dim}  Embeddings: Perplexity Context (${pplxEmbed.dims}d)${c.reset}\n`);

    // Build docId lookup from filePath
    // filePath ends with /{docId}.md, extract docId

    // 7. Run queries and compute metrics
    const K = 10;
    let sumNDCG = 0;
    let sumRecall = 0;
    let sumMRR = 0;
    let evaluated = 0;

    const searchStart = Date.now();

    for (let i = 0; i < evalQueries.length; i++) {
        const q = evalQueries[i];
        if (i % 10 === 0) {
            process.stdout.write(`\r${c.dim}  [${i + 1}/${evalQueries.length}] Searching...${c.reset}      `);
        }

        const hits: SearchResult[] = await docsPlugin.search(q.text, { k: K, minScore: 0.0 });

        // Extract doc IDs from file paths: /tmp/beir-docs-xxx/{docId}.md → docId
        const retrievedIds = hits.map(h => {
            const filename = (h.filePath ?? '').split('/').pop() ?? '';
            return filename.replace('.md', '');
        });

        const qrel = qrels.get(q.id)!;
        sumNDCG += ndcgAtK(retrievedIds, qrel, K);
        sumRecall += recallAtK(retrievedIds, qrel, K);
        sumMRR += mrr(retrievedIds, qrel);
        evaluated++;
    }

    const searchTime = ((Date.now() - searchStart) / 1000).toFixed(1);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');

    // 8. Print results
    const avgNDCG = sumNDCG / evaluated;
    const avgRecall = sumRecall / evaluated;
    const avgMRR = sumMRR / evaluated;

    const ndcgColor = avgNDCG >= dataset.bm25Baseline ? c.green : c.yellow;
    const pad = (s: string, n: number) => s.padEnd(n);
    const flt = (v: number) => v.toFixed(3);

    console.log(`${c.bold}  Metric         Score    BM25 Baseline${c.reset}`);
    console.log(`${c.dim}  ──────────── ──────── ──────────────${c.reset}`);
    console.log(`  ${pad('NDCG@10', 12)} ${ndcgColor}${flt(avgNDCG).padStart(8)}${c.reset}    ${flt(dataset.bm25Baseline).padStart(8)}`);
    console.log(`  ${pad('Recall@10', 12)} ${flt(avgRecall).padStart(8)}`);
    console.log(`  ${pad('MRR', 12)} ${flt(avgMRR).padStart(8)}`);
    console.log(`${c.dim}  ──────────── ──────── ──────────────${c.reset}`);

    const delta = avgNDCG - dataset.bm25Baseline;
    const deltaStr = delta >= 0 ? `+${(delta * 100).toFixed(1)}pp` : `${(delta * 100).toFixed(1)}pp`;
    const deltaColor = delta >= 0 ? c.green : c.red;
    console.log(`\n  ${c.bold}vs BM25: ${deltaColor}${deltaStr}${c.reset} NDCG@10`);
    console.log(`${c.dim}  Queries: ${evaluated} | Index: ${indexTime}s | Search: ${searchTime}s${c.reset}`);
    console.log();

    // Cleanup
    brain.close();
    try { rmSync(dbPath); } catch { /* ok */ }
}

main().catch(err => {
    console.error(`${c.red}Error: ${err.message}${c.reset}`);
    console.error(err.stack);
    process.exit(1);
});
