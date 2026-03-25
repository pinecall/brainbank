/**
 * BrainBank — Perplexity Standard Embedding Tests
 *
 * Tests the Perplexity standard embedding provider with mocked fetch.
 */

import { PerplexityEmbedding, decodeBase64Int8 } from '../../helpers.ts';

export const name = 'Perplexity Embedding';

/** Create a base64-encoded int8 vector for testing. */
function makeBase64Int8(values: number[]): string {
    const bytes = new Uint8Array(values.map(v => v & 0xFF));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

export const tests = {
    async 'constructs with defaults'(assert: any) {
        const provider = new PerplexityEmbedding({ apiKey: 'pplx-test' });
        assert.equal(provider.dims, 2560);
    },

    async 'respects 0.6b model dims'(assert: any) {
        const provider = new PerplexityEmbedding({
            apiKey: 'pplx-test',
            model: 'pplx-embed-v1-0.6b',
        });
        assert.equal(provider.dims, 1024);
    },

    async 'respects custom dims (Matryoshka)'(assert: any) {
        const provider = new PerplexityEmbedding({
            apiKey: 'pplx-test',
            dims: 512,
        });
        assert.equal(provider.dims, 512);
    },

    async 'throws without API key'(assert: any) {
        const original = process.env.PERPLEXITY_API_KEY;
        delete process.env.PERPLEXITY_API_KEY;

        const provider = new PerplexityEmbedding({ apiKey: '' });

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

    async 'decodeBase64Int8 decodes correctly'(assert: any) {
        // Create a known int8 vector: [1, -1, 127, -128, 0]
        const b64 = makeBase64Int8([1, 255, 127, 128, 0]); // 255 = -1 as signed, 128 = -128 as signed
        const result = decodeBase64Int8(b64, 5);

        assert(result instanceof Float32Array, 'should be Float32Array');
        assert.equal(result.length, 5);
        assert.equal(result[0], 1);
        assert.equal(result[1], -1);   // 0xFF → -1 signed
        assert.equal(result[2], 127);
        assert.equal(result[3], -128); // 0x80 → -128 signed
        assert.equal(result[4], 0);
    },

    async 'embed calls fetch and returns Float32Array'(assert: any) {
        const fakeB64 = makeBase64Int8([10, 20, 30, 40]);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response(JSON.stringify({
                data: [{ index: 0, embedding: fakeB64 }],
            }), { status: 200 });

        try {
            const provider = new PerplexityEmbedding({ apiKey: 'pplx-test', dims: 4 });
            const result = await provider.embed('hello');
            assert(result instanceof Float32Array, 'should be Float32Array');
            assert.equal(result.length, 4);
            assert.equal(result[0], 10);
            assert.equal(result[1], 20);
        } finally {
            globalThis.fetch = originalFetch;
        }
    },

    async 'embedBatch handles multiple texts'(assert: any) {
        const fakeB64 = makeBase64Int8([1, 2, 3, 4]);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response(JSON.stringify({
                data: [
                    { index: 0, embedding: fakeB64 },
                    { index: 1, embedding: fakeB64 },
                ],
            }), { status: 200 });

        try {
            const provider = new PerplexityEmbedding({ apiKey: 'pplx-test', dims: 4 });
            const results = await provider.embedBatch(['hello', 'world']);
            assert.equal(results.length, 2);
            assert(results[0] instanceof Float32Array, 'first result should be Float32Array');
        } finally {
            globalThis.fetch = originalFetch;
        }
    },

    async 'embedBatch returns empty for empty input'(assert: any) {
        const provider = new PerplexityEmbedding({ apiKey: 'pplx-test' });
        const results = await provider.embedBatch([]);
        assert.equal(results.length, 0);
    },

    async 'handles API error gracefully'(assert: any) {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response('{"error":"rate limited"}', { status: 429 });

        try {
            const provider = new PerplexityEmbedding({ apiKey: 'pplx-test' });
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

    async 'timeout fires on slow response'(assert: any) {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (_, init: any) => {
            return new Promise((_, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                });
            });
        };

        try {
            const provider = new PerplexityEmbedding({ apiKey: 'pplx-test', timeout: 50 });
            let threw = false;
            try {
                await provider.embed('test');
            } catch (e: any) {
                threw = true;
                assert.includes(e.message, 'timed out');
            }
            assert(threw, 'should throw on timeout');
        } finally {
            globalThis.fetch = originalFetch;
        }
    },

    async 'close is a no-op'(assert: any) {
        const provider = new PerplexityEmbedding({ apiKey: 'pplx-test' });
        await provider.close(); // should not throw
        assert(true, 'close completed');
    },

    async 'embedBatch delays between chunks'(assert: any) {
        const fakeB64 = makeBase64Int8([1, 2]);
        let callCount = 0;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => {
            callCount++;
            const items = Array.from({ length: 100 }, (_, i) => ({ index: i, embedding: fakeB64 }));
            return new Response(JSON.stringify({ data: items }), { status: 200 });
        };

        try {
            const provider = new PerplexityEmbedding({ apiKey: 'pplx-test', dims: 2 });
            const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);
            const start = Date.now();
            await provider.embedBatch(texts);
            const elapsed = Date.now() - start;

            assert.equal(callCount, 2, 'should make 2 API calls for 150 texts');
            assert(elapsed >= 90, `should delay between batches (elapsed: ${elapsed}ms)`);
        } finally {
            globalThis.fetch = originalFetch;
        }
    },
};
