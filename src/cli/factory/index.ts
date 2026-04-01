/**
 * BrainBank CLI — Brain Factory
 *
 * Creates a configured BrainBank instance with dynamically loaded plugins,
 * auto-discovered indexers, and config file support.
 * Delegates to focused modules in factory/.
 */

import type { BrainBankConfig } from '@/types.ts';

import { BrainBank } from '@/brainbank.ts';
import { getFlag } from '../utils.ts';
import { registerBuiltins, registerConfigCollections } from './builtin-registration.ts';
import { loadConfig, getConfig, resetConfigCache } from './config-loader.ts';
import { discoverFolderPlugins, resetPluginCache, setupProviders } from './plugin-loader.ts';

export type { ProjectConfig } from './config-loader.ts';
export { getConfig, registerConfigCollections };

/** Reset factory caches. Useful for tests. */
export function resetFactoryCache(): void {
    resetConfigCache();
    resetPluginCache();
}

/** Create a BrainBank with built-in + discovered + config plugins. */
export async function createBrain(repoPath?: string): Promise<BrainBank> {
    const rp = repoPath ?? getFlag('repo') ?? '.';
    const config = await loadConfig(rp);
    const folderPlugins = await discoverFolderPlugins();

    const brainOpts: Partial<BrainBankConfig> & Record<string, unknown> = { repoPath: rp, ...(config?.brainbank ?? {}) };
    if (config?.maxFileSize) brainOpts.maxFileSize = config.maxFileSize;
    await setupProviders(brainOpts, config);

    const brain = new BrainBank(brainOpts);
    const builtins = config?.plugins ?? ['code', 'git', 'docs'];
    await registerBuiltins(brain, rp, builtins, config);

    for (const plugin of folderPlugins) brain.use(plugin);

    if (config?.indexers) {
        for (const plugin of config.indexers) brain.use(plugin);
    }

    return brain;
}
