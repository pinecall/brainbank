/**
 * BrainBank — Conversations Module
 * 
 * Store structured conversation digests so the agent
 * remembers past discussions.
 * 
 *   import { conversations } from 'brainbank/conversations';
 *   brain.use(conversations());
 */

import type { BrainBankModule, ModuleContext } from './types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import { ConversationStore } from '../memory/conversation-store.ts';
import type { ConversationDigest, StoredMemory, RecallOptions } from '../memory/conversation-store.ts';

export interface ConversationsModuleOptions {}

class ConversationsModuleImpl implements BrainBankModule {
    readonly name = 'conversations';
    hnsw!: HNSWIndex;
    store!: ConversationStore;
    vecCache = new Map<number, Float32Array>();

    constructor(private opts: ConversationsModuleOptions = {}) {}

    async initialize(ctx: ModuleContext): Promise<void> {
        this.hnsw = await ctx.createHnsw(100_000);
        ctx.loadVectors('conversation_vectors', 'memory_id', this.hnsw, this.vecCache);
        this.store = new ConversationStore(ctx.db, ctx.embedding, this.hnsw, this.vecCache);
    }

    /** Store a conversation digest. */
    async remember(digest: ConversationDigest): Promise<number> {
        return this.store.remember(digest);
    }

    /** Recall relevant conversation memories (hybrid search). */
    async recall(query: string, options?: RecallOptions): Promise<StoredMemory[]> {
        return this.store.recall(query, options);
    }

    /** List recent memories. */
    list(limit?: number, tier?: 'short' | 'long'): StoredMemory[] {
        return this.store.list(limit, tier);
    }

    /** Consolidate old short-term → long-term. */
    consolidate(keepRecent?: number): { promoted: number } {
        return this.store.consolidate(keepRecent);
    }

    /** Count memories by tier. */
    count(): { total: number; short: number; long: number } {
        return this.store.count();
    }

    stats(): Record<string, any> {
        return this.store.count();
    }
}

/** Create a conversations memory module. */
export function conversations(opts?: ConversationsModuleOptions): BrainBankModule {
    return new ConversationsModuleImpl(opts);
}
