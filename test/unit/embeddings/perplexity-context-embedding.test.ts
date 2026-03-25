/**
 * BrainBank — Perplexity Contextualized Embedding Tests
 *
 * Tests the contextualized embedding provider with mocked fetch.
 */

import { PerplexityContextEmbedding, decodeBase64Int8 } from '../../helpers.ts';

export const name = 'Perplexity Context Embedding';

/** Create a base64-encoded int8 vector for testing. */
function makeBase64Int8(values: number[]): string {
    const bytes = new Uint8Array(values.map(v => v & 0xFF));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

export const tests = {
    async 'constructs with defaults'(assert: any) {
        const provider = new PerplexityContextEmbedding({ apiKey: 'pplx-test' });
        assert.equal(provider.dims, 2560);
    },

    async 'respects 0.6b model dims'(assert: any) {
        const provider = new PerplexityContextEmbedding({
            apiKey: 'pplx-test',
            model: 'pplx-embed-context-v1-0.6b',
        });
        assert.equal(provider.dims, 1024);
    },

    async 'respects custom dims (Matryoshka)'(assert: any) {
        const provider = new PerplexityContextEmbedding({
            apiKey: 'pplx-test',
            dims: 512,
        });
        assert.equal(provider.dims, 512);
    },

    async 'throws without API key'(assert: any) {
        const original = process.env.PERPLEXITY_API_KEY;
        delete process.env.PERPLEXITY_API_KEY;

        const provider = new PerplexityContextEmbedding({ apiKey: '' });

        let threw = false;
        try {
            await provider.embed('test');
        } catch (e: any) {
            threw = true;
            assert.includes(e.message, 'API key required');
        }
        assert(threw, 'should throw without API key');

        if (original) process.env.PERPLEXITY_API_KEY = original;
    },

    async 'embed wraps text as [[text]] and returns Float32Array'(assert: any) {
        const fakeB64 = makeBase64Int8([10, 20, 30, 40]);
        const originalFetch = globalThis.fetch;
        let capturedBody: any = null;

        globalThis.fetch = async (_url: any, init: any) => {
            capturedBody = JSON.parse(init.body);
            return new Response(JSON.stringify({
                data: [{
                    index: 0,
                    data: [{ index: 0, embedding: fakeB64 }],
                }],
            }), { status: 200 });
        };

        try {
            const provider = new PerplexityContextEmbedding({ apiKey: 'pplx-test', dims: 4 });
            const result = await provider.embed('hello');
            assert(result instanceof Float32Array, 'should be Float32Array');
            assert.equal(result.length, 4);
            assert.equal(result[0], 10);

            // Verify input was wrapped as [[text]]
            assert.equal(capturedBody.input.length, 1);
            assert.equal(capturedBody.input[0].length, 1);
            assert.equal(capturedBody.input[0][0], 'hello');
        } finally {
            globalThis.fetch = originalFetch;
        }
    },

    async 'embedBatch wraps texts as [texts] (one document)'(assert: any) {
        const fakeB64 = makeBase64Int8([1, 2, 3, 4]);
        const originalFetch = globalThis.fetch;
        let capturedBody: any = null;

        globalThis.fetch = async (_url: any, init: any) => {
            capturedBody = JSON.parse(init.body);
            return new Response(JSON.stringify({
                data: [{
                    index: 0,
                    data: [
                        { index: 0, embedding: fakeB64 },
                        { index: 1, embedding: fakeB64 },
                        { index: 2, embedding: fakeB64 },
                    ],
                }],
            }), { status: 200 });
        };

        try {
            const provider = new PerplexityContextEmbedding({ apiKey: 'pplx-test', dims: 4 });
            const results = await provider.embedBatch(['chunk1', 'chunk2', 'chunk3']);
            assert.equal(results.length, 3);

            // Verify input was wrapped as [texts] (one doc with 3 chunks)
            assert.equal(capturedBody.input.length, 1);
            assert.equal(capturedBody.input[0].length, 3);
        } finally {
            globalThis.fetch = originalFetch;
        }
    },

    async 'embedBatch returns empty for empty input'(assert: any) {
        const provider = new PerplexityContextEmbedding({ apiKey: 'pplx-test' });
        const results = await provider.embedBatch([]);
        assert.equal(results.length, 0);
    },

    async 'flattens nested response correctly'(assert: any) {
        const b64a = makeBase64Int8([1, 2]);
        const b64b = makeBase64Int8([3, 4]);
        const b64c = makeBase64Int8([5, 6]);
        const originalFetch = globalThis.fetch;

        globalThis.fetch = async () =>
            new Response(JSON.stringify({
                data: [{
                    index: 0,
                    data: [
                        { index: 1, embedding: b64b }, // out of order
                        { index: 0, embedding: b64a },
                        { index: 2, embedding: b64c },
                    ],
                }],
            }), { status: 200 });

        try {
            const provider = new PerplexityContextEmbedding({ apiKey: 'pplx-test', dims: 2 });
            const results = await provider.embedBatch(['a', 'b', 'c']);
            assert.equal(results.length, 3);
            // Should be sorted by index: a(1,2), b(3,4), c(5,6)
            assert.equal(results[0][0], 1);
            assert.equal(results[1][0], 3);
            assert.equal(results[2][0], 5);
        } finally {
            globalThis.fetch = originalFetch;
        }
    },

    async 'handles API error gracefully'(assert: any) {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response('{"error":"rate limited"}', { status: 429 });

        try {
            const provider = new PerplexityContextEmbedding({ apiKey: 'pplx-test' });
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
        const provider = new PerplexityContextEmbedding({ apiKey: 'pplx-test' });
        await provider.close();
        assert(true, 'close completed');
    },
};
