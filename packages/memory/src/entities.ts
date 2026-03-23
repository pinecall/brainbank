/**
 * @brainbank/memory — Entity Store
 *
 * Manages entities and relationships extracted from conversations.
 * Uses BrainBank collections (SQLite) — no Neo4j or external graph DB needed.
 * Optional LLM for intelligent entity resolution (e.g. merging "TS" with "TypeScript").
 */

import type { MemoryStore, MemoryItem } from './memory.js';
import type { LLMProvider } from './llm.js';

// ─── Prompts ────────────────────────────────────────

const ENTITY_RESOLVE_PROMPT = `You are an entity resolution engine. Given a NEW entity and a list of EXISTING entities, determine if the new entity refers to the same real-world thing as any existing one.

Consider aliases, abbreviations, alternate names, and typos:
- "TS" = "TypeScript"
- "JS" = "JavaScript"
- "berna" = "Berna"
- "GCP" = "Google Cloud Platform"
- "React.js" = "React"

Respond with ONLY the matching entity name (exactly as listed) or "NONE" if no match.

Existing entities:
{entities}

New entity: {newEntity}

Match:`;

// ─── Types ──────────────────────────────────────────

export interface Entity {
    name: string;
    type: 'person' | 'service' | 'project' | 'organization' | 'concept' | string;
    attributes?: Record<string, any>;
    firstSeen?: number;
    lastSeen?: number;
    mentionCount?: number;
}

export interface Relationship {
    source: string;
    target: string;
    relation: string;
    context?: string;
    timestamp?: number;
}

export interface TraversalNode {
    entity: string;
    relation: string;
    depth: number;
    path: string[];
}

export interface TraversalResult {
    start: string;
    maxDepth: number;
    nodes: TraversalNode[];
}

/** Object with a .collection() method — satisfied by BrainBank */
export interface CollectionProvider {
    collection(name: string): MemoryStore;
}

export interface EntityStoreConfig {
    /** Optional LLM for intelligent entity resolution */
    llm?: LLMProvider;
    /** Callback fired for each entity operation */
    onEntity?: (op: { action: 'NEW' | 'UPDATED' | 'RELATED'; name: string; type?: string; detail?: string }) => void;
    /** Custom entity collection name. Default: 'entities' */
    entityCollectionName?: string;
    /** Custom relationship collection name. Default: 'relationships' */
    relationCollectionName?: string;
}

/**
 * @deprecated Use `new EntityStore(brain, config?)` instead.
 */
export interface EntityStoreOptions {
    /** Collection for entities */
    entityCollection: MemoryStore;
    /** Collection for relationships */
    relationCollection: MemoryStore;
    /** Optional LLM for intelligent entity resolution */
    llm?: LLMProvider;
    /** Callback fired for each entity operation */
    onEntity?: (op: { action: 'NEW' | 'UPDATED' | 'RELATED'; name: string; type?: string; detail?: string }) => void;
}

// ─── EntityStore Class ──────────────────────────────

export class EntityStore {
    private readonly entities: MemoryStore;
    private readonly relations: MemoryStore;
    private llm?: LLMProvider;
    private readonly onEntity?: EntityStoreConfig['onEntity'];

    /**
     * Create an EntityStore.
     *
     * @example Simple (recommended)
     * ```typescript
     * const entityStore = new EntityStore(brain);
     * ```
     *
     * @example With config
     * ```typescript
     * const entityStore = new EntityStore(brain, {
     *   onEntity: (op) => console.log(op),
     * });
     * ```
     */
    constructor(provider: CollectionProvider, config?: EntityStoreConfig);
    /** @deprecated Pass a CollectionProvider (brain) instead */
    constructor(options: EntityStoreOptions);
    constructor(providerOrOptions: CollectionProvider | EntityStoreOptions, config?: EntityStoreConfig) {
        if ('collection' in providerOrOptions && typeof providerOrOptions.collection === 'function') {
            // New API: EntityStore(brain, config?)
            const c = config ?? {};
            this.entities = providerOrOptions.collection(c.entityCollectionName ?? 'entities');
            this.relations = providerOrOptions.collection(c.relationCollectionName ?? 'relationships');
            this.llm = c.llm;
            this.onEntity = c.onEntity;
        } else {
            // Legacy API: EntityStore({ entityCollection, relationCollection })
            const opts = providerOrOptions as EntityStoreOptions;
            this.entities = opts.entityCollection;
            this.relations = opts.relationCollection;
            this.llm = opts.llm;
            this.onEntity = opts.onEntity;
        }
    }

    /** @internal — used by Memory to share its LLM if EntityStore doesn't have one */
    setLLM(llm: LLMProvider): void {
        if (!this.llm) this.llm = llm;
    }

    /**
     * Upsert an entity — create if new, update mention count if exists.
     */
    async upsert(entity: Entity): Promise<void> {
        const now = Date.now();
        const existing = await this.findEntity(entity.name);

        if (existing) {
            // Update: remove old, add updated
            if (existing.id != null) await this.entities.remove(existing.id);
            await this.entities.add(this.serializeEntity(entity), {
                metadata: {
                    type: entity.type,
                    attributes: { ...(existing.metadata?.attributes ?? {}), ...(entity.attributes ?? {}) },
                    firstSeen: existing.metadata?.firstSeen ?? now,
                    lastSeen: now,
                    mentionCount: (existing.metadata?.mentionCount ?? 1) + 1,
                },
            });
            this.onEntity?.({ action: 'UPDATED', name: entity.name, type: entity.type, detail: `${(existing.metadata?.mentionCount ?? 1) + 1}x` });
        } else {
            await this.entities.add(this.serializeEntity(entity), {
                metadata: {
                    type: entity.type,
                    attributes: entity.attributes ?? {},
                    firstSeen: now,
                    lastSeen: now,
                    mentionCount: 1,
                },
            });
            this.onEntity?.({ action: 'NEW', name: entity.name, type: entity.type });
        }
    }

    /**
     * Add a relationship between two entities.
     */
    async relate(source: string, target: string, relation: string, context?: string): Promise<void> {
        const now = Date.now();
        const content = `${source} → ${relation} → ${target}`;
        await this.relations.add(content, {
            metadata: { source, target, relation, context, timestamp: now },
        });
        this.onEntity?.({ action: 'RELATED', name: source, detail: `${source} → ${relation} → ${target}` });
    }

    /**
     * Find an entity by name.
     * 1. Exact name match (case-insensitive)
     * 2. LLM resolution if available (e.g. "TS" → "TypeScript")
     */
    async findEntity(name: string): Promise<(MemoryItem & { metadata?: Record<string, any> }) | null> {
        const results = await this.entities.search(name, { k: 5 });

        // First: exact name match (case-insensitive)
        for (const r of results) {
            if (this.extractName(r.content).toLowerCase() === name.toLowerCase()) {
                return r;
            }
        }

        // Second: LLM resolution (if available and we have candidates)
        if (this.llm && results.length > 0) {
            const candidateNames = results.map(r => this.extractName(r.content));
            const resolved = await this.resolveEntity(name, candidateNames);
            if (resolved) {
                return results.find(r => this.extractName(r.content) === resolved) ?? null;
            }
        }

        return null;
    }

    /**
     * Ask LLM if a new entity matches any existing entity.
     * Returns the matching entity name or null.
     */
    private async resolveEntity(newEntity: string, existing: string[]): Promise<string | null> {
        if (!this.llm || existing.length === 0) return null;

        const prompt = ENTITY_RESOLVE_PROMPT
            .replace('{entities}', existing.map(e => `- ${e}`).join('\n'))
            .replace('{newEntity}', newEntity);

        try {
            const response = await this.llm.generate(
                [{ role: 'user', content: prompt }],
                { maxTokens: 50, temperature: 0 }
            );
            const match = response.trim();
            if (match === 'NONE' || match === 'none') return null;

            // Verify the response is actually one of the existing entities
            const found = existing.find(e => e.toLowerCase() === match.toLowerCase());
            return found ?? null;
        } catch {
            return null; // Fail silently — fall back to no match
        }
    }

    /**
     * Get all relationships for an entity (as source or target).
     */
    async getRelated(entityName: string): Promise<Relationship[]> {
        const results = await this.relations.search(entityName, { k: 20 });
        return results
            .filter(r => r.metadata?.source === entityName || r.metadata?.target === entityName)
            .map(r => ({
                source: r.metadata?.source ?? '',
                target: r.metadata?.target ?? '',
                relation: r.metadata?.relation ?? '',
                context: r.metadata?.context,
                timestamp: r.metadata?.timestamp,
            }));
    }

    /**
     * Get all relationships for an entity (shorthand for getRelated).
     */
    async relationsOf(entityName: string): Promise<Relationship[]> {
        return this.getRelated(entityName);
    }

    /**
     * List all entities, optionally filtered by type.
     */
    listEntities(options?: { type?: string; limit?: number }): MemoryItem[] {
        const all = this.entities.list({ limit: options?.limit ?? 100 });
        if (options?.type) {
            return all.filter(e => e.metadata?.type === options.type);
        }
        return all;
    }

    /**
     * List all relationships.
     */
    listRelationships(): MemoryItem[] {
        return this.relations.list({ limit: 200 });
    }

    /**
     * Get entity count.
     */
    entityCount(): number {
        return this.entities.count();
    }

    /**
     * Get relationship count.
     */
    relationCount(): number {
        return this.relations.count();
    }

    /**
     * Traverse the entity graph — multi-hop BFS from a starting entity.
     * Returns all reachable entities within the given depth.
     */
    async traverse(startEntity: string, maxDepth = 2): Promise<TraversalResult> {
        const visited = new Set<string>();
        const queue: Array<{ entity: string; depth: number; path: string[]; relation: string }> = [
            { entity: startEntity, depth: 0, path: [startEntity], relation: '' },
        ];
        const nodes: TraversalNode[] = [];

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (current.depth > maxDepth || visited.has(current.entity)) continue;
            visited.add(current.entity);

            const rels = await this.getRelated(current.entity);
            for (const rel of rels) {
                const next = rel.source === current.entity ? rel.target : rel.source;
                const nextPath = [...current.path, next];

                if (!visited.has(next)) {
                    nodes.push({
                        entity: next,
                        relation: rel.relation,
                        depth: current.depth + 1,
                        path: nextPath,
                    });
                    queue.push({
                        entity: next,
                        depth: current.depth + 1,
                        path: nextPath,
                        relation: rel.relation,
                    });
                }
            }
        }

        return { start: startEntity, maxDepth, nodes };
    }

    /**
     * Build markdown context for system prompt injection.
     */
    buildContext(entityName?: string): string {
        const parts: string[] = [];

        if (entityName) {
            // Context for a specific entity
            const entities = this.entities.list({ limit: 100 });
            const match = entities.find(e => this.extractName(e.content).toLowerCase() === entityName.toLowerCase());
            if (match) {
                parts.push(`## Entity: ${this.extractName(match.content)}`);
                if (match.metadata?.type) parts.push(`Type: ${match.metadata.type}`);
                if (match.metadata?.mentionCount) parts.push(`Mentions: ${match.metadata.mentionCount}`);
            }

            const rels = this.relations.list({ limit: 200 });
            const related = rels.filter(r =>
                r.metadata?.source === entityName || r.metadata?.target === entityName
            );
            if (related.length > 0) {
                parts.push('### Relationships');
                for (const r of related) {
                    parts.push(`- ${r.metadata?.source} → ${r.metadata?.relation} → ${r.metadata?.target}`);
                }
            }
        } else {
            // Full entity context
            const entities = this.entities.list({ limit: 50 });
            if (entities.length === 0) return '';

            parts.push('## Known Entities');
            for (const e of entities) {
                const name = this.extractName(e.content);
                const type = e.metadata?.type ?? 'unknown';
                const mentions = e.metadata?.mentionCount ?? 1;
                parts.push(`- ${name} (${type}, ${mentions}x)`);
            }

            const rels = this.relations.list({ limit: 50 });
            if (rels.length > 0) {
                parts.push('\n## Relationships');
                for (const r of rels) {
                    parts.push(`- ${r.metadata?.source} → ${r.metadata?.relation} → ${r.metadata?.target}`);
                }
            }
        }

        return parts.join('\n');
    }

    /**
     * Process raw entities and relationships from LLM extraction.
     */
    async processExtraction(
        entities: Array<{ name: string; type: string; attributes?: Record<string, any> }>,
        relationships: Array<{ source: string; target: string; relation: string }>,
        context?: string,
    ): Promise<{ entitiesProcessed: number; relationshipsProcessed: number }> {
        let entitiesProcessed = 0;
        let relationshipsProcessed = 0;

        for (const entity of entities) {
            await this.upsert(entity);
            entitiesProcessed++;
        }

        for (const rel of relationships) {
            await this.relate(rel.source, rel.target, rel.relation, context);
            relationshipsProcessed++;
        }

        return { entitiesProcessed, relationshipsProcessed };
    }

    // ─── Internal ───────────────────────────────────

    private serializeEntity(entity: Entity): string {
        const parts = [entity.name];
        if (entity.type) parts.push(`(${entity.type})`);
        if (entity.attributes && Object.keys(entity.attributes).length > 0) {
            parts.push(JSON.stringify(entity.attributes));
        }
        return parts.join(' ');
    }

    private extractName(content: string): string {
        // "EntityName (type) {attrs}" → "EntityName"
        return content.split(/\s*\(/)[0].trim();
    }
}

