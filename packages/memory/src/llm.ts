/**
 * @brainbank/memory — LLM Provider Interface
 *
 * Framework-agnostic interface for LLM calls.
 * Implement this to use any LLM: OpenAI, Anthropic, LangChain, Vercel AI SDK, etc.
 */

// ─── LLM Provider Interface ────────────────────────

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface GenerateOptions {
    /** Request JSON output */
    json?: boolean;
    /** Max tokens for response */
    maxTokens?: number;
}

/**
 * LLM provider interface. Implement this to bring your own model.
 *
 * @example OpenAI
 * ```typescript
 * const llm = new OpenAIProvider({ apiKey: 'sk-...', model: 'gpt-4.1-nano' });
 * ```
 *
 * @example LangChain
 * ```typescript
 * import { ChatOpenAI } from '@langchain/openai';
 * const model = new ChatOpenAI({ model: 'gpt-4.1-nano' });
 * const llm: LLMProvider = {
 *   generate: async (messages, opts) => {
 *     const res = await model.invoke(messages);
 *     return res.content as string;
 *   }
 * };
 * ```
 *
 * @example Vercel AI SDK
 * ```typescript
 * import { generateText } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * const llm: LLMProvider = {
 *   generate: async (messages) => {
 *     const { text } = await generateText({ model: openai('gpt-4.1-nano'), messages });
 *     return text;
 *   }
 * };
 * ```
 */
export interface LLMProvider {
    generate(messages: ChatMessage[], options?: GenerateOptions): Promise<string>;
}

// ─── Built-in OpenAI Provider ───────────────────────

export interface OpenAIProviderOptions {
    /** OpenAI API key. Defaults to OPENAI_API_KEY env var. */
    apiKey?: string;
    /** Model name. Default: gpt-4.1-nano */
    model?: string;
    /** Base URL for API. Default: https://api.openai.com/v1 */
    baseUrl?: string;
}

export class OpenAIProvider implements LLMProvider {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly baseUrl: string;

    constructor(options: OpenAIProviderOptions = {}) {
        this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
        this.model = options.model ?? 'gpt-4.1-nano';
        this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';

        if (!this.apiKey) {
            throw new Error('@brainbank/memory: OPENAI_API_KEY is required for OpenAIProvider');
        }
    }

    async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<string> {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                max_tokens: options?.maxTokens ?? 500,
                ...(options?.json ? { response_format: { type: 'json_object' } } : {}),
            }),
        });

        if (!res.ok) {
            throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
        }

        const data = (await res.json()) as any;
        return data.choices?.[0]?.message?.content ?? '';
    }
}
