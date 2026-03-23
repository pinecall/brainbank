/**
 * BrainBank Integration Test — Docs Indexer
 *
 * Full pipeline: register markdown doc collections → index with smart chunking →
 * search by content → filter by collection → manage contexts → incremental skip.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrainBank, docs, hashEmbedding } from '../../helpers.ts';

export const name = 'Docs Indexer';

let tmpDir: string;
let docsDir: string;
let notesDir: string;
let brain: BrainBank;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-docs-'));
    docsDir = path.join(tmpDir, 'docs');
    notesDir = path.join(tmpDir, 'notes');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(notesDir, { recursive: true });

    // Project docs collection
    fs.writeFileSync(path.join(docsDir, 'getting-started.md'), `# Getting Started

## Installation

\`\`\`bash
npm install brainbank
\`\`\`

## Quick Start

Create a BrainBank instance:

\`\`\`typescript
import { BrainBank, code } from 'brainbank';
const brain = new BrainBank().use(code());
await brain.index();
\`\`\`

## Configuration

BrainBank uses sensible defaults. Override via constructor options.
`);

    fs.writeFileSync(path.join(docsDir, 'api-reference.md'), `# API Reference

## BrainBank Class

### Constructor
\`new BrainBank(options?)\`

### Methods

#### search(query, options?)
Search across all indexed data.

#### index(options?)
Index code and git history.

#### collection(name)
Get or create a dynamic collection.

## Search Options

| Option | Default | Description |
|--------|---------|-------------|
| mode   | hybrid  | vector, keyword, or hybrid |
| k      | 10      | Max results |
| tags   | []      | Tag filter |
`);

    fs.writeFileSync(path.join(docsDir, 'architecture.md'), `# Architecture

## Storage

All data lives in a single SQLite database.
WAL mode enables concurrent reads.

## Vector Index

HNSW (Hierarchical Navigable Small World) for approximate nearest neighbor search.
Default: 384 dimensions (MiniLM-L6-v2).

## Hybrid Search

1. HNSW k-NN for semantic similarity
2. FTS5 BM25 for keyword matching
3. RRF (Reciprocal Rank Fusion) to merge
`);

    // Separate notes collection
    fs.writeFileSync(path.join(notesDir, 'meeting-2024-01-15.md'), `# Team Meeting Notes

## Attendees
Alice, Bob, Charlie

## Discussion
- Decided to use HNSW for vector search
- BM25 scoring needs normalization fix
- Next sprint: reranker integration
`);

    fs.writeFileSync(path.join(notesDir, 'retrospective.md'), `# Sprint Retrospective

## What went well
- Code indexer performance improved 3x
- Test coverage above 90%

## What to improve
- Documentation needs more examples
- CI pipeline too slow
`);
}

export const tests: Record<string, () => Promise<void>> = {};

tests['setup: create brain with docs module'] = async () => {
    const assert = (await import('node:assert')).strict;
    setup();

    brain = new BrainBank({ repoPath: tmpDir, dbPath: path.join(tmpDir, 'test.db'), embeddingProvider: hashEmbedding() })
        .use(docs());
    await brain.initialize();
    assert.ok(brain, 'brain created');
};

tests['register: add two document collections'] = async () => {
    const assert = (await import('node:assert')).strict;

    await brain.addCollection({ name: 'project-docs', path: docsDir, pattern: '**/*.md' });
    await brain.addCollection({ name: 'meeting-notes', path: notesDir, pattern: '**/*.md' });

    const docsMod = brain.indexer('docs') as any;
    const collections = docsMod.listCollections();
    assert.equal(collections.length, 2, 'two collections registered');
};

tests['index: indexes both collections'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexDocs();

    assert.ok(result['project-docs'], 'project-docs indexed');
    assert.ok(result['project-docs'].indexed >= 3, `docs: ${result['project-docs'].indexed} files`);
    assert.ok(result['project-docs'].chunks > 0, `docs: ${result['project-docs'].chunks} chunks`);

    assert.ok(result['meeting-notes'], 'meeting-notes indexed');
    assert.ok(result['meeting-notes'].indexed >= 2, `notes: ${result['meeting-notes'].indexed} files`);
};

tests['index: skips unchanged docs on re-index'] = async () => {
    const assert = (await import('node:assert')).strict;
    const result = await brain.indexDocs();

    assert.equal(result['project-docs'].indexed, 0, 'docs unchanged');
    assert.equal(result['meeting-notes'].indexed, 0, 'notes unchanged');
};

tests['index: re-indexes only changed doc'] = async () => {
    const assert = (await import('node:assert')).strict;

    fs.appendFileSync(path.join(docsDir, 'getting-started.md'), '\n## Troubleshooting\n\nCommon issues and solutions.\n');
    const result = await brain.indexDocs();

    assert.equal(result['project-docs'].indexed, 1, 'only changed file');
    assert.equal(result['meeting-notes'].indexed, 0, 'notes untouched');
};

tests['search: finds docs by content'] = async () => {
    const assert = (await import('node:assert')).strict;
    const results = await brain.searchDocs('npm install setup');

    assert.ok(results.length > 0, `got ${results.length} results`);
    assert.equal(results[0].type, 'document', 'type is document');
};

tests['search: returns title and collection metadata'] = async () => {
    const assert = (await import('node:assert')).strict;
    const results = await brain.searchDocs('API reference search options');

    assert.ok(results.length > 0, 'has results');
    const first = results[0];
    assert.ok(first.metadata?.collection, 'has collection');
    assert.ok(first.metadata?.title, 'has title');
};

tests['search: filters by collection'] = async () => {
    const assert = (await import('node:assert')).strict;

    const docsResults = await brain.searchDocs('search', { collection: 'project-docs' });
    const notesResults = await brain.searchDocs('search', { collection: 'meeting-notes' });

    for (const r of docsResults) {
        assert.equal(r.metadata?.collection, 'project-docs', 'filtered to project-docs');
    }
    for (const r of notesResults) {
        assert.equal(r.metadata?.collection, 'meeting-notes', 'filtered to meeting-notes');
    }
};

tests['context: add and resolve path context'] = async () => {
    const assert = (await import('node:assert')).strict;

    brain.addContext('project-docs', '/api-reference.md', 'Main API documentation for BrainBank library');
    const contexts = brain.listContexts();

    assert.ok(contexts.length >= 1, 'has contexts');
    const found = contexts.find(c => c.path === '/api-reference.md');
    assert.ok(found, 'context for api-reference.md');
    assert.ok(found!.context.includes('API documentation'), 'correct context text');
};

tests['context: remove context'] = async () => {
    const assert = (await import('node:assert')).strict;

    brain.removeContext('project-docs', '/api-reference.md');
    const contexts = brain.listContexts();
    const found = contexts.find(c => c.path === '/api-reference.md');
    assert.ok(!found, 'context removed');
};

tests['remove: removeCollection clears all data'] = async () => {
    const assert = (await import('node:assert')).strict;
    const docsMod = brain.indexer('docs') as any;

    docsMod.removeCollection('meeting-notes');
    const collections = docsMod.listCollections();
    const found = collections.find((c: any) => c.name === 'meeting-notes');
    assert.ok(!found, 'collection removed');
};

tests['cleanup'] = async () => {
    brain.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};
