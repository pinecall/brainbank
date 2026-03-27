/**
 * BrainBank — Notes Module
 * 
 * Store structured conversation digests so the agent
 * remembers past discussions.
 * 
 *   import { notes } from 'brainbank/notes';
 *   brain.use(notes());
 */

import type { Plugin, PluginContext } from '@/indexers/base.ts';
import type { HNSWIndex } from '@/providers/vector/hnsw-index.ts';
import { NoteStore } from './note-store.ts';
import type { NoteDigest, StoredNote, RecallOptions } from './note-store.ts';

class NotesPlugin implements Plugin {
    readonly name = 'notes';
    hnsw!: HNSWIndex;
    store!: NoteStore;
    vecCache = new Map<number, Float32Array>();

    async initialize(ctx: PluginContext): Promise<void> {
        this.hnsw = await ctx.createHnsw(100_000);
        ctx.loadVectors('note_vectors', 'note_id', this.hnsw, this.vecCache);
        this.store = new NoteStore(ctx.db, ctx.embedding, this.hnsw, this.vecCache);
    }

    /** Store a note digest. */
    async remember(digest: NoteDigest): Promise<number> {
        return this.store.remember(digest);
    }

    /** Recall relevant notes (hybrid search). */
    async recall(query: string, options?: RecallOptions): Promise<StoredNote[]> {
        return this.store.recall(query, options);
    }

    /** List recent notes. */
    list(limit?: number, tier?: 'short' | 'long'): StoredNote[] {
        return this.store.list(limit, tier);
    }

    /** Consolidate old short-term → long-term. */
    consolidate(keepRecent?: number): { promoted: number } {
        return this.store.consolidate(keepRecent);
    }

    /** Count notes by tier. */
    count(): { total: number; short: number; long: number } {
        return this.store.count();
    }

    stats(): Record<string, any> {
        return this.store.count();
    }
}

/** Create a notes plugin. */
export function notes(): Plugin {
    return new NotesPlugin();
}
