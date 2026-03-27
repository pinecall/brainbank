/**
 * BrainBank CLI — Brain Factory
 *
 * Creates a configured BrainBank instance with built-in indexers,
 * auto-discovered indexers, and config file support.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { BrainBank } from '@/brainbank.ts';
import { code } from '@/indexers/code/code-plugin.ts';
import { git } from '@/indexers/git/git-plugin.ts';
import { docs } from '@/indexers/docs/docs-plugin.ts';
import type { Indexer } from '@/indexers/base.ts';
import { c, getFlag } from './utils.ts';

// ── Types ───────────────────────────────────────────

interface BrainBankCliConfig {
    /** Custom indexers to register alongside built-in ones. */
    indexers?: Indexer[];
    /** Override which built-in indexers to load. Default: ['code', 'git', 'docs'] */
    builtins?: ('code' | 'git' | 'docs')[];
    /** BrainBank constructor options. */
    brainbank?: Record<string, any>;
}

const CONFIG_NAMES = ['config.ts', 'config.js', 'config.mjs'];
const INDEXER_EXTENSIONS = ['.ts', '.js', '.mjs'];

// ── Caches ──────────────────────────────────────────

const NOT_LOADED = Symbol('not-loaded');
let _configCache: BrainBankCliConfig | null | typeof NOT_LOADED = NOT_LOADED;
let _folderIndexersCache: Indexer[] | typeof NOT_LOADED = NOT_LOADED;

/** Reset factory caches. Useful for tests that import this module multiple times. */
export function resetFactoryCache(): void {
    _configCache = NOT_LOADED;
    _folderIndexersCache = NOT_LOADED;
}

// ── Config Loader ───────────────────────────────────

/** Load .brainbank/config.ts if present. */
async function loadConfig(): Promise<BrainBankCliConfig | null> {
    if (_configCache !== NOT_LOADED) return _configCache;

    const repoPath = getFlag('repo') ?? '.';
    const brainbankDir = path.resolve(repoPath, '.brainbank');

    for (const name of CONFIG_NAMES) {
        const configPath = path.join(brainbankDir, name);
        if (fs.existsSync(configPath)) {
            try {
                const mod = await import(configPath);
                _configCache = (mod.default ?? mod) as BrainBankCliConfig;
                return _configCache;
            } catch (err: any) {
                console.error(c.red(`Error loading .brainbank/${name}: ${err.message}`));
                process.exit(1);
            }
        }
    }

    _configCache = null;
    return null;
}

// ── Indexer Discovery ───────────────────────────────

/** Auto-discover indexers from .brainbank/indexers/ folder. */
async function discoverFolderIndexers(): Promise<Indexer[]> {
    if (_folderIndexersCache !== NOT_LOADED) return _folderIndexersCache;

    const repoPath = getFlag('repo') ?? '.';
    const indexersDir = path.resolve(repoPath, '.brainbank', 'indexers');

    if (!fs.existsSync(indexersDir)) {
        _folderIndexersCache = [];
        return [];
    }

    const files = fs.readdirSync(indexersDir)
        .filter(f => INDEXER_EXTENSIONS.some(ext => f.endsWith(ext)))
        .sort();

    const indexers: Indexer[] = [];

    for (const file of files) {
        const filePath = path.join(indexersDir, file);
        try {
            const mod = await import(filePath);
            const indexer = mod.default ?? mod;

            if (indexer && typeof indexer === 'object' && indexer.name) {
                indexers.push(indexer as Indexer);
            } else {
                console.error(c.yellow(`⚠ ${file}: must export a default Indexer with a 'name' property, skipping`));
            }
        } catch (err: any) {
            console.error(c.red(`Error loading indexer ${file}: ${err.message}`));
        }
    }

    _folderIndexersCache = indexers;
    return indexers;
}

// ── Multi-repo Detection ────────────────────────────

/** Detect subdirectories that have their own .git repo. */
function detectGitSubdirs(parentPath: string): { name: string; path: string }[] {
    try {
        const entries = fs.readdirSync(parentPath, { withFileTypes: true });
        return entries
            .filter(e =>
                e.isDirectory() &&
                !e.name.startsWith('.') &&
                !e.name.startsWith('node_modules') &&
                fs.existsSync(path.join(parentPath, e.name, '.git')),
            )
            .map(e => ({ name: e.name, path: path.join(parentPath, e.name) }));
    } catch {
        return [];
    }
}

// ── Factory ─────────────────────────────────────────

/** Create a BrainBank with built-in + discovered + config indexers. */
export async function createBrain(repoPath?: string): Promise<BrainBank> {
    const rp = repoPath ?? getFlag('repo') ?? '.';
    const config = await loadConfig();
    const folderIndexers = await discoverFolderIndexers();

    const brainOpts: Record<string, any> = { repoPath: rp, ...(config?.brainbank ?? {}) };
    await setupProviders(brainOpts);

    const brain = new BrainBank(brainOpts);
    const builtins = config?.builtins ?? ['code', 'git', 'docs'];
    registerBuiltins(brain, rp, builtins);

    for (const indexer of folderIndexers) brain.use(indexer);
    if (config?.indexers) {
        for (const indexer of config.indexers) brain.use(indexer);
    }

    return brain;
}

/** Configure reranker and embedding provider on brainOpts. */
async function setupProviders(brainOpts: Record<string, any>): Promise<void> {
    const rerankerFlag = getFlag('reranker');
    if (rerankerFlag === 'qwen3') {
        const { Qwen3Reranker } = await import('@/providers/rerankers/qwen3-reranker.ts');
        brainOpts.reranker = new Qwen3Reranker();
    }

    if (process.env.BRAINBANK_EMBEDDING === 'openai') {
        const { OpenAIEmbedding } = await import('../providers/embeddings/openai-embedding.ts');
        const provider = new OpenAIEmbedding();
        brainOpts.embeddingProvider = provider;
        brainOpts.embeddingDims = provider.dims;
    } else if (process.env.BRAINBANK_EMBEDDING === 'perplexity') {
        const { PerplexityEmbedding } = await import('../providers/embeddings/perplexity-embedding.ts');
        const provider = new PerplexityEmbedding();
        brainOpts.embeddingProvider = provider;
        brainOpts.embeddingDims = provider.dims;
    } else if (process.env.BRAINBANK_EMBEDDING === 'perplexity-context') {
        const { PerplexityContextEmbedding } = await import('../providers/embeddings/perplexity-context-embedding.ts');
        const provider = new PerplexityContextEmbedding();
        brainOpts.embeddingProvider = provider;
        brainOpts.embeddingDims = provider.dims;
    }
}

/** Register built-in indexers with multi-repo detection. */
function registerBuiltins(
    brain: BrainBank, rp: string, builtins: ('code' | 'git' | 'docs')[],
): void {
    const resolvedRp = path.resolve(rp);
    const hasRootGit = fs.existsSync(path.join(resolvedRp, '.git'));
    const gitSubdirs = !hasRootGit ? detectGitSubdirs(resolvedRp) : [];

    if (gitSubdirs.length > 0 && (builtins.includes('code') || builtins.includes('git'))) {
        console.log(c.cyan(`  Multi-repo: found ${gitSubdirs.length} git repos: ${gitSubdirs.map(d => d.name).join(', ')}`));
        for (const sub of gitSubdirs) {
            if (builtins.includes('code')) brain.use(code({ repoPath: sub.path, name: `code:${sub.name}` }));
            if (builtins.includes('git')) brain.use(git({ repoPath: sub.path, name: `git:${sub.name}` }));
        }
    } else {
        if (builtins.includes('code')) brain.use(code({ repoPath: rp }));
        if (builtins.includes('git')) brain.use(git());
    }

    if (builtins.includes('docs')) brain.use(docs());
}
