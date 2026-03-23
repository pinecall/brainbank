/**
 * @brainbank/memory — Extraction & Dedup Prompts
 */

export const EXTRACT_PROMPT = `You are a memory extraction engine. Given a conversation turn between a user and an assistant, extract distinct atomic facts worth remembering for future conversations.

Focus on:
- User preferences (language, tools, patterns, style)
- User personal info (name, role, projects)
- Decisions made (architecture, design, technology choices)
- Important context (deadlines, constraints, goals)

Respond with JSON: { "facts": ["fact1", "fact2", ...] }
If nothing is worth remembering, return: { "facts": [] }

Rules:
- Each fact must be a single, self-contained sentence
- Be specific ("prefers TypeScript" not "has programming preferences")
- Skip trivial info ("said hello", "asked a question")
- Max 5 facts per turn`;

export const EXTRACT_WITH_ENTITIES_PROMPT = `You are a memory extraction engine. Given a conversation turn, extract:
1. Atomic facts worth remembering
2. Named entities (people, services, projects, organizations, concepts)
3. Relationships between entities

Respond with JSON:
{
  "facts": ["fact1", "fact2"],
  "entities": [
    { "name": "EntityName", "type": "person|service|project|organization|concept", "attributes": {} }
  ],
  "relationships": [
    { "source": "EntityA", "target": "EntityB", "relation": "verb_phrase" }
  ]
}

Rules:
- Facts: single self-contained sentences, be specific, max 5 per turn
- Entities: only extract clearly named entities, not generic nouns
- Relationships: use lowercase verb phrases ("works_on", "prefers", "depends_on", "migrating_to")
- Entity types: person, service, project, organization, concept (or custom)
- If nothing found, return empty arrays
- Skip trivial info`;

export const DEDUP_PROMPT = `You are a memory deduplication engine. Given a NEW fact and a list of EXISTING memories, decide what action to take.

Respond with JSON: { "action": "ADD" | "UPDATE" | "NONE", "reason": "brief reason" }

- ADD: the fact is genuinely new information not covered by any existing memory
- UPDATE: the fact updates, corrects, or expands an existing memory (include "update_index" field: 0-based index)
- NONE: the fact is already well-captured by existing memories

Be conservative — if in doubt, say NONE.`;

