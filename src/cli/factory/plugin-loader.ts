/**
 * BrainBank CLI — Plugin Loader
 *
 * Generic plugin loader registry with dynamic @brainbank/* package loading,
 * npm package fallback for third-party plugins, and auto-discovery of
 * user plugins from .brainbank/plugins/.
 */

import type { Plugin, PluginScanInfo, PluginPreviewLine } from '@/plugin.ts';
import type { EmbeddingProvider } from '@/types.ts';
import type { ProjectConfig } from './config-loader.ts';
import type { ScanModule } from '@/cli/commands/scan.ts';
import type { PreviewLine } from '@/cli/tui/tree-scanner.ts';

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

/** Built-in plugin names — used to skip npm fallback. */
const BUILTIN_PLUGINS = new Set(['code', 'git', 'docs']);



/**
 * Load a plugin factory by name.
 * 1. Check the built-in loader registry.
 * 2. Fallback: try `import(name)` for npm packages (third-party plugins).
 * Returns null if not installed.
 */
export async function loadPlugin(name: string): Promise<PluginFactory | null> {
    // Built-in loader
    const loader = PLUGIN_LOADERS.get(name);
    if (loader) return loader();

    // npm package fallback — try importing the package directly
    try {
        const mod = await import(name) as Record<string, unknown>;
        // Convention: export default factory, or named export matching short name
        // e.g. 'brainbank-csv' exports `csv()`, '@myorg/brainbank-csv' exports `csv()`
        const shortName = name.replace(/^@[^/]+\//, '').replace(/^brainbank-/, '');
        const factory = mod.default ?? mod[shortName];
        if (typeof factory === 'function') return factory as PluginFactory;

        // Fallback: check all exports for a function that returns a Plugin-like object
        for (const val of Object.values(mod)) {
            if (typeof val === 'function') return val as PluginFactory;
        }
    } catch {
        // Not installed — will be reported by registerBuiltins
    }

    return null;
}

/** Register a custom plugin loader. */
export function registerPluginLoader(name: string, loader: PluginLoaderFn): void {
    PLUGIN_LOADERS.set(name, loader);
}



/** Check if a plugin name is a built-in. */
export function isBuiltinPlugin(name: string): boolean {
    return BUILTIN_PLUGINS.has(name);
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


// ── External Plugin Discovery (TUI integration) ──────────────────

/** Result of discovering external (non-built-in) plugins. */
export interface ExternalPluginDiscovery {
    /** ScanModule entries to merge into the TUI sidebar. */
    modules: ScanModule[];
    /** Preview lines keyed by plugin name, for the TUI explorer panel. */
    previews: Map<string, PreviewLine[]>;
}

/**
 * Discover external plugins from config and produce scan/preview data for the TUI.
 *
 * For each non-built-in plugin in the list:
 *   1. Try `import(name)` to load the package.
 *   2. If it exports `scan(repoPath)`, use it for the sidebar.
 *   3. If it exports `preview(repoPath)`, use it for the explorer panel.
 *   4. If not installed, show as unavailable with install hint.
 *
 * Also scans `.brainbank/plugins/` folder plugins for scan/preview exports.
 */
export async function discoverExternalPlugins(
    repoPath: string,
    pluginNames: string[],
): Promise<ExternalPluginDiscovery> {
    const modules: ScanModule[] = [];
    const previews = new Map<string, PreviewLine[]>();
    const resolvedRp = path.resolve(repoPath);

    // 1. Discover npm plugins listed in config
    for (const name of pluginNames) {
        if (BUILTIN_PLUGINS.has(name)) continue;

        try {
            const mod = await import(name) as Record<string, unknown>;

            // scan() → ScanModule for sidebar
            if (typeof mod.scan === 'function') {
                const info = mod.scan(resolvedRp) as PluginScanInfo;
                modules.push(scanInfoToModule(info));
            } else {
                // No scan export — generic entry
                modules.push({
                    name,
                    available: true,
                    checked: true,
                    icon: '🔌',
                    summary: `${name} plugin`,
                });
            }

            // preview() → PreviewLine[] for explorer
            if (typeof mod.preview === 'function') {
                const lines = mod.preview(resolvedRp) as PluginPreviewLine[];
                previews.set(name, lines.map(previewLineToInternal));
            }
        } catch {
            // Package not installed
            modules.push({
                name,
                available: false,
                checked: false,
                icon: '🔌',
                summary: 'not installed',
                disabled: `npm i ${name}`,
            });
        }
    }

    // 2. Discover folder plugins that export scan/preview
    const pluginsDir = path.resolve(repoPath, '.brainbank', 'plugins');
    if (fs.existsSync(pluginsDir)) {
        const files = fs.readdirSync(pluginsDir)
            .filter(f => INDEXER_EXTENSIONS.some(ext => f.endsWith(ext)))
            .sort();

        for (const file of files) {
            const filePath = path.join(pluginsDir, file);
            try {
                const mod = await import(filePath) as Record<string, unknown>;
                const plugin = mod.default ?? mod;
                const pluginName = (plugin && typeof plugin === 'object' && 'name' in plugin)
                    ? (plugin as { name: string }).name
                    : file.replace(/\.[^.]+$/, '');

                // Skip if already added from config
                if (modules.some(m => m.name === pluginName)) continue;

                if (typeof mod.scan === 'function') {
                    const info = mod.scan(resolvedRp) as PluginScanInfo;
                    modules.push(scanInfoToModule(info));
                } else {
                    modules.push({
                        name: pluginName,
                        available: true,
                        checked: true,
                        icon: '🔌',
                        summary: `local plugin (${file})`,
                    });
                }

                if (typeof mod.preview === 'function') {
                    const lines = mod.preview(resolvedRp) as PluginPreviewLine[];
                    previews.set(pluginName, lines.map(previewLineToInternal));
                }
            } catch {
                // Failed to load folder plugin — skip for discovery
            }
        }
    }

    return { modules, previews };
}

/** Convert PluginScanInfo (public type) to ScanModule (internal type). */
function scanInfoToModule(info: PluginScanInfo): ScanModule {
    return {
        name: info.name,
        available: info.available,
        summary: info.summary,
        icon: info.icon,
        checked: info.checked,
        disabled: info.disabled,
        details: info.details,
    };
}

/** Convert PluginPreviewLine (public type) to PreviewLine (internal type). */
function previewLineToInternal(line: PluginPreviewLine): PreviewLine {
    return {
        text: line.text,
        color: line.color,
        bold: line.bold,
        dim: line.dim,
    };
}


// ── Provider Setup ───────────────────────────────────────────────

/** Resolve an embedding key string to an EmbeddingProvider instance. */
export async function resolveEmbeddingKey(key: string): Promise<EmbeddingProvider> {
    const { resolveEmbedding } = await import('@/providers/embeddings/resolve.ts');
    return resolveEmbedding(key);
}

/** Configure pruner, expander, and global embedding provider on brainOpts. */
export async function setupProviders(
    brainOpts: Record<string, unknown>,
    config: ProjectConfig | null,
    flags?: Record<string, string | undefined>,
    env?: Record<string, string | undefined>,
): Promise<void> {
    // Resolve API keys: config.keys > env vars
    const keys = config?.keys ?? {};
    const anthropicKey = keys.anthropic || process.env.ANTHROPIC_API_KEY;
    const perplexityKey = keys.perplexity || process.env.PERPLEXITY_API_KEY;
    const openaiKey = keys.openai || process.env.OPENAI_API_KEY;

    // Inject resolved keys into process.env so downstream providers auto-detect them
    if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;
    if (perplexityKey) process.env.PERPLEXITY_API_KEY = perplexityKey;
    if (openaiKey) process.env.OPENAI_API_KEY = openaiKey;



    const prunerFlag = flags?.pruner ?? (config?.pruner as string | undefined);
    if (prunerFlag === 'haiku') {
        const { HaikuPruner } = await import('@/providers/pruners/haiku-pruner.ts');
        brainOpts.pruner = new HaikuPruner({ apiKey: anthropicKey });
    }

    // Expander: explicit opt-in only (config.json `expander: "haiku"` or --expander flag)
    const expanderFlag = flags?.expander ?? (config?.expander as string | undefined);
    if (expanderFlag === 'haiku') {
        try {
            const { HaikuExpander } = await import('@/providers/pruners/haiku-expander.ts');
            brainOpts.expander = new HaikuExpander({ apiKey: anthropicKey });
        } catch {
            // Fail-open: if API key missing, skip expander silently
        }
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

    // Context field defaults from config.json "context" section
    if (config?.context) {
        brainOpts.contextFields = config.context;
    }
}
