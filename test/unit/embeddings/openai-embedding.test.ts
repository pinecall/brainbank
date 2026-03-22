/**
 * BrainBank — OpenAI Embedding Tests
 * 
 * Tests the OpenAI embedding provider with mocked fetch.
 */

import { OpenAIEmbedding } from '../../helpers.ts';

export const name = 'OpenAI Embedding';

export const tests = {
    async 'constructs with defaults'(assert: any) {
        const provider = new OpenAIEmbedding({ apiKey: 'sk-test' });
        assert.equal(provider.dims, 1536);
    },

    async 'respects custom model and dims'(assert: any) {
        const provider = new OpenAIEmbedding({
            apiKey: 'sk-test',
            model: 'text-embedding-3-small',
            dims: 512,
        });
        assert.equal(provider.dims, 512);
    },

    async 'ada-002 ignores custom dims'(assert: any) {
        const provider = new OpenAIEmbedding({
            apiKey: 'sk-test',
            model: 'text-embedding-ada-002',
            dims: 512,
        });
        assert.equal(provider.dims, 512);
    },

    async 'throws without API key'(assert: any) {
        const original = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const provider = new OpenAIEmbedding({ apiKey: '' });

        let threw = false;
        try {
            await provider.embed('test');
        } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'API key required');
        }
        assert(threw, 'should throw without API key');

        if (original) process.env.OPENAI_API_KEY = original;
    },

    async 'embed calls fetch and returns Float32Array'(assert: any) {
        const fakeEmbedding = Array.from({ length: 8 }, (_, i) => i * 0.1);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response(JSON.stringify({ data: [{ embedding: fakeEmbedding, index: 0 }] }), { status: 200 });

        try {
            const provider = new OpenAIEmbedding({ apiKey: 'sk-test', dims: 8 });
            const result = await provider.embed('hello');

            assert(result instanceof Float32Array, 'should return Float32Array');
            assert.equal(result.length, 8);
            assert(Math.abs(result[1] - 0.1) < 0.001, 'values should match');
        } finally {
            globalThis.fetch = originalFetch;
        }
    },

    async 'embedBatch handles multiple texts'(assert: any) {
        let callCount = 0;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (_url: any, opts: any) => {
            callCount++;
            const body = JSON.parse(opts.body);
            const data = body.input.map((_: string, i: number) => ({
                embedding: Array.from({ length: 4 }, () => i * 0.1),
                index: i,
            }));
            return new Response(JSON.stringify({ data }), { status: 200 });
        };

        try {
            const provider = new OpenAIEmbedding({ apiKey: 'sk-test', dims: 4 });
            const results = await provider.embedBatch(['hello', 'world', 'test']);

            assert.equal(results.length, 3);
            assert(results[0] instanceof Float32Array, 'should return Float32Array[]');
            assert.equal(callCount, 1, 'should batch in single request');
        } finally {
            globalThis.fetch = originalFetch;
        }
    },

    async 'embedBatch returns empty for empty input'(assert: any) {
        const provider = new OpenAIEmbedding({ apiKey: 'sk-test' });
        const results = await provider.embedBatch([]);
        assert.equal(results.length, 0);
    },

    async 'handles API error gracefully'(assert: any) {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response('{"error": {"message": "Rate limit exceeded"}}', { status: 429 });

        try {
            const provider = new OpenAIEmbedding({ apiKey: 'sk-test' });
            let threw = false;
            try {
                await provider.embed('test');
            } catch (e: any) {
                threw = true;
                assert.includes(e.message, '429');
            }
            assert(threw, 'should throw on API error');
        } finally {
            globalThis.fetch = originalFetch;
        }
    },

    async 'close is a no-op'(assert: any) {
        const provider = new OpenAIEmbedding({ apiKey: 'sk-test' });
        await provider.close();
        assert(true, 'close should succeed');
    },
};
