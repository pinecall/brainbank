/**
 * BrainBank — Engine Layer Types
 *
 * Dependency interfaces for IndexAPI and SearchAPI.
 * Centralizes all engine deps so they're discoverable in one place.
 */

import type { PluginRegistry } from '@/services/plugin-registry.ts';
import type { SearchStrategy } from '@/search/types.ts';
import type { ContextBuilder } from '@/search/context-builder.ts';
import type { ResolvedConfig } from '@/types.ts';
import type { KVService } from '@/services/kv-service.ts';

export interface IndexAPIDeps {
    registry: PluginRegistry;
    gitDepth: number;
    emit: (event: string, data: unknown) => void;
}

export interface SearchAPIDeps {
    search?:          SearchStrategy;
    bm25?:            SearchStrategy;
    registry:         PluginRegistry;
    config:           ResolvedConfig;
    kvService:        KVService;
    contextBuilder?:  ContextBuilder;
}
