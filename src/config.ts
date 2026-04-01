import type { BrainBankConfig, ResolvedConfig } from './types.ts';

import * as path from 'node:path';


export const DEFAULTS: ResolvedConfig = {
    repoPath: '.',
    dbPath: '.brainbank/brainbank.db',
    gitDepth: 500,
    maxFileSize: 512_000,      // 500KB
    maxDiffBytes: 8192,
    hnswM: 16,
    hnswEfConstruction: 200,
    hnswEfSearch: 50,
    embeddingDims: 384,
    maxElements: 2_000_000,
};


/**
 * Merge partial config with defaults.
 * All fields become required.
 * Relative dbPath is resolved against repoPath.
 */
export function resolveConfig(partial: BrainBankConfig = {}): ResolvedConfig {
    const repoPath = path.resolve(partial.repoPath ?? DEFAULTS.repoPath);
    const rawDbPath = partial.dbPath ?? DEFAULTS.dbPath;
    // Resolve relative dbPath against repoPath so DB lives alongside the repo
    const dbPath = path.isAbsolute(rawDbPath) ? rawDbPath : path.join(repoPath, rawDbPath);

    return {
        repoPath,
        dbPath,
        gitDepth:          partial.gitDepth          ?? DEFAULTS.gitDepth,
        maxFileSize:       partial.maxFileSize       ?? DEFAULTS.maxFileSize,
        maxDiffBytes:      partial.maxDiffBytes      ?? DEFAULTS.maxDiffBytes,
        hnswM:             partial.hnswM             ?? DEFAULTS.hnswM,
        hnswEfConstruction: partial.hnswEfConstruction ?? DEFAULTS.hnswEfConstruction,
        hnswEfSearch:      partial.hnswEfSearch      ?? DEFAULTS.hnswEfSearch,
        embeddingDims:     partial.embeddingDims     ?? DEFAULTS.embeddingDims,
        maxElements:       partial.maxElements       ?? DEFAULTS.maxElements,
        embeddingProvider: partial.embeddingProvider,
        reranker: partial.reranker,
    };
}

