/**
 * BrainBank CLI — Plugin Loader
 *
 * Dynamic loading of @brainbank/* plugin packages and
 * auto-discovery of user plugins from .brainbank/plugins/.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Plugin } from '@/plugin.ts';
import { c, getFlag } from '../utils.ts';

/** Plugin factory — accepts config, returns Plugin. */
type PluginFactory = (opts: Record<string, unknown>) => Plugin;

const INDEXER_EXTENSIONS = ['.ts', '.js', '.mjs'];
const NOT_LOADED = Symbol('not-loaded');
let _folderPluginsCache: Plugin[] | typeof NOT_LOADED = NOT_LOADED;

/** Try to load @brainbank/code. Returns factory or null if not installed. */
export async function loadCodePlugin(): Promise<PluginFactory | null> {
    try {
        const mod = await import('@brainbank/code');
        return mod.code;
    } catch { return null; }
}

/** Try to load @brainbank/git. Returns factory or null if not installed. */
export async function loadGitPlugin(): Promise<PluginFactory | null> {
    try {
        const mod = await import('@brainbank/git');
        return mod.git;
    } catch { return null; }
}

/** Try to load @brainbank/docs. Returns factory or null if not installed. */
export async function loadDocsPlugin(): Promise<PluginFactory | null> {
    try {
        const mod = await import('@brainbank/docs');
        return mod.docs;
    } catch { return null; }
}

/** Auto-discover plugins from .brainbank/plugins/ folder. */
export async function discoverFolderPlugins(): Promise<Plugin[]> {
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
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(c.red(`Error loading plugin ${file}: ${message}`));
        }
    }

    _folderPluginsCache = plugins;
    return plugins;
}

/** Reset folder plugins cache. Useful for tests. */
export function resetPluginCache(): void {
    _folderPluginsCache = NOT_LOADED;
}

// ── Provider Setup (merged from provider-setup.ts) ──

import type { EmbeddingProvider } from '@/types.ts';
import type { ProjectConfig } from './config-loader.ts';

/** Resolve an embedding key string to an EmbeddingProvider instance. */
export async function resolveEmbeddingKey(key: string): Promise<EmbeddingProvider> {
    const { resolveEmbedding } = await import('@/providers/embeddings/resolve.ts');
    return resolveEmbedding(key);
}

/** Configure reranker and global embedding provider on brainOpts. */
export async function setupProviders(brainOpts: Record<string, unknown>, config: ProjectConfig | null): Promise<void> {
    const rerankerFlag = getFlag('reranker') ?? (config?.reranker as string | undefined);
    if (rerankerFlag === 'qwen3') {
        const { Qwen3Reranker } = await import('@/providers/rerankers/qwen3-reranker.ts');
        brainOpts.reranker = new Qwen3Reranker();
    }

    const embFlag = getFlag('embedding') ?? (config?.embedding as string | undefined) ?? process.env.BRAINBANK_EMBEDDING;
    if (embFlag) {
        const provider = await resolveEmbeddingKey(embFlag);
        brainOpts.embeddingProvider = provider;
        brainOpts.embeddingDims = provider.dims;
    }
}
