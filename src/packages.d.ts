/**
 * Type declarations for separate @brainbank packages (dynamic imports).
 * 
 * IMPORTANT: These are manually maintained. If you change the public API
 * of @brainbank/memory, @brainbank/reranker, or @brainbank/mcp, update
 * the corresponding declarations here. The canonical source is each
 * package's own src/index.ts.
 * 
 * This file exists because these packages are not npm-linked during development.
 * Once they are published and installed as real dependencies, this file can be deleted.
 */

declare module '@brainbank/reranker' {
    export interface Qwen3RerankerOptions {
        modelUri?: string;
        cacheDir?: string;
        contextSize?: number;
    }
    
    export class Qwen3Reranker {
        constructor(options?: Qwen3RerankerOptions);
        rank(query: string, documents: string[]): Promise<number[]>;
        close(): Promise<void>;
    }
}

declare module '@brainbank/mcp' {
    // MCP server auto-starts on import — no exports needed
}

declare module '@brainbank/memory' {
    export interface ChatMessage {
        role: 'system' | 'user' | 'assistant';
        content: string;
    }

    export interface GenerateOptions {
        json?: boolean;
        maxTokens?: number;
        temperature?: number;
    }

    export interface LLMProvider {
        generate(messages: ChatMessage[], options?: GenerateOptions): Promise<string>;
    }

    export interface OpenAIProviderOptions {
        apiKey?: string;
        model?: string;
        baseUrl?: string;
    }

    export class OpenAIProvider implements LLMProvider {
        constructor(options?: OpenAIProviderOptions);
        generate(messages: ChatMessage[], options?: GenerateOptions): Promise<string>;
    }

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

    export interface MemoryStore {
        add(content: string, options?: { tags?: string[]; metadata?: Record<string, any> }): Promise<any>;
        search(query: string, options?: { k?: number }): Promise<MemoryItem[]>;
        list(options?: { limit?: number }): MemoryItem[];
        remove(id: string | number): void | Promise<void>;
        count(): number;
    }

    export interface MemoryOptions {
        llm: LLMProvider;
        entityStore?: EntityStore;
        maxFacts?: number;
        maxMemories?: number;
        dedupTopK?: number;
        extractPrompt?: string;
        dedupPrompt?: string;
        onOperation?: (op: MemoryOperation) => void;
        collectionName?: string;
    }

    export interface ProcessResult {
        operations: MemoryOperation[];
        entities?: { entitiesProcessed: number; relationshipsProcessed: number };
    }

    export class Memory {
        constructor(store: MemoryStore, options: MemoryOptions);
        process(userMessage: string, assistantMessage: string): Promise<ProcessResult>;
        search(query: string, k?: number): Promise<MemoryItem[]>;
        recall(limit?: number): MemoryItem[];
        count(): number;
        buildContext(limit?: number): string;
        getEntityStore(): EntityStore | undefined;
    }

    export interface Entity {
        name: string;
        type: 'person' | 'service' | 'project' | 'organization' | 'concept' | string;
        attributes?: Record<string, any>;
    }

    export interface Relationship {
        source: string;
        target: string;
        relation: string;
        context?: string;
        timestamp?: number;
    }

    export interface EntityStoreConfig {
        llm?: LLMProvider;
        onEntity?: (op: { action: 'NEW' | 'UPDATED' | 'RELATED'; name: string; type?: string; detail?: string }) => void;
        entityCollectionName?: string;
        relationCollectionName?: string;
    }

    export interface CollectionProvider {
        collection(name: string): MemoryStore;
    }

    export class EntityStore {
        constructor(provider: CollectionProvider, config?: EntityStoreConfig);
        setLLM(llm: LLMProvider): void;
        upsert(entity: Entity): Promise<void>;
        relate(source: string, target: string, relation: string, context?: string): Promise<void>;
        findEntity(name: string): Promise<(MemoryItem & { metadata?: Record<string, any> }) | null>;
        getRelated(entityName: string): Promise<Relationship[]>;
        listEntities(options?: { type?: string; limit?: number }): MemoryItem[];
        listRelationships(): MemoryItem[];
        entityCount(): number;
        relationCount(): number;
        buildContext(entityName?: string): string;
    }
}
