/**
 * BrainBank — Conversation Memory Store
 * 
 * Stores structured conversation digests for long-term agent memory.
 * Each digest captures decisions, files changed, patterns, and open questions.
 * Supports vector + BM25 hybrid retrieval via HNSW + FTS5.
 * 
 * Memory tiers:
 *   - "short" (default): Full digest, last ~20 conversations
 *   - "long":  Compressed to patterns + decisions only
 */

import type { Database } from '../storage/database.ts';
import type { EmbeddingProvider, SearchResult } from '../types.ts';
import type { HNSWIndex } from '../vector/hnsw.ts';
import { BM25Search } from '../query/bm25.ts';
import { reciprocalRankFusion } from '../query/rrf.ts';

export interface ConversationDigest {
    title: string;
    summary: string;
    decisions?: string[];
    filesChanged?: string[];
    patterns?: string[];
    openQuestions?: string[];
    tags?: string[];
}

export interface StoredMemory extends ConversationDigest {
    id: number;
    tier: 'short' | 'long';
    createdAt: number;
    score?: number;
}

export interface RecallOptions {
    /** Max results. Default: 5 */
    k?: number;
    /** Search mode. Default: 'hybrid' */
    mode?: 'hybrid' | 'vector' | 'keyword';
    /** Minimum score threshold. Default: 0.15 */
    minScore?: number;
    /** Filter by tier. Default: all */
    tier?: 'short' | 'long';
}

export class ConversationStore {
    private _db: Database;
    private _embedding: EmbeddingProvider;
    private _hnsw: HNSWIndex;
    private _vecs: Map<number, Float32Array>;

    constructor(
        db: Database,
        embedding: EmbeddingProvider,
        hnsw: HNSWIndex,
        vecs: Map<number, Float32Array>,
    ) {
        this._db = db;
        this._embedding = embedding;
        this._hnsw = hnsw;
        this._vecs = vecs;
    }

    /**
     * Store a conversation digest.
     * Embeds title + summary for vector search, auto-indexed in FTS5.
     */
    async remember(digest: ConversationDigest): Promise<number> {
        const { title, summary, decisions = [], filesChanged = [], patterns = [], openQuestions = [], tags = [] } = digest;

        // Store in SQLite
        const result = this._db.prepare(`
            INSERT INTO conversation_memories (title, summary, decisions_json, files_json, patterns_json, open_json, tags_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            title,
            summary,
            JSON.stringify(decisions),
            JSON.stringify(filesChanged),
            JSON.stringify(patterns),
            JSON.stringify(openQuestions),
            JSON.stringify(tags),
        );

        const id = Number(result.lastInsertRowid);

        // Embed and index
        const text = `${title}\n${summary}\n${decisions.join('. ')}\n${patterns.join('. ')}`;
        const vec = await this._embedding.embed(text);

        this._db.prepare('INSERT INTO conversation_vectors (memory_id, embedding) VALUES (?, ?)').run(
            id, Buffer.from(vec.buffer),
        );

        this._hnsw.add(vec, id);
        this._vecs.set(id, vec);

        return id;
    }

    /**
     * Recall relevant conversation memories.
     * Supports vector, keyword, or hybrid (default) retrieval.
     */
    async recall(query: string, options: RecallOptions = {}): Promise<StoredMemory[]> {
        const { k = 5, mode = 'hybrid', minScore = 0.15, tier } = options;

        let results: StoredMemory[];

        if (mode === 'keyword') {
            results = this._searchBM25(query, k);
        } else if (mode === 'vector') {
            results = await this._searchVector(query, k);
        } else {
            // Hybrid: vector + BM25 → RRF
            const [vectorHits, bm25Hits] = await Promise.all([
                this._searchVector(query, k),
                Promise.resolve(this._searchBM25(query, k)),
            ]);

            const fusedResults = reciprocalRankFusion(
                [
                    vectorHits.map(m => ({ type: 'pattern' as const, score: m.score ?? 0, content: m.summary, metadata: { id: m.id } })),
                    bm25Hits.map(m => ({ type: 'pattern' as const, score: m.score ?? 0, content: m.summary, metadata: { id: m.id } })),
                ],
            );

            // Map back to full StoredMemory objects
            const allById = new Map<number, StoredMemory>();
            for (const m of [...vectorHits, ...bm25Hits]) allById.set(m.id, m);

            results = fusedResults
                .map(r => {
                    const mem = allById.get(r.metadata.id);
                    if (!mem) return null;
                    return { ...mem, score: r.score };
                })
                .filter(Boolean) as StoredMemory[];
        }

        // Apply filters
        return results
            .filter(m => (m.score ?? 0) >= minScore)
            .filter(m => !tier || m.tier === tier)
            .slice(0, k);
    }

    /**
     * List recent conversation memories.
     */
    list(limit: number = 20, tier?: 'short' | 'long'): StoredMemory[] {
        const sql = tier
            ? 'SELECT * FROM conversation_memories WHERE tier = ? ORDER BY id DESC LIMIT ?'
            : 'SELECT * FROM conversation_memories ORDER BY id DESC LIMIT ?';

        const rows = tier
            ? this._db.prepare(sql).all(tier, limit) as any[]
            : this._db.prepare(sql).all(limit) as any[];

        return rows.map(r => this._rowToMemory(r));
    }

    /**
     * Get total count of conversation memories.
     */
    count(): { total: number; short: number; long: number } {
        const total = (this._db.prepare('SELECT COUNT(*) as n FROM conversation_memories').get() as any).n;
        const short = (this._db.prepare("SELECT COUNT(*) as n FROM conversation_memories WHERE tier = 'short'").get() as any).n;
        const long = (this._db.prepare("SELECT COUNT(*) as n FROM conversation_memories WHERE tier = 'long'").get() as any).n;
        return { total, short, long };
    }

    /**
     * Consolidate old short-term memories into long-term.
     * Keeps the most recent `keepRecent` as short-term, compresses the rest.
     */
    consolidate(keepRecent: number = 20): { promoted: number } {
        // Find short-term memories beyond the keep window
        const old = this._db.prepare(`
            SELECT id FROM conversation_memories 
            WHERE tier = 'short' 
            ORDER BY created_at DESC 
            LIMIT -1 OFFSET ?
        `).all(keepRecent) as any[];

        if (old.length === 0) return { promoted: 0 };

        const ids = old.map((r: any) => r.id);
        const placeholders = ids.map(() => '?').join(',');

        // Promote to long-term: clear verbose fields, keep patterns + decisions
        this._db.prepare(`
            UPDATE conversation_memories 
            SET tier = 'long',
                open_json = '[]',
                files_json = '[]'
            WHERE id IN (${placeholders})
        `).run(...ids);

        return { promoted: ids.length };
    }

    // ── Private helpers ────────────────────────────

    private async _searchVector(query: string, k: number): Promise<StoredMemory[]> {
        if (this._hnsw.size === 0) return [];

        const queryVec = await this._embedding.embed(query);
        const hits = this._hnsw.search(queryVec, k);

        if (hits.length === 0) return [];

        const ids = hits.map(h => h.id);
        const scoreMap = new Map(hits.map(h => [h.id, h.score]));
        const placeholders = ids.map(() => '?').join(',');

        const rows = this._db.prepare(
            `SELECT * FROM conversation_memories WHERE id IN (${placeholders})`
        ).all(...ids) as any[];

        return rows.map(r => ({
            ...this._rowToMemory(r),
            score: scoreMap.get(r.id) ?? 0,
        }));
    }

    private _searchBM25(query: string, k: number): StoredMemory[] {
        // Sanitize for FTS5
        const clean = query
            .replace(/[{}[\]()^~*:]/g, ' ')
            .replace(/\bAND\b|\bOR\b|\bNOT\b|\bNEAR\b/gi, '')
            .trim();

        const words = clean.split(/\s+/).filter(w => w.length > 1);
        if (words.length === 0) return [];

        const ftsQuery = words.map(w => `"${w}"`).join(' ');

        try {
            const rows = this._db.prepare(`
                SELECT m.*, bm25(fts_conversations, 5.0, 3.0, 2.0, 2.0, 1.0) AS score
                FROM fts_conversations f
                JOIN conversation_memories m ON m.id = f.rowid
                WHERE fts_conversations MATCH ?
                ORDER BY score ASC
                LIMIT ?
            `).all(ftsQuery, k) as any[];

            return rows.map(r => ({
                ...this._rowToMemory(r),
                score: 1.0 / (1.0 + Math.exp(-0.3 * (Math.abs(r.score) - 5))),
            }));
        } catch {
            return [];
        }
    }

    private _rowToMemory(r: any): StoredMemory {
        return {
            id: r.id,
            title: r.title,
            summary: r.summary,
            decisions: JSON.parse(r.decisions_json || '[]'),
            filesChanged: JSON.parse(r.files_json || '[]'),
            patterns: JSON.parse(r.patterns_json || '[]'),
            openQuestions: JSON.parse(r.open_json || '[]'),
            tags: JSON.parse(r.tags_json || '[]'),
            tier: r.tier,
            createdAt: r.created_at,
        };
    }
}
