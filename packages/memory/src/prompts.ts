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

export const DEDUP_PROMPT = `You are a memory deduplication engine. Given a NEW fact and a list of EXISTING memories, decide what action to take.

Respond with JSON: { "action": "ADD" | "UPDATE" | "NONE", "reason": "brief reason" }

- ADD: the fact is genuinely new information not covered by any existing memory
- UPDATE: the fact updates, corrects, or expands an existing memory (include "update_index" field: 0-based index)
- NONE: the fact is already well-captured by existing memories

Be conservative — if in doubt, say NONE.`;
