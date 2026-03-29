/**
 * BrainBank CLI — Brain Factory
 *
 * Creates a configured BrainBank instance with dynamically loaded plugins,
 * auto-discovered indexers, and config file support.
 *
 * Config priority: CLI flags > .brainbank/config.json > .brainbank/config.ts > defaults.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { BrainBank } from '@/brainbank.ts';
import type { Plugin } from '@/plugins/base.ts';
import type { EmbeddingProvider, DocumentCollection } from '@/types.ts';
import { c, getFlag } from './utils.ts';

// ── Types ───────────────────────────────────────────

/** Per-plugin config section (shared shape). */
interface PluginConfig {
    /** Embedding provider key: "local", "openai", "perplexity", "perplexity-context". */
    embedding?: string;
}

/** Code plugin config. */
interface CodeConfig extends PluginConfig {
    maxFileSize?: number;
    /** Glob patterns to ignore (e.g. sdk/**, *.generated.ts). */
    ignore?: string[];
}

/** Git plugin config. */
interface GitConfig extends PluginConfig {
    depth?: number;
    maxDiffBytes?: number;
}

/** Docs plugin config. */
interface DocsConfig extends PluginConfig {
    collections?: DocumentCollection[];
}

/** Full .brainbank/config.json schema. */
export interface ProjectConfig {
    /** Which built-in plugins to load. Default: ["code", "git", "docs"] */
    plugins?: ('code' | 'git' | 'docs')[];

    /** Per-plugin config sections. */
    code?: CodeConfig;
    git?: GitConfig;
    docs?: DocsConfig;

    /** Global embedding provider key (default for all plugins). */
    embedding?: string;
    /** Reranker: "none" or "qwen3". */
    reranker?: string;
    /** Max file size in bytes. */
    maxFileSize?: number;

    /** Custom plugin instances (only from .ts config). */
    indexers?: Plugin[];
    /** BrainBank constructor options. */
    brainbank?: Record<string, any>;

    /** Any other plugin name → config (for custom plugins). */
    [pluginName: string]: any;
}

const CONFIG_NAMES = ['config.json', 'config.ts', 'config.js', 'config.mjs'];
const INDEXER_EXTENSIONS = ['.ts', '.js', '.mjs'];

// ── Caches ──────────────────────────────────────────

const NOT_LOADED = Symbol('not-loaded');
let _configCache: ProjectConfig | null | typeof NOT_LOADED = NOT_LOADED;
let _folderPluginsCache: Plugin[] | typeof NOT_LOADED = NOT_LOADED;

/** Reset factory caches. Useful for tests that import this module multiple times. */
export function resetFactoryCache(): void {
    _configCache = NOT_LOADED;
    _folderPluginsCache = NOT_LOADED;
}

// ── Config Loader ───────────────────────────────────

/** Load .brainbank/config.json (or .ts fallback) if present. */
async function loadConfig(): Promise<ProjectConfig | null> {
    if (_configCache !== NOT_LOADED) return _configCache;

    const repoPath = getFlag('repo') ?? '.';
    const brainbankDir = path.resolve(repoPath, '.brainbank');

    for (const name of CONFIG_NAMES) {
        const configPath = path.join(brainbankDir, name);
        if (!fs.existsSync(configPath)) continue;

        try {
            if (name === 'config.json') {
                const raw = fs.readFileSync(configPath, 'utf-8');
                _configCache = JSON.parse(raw) as ProjectConfig;
            } else {
                const mod = await import(configPath);
                _configCache = (mod.default ?? mod) as ProjectConfig;
            }
            return _configCache;
        } catch (err: any) {
            console.error(c.red(`Error loading .brainbank/${name}: ${err.message}`));
            process.exit(1);
        }
    }

    _configCache = null;
    return null;
}

/** Get the loaded config (for use by commands). */
export async function getConfig(): Promise<ProjectConfig | null> {
    return loadConfig();
}

// ── Embedding Resolver ─────────────────────────────

/** Resolve an embedding key string to an EmbeddingProvider instance. */
async function resolveEmbeddingKey(key: string): Promise<EmbeddingProvider> {
    const { resolveEmbedding } = await import('@/providers/embeddings/resolve.ts');
    return resolveEmbedding(key);
}

// ── Dynamic Plugin Loaders ─────────────────────────

/** Try to load @brainbank/code. Returns factory or null if not installed. */
async function loadCodePlugin(): Promise<((opts: any) => Plugin) | null> {
    try {
        const mod = await import('@brainbank/code');
        return mod.code;
    } catch {
        return null;
    }
}

/** Try to load @brainbank/git. Returns factory or null if not installed. */
async function loadGitPlugin(): Promise<((opts: any) => Plugin) | null> {
    try {
        const mod = await import('@brainbank/git');
        return mod.git;
    } catch {
        return null;
    }
}

/** Try to load @brainbank/docs. Returns factory or null if not installed. */
async function loadDocsPlugin(): Promise<((opts: any) => Plugin) | null> {
    try {
        const mod = await import('@brainbank/docs');
        return mod.docs;
    } catch {
        return null;
    }
}

// ── Plugin Discovery ───────────────────────────────

/** Auto-discover plugins from .brainbank/plugins/ folder. */
async function discoverFolderPlugins(): Promise<Plugin[]> {
    if (_folderPluginsCache !== NOT_LOADED) return _folderPluginsCache;

    const repoPath = getFlag('repo') ?? '.';
    const pluginsDir = path.resolve(repoPath, '.brainbank', 'plugins');

    if (!fs.existsSync(pluginsDir)) {
        _folderPluginsCache = [];
        return [];
    }

    const files = fs.readdirSync(pluginsDir)
        .filter(f => INDEXER_EXTENSIONS.some(ext => f.endsWith(ext)))
        .sort();

    const plugins: Plugin[] = [];

    for (const file of files) {
        const filePath = path.join(pluginsDir, file);
        try {
            const mod = await import(filePath);
            const plugin = mod.default ?? mod;

            if (plugin && typeof plugin === 'object' && plugin.name) {
                plugins.push(plugin as Plugin);
            } else {
                console.error(c.yellow(`⚠ ${file}: must export a default Plugin with a 'name' property, skipping`));
            }
        } catch (err: any) {
            console.error(c.red(`Error loading plugin ${file}: ${err.message}`));
        }
    }

    _folderPluginsCache = plugins;
    return plugins;
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
    const folderIndexers = await discoverFolderPlugins();

    const brainOpts: Record<string, any> = { repoPath: rp, ...(config?.brainbank ?? {}) };

    // Apply global config options
    if (config?.maxFileSize) brainOpts.maxFileSize = config.maxFileSize;

    await setupProviders(brainOpts, config);

    const brain = new BrainBank(brainOpts);
    const builtins = config?.plugins ?? ['code', 'git', 'docs'];
    await registerBuiltins(brain, rp, builtins, config);

    // Register custom plugins from .brainbank/plugins/
    for (const plugin of folderIndexers) brain.use(plugin);

    // Register custom plugins from config.ts (programmatic)
    if (config?.indexers) {
        for (const plugin of config.indexers) brain.use(plugin);
    }

    return brain;
}

/** Configure reranker and global embedding provider. */
async function setupProviders(brainOpts: Record<string, any>, config: ProjectConfig | null): Promise<void> {
    // Reranker: CLI flag > config > default
    const rerankerFlag = getFlag('reranker') ?? config?.reranker;
    if (rerankerFlag === 'qwen3') {
        const { Qwen3Reranker } = await import('@/providers/rerankers/qwen3-reranker.ts');
        brainOpts.reranker = new Qwen3Reranker();
    }

    // Embedding: CLI flag > config > BRAINBANK_EMBEDDING env > auto-resolve from DB
    const embFlag = getFlag('embedding') ?? config?.embedding ?? process.env.BRAINBANK_EMBEDDING;
    if (embFlag) {
        const provider = await resolveEmbeddingKey(embFlag);
        brainOpts.embeddingProvider = provider;
        brainOpts.embeddingDims = provider.dims;
    }
    // If no flag, no config, and no env → Initializer reads provider_key from DB → falls back to local
}

/** Register built-in indexers with multi-repo detection and per-plugin embedding. */
async function registerBuiltins(
    brain: BrainBank, rp: string, builtins: ('code' | 'git' | 'docs')[], config: ProjectConfig | null,
): Promise<void> {
    const resolvedRp = path.resolve(rp);
    const hasRootGit = fs.existsSync(path.join(resolvedRp, '.git'));
    const gitSubdirs = !hasRootGit ? detectGitSubdirs(resolvedRp) : [];

    // Resolve per-plugin embeddings from config
    const codeEmb = config?.code?.embedding ? await resolveEmbeddingKey(config.code.embedding) : undefined;
    const gitEmb = config?.git?.embedding ? await resolveEmbeddingKey(config.git.embedding) : undefined;
    const docsEmb = config?.docs?.embedding ? await resolveEmbeddingKey(config.docs.embedding) : undefined;

    // Resolve ignore patterns: CLI flag (--ignore) merges with config.json
    const ignoreFlag = getFlag('ignore');
    const cliIgnore = ignoreFlag ? ignoreFlag.split(',').map(s => s.trim()) : [];
    const configIgnore = config?.code?.ignore ?? [];
    const mergedIgnore = [...configIgnore, ...cliIgnore];
    const ignore = mergedIgnore.length > 0 ? mergedIgnore : undefined;

    // Load plugins dynamically from @brainbank/* packages
    const codeFactory = builtins.includes('code') ? await loadCodePlugin() : null;
    const gitFactory = builtins.includes('git') ? await loadGitPlugin() : null;
    const docsFactory = builtins.includes('docs') ? await loadDocsPlugin() : null;

    // Warn if requested but not installed
    if (builtins.includes('code') && !codeFactory) {
        console.log(c.yellow('  ⚠ @brainbank/code not installed — skipping code indexing'));
        console.log(c.dim('    Install: npm i -g @brainbank/code'));
    }
    if (builtins.includes('git') && !gitFactory) {
        console.log(c.yellow('  ⚠ @brainbank/git not installed — skipping git indexing'));
        console.log(c.dim('    Install: npm i -g @brainbank/git'));
    }
    if (builtins.includes('docs') && !docsFactory) {
        console.log(c.yellow('  ⚠ @brainbank/docs not installed — skipping docs indexing'));
        console.log(c.dim('    Install: npm i -g @brainbank/docs'));
    }

    if (gitSubdirs.length > 0 && (codeFactory || gitFactory)) {
        console.log(c.cyan(`  Multi-repo: found ${gitSubdirs.length} git repos: ${gitSubdirs.map(d => d.name).join(', ')}`));
        for (const sub of gitSubdirs) {
            if (codeFactory) {
                brain.use(codeFactory({
                    repoPath: sub.path,
                    name: `code:${sub.name}`,
                    embeddingProvider: codeEmb,
                    maxFileSize: config?.code?.maxFileSize,
                    ignore,
                }));
            }
            if (gitFactory) {
                brain.use(gitFactory({
                    repoPath: sub.path,
                    name: `git:${sub.name}`,
                    embeddingProvider: gitEmb,
                    depth: config?.git?.depth,
                    maxDiffBytes: config?.git?.maxDiffBytes,
                }));
            }
        }
    } else {
        if (codeFactory) {
            brain.use(codeFactory({
                repoPath: rp,
                embeddingProvider: codeEmb,
                maxFileSize: config?.code?.maxFileSize,
                ignore,
            }));
        }
        if (gitFactory) {
            brain.use(gitFactory({
                embeddingProvider: gitEmb,
                depth: config?.git?.depth,
                maxDiffBytes: config?.git?.maxDiffBytes,
            }));
        }
    }

    if (docsFactory) {
        brain.use(docsFactory({ embeddingProvider: docsEmb }));
    }
}

/** Register doc collections from config. Call after brain.initialize(). */
export async function registerConfigCollections(brain: BrainBank, config: ProjectConfig | null): Promise<void> {
    const collections = config?.docs?.collections;
    if (!collections?.length) return;

    const docsPlugin = brain.docs as any;
    if (!docsPlugin?.addCollection) return;

    for (const coll of collections) {
        const absPath = path.resolve(coll.path);
        try {
            await docsPlugin.addCollection({
                name: coll.name,
                path: absPath,
                pattern: coll.pattern ?? '**/*.md',
                ignore: coll.ignore,
                context: coll.context,
            });
        } catch {
            // Collection already registered — skip
        }
    }
}
