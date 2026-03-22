/**
 * BrainBank — Built-in Indexer Integration Tests
 *
 * End-to-end tests for the code, git, and docs indexers using
 * real temp repos, real git history, and real markdown files.
 *
 * Creates fixtures in /tmp and cleans up after. Uses hash-based
 * embedding (no model download) to keep tests fast but still
 * exercise the full pipeline: file walk → chunk → embed → HNSW + SQLite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { BrainBank } from '../../src/core/brainbank.ts';
import { code } from '../../src/plugins/code.ts';
import { git } from '../../src/plugins/git.ts';
import { docs } from '../../src/plugins/docs.ts';
import type { EmbeddingProvider } from '../../src/types.ts';

export const name = 'Integration — Built-in Indexers';

// ── Deterministic hash embedding ──────────────────────
function hashEmbedding(dims = 384): EmbeddingProvider {
    function embed(text: string): Float32Array {
        const vec = new Float32Array(dims);
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        for (let i = 0; i < dims; i++) {
            h ^= (h >>> 13); h = Math.imul(h, 0x5bd1e995) >>> 0;
            vec[i] = (h / 0xFFFFFFFF) * 2 - 1;
        }
        let norm = 0;
        for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm);
        for (let i = 0; i < dims; i++) vec[i] /= norm;
        return vec;
    }
    return {
        dims,
        embed: async (text: string) => embed(text),
        embedBatch: async (texts: string[]) => texts.map(t => embed(t)),
        close: () => {},
    };
}

// ── Fixture Builder ─────────────────────────────────────

let tmpDir: string;
let repoDir: string;
let docsDir: string;
let dbPath: string;

function createFixtures() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainbank-indexer-test-'));
    repoDir = path.join(tmpDir, 'repo');
    docsDir = path.join(tmpDir, 'docs');
    dbPath = path.join(tmpDir, 'test.db');

    // ── Create a git repo with code files ──────────
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });

    // Init git repo
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@brainbank.dev"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'pipe' });

    // First commit: add TypeScript files
    fs.writeFileSync(path.join(repoDir, 'src', 'hello.ts'), `
/**
 * Greet a user
 */
export function greet(name: string): string {
    return \`Hello, \${name}! Welcome to BrainBank.\`;
}

export function farewell(name: string): string {
    return \`Goodbye, \${name}!\`;
}
`.trim());

    fs.writeFileSync(path.join(repoDir, 'src', 'math.ts'), `
/**
 * Basic math utilities
 */
export function add(a: number, b: number): number {
    return a + b;
}

export function multiply(a: number, b: number): number {
    return a * b;
}

export function fibonacci(n: number): number {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
}
`.trim());

    fs.writeFileSync(path.join(repoDir, 'src', 'utils.py'), `
"""Python utility functions for data processing."""

def parse_csv(filepath: str) -> list:
    """Parse a CSV file and return rows."""
    with open(filepath) as f:
        return [line.split(',') for line in f]

def clean_text(text: str) -> str:
    """Remove extra whitespace from text."""
    return ' '.join(text.split())
`.trim());

    execSync('git add -A && git commit -m "feat: initial code — hello, math, utils"', { cwd: repoDir, stdio: 'pipe' });

    // Second commit: modify a file
    fs.writeFileSync(path.join(repoDir, 'src', 'hello.ts'), `
/**
 * Greet a user with optional excitement
 */
export function greet(name: string, excited: boolean = false): string {
    const msg = \`Hello, \${name}! Welcome to BrainBank.\`;
    return excited ? msg.toUpperCase() : msg;
}

export function farewell(name: string): string {
    return \`Goodbye, \${name}! See you soon.\`;
}
`.trim());

    execSync('git add -A && git commit -m "refactor: add excitement option to greet"', { cwd: repoDir, stdio: 'pipe' });

    // Third commit: add a new file
    fs.writeFileSync(path.join(repoDir, 'src', 'api.ts'), `
/**
 * Simple HTTP API client
 */
export async function fetchJSON(url: string): Promise<any> {
    const res = await fetch(url);
    return res.json();
}

export async function postJSON(url: string, data: any): Promise<any> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    return res.json();
}
`.trim());

    execSync('git add -A && git commit -m "feat: add HTTP API client"', { cwd: repoDir, stdio: 'pipe' });

    // ── Create markdown docs ───────────────────────
    fs.mkdirSync(docsDir, { recursive: true });

    fs.writeFileSync(path.join(docsDir, 'getting-started.md'), `
# Getting Started with BrainBank

BrainBank is a semantic knowledge bank for AI agents.

## Installation

\`\`\`bash
npm install brainbank
\`\`\`

## Quick Start

Create a BrainBank instance and index your codebase:

\`\`\`typescript
import { BrainBank, code, git } from 'brainbank';
const brain = new BrainBank().use(code()).use(git());
await brain.index();
\`\`\`

## Features

- **Code Indexing**: 30+ language support
- **Git History**: Commit analysis and co-edit detection
- **Semantic Search**: HNSW vector + BM25 hybrid
- **Collections**: Universal key-value store
`.trim());

    fs.writeFileSync(path.join(docsDir, 'api-reference.md'), `
# API Reference

## BrainBank Class

The main entry point for all operations.

### Constructor

\`\`\`typescript
new BrainBank(options?: BrainBankConfig)
\`\`\`

### Methods

#### search(query, options?)
Search across all indices.

#### index(options?)
Index code and git history.

#### collection(name)
Get or create a dynamic collection.

## Embedding Providers

BrainBank supports pluggable embedding providers:

- **LocalEmbedding**: MiniLM-L6-v2 (384 dims, runs locally)
- **OpenAIEmbedding**: text-embedding-3-small (1536 dims)
`.trim());

    fs.writeFileSync(path.join(docsDir, 'architecture.md'), `
# Architecture

## Overview

BrainBank uses a hybrid search architecture combining:

1. **HNSW** — Approximate nearest neighbor for vector search
2. **FTS5** — SQLite full-text search for keyword matching
3. **RRF** — Reciprocal Rank Fusion to merge results

## Data Flow

Files → Chunker → Embedder → HNSW + SQLite

## Storage

All data lives in a single SQLite database with WAL mode
for concurrent reads. Vectors are stored as blobs alongside
their chunk data.
`.trim());
}

function cleanup() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ── Tests ──────────────────────────────────────────────

export const tests: Record<string, () => Promise<void>> = {};

// ── SETUP ──────────────────────────────────────────────

let brain: BrainBank;

tests['setup: create temp repo with git history, code files, and docs'] = async () => {
    createFixtures();

    brain = new BrainBank({
        repoPath: repoDir,
        dbPath,
        embeddingProvider: hashEmbedding(),
    })
        .use(code({ repoPath: repoDir }))
        .use(git({ repoPath: repoDir }))
        .use(docs());

    await brain.initialize();

    const assert = (await import('node:assert')).strict;
    assert.ok(brain, 'BrainBank instance created');
};

// ── CODE INDEXER ──────────────────────────────────────

tests['code indexer: indexes TypeScript and Python files'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexCode();

    assert.ok(result.indexed >= 3, `indexed ${result.indexed} files (expected ≥3)`);
    assert.ok(result.chunks! > 0, `created ${result.chunks} chunks`);
};

tests['code indexer: skips unchanged files on re-index'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexCode();

    assert.equal(result.indexed, 0, 'no files re-indexed');
    assert.ok(result.skipped >= 3, `skipped ${result.skipped} unchanged files`);
};

tests['code indexer: search finds function by semantic query'] = async () => {
    const assert = (await import('node:assert')).strict;

    // Use code module's HNSW directly for search
    const codeMod = brain.indexer('code') as any;
    const embedding = hashEmbedding();
    const queryVec = await embedding.embed('greeting function');
    const hits = codeMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, `found ${hits.length} vector hits`);
};

tests['code indexer: search finds python modules'] = async () => {
    const assert = (await import('node:assert')).strict;

    const codeMod = brain.indexer('code') as any;
    const embedding = hashEmbedding();
    const queryVec = await embedding.embed('parse CSV file');
    const hits = codeMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, `found ${hits.length} vector hits for CSV query`);
};

tests['code indexer: force reindex re-processes all files'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexCode({ forceReindex: true });

    assert.ok(result.indexed >= 3, `force re-indexed ${result.indexed} files`);
};

// ── GIT INDEXER ────────────────────────────────────────

tests['git indexer: indexes commit history'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexGit({ depth: 50 });

    assert.ok(result.indexed >= 3, `indexed ${result.indexed} commits (expected ≥3)`);
};

tests['git indexer: skips already indexed commits'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexGit({ depth: 50 });

    assert.equal(result.indexed, 0, 'no new commits');
    assert.ok(result.skipped >= 3, `skipped ${result.skipped} existing commits`);
};

tests['git indexer: search finds commits by message'] = async () => {
    const assert = (await import('node:assert')).strict;

    const gitMod = brain.indexer('git') as any;
    const embedding = hashEmbedding();
    const queryVec = await embedding.embed('excitement option');
    const hits = gitMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, `found ${hits.length} commit vector hits`);
};

tests['git indexer: search finds commits by file change'] = async () => {
    const assert = (await import('node:assert')).strict;

    const gitMod = brain.indexer('git') as any;
    const embedding = hashEmbedding();
    const queryVec = await embedding.embed('HTTP API client');
    const hits = gitMod.hnsw.search(queryVec, 5);

    assert.ok(hits.length > 0, `found ${hits.length} commit vector hits for API query`);
};

// ── DOCS INDEXER ──────────────────────────────────────

tests['docs indexer: register and index a collection'] = async () => {
    const assert = (await import('node:assert')).strict;

    await brain.addCollection({
        name: 'project-docs',
        path: docsDir,
        pattern: '**/*.md',
    });

    const result = await brain.indexDocs();
    const stats = result['project-docs'];
    assert.ok(stats, 'collection was indexed');
    assert.ok(stats.indexed >= 3, `indexed ${stats.indexed} docs (expected ≥3)`);
    assert.ok(stats.chunks > 0, `created ${stats.chunks} chunks`);
};

tests['docs indexer: skips unchanged docs on re-index'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexDocs();
    const stats = result['project-docs'];

    assert.equal(stats.indexed, 0, 'no docs re-indexed');
    assert.ok(stats.skipped >= 3, `skipped ${stats.skipped} unchanged docs`);
};

tests['docs indexer: search finds docs by content'] = async () => {
    const assert = (await import('node:assert')).strict;

    const docsMod = brain.indexer('docs') as any;
    const results = await docsMod.search('installation npm');

    assert.ok(results.length > 0, 'has document results');
    const docResult = results.find((r: any) => r.type === 'document');
    assert.ok(docResult, 'found document type');
};

tests['docs indexer: lists registered collections'] = async () => {
    const assert = (await import('node:assert')).strict;

    const docsMod = brain.indexer('docs') as any;
    const collections = docsMod.listCollections();

    assert.ok(collections.length >= 1, 'has at least one collection');
    const found = collections.find((c: any) => c.name === 'project-docs');
    assert.ok(found, 'project-docs found');
    assert.equal(found.path, docsDir);
};

tests['docs indexer: remove collection clears all data'] = async () => {
    const assert = (await import('node:assert')).strict;

    const docsMod = brain.indexer('docs') as any;
    docsMod.removeCollection('project-docs');

    const collections = docsMod.listCollections();
    const found = collections.find((c: any) => c.name === 'project-docs');
    assert.ok(!found, 'collection removed');
};

// ── UNIFIED INDEX & SEARCH ─────────────────────────────

tests['full index: brain.index() runs code + git together'] = async () => {
    const assert = (await import('node:assert')).strict;

    // Re-add docs collection for full index
    await brain.addCollection({ name: 'docs', path: docsDir, pattern: '**/*.md' });

    const result = await brain.index({ forceReindex: true });
    assert.ok(result.code, 'code result present');
    assert.ok(result.code.indexed >= 3, `code indexed ${result.code.indexed}`);
    assert.ok(result.git, 'git result present');
};

tests['unified search: code + git HNSW both have vectors'] = async () => {
    const assert = (await import('node:assert')).strict;

    const codeMod = brain.indexer('code') as any;
    const gitMod = brain.indexer('git') as any;

    assert.ok(codeMod.hnsw.size > 0, `code HNSW has ${codeMod.hnsw.size} vectors`);
    assert.ok(gitMod.hnsw.size > 0, `git HNSW has ${gitMod.hnsw.size} vectors`);

    // Search both indices for "BrainBank"
    const embedding = hashEmbedding();
    const queryVec = await embedding.embed('BrainBank');
    const codeHits = codeMod.hnsw.search(queryVec, 5);
    const gitHits = gitMod.hnsw.search(queryVec, 5);

    assert.ok(codeHits.length > 0, 'has code hits');
    assert.ok(gitHits.length > 0, 'has git hits');
};

tests['stats: returns indexer stats'] = async () => {
    const assert = (await import('node:assert')).strict;
    const stats = await brain.stats();

    assert.ok(stats.code, 'code stats');
    assert.ok(stats.git, 'git stats');
    assert.ok(stats.code.hnswSize > 0, `code HNSW has ${stats.code.hnswSize} vectors`);
    assert.ok(stats.git.hnswSize > 0, `git HNSW has ${stats.git.hnswSize} vectors`);
};

// ── CLEANUP ────────────────────────────────────────────

tests['cleanup'] = async () => {
    brain.close();
    cleanup();
};
