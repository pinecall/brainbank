/**
 * Unit Tests — Language Registry
 */

import { isSupported, getLanguage, isIgnoredDir, isIgnoredFile, SUPPORTED_EXTENSIONS, IGNORE_DIRS } from '../../../../src/indexers/languages.ts';

export const name = 'Language Registry';

export const tests = {
    'getLanguage returns typescript for .ts'(assert: any) {
        assert.equal(getLanguage('src/agent.ts'), 'typescript');
    },

    'getLanguage returns typescript for .tsx'(assert: any) {
        assert.equal(getLanguage('components/App.tsx'), 'typescript');
    },

    'getLanguage returns python for .py'(assert: any) {
        assert.equal(getLanguage('scripts/build.py'), 'python');
    },

    'getLanguage returns go for .go'(assert: any) {
        assert.equal(getLanguage('main.go'), 'go');
    },

    'getLanguage returns rust for .rs'(assert: any) {
        assert.equal(getLanguage('src/lib.rs'), 'rust');
    },

    'getLanguage returns undefined for unsupported'(assert: any) {
        assert.equal(getLanguage('binary.exe'), undefined);
        assert.equal(getLanguage('image.png'), undefined);
    },

    'isSupported returns true for supported extensions'(assert: any) {
        assert.ok(isSupported('file.ts'));
        assert.ok(isSupported('file.py'));
        assert.ok(isSupported('file.go'));
        assert.ok(isSupported('file.rs'));
    },

    'isSupported returns false for unsupported'(assert: any) {
        assert.ok(!isSupported('file.exe'));
        assert.ok(!isSupported('file.png'));
        assert.ok(!isSupported('file.zip'));
    },

    'isIgnoredDir ignores node_modules'(assert: any) {
        assert.ok(isIgnoredDir('node_modules'));
    },

    'isIgnoredDir ignores .git'(assert: any) {
        assert.ok(isIgnoredDir('.git'));
    },

    'isIgnoredDir does not ignore src'(assert: any) {
        assert.ok(!isIgnoredDir('src'));
    },

    'isIgnoredDir allows unlisted dotfile dirs'(assert: any) {
        assert.ok(!isIgnoredDir('.hidden'), '.hidden is not in IGNORE_DIRS');
        assert.ok(!isIgnoredDir('.github'), '.github should be indexable');
        assert.ok(!isIgnoredDir('.husky'), '.husky should be indexable');
    },

    'isIgnoredFile ignores lockfiles'(assert: any) {
        assert.ok(isIgnoredFile('package-lock.json'));
        assert.ok(isIgnoredFile('yarn.lock'));
    },

    'isIgnoredFile allows regular files'(assert: any) {
        assert.ok(!isIgnoredFile('utils.ts'));
        assert.ok(!isIgnoredFile('README.md'));
    },

    'SUPPORTED_EXTENSIONS has reasonable count'(assert: any) {
        assert.gt(Object.keys(SUPPORTED_EXTENSIONS).length, 20, 'should have > 20 extensions');
    },

    'IGNORE_DIRS has reasonable count'(assert: any) {
        assert.gt(IGNORE_DIRS.size, 15, 'should have > 15 ignore dirs');
    },
};
