/**
 * BrainBank CLI — Config Loader
 *
 * Loads .brainbank/config.json (or .ts/.js/.mjs fallback).
 * Config priority: CLI flags > config file > defaults.
 */

import type { Plugin } from '@/plugin.ts';
import type { BrainBankConfig, DocumentCollection } from '@/types.ts';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { c, getFlag } from '../utils.ts';

/** Per-plugin config section (shared shape). */
interface PluginConfig {
    embedding?: string;
}

/** Code plugin config. */
export interface CodeConfig extends PluginConfig {
    maxFileSize?: number;
    ignore?: string[];
}

/** Git plugin config. */
export interface GitConfig extends PluginConfig {
    depth?: number;
    maxDiffBytes?: number;
}

/** Docs plugin config. */
export interface DocsConfig extends PluginConfig {
    collections?: DocumentCollection[];
}

/** Full .brainbank/config.json schema. */
export interface ProjectConfig {
    plugins?: ('code' | 'git' | 'docs')[];
    code?: CodeConfig;
    git?: GitConfig;
    docs?: DocsConfig;
    embedding?: string;
    reranker?: string;
    maxFileSize?: number;
    indexers?: Plugin[];
    brainbank?: Partial<BrainBankConfig>;
    [pluginName: string]: unknown;
}

const CONFIG_NAMES = ['config.json', 'config.ts', 'config.js', 'config.mjs'];
const NOT_LOADED = Symbol('not-loaded');
let _configCache: ProjectConfig | null | typeof NOT_LOADED = NOT_LOADED;

/** Load .brainbank/config.json (or .ts fallback) if present. */
export async function loadConfig(): Promise<ProjectConfig | null> {
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
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(c.red(`Error loading .brainbank/${name}: ${message}`));
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

/** Reset config cache. Useful for tests. */
export function resetConfigCache(): void {
    _configCache = NOT_LOADED;
}
