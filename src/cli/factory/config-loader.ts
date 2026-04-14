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
import { c } from '../utils.ts';

/** Full .brainbank/config.json schema. */
export interface ProjectConfig {
    plugins?: string[];
    embedding?: string;
    reranker?: string;
    pruner?: string;
    maxFileSize?: number;
    indexers?: Plugin[];
    brainbank?: Partial<BrainBankConfig>;
    /** Optional API keys — override env vars. Kept out of version control. */
    keys?: {
        anthropic?: string;
        perplexity?: string;
        openai?: string;
    };
    /** Context field defaults (e.g. { lines: true, callTree: true, symbols: false }). */
    context?: Record<string, unknown>;
    /** Per-plugin config sections (e.g. code, git, docs). */
    [pluginName: string]: unknown;
}

const CONFIG_NAMES = ['config.json', 'config.ts', 'config.js', 'config.mjs'];
const NOT_LOADED = Symbol('not-loaded');
let _configCache: ProjectConfig | null | typeof NOT_LOADED = NOT_LOADED;

/** Load .brainbank/config.json (or .ts fallback) if present. */
export async function loadConfig(repoPath: string): Promise<ProjectConfig | null> {
    if (_configCache !== NOT_LOADED) return _configCache;

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
export async function getConfig(repoPath?: string): Promise<ProjectConfig | null> {
    return loadConfig(repoPath ?? '.');
}

/** Reset config cache. Useful for tests. */
export function resetConfigCache(): void {
    _configCache = NOT_LOADED;
}
