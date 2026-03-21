#!/usr/bin/env npx tsx

/**
 * BrainBank Test Runner — Same pattern as Drift test runner
 * 
 * Usage:
 *   npx tsx packages/brainbank/test/run.ts                      # Unit tests only
 *   npx tsx packages/brainbank/test/run.ts --integration        # Include integration (downloads model)
 *   npx tsx packages/brainbank/test/run.ts --filter math        # Filter by name
 *   npx tsx packages/brainbank/test/run.ts --verbose            # Show assertion details
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const includeIntegration = args.includes('--integration');
const verbose = args.includes('--verbose');
const filterArg = args.find(a => a.startsWith('--filter'));
const filter = filterArg ? (args[args.indexOf(filterArg) + 1] || filterArg.split('=')[1]) : null;

// Colors
const c = {
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// Test file discovery
interface TestFile {
    path: string;
    dir: string;
    name: string;
}

function discoverTests(baseDir: string): TestFile[] {
    const files: TestFile[] = [];
    const dirs = ['unit'];
    if (includeIntegration) dirs.push('integration');

    for (const dir of dirs) {
        const fullDir = path.join(baseDir, dir);
        if (!fs.existsSync(fullDir)) continue;
        for (const file of fs.readdirSync(fullDir)) {
            if (!file.endsWith('.test.ts')) continue;
            if (filter && !file.includes(filter) && !dir.includes(filter)) continue;
            files.push({ path: path.join(fullDir, file), dir, name: file.replace('.test.ts', '') });
        }
    }
    return files;
}

// Assertion helpers
interface AssertResult { pass: boolean; message: string; }

interface Assert {
    (condition: any, message?: string): void;
    ok: (val: any, msg?: string) => void;
    equal: (a: any, b: any, msg?: string) => void;
    deepEqual: (a: any, b: any, msg?: string) => void;
    throws: (fn: () => void, msg?: string) => void;
    includes: (haystack: any, needle: any, msg?: string) => void;
    gt: (a: number, b: number, msg?: string) => void;
    gte: (a: number, b: number, msg?: string) => void;
    lt: (a: number, b: number, msg?: string) => void;
    notEqual: (a: any, b: any, msg?: string) => void;
    results: AssertResult[];
}

function createAssert(): Assert {
    const results: AssertResult[] = [];

    function assert(condition: any, message = 'assertion failed') {
        results.push({ pass: !!condition, message });
        if (!condition) throw new Error(`AssertionError: ${message}`);
    }

    assert.equal = (a: any, b: any, msg?: string) => {
        const pass = a === b;
        const message = msg || `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`;
        results.push({ pass, message });
        if (!pass) throw new Error(`AssertionError: ${message}`);
    };

    assert.notEqual = (a: any, b: any, msg?: string) => {
        const pass = a !== b;
        const message = msg || `expected ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
        results.push({ pass, message });
        if (!pass) throw new Error(`AssertionError: ${message}`);
    };

    assert.deepEqual = (a: any, b: any, msg?: string) => {
        const pass = JSON.stringify(a) === JSON.stringify(b);
        const message = msg || `expected deepEqual\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`;
        results.push({ pass, message });
        if (!pass) throw new Error(`AssertionError: ${message}`);
    };

    assert.ok = (val: any, msg?: string) => assert(!!val, msg || `expected truthy, got ${JSON.stringify(val)}`);

    assert.throws = (fn: () => void, msg?: string) => {
        let threw = false;
        try { fn(); } catch { threw = true; }
        const message = msg || 'expected function to throw';
        results.push({ pass: threw, message });
        if (!threw) throw new Error(`AssertionError: ${message}`);
    };

    assert.includes = (haystack: any, needle: any, msg?: string) => {
        const pass = Array.isArray(haystack) ? haystack.includes(needle) : String(haystack).includes(needle);
        const message = msg || `expected ${JSON.stringify(haystack).slice(0, 80)} to include ${JSON.stringify(needle)}`;
        results.push({ pass, message });
        if (!pass) throw new Error(`AssertionError: ${message}`);
    };

    assert.gt = (a: number, b: number, msg?: string) => {
        const pass = a > b;
        const message = msg || `expected ${a} > ${b}`;
        results.push({ pass, message });
        if (!pass) throw new Error(`AssertionError: ${message}`);
    };

    assert.gte = (a: number, b: number, msg?: string) => {
        const pass = a >= b;
        const message = msg || `expected ${a} >= ${b}`;
        results.push({ pass, message });
        if (!pass) throw new Error(`AssertionError: ${message}`);
    };

    assert.lt = (a: number, b: number, msg?: string) => {
        const pass = a < b;
        const message = msg || `expected ${a} < ${b}`;
        results.push({ pass, message });
        if (!pass) throw new Error(`AssertionError: ${message}`);
    };

    assert.results = results;
    return assert;
}

// Runner
interface SuiteResult { file: TestFile; passed: number; failed: number; }

async function runTestFile(testFile: TestFile): Promise<SuiteResult> {
    const mod = await import(testFile.path);
    const exported = mod.default || mod;
    const suiteResults: SuiteResult = { file: testFile, passed: 0, failed: 0 };

    const tests = exported.tests || exported;
    const suiteName = exported.name || testFile.name;

    console.log(`\n${c.cyan('●')} ${c.bold(suiteName)} ${c.dim(`(${testFile.dir}/${testFile.name})`)}`);

    for (const [name, fn] of Object.entries(tests)) {
        if (typeof fn !== 'function') continue;

        const assert = createAssert();
        const start = Date.now();

        try {
            await (fn as Function)(assert);
            const ms = Date.now() - start;
            suiteResults.passed++;
            const timeStr = ms > 1000 ? c.yellow(`${(ms / 1000).toFixed(1)}s`) : c.dim(`${ms}ms`);
            console.log(`  ${c.green('✓')} ${name} ${timeStr}`);
            if (verbose) {
                for (const r of assert.results) {
                    console.log(`    ${c.dim('·')} ${r.message}`);
                }
            }
        } catch (err: any) {
            const ms = Date.now() - start;
            suiteResults.failed++;
            console.log(`  ${c.red('✗')} ${name} ${c.dim(`${ms}ms`)}`);
            console.log(`    ${c.red(err.message)}`);
            if (err.stack && verbose) {
                const relevantLines = err.stack.split('\n').slice(1, 4).map((l: string) => `    ${c.dim(l.trim())}`).join('\n');
                console.log(relevantLines);
            }
        }
    }

    return suiteResults;
}

async function main() {
    const testFiles = discoverTests(__dirname);

    console.log(c.bold('\n━━━ BrainBank Test Runner ━━━'));
    console.log(c.dim(`  Mode: ${includeIntegration ? 'unit + integration' : 'unit only'}`));
    if (filter) console.log(c.dim(`  Filter: ${filter}`));
    console.log(c.dim(`  Found: ${testFiles.length} test file(s)`));

    if (testFiles.length === 0) {
        console.log(c.yellow('\n  No test files found.'));
        if (!includeIntegration) console.log(c.dim('  Tip: use --integration to include integration tests'));
        process.exit(0);
    }

    let totalPassed = 0, totalFailed = 0;
    const startTime = Date.now();

    for (const testFile of testFiles) {
        const result = await runTestFile(testFile);
        totalPassed += result.passed;
        totalFailed += result.failed;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n${c.bold('━━━ Results ━━━')}`);
    console.log(`  ${c.green(`${totalPassed} passed`)}  ${totalFailed > 0 ? c.red(`${totalFailed} failed`) : ''}  ${c.dim(`${elapsed}s`)}`);

    if (!includeIntegration) {
        console.log(c.dim('  Integration tests skipped (use --integration)'));
    }

    process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(c.red(`Fatal: ${err.message}`));
    console.error(err.stack);
    process.exit(1);
});
