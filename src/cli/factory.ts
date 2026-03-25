/**
 * BrainBank CLI — Brain Factory
 *
 * Creates a configured BrainBank instance with built-in indexers,
 * auto-discovered indexers, and config file support.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { BrainBank } from '../engine/brainbank.ts';
import { code } from '../indexers/code/code-plugin.ts';
import { git } from '../indexers/git/git-plugin.ts';
import { docs } from '../indexers/docs/docs-plugin.ts';
import type { Indexer } from '../indexers/base.ts';
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

let _configCache: BrainBankCliConfig | null | undefined = undefined;
let _folderIndexersCache: Indexer[] | undefined = undefined;

// ── Config Loader ───────────────────────────────────

/** Load .brainbank/config.ts if present. */
async function loadConfig(): Promise<BrainBankCliConfig | null> {
    if (_configCache !== undefined) return _configCache;

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
    if (_folderIndexersCache !== undefined) return _folderIndexersCache;

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

    // Optional Qwen3 reranker via --reranker qwen3
    const rerankerFlag = getFlag('reranker');
    if (rerankerFlag === 'qwen3') {
        const { Qwen3Reranker } = await import('@brainbank/reranker');
        brainOpts.reranker = new Qwen3Reranker();
    }

    // Embedding provider via BRAINBANK_EMBEDDING env (default: local WASM)
    const embeddingEnv = process.env.BRAINBANK_EMBEDDING;
    if (embeddingEnv === 'openai') {
        const { OpenAIEmbedding } = await import('../providers/embeddings/openai.ts');
        const provider = new OpenAIEmbedding();
        brainOpts.embeddingProvider = provider;
        brainOpts.embeddingDims = provider.dims;
    }

    const brain = new BrainBank(brainOpts);

    // 1. Built-in indexers (default: all three)
    const builtins = config?.builtins ?? ['code', 'git', 'docs'];

    // Multi-repo detection: check if repoPath has no .git but subdirs do
    const resolvedRp = path.resolve(rp);
    const hasRootGit = fs.existsSync(path.join(resolvedRp, '.git'));
    const gitSubdirs = !hasRootGit ? detectGitSubdirs(resolvedRp) : [];

    if (gitSubdirs.length > 0 && (builtins.includes('code') || builtins.includes('git'))) {
        // Multi-repo mode: create namespaced indexers for each subdir
        console.log(c.cyan(`  Multi-repo: found ${gitSubdirs.length} git repos: ${gitSubdirs.map(d => d.name).join(', ')}`));
        for (const sub of gitSubdirs) {
            if (builtins.includes('code')) {
                brain.use(code({ repoPath: sub.path, name: `code:${sub.name}` }));
            }
            if (builtins.includes('git')) {
                brain.use(git({ repoPath: sub.path, name: `git:${sub.name}` }));
            }
        }
    } else {
        // Single-repo mode (standard)
        if (builtins.includes('code')) brain.use(code({ repoPath: rp }));
        if (builtins.includes('git')) brain.use(git());
    }

    if (builtins.includes('docs')) brain.use(docs());

    // 2. Auto-discovered from .brainbank/indexers/
    for (const indexer of folderIndexers) {
        brain.use(indexer);
    }

    // 3. Indexers from config file
    if (config?.indexers) {
        for (const indexer of config.indexers) {
            brain.use(indexer);
        }
    }

    return brain;
}
