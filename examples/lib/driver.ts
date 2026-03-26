/**
 * Minimal LLM driver — one interface, multiple backends.
 *
 * Backends:
 *   native    — raw fetch to OpenAI (zero deps)
 *   vercel    — Vercel AI SDK (requires: ai, @ai-sdk/openai)
 *   langchain — LangChain (requires: @langchain/openai)
 *
 * Usage:
 *   const llm = await createDriver('native', 'gpt-4.1-nano');
 *   const reply = await llm.stream(messages, onChunk);
 */

export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LLMDriver {
    stream(messages: Message[], onChunk: (text: string) => void): Promise<string>;
    generate(messages: Message[]): Promise<string>;
}

export type Backend = 'native' | 'vercel' | 'langchain';

/** Parse --llm flag from CLI args. Default: native. */
export function parseBackend(): Backend {
    const idx = process.argv.indexOf('--llm');
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1] as Backend;
    return 'native';
}

/** Parse --model flag. Default: gpt-4.1-nano. */
export function parseModel(): string {
    const idx = process.argv.indexOf('--model');
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    return 'gpt-4.1-nano';
}

/** Create an LLM driver for the given backend. */
export async function createDriver(backend: Backend = 'native', model = 'gpt-4.1-nano'): Promise<LLMDriver> {
    switch (backend) {
        case 'native': return createNativeDriver(model);
        case 'vercel': return createVercelDriver(model);
        case 'langchain': return createLangchainDriver(model);
        default: throw new Error(`Unknown LLM backend: ${backend}`);
    }
}

// ─── Native (zero deps) ─────────────────────────────

function createNativeDriver(model: string): LLMDriver {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('Set OPENAI_API_KEY');

    return {
        async stream(messages, onChunk) {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                body: JSON.stringify({ model, messages, stream: true }),
            });
            if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);

            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let full = '', buf = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                    try {
                        const chunk = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
                        if (chunk) { onChunk(chunk); full += chunk; }
                    } catch { /* skip */ }
                }
            }
            return full;
        },
        async generate(messages) {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                body: JSON.stringify({ model, messages }),
            });
            if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
            return (await res.json()).choices[0].message.content;
        },
    };
}

// ─── Vercel AI SDK ──────────────────────────────────

async function createVercelDriver(model: string): Promise<LLMDriver> {
    const { streamText, generateText } = await import('ai');
    const { openai } = await import('@ai-sdk/openai');

    return {
        async stream(messages, onChunk) {
            const result = streamText({ model: openai(model), messages });
            let full = '';
            for await (const chunk of result.textStream) {
                onChunk(chunk);
                full += chunk;
            }
            return full;
        },
        async generate(messages) {
            const { text } = await generateText({ model: openai(model), messages });
            return text;
        },
    };
}

// ─── LangChain ──────────────────────────────────────

async function createLangchainDriver(model: string): Promise<LLMDriver> {
    const { ChatOpenAI } = await import('@langchain/openai');
    const { HumanMessage, SystemMessage, AIMessage } = await import('@langchain/core/messages');

    const llm = new ChatOpenAI({ model, temperature: 0 });

    function toLCMessages(messages: Message[]) {
        return messages.map(m => {
            if (m.role === 'system') return new SystemMessage(m.content);
            if (m.role === 'assistant') return new AIMessage(m.content);
            return new HumanMessage(m.content);
        });
    }

    return {
        async stream(messages, onChunk) {
            const stream = await llm.stream(toLCMessages(messages));
            let full = '';
            for await (const chunk of stream) {
                const text = typeof chunk.content === 'string' ? chunk.content : '';
                if (text) { onChunk(text); full += text; }
            }
            return full;
        },
        async generate(messages) {
            const res = await llm.invoke(toLCMessages(messages));
            return typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
        },
    };
}
