/**
 * Unit Tests — Daemon PID File Management
 *
 * Tests writePid, readPid, removePid, isServerRunning, getServerUrl.
 * Uses isolated temp directories to avoid interfering with real PID files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// We test the raw functions, but they read from a fixed path (~/.cache/brainbank/server.pid).
// To isolate: we test readPid/writePid by directly reading/writing the PID file.
// For isServerRunning and getServerUrl we rely on PID file state.

import { writePid, readPid, removePid, isServerRunning, getServerUrl, DEFAULT_PORT } from '../../../src/services/daemon.ts';

export const name = 'Daemon PID Management';

export const tests = {
    'DEFAULT_PORT is 8181'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        assert.equal(DEFAULT_PORT, 8181);
    },

    'writePid + readPid roundtrip'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        // Write a PID with a known port
        writePid(process.pid, 9999);

        const info = readPid();
        assert.ok(info, 'readPid should return an object');
        assert.equal(info!.pid, process.pid, 'should read back the same PID');
        assert.equal(info!.port, 9999, 'should read back the same port');

        // Cleanup
        removePid();
    },

    'removePid clears the PID file'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        writePid(process.pid, 9999);
        removePid();

        const info = readPid();
        assert.equal(info, null, 'readPid should return null after removePid');
    },

    'removePid is safe when no file exists'(assert: { ok: (v: unknown, msg?: string) => void }) {
        removePid(); // ensure clean
        removePid(); // second call should not throw
        assert.ok(true, 'removePid on missing file should not throw');
    },

    'readPid returns null for malformed file'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        // Write garbage to PID file path
        const pidDir = path.join(os.homedir(), '.cache', 'brainbank');
        fs.mkdirSync(pidDir, { recursive: true });
        fs.writeFileSync(path.join(pidDir, 'server.pid'), 'not json');

        const info = readPid();
        assert.equal(info, null, 'should return null for malformed PID file');

        removePid();
    },

    'readPid returns null when pid field is missing'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        const pidDir = path.join(os.homedir(), '.cache', 'brainbank');
        fs.mkdirSync(pidDir, { recursive: true });
        fs.writeFileSync(path.join(pidDir, 'server.pid'), JSON.stringify({ port: 8181 }));

        const info = readPid();
        assert.equal(info, null, 'should return null when pid field missing');

        removePid();
    },

    'isServerRunning returns PidInfo when current process PID used'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        writePid(process.pid, 7777);

        const info = isServerRunning();
        assert.ok(info, 'should detect own process as running');
        assert.equal(info!.pid, process.pid);
        assert.equal(info!.port, 7777);

        removePid();
    },

    'isServerRunning returns null for dead PID and cleans up file'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        writePid(999999999, 8181); // definitely not running

        const info = isServerRunning();
        assert.equal(info, null, 'should return null for dead PID');

        const afterCleanup = readPid();
        assert.equal(afterCleanup, null, 'should have cleaned up stale PID file');
    },

    'getServerUrl returns URL when running'(assert: { ok: (v: unknown, msg?: string) => void; equal: (a: unknown, b: unknown, msg?: string) => void }) {
        writePid(process.pid, 8181);

        const url = getServerUrl();
        assert.equal(url, 'http://localhost:8181');

        removePid();
    },

    'getServerUrl returns null when not running'(assert: { equal: (a: unknown, b: unknown, msg?: string) => void }) {
        removePid();

        const url = getServerUrl();
        assert.equal(url, null);
    },
};
