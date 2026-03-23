/**
 * @brainbank/memory — Entity Store
 *
 * Manages entities and relationships extracted from conversations.
 * Uses BrainBank collections (SQLite) — no Neo4j or external graph DB needed.
 */

import type { MemoryStore, MemoryItem } from './memory.js';

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

export interface EntityStoreOptions {
    /** Collection for entities */
    entityCollection: MemoryStore;
    /** Collection for relationships */
    relationCollection: MemoryStore;
}

// ─── EntityStore Class ──────────────────────────────

export class EntityStore {
    private readonly entities: MemoryStore;
    private readonly relations: MemoryStore;

    constructor(options: EntityStoreOptions) {
        this.entities = options.entityCollection;
        this.relations = options.relationCollection;
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
    }

    /**
     * Find an entity by name (semantic search).
     */
    async findEntity(name: string): Promise<(MemoryItem & { metadata?: Record<string, any> }) | null> {
        const results = await this.entities.search(name, { k: 3 });
        // Find exact or closest match
        for (const r of results) {
            if (this.extractName(r.content).toLowerCase() === name.toLowerCase()) {
                return r;
            }
        }
        return results.length > 0 && (results[0].score ?? 0) > 0.8 ? results[0] : null;
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

