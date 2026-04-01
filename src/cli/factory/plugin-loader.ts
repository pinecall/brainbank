/**
 * BrainBank CLI — Plugin Loader
 *
 * Generic plugin loader registry with dynamic @brainbank/* package loading
 * and auto-discovery of user plugins from .brainbank/plugins/.
 */

import type { Plugin } from '@/plugin.ts';
import type { EmbeddingProvider } from '@/types.ts';
import type { ProjectConfig } from './config-loader.ts';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { c } from '../utils.ts';

/** Plugin factory — accepts config, returns Plugin. */
type PluginFactory = (opts: Record<string, unknown>) => Plugin;

/** Loader function: dynamically imports a package and returns its factory. */
type PluginLoaderFn = () => Promise<PluginFactory | null>;

/** Built-in plugin loader registry. Extensible at runtime. */
const PLUGIN_LOADERS = new Map<string, PluginLoaderFn>([
    ['code', async () => { try { return (await import('@brainbank/code')).code as PluginFactory; } catch { return null; } }],
    ['git', async () => { try { return (await import('@brainbank/git')).git as PluginFactory; } catch { return null; } }],
    ['docs', async () => { try { return (await import('@brainbank/docs')).docs as PluginFactory; } catch { return null; } }],
]);

/** Plugins that support multi-repo mode (one instance per git subdir). */
const MULTI_REPO_PLUGINS = new Set(['code', 'git']);

/** Load a plugin factory by name. Returns null if not installed. */
export async function loadPlugin(name: string): Promise<PluginFactory | null> {
    const loader = PLUGIN_LOADERS.get(name);
    if (!loader) return null;
    return loader();
}

/** Register a custom plugin loader. */
export function registerPluginLoader(name: string, loader: PluginLoaderFn): void {
    PLUGIN_LOADERS.set(name, loader);
}

/** Check if a plugin supports multi-repo mode. */
export function isMultiRepoCapable(name: string): boolean {
    return MULTI_REPO_PLUGINS.has(name);
}

const INDEXER_EXTENSIONS = ['.ts', '.js', '.mjs'];
const NOT_LOADED = Symbol('not-loaded');
let _folderPluginsCache: Plugin[] | typeof NOT_LOADED = NOT_LOADED;

/** Auto-discover plugins from .brainbank/plugins/ folder. */
export async function discoverFolderPlugins(repoPath: string): Promise<Plugin[]> {
    if (_folderPluginsCache !== NOT_LOADED) return _folderPluginsCache;

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

/** Resolve an embedding key string to an EmbeddingProvider instance. */
export async function resolveEmbeddingKey(key: string): Promise<EmbeddingProvider> {
    const { resolveEmbedding } = await import('@/providers/embeddings/resolve.ts');
    return resolveEmbedding(key);
}

/** Configure reranker and global embedding provider on brainOpts. */
export async function setupProviders(
    brainOpts: Record<string, unknown>,
    config: ProjectConfig | null,
    flags?: Record<string, string | undefined>,
    env?: Record<string, string | undefined>,
): Promise<void> {
    const rerankerFlag = flags?.reranker ?? (config?.reranker as string | undefined);
    if (rerankerFlag === 'qwen3') {
        const { Qwen3Reranker } = await import('@/providers/rerankers/qwen3-reranker.ts');
        brainOpts.reranker = new Qwen3Reranker();
    }

    const embFlag = flags?.embedding
        ?? (config?.embedding as string | undefined)
        ?? env?.BRAINBANK_EMBEDDING
        ?? process.env.BRAINBANK_EMBEDDING;
    if (embFlag) {
        const provider = await resolveEmbeddingKey(embFlag);
        brainOpts.embeddingProvider = provider;
        brainOpts.embeddingDims = provider.dims;
    }
}
