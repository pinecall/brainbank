/**
 * @brainbank/memory — Deterministic Memory Pipeline
 *
 * Automatic fact extraction and deduplication for LLM conversations.
 * Optionally extracts entities and relationships (knowledge graph).
 * Runs after every turn: extract → search → dedup → ADD/UPDATE/NONE.
 */

import type { LLMProvider, ChatMessage } from './llm.js';
import { EXTRACT_PROMPT, EXTRACT_WITH_ENTITIES_PROMPT, DEDUP_PROMPT } from './prompts.js';
import { EntityStore } from './entities.js';
import type { Entity, Relationship } from './entities.js';

// ─── Types ──────────────────────────────────────────

export interface MemoryItem {
    id?: string | number;
    content: string;
    score?: number;
    metadata?: Record<string, any>;
}

export type MemoryAction = 'ADD' | 'UPDATE' | 'NONE';

export interface MemoryOperation {
    fact: string;
    action: MemoryAction;
    reason: string;
}

export interface EntityOperation {
    entitiesProcessed: number;
    relationshipsProcessed: number;
}

export interface ProcessResult {
    operations: MemoryOperation[];
    entities?: EntityOperation;
}

/**
 * Collection interface — matches BrainBank's collection API.
 * Implement this to use a different storage backend.
 */
export interface MemoryStore {
    add(content: string, options?: { tags?: string[]; metadata?: Record<string, any> }): Promise<any>;
    search(query: string, options?: { k?: number }): Promise<MemoryItem[]>;
    list(options?: { limit?: number }): MemoryItem[];
    remove(id: string | number): void | Promise<void>;
    count(): number;
}

export interface MemoryOptions {
    /** LLM provider for extraction and dedup */
    llm: LLMProvider;

    /** Entity store for knowledge graph (opt-in) */
    entityStore?: EntityStore;

    /** Max facts to extract per turn. Default: 5 */
    maxFacts?: number;

    /** Max existing memories to compare against for dedup. Default: 50 */
    maxMemories?: number;

    /** Number of similar memories to check for dedup. Default: 3 */
    dedupTopK?: number;

    /** Custom extraction prompt (replaces default) */
    extractPrompt?: string;

    /** Custom dedup prompt (replaces default) */
    dedupPrompt?: string;

    /** Called for each memory operation */
    onOperation?: (op: MemoryOperation) => void;
}

// ─── Memory Class ───────────────────────────────────

export class Memory {
    private readonly store: MemoryStore;
    private readonly llm: LLMProvider;
    private readonly entityStore?: EntityStore;
    private readonly maxFacts: number;
    private readonly maxMemories: number;
    private readonly dedupTopK: number;
    private readonly extractPrompt: string;
    private readonly dedupPrompt: string;
    private readonly onOperation?: (op: MemoryOperation) => void;

    constructor(store: MemoryStore, options: MemoryOptions) {
        this.store = store;
        this.llm = options.llm;
        this.entityStore = options.entityStore;
        this.maxFacts = options.maxFacts ?? 5;
        this.maxMemories = options.maxMemories ?? 50;
        this.dedupTopK = options.dedupTopK ?? 3;
        // Use entity-aware prompt when entityStore is provided
        this.extractPrompt = options.extractPrompt ?? (options.entityStore ? EXTRACT_WITH_ENTITIES_PROMPT : EXTRACT_PROMPT);
        this.dedupPrompt = options.dedupPrompt ?? DEDUP_PROMPT;
        this.onOperation = options.onOperation;

        // Auto-share LLM with EntityStore for entity resolution
        if (this.entityStore) this.entityStore.setLLM(this.llm);
    }

    /**
     * Process a conversation turn — extract facts (and optionally entities) and store/update memories.
     * This is the main entry point. Call after every user↔assistant exchange.
     */
    async process(userMessage: string, assistantMessage: string): Promise<ProcessResult> {
        // Step 1: Extract atomic facts (and entities if enabled)
        const extraction = await this.extract(userMessage, assistantMessage);
        if (extraction.facts.length === 0 && extraction.entities.length === 0) {
            return { operations: [] };
        }

        // Step 2: Get existing memories for dedup
        const existing = this.store.list({ limit: this.maxMemories });

        // Step 3: Dedup and execute each fact
        const operations: MemoryOperation[] = [];

        for (const fact of extraction.facts) {
            const op = await this.dedup(fact, existing);
            operations.push(op);
            this.onOperation?.(op);

            switch (op.action) {
                case 'ADD':
                    await this.store.add(fact);
                    break;

                case 'UPDATE': {
                    // Find the memory to update via semantic search
                    const similar = await this.store.search(fact, { k: this.dedupTopK });
                    const target = similar[0];
                    if (target?.id) {
                        await this.store.remove(target.id);
                        await this.store.add(fact);
                    }
                    break;
                }

                case 'NONE':
                    // Skip — already captured
                    break;
            }
        }

        // Step 4: Process entities and relationships (if enabled)
        let entityOps: EntityOperation | undefined;
        if (this.entityStore && (extraction.entities.length > 0 || extraction.relationships.length > 0)) {
            const context = `${userMessage} — ${assistantMessage}`.slice(0, 200);
            entityOps = await this.entityStore.processExtraction(
                extraction.entities,
                extraction.relationships,
                context,
            );
        }

        return { operations, entities: entityOps };
    }

    /**
     * Search memories semantically.
     */
    async search(query: string, k = 5): Promise<MemoryItem[]> {
        return this.store.search(query, { k });
    }

    /**
     * Get all memories (for system prompt injection).
     */
    recall(limit = 20): MemoryItem[] {
        return this.store.list({ limit });
    }

    /**
     * Get memory count.
     */
    count(): number {
        return this.store.count();
    }

    /**
     * Build a system prompt section with all memories (and entities if enabled).
     * Drop this into your system prompt.
     */
    buildContext(limit = 20): string {
        const parts: string[] = [];

        const items = this.store.list({ limit });
        if (items.length > 0) {
            parts.push('## Memories\n' + items.map(m => `- ${m.content}`).join('\n'));
        }

        if (this.entityStore) {
            const entityCtx = this.entityStore.buildContext();
            if (entityCtx) parts.push(entityCtx);
        }

        return parts.join('\n\n');
    }

    /**
     * Get entity store (if enabled).
     */
    getEntityStore(): EntityStore | undefined {
        return this.entityStore;
    }

    // ─── Internal ───────────────────────────────────

    private async extract(userMsg: string, assistantMsg: string): Promise<{
        facts: string[];
        entities: Array<{ name: string; type: string; attributes?: Record<string, any> }>;
        relationships: Array<{ source: string; target: string; relation: string }>;
    }> {
        const response = await this.llm.generate([
            { role: 'system', content: this.extractPrompt },
            { role: 'user', content: `User: ${userMsg}\n\nAssistant: ${assistantMsg}` },
        ], { json: true, maxTokens: 500 });

        try {
            const parsed = JSON.parse(response);
            return {
                facts: (parsed.facts ?? []).slice(0, this.maxFacts),
                entities: parsed.entities ?? [],
                relationships: parsed.relationships ?? [],
            };
        } catch {
            return { facts: [], entities: [], relationships: [] };
        }
    }

    private async dedup(fact: string, _existing: MemoryItem[]): Promise<MemoryOperation> {
        // Search for similar memories
        const similar = await this.store.search(fact, { k: this.dedupTopK });

        if (similar.length === 0) {
            return { fact, action: 'ADD', reason: 'no similar memories found' };
        }

        const context = similar
            .map((m, i) => `[${i}] ${m.content}`)
            .join('\n');

        const response = await this.llm.generate([
            { role: 'system', content: this.dedupPrompt },
            { role: 'user', content: `NEW FACT: "${fact}"\n\nEXISTING MEMORIES:\n${context}` },
        ], { json: true, maxTokens: 150 });

        try {
            const parsed = JSON.parse(response);
            return {
                fact,
                action: parsed.action ?? 'ADD',
                reason: parsed.reason ?? '',
            };
        } catch {
            return { fact, action: 'ADD', reason: 'parse error, defaulting to ADD' };
        }
    }
}
