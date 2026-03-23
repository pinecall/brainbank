#!/usr/bin/env node
/**
 * Search Quality A/B: Sliding Window vs Tree-Sitter AST
 *
 * Self-contained benchmark using BrainBank's own source files.
 * Chunks the same files with both strategies, embeds all chunks,
 * then runs identical search queries and compares relevance.
 *
 * Usage: node test/benchmarks/search-quality.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

const c = {
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

// ── Sliding Window Chunker ──────────────────────────
function chunkSW(filePath, content, max = 80, overlap = 5) {
    const lines = content.split('\n');
    if (lines.length <= max) return [{ filePath, type: 'file', name: path.basename(filePath), s: 1, e: lines.length, content: content.trim() }];
    const chunks = [], step = max - overlap;
    for (let s = 0; s < lines.length; s += step) {
        const e = Math.min(s + max, lines.length);
        chunks.push({ filePath, type: 'block', name: `L${s+1}-${e}`, s: s+1, e, content: lines.slice(s,e).join('\n').trim() });
        if (e >= lines.length) break;
    }
    return chunks;
}

// ── AST Chunker ─────────────────────────────────────
function chunkAST(filePath, content, max = 80) {
    const Parser = require('tree-sitter');
    const parser = new Parser();
    const grammar = require('tree-sitter-typescript').typescript;
    parser.setLanguage(grammar);
    const tree = parser.parse(content);
    const root = tree.rootNode;
    const lines = content.split('\n');
    const chunks = [];
    const seen = new Set();

    const classTypes = new Set(['class_declaration', 'abstract_class_declaration']);
    const funcTypes = new Set(['function_declaration', 'method_definition', 'arrow_function']);
    const ifaceTypes = new Set(['interface_declaration', 'type_alias_declaration']);

    function name(n) {
        const f = n.childForFieldName?.('name');
        if (f) return f.text;
        for (let i = 0; i < n.childCount; i++) {
            const c = n.child(i);
            if (['identifier','type_identifier','property_identifier'].includes(c.type)) return c.text;
        }
        return null;
    }

    function add(node, typ, nm) {
        const s = node.startPosition.row, e = node.endPosition.row;
        const key = `${s}-${e}`;
        if (seen.has(key)) return;
        seen.add(key);
        const ct = lines.slice(s, e+1).join('\n').trim();
        if (ct.length > 20) chunks.push({ filePath, type: typ, name: nm, s: s+1, e: e+1, content: ct });
    }

    function walk(node) {
        const t = node.type;
        if (t === 'export_statement') {
            for (let i = 0; i < node.childCount; i++) walk(node.child(i));
            return;
        }
        if (classTypes.has(t)) {
            const nm = name(node) || 'Class';
            const nl = node.endPosition.row - node.startPosition.row + 1;
            if (nl > max) {
                const body = node.childForFieldName?.('body');
                if (body) for (let i = 0; i < body.childCount; i++) {
                    const m = body.child(i);
                    if (funcTypes.has(m.type)) add(m, 'method', name(m) || `m${i}`);
                }
            } else add(node, 'class', nm);
            return;
        }
        if (funcTypes.has(t)) { add(node, 'function', name(node) || `fn`); return; }
        if (ifaceTypes.has(t)) { add(node, 'interface', name(node) || 'iface'); return; }
        if (t === 'lexical_declaration') {
            for (let i = 0; i < node.childCount; i++) {
                const d = node.child(i);
                const v = d.childForFieldName?.('value');
                if (v?.type === 'arrow_function') { add(node, 'function', name(d) || 'arrow'); return; }
            }
        }
    }
    for (let i = 0; i < root.childCount; i++) walk(root.child(i));
    return chunks.length > 0 ? chunks : null;
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
    console.log(c.bold('\n━━━ Search Quality A/B Benchmark ━━━'));
    console.log(c.dim('  Sliding Window (80-line blocks) vs Tree-Sitter AST (semantic chunks)\n'));

    // Use BrainBank's own source files (always available in the repo)
    const files = [
        'src/core/brainbank.ts',
        'src/indexers/chunker.ts',
        'src/core/collection.ts',
        'src/query/search.ts',
        'src/cli.ts',
        'src/indexers/code-indexer.ts',
        'src/core/context-builder.ts',
    ];

    // Step 1: Chunk
    console.log(c.bold('Step 1: Chunking source files...\n'));
    const swAll = [], astAll = [];
    let totalLines = 0;

    for (const f of files) {
        const fullPath = path.join(rootDir, f);
        if (!fs.existsSync(fullPath)) { console.log(`  ${c.red('✗')} ${f} not found, skipping`); continue; }
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n').length;
        totalLines += lines;

        const sw = chunkSW(f, content);
        const ast = chunkAST(f, content) || [];
        swAll.push(...sw);
        astAll.push(...ast);

        const names = ast.slice(0, 4).map(c => c.name).join(', ');
        console.log(`  ${c.cyan(path.basename(f).padEnd(28))} ${String(lines).padStart(4)}ln  SW:${String(sw.length).padStart(3)}  AST:${c.green(String(ast.length).padStart(3))}  → ${c.dim(names)}${ast.length > 4 ? '...' : ''}`);
    }

    console.log(`\n  ${c.bold('Total:')} ${totalLines} lines | SW: ${swAll.length} chunks | AST: ${c.green(String(astAll.length))} chunks\n`);

    // Step 2: Pre-embed
    console.log(c.bold('Step 2: Embedding all chunks...\n'));
    const { LocalEmbedding } = await import(path.join(rootDir, 'dist/index.js'));
    const emb = new LocalEmbedding();

    const t0 = performance.now();
    const swVecs = [];
    for (const chunk of swAll) swVecs.push(await emb.embed(chunk.content));
    console.log(`  SW:  ${swAll.length} chunks in ${((performance.now()-t0)/1000).toFixed(1)}s`);

    const t1 = performance.now();
    const astVecs = [];
    for (const chunk of astAll) astVecs.push(await emb.embed(chunk.content));
    console.log(`  AST: ${astAll.length} chunks in ${((performance.now()-t1)/1000).toFixed(1)}s\n`);

    // Step 3: Search queries (BrainBank domain-specific)
    const queries = [
        { q: 'initialize database and create tables', expect: 'initialize' },
        { q: 'search using vector embeddings and similarity', expect: 'search' },
        { q: 'add item to a key-value collection', expect: 'add' },
        { q: 'close database connections and cleanup resources', expect: 'close' },
        { q: 'hybrid search with reciprocal rank fusion', expect: 'search' },
        { q: 'parse source code with tree-sitter grammar', expect: 'chunk' },
        { q: 'trim collection keep only recent items', expect: 'trim' },
        { q: 'generate context for an AI agent task', expect: 'context' },
        { q: 'index repository code files incrementally', expect: 'index' },
        { q: 'CLI command to reindex the codebase', expect: 'index' },
    ];

    console.log(c.bold('Step 3: Searching (10 queries)...\n'));

    const results = [];
    for (const { q, expect } of queries) {
        const qVec = await emb.embed(q);

        const swScored = swAll.map((ch, i) => ({ ...ch, score: cosine(qVec, swVecs[i]) })).sort((a, b) => b.score - a.score);
        const astScored = astAll.map((ch, i) => ({ ...ch, score: cosine(qVec, astVecs[i]) })).sort((a, b) => b.score - a.score);

        const swTop = swScored[0], astTop = astScored[0];
        const swTop3 = swScored.slice(0, 3), astTop3 = astScored.slice(0, 3);
        const delta = astTop.score - swTop.score;
        const winner = delta > 0.005 ? 'AST' : (delta < -0.005 ? 'SW' : 'TIE');

        const swRel = (swTop.name + ' ' + swTop.content.slice(0,300)).toLowerCase().includes(expect);
        const astRel = (astTop.name + ' ' + astTop.content.slice(0,300)).toLowerCase().includes(expect);
        const swP3 = swTop3.filter(r => (r.name + ' ' + r.content.slice(0,300)).toLowerCase().includes(expect)).length;
        const astP3 = astTop3.filter(r => (r.name + ' ' + r.content.slice(0,300)).toLowerCase().includes(expect)).length;

        results.push({ q, swScore: swTop.score, astScore: astTop.score, delta, winner, swName: swTop.name, astName: astTop.name, swRel, astRel, swP3, astP3, swFile: swTop.filePath, astFile: astTop.filePath });

        const dStr = delta > 0 ? c.green(`+${delta.toFixed(3)}`) : (delta < 0 ? c.red(delta.toFixed(3)) : c.dim('0.000'));
        const wStr = winner === 'AST' ? c.green('AST ✓') : (winner === 'SW' ? c.yellow('SW') : c.dim('TIE'));
        const swRelStr = swRel ? '' : c.red(' ✗');
        const astRelStr = astRel ? '' : c.red(' ✗');

        console.log(`  ${c.cyan('Q:')} "${q}"`);
        console.log(`    SW  ${swTop.score.toFixed(3)}  ${c.dim((swTop.name || '-').padEnd(24))} ${c.dim(path.basename(swTop.filePath).padEnd(24))} P@3:${swP3}/3${swRelStr}`);
        console.log(`    AST ${astTop.score.toFixed(3)}  ${c.green((astTop.name || '-').padEnd(24))} ${c.dim(path.basename(astTop.filePath).padEnd(24))} P@3:${astP3}/3${astRelStr}`);
        console.log(`    Δ ${dStr}  ${wStr}\n`);
    }

    // ── Summary ─────────────────────────────────────
    const astW = results.filter(r => r.winner === 'AST').length;
    const swW = results.filter(r => r.winner === 'SW').length;
    const ties = results.filter(r => r.winner === 'TIE').length;
    const avgD = results.reduce((s,r) => s + r.delta, 0) / results.length;
    const astRelCount = results.filter(r => r.astRel).length;
    const swRelCount = results.filter(r => r.swRel).length;
    const astAvgP3 = (results.reduce((s,r) => s + r.astP3, 0) / results.length).toFixed(1);
    const swAvgP3 = (results.reduce((s,r) => s + r.swP3, 0) / results.length).toFixed(1);

    console.log(c.bold('━━━ Results ━━━\n'));
    console.log(`  ${c.bold('Wins:')}       AST ${c.green(astW)}  SW ${c.yellow(swW)}  TIE ${ties}  / ${results.length}`);
    console.log(`  ${c.bold('Avg Δ:')}      ${avgD > 0 ? c.green(`+${avgD.toFixed(4)}`) : c.red(avgD.toFixed(4))} ${c.dim('(positive = AST better)')}`);
    console.log(`  ${c.bold('Top-1 Rel:')} AST ${c.green(astRelCount+'/'+results.length)}  SW ${c.yellow(swRelCount+'/'+results.length)}`);
    console.log(`  ${c.bold('Avg P@3:')}   AST ${c.green(astAvgP3)}/3  SW ${c.yellow(swAvgP3)}/3`);

    // Chunk Quality
    const swAvgLn = Math.round(swAll.reduce((s,c) => s+(c.e-c.s+1),0) / swAll.length);
    const astAvgLn = Math.round(astAll.reduce((s,c) => s+(c.e-c.s+1),0) / astAll.length);
    const astNamed = astAll.filter(c => c.name && !c.name.startsWith('L')).length;

    console.log(`\n${c.bold('━━━ Chunk Quality ━━━\n')}`);
    console.log(`  ┌───────────────────┬────────────────┬─────────────────┐`);
    console.log(`  │ Metric            │ Sliding Window │ Tree-Sitter AST │`);
    console.log(`  ├───────────────────┼────────────────┼─────────────────┤`);
    console.log(`  │ Total chunks      │ ${String(swAll.length).padStart(14)} │ ${String(astAll.length).padStart(15)} │`);
    console.log(`  │ Avg lines/chunk   │ ${String(swAvgLn).padStart(14)} │ ${String(astAvgLn).padStart(15)} │`);
    console.log(`  │ Named chunks      │ ${String(0).padStart(14)} │ ${String(astNamed).padStart(15)} │`);
    console.log(`  │ Types             │ ${'block'.padStart(14)} │ ${[...new Set(astAll.map(c=>c.type))].join(',').padStart(15)} │`);
    console.log(`  │ Source lines      │ ${String(totalLines).padStart(14)} │ ${String(totalLines).padStart(15)} │`);
    console.log(`  └───────────────────┴────────────────┴─────────────────┘\n`);
}

main().catch(console.error);
