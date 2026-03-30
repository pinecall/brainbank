#!/usr/bin/env node
/**
 * Lint: find @/ imports that should be ./ (same-directory files).
 *
 * Rule: if file A imports from @/X.ts and both A and X.ts are in
 * the same directory, it should use ./X.ts instead.
 *
 * Usage: node scripts/lint-imports.mjs [src-dir]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const srcDir = resolve(process.argv[2] || 'src');
const aliasRoot = srcDir; // @/ maps to src/

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (entry.name.endsWith('.ts')) results.push(full);
  }
  return results;
}

const importRe = /from\s+['"](@\/[^'"]+)['"]/g;
let issues = 0;

for (const file of walk(srcDir)) {
  const content = readFileSync(file, 'utf-8');
  const fileDir = dirname(file);
  let match;

  while ((match = importRe.exec(content)) !== null) {
    const importPath = match[1]; // e.g. @/types.ts
    const resolved = join(aliasRoot, importPath.slice(2)); // strip @/
    const resolvedDir = dirname(resolved);

    if (resolvedDir === fileDir) {
      const rel = relative(srcDir, file);
      const line = content.slice(0, match.index).split('\n').length;
      const basename = importPath.split('/').pop();
      console.log(`  ${rel}:${line}  →  ${importPath}  should be  ./${basename}`);
      issues++;
    }
  }
}

if (issues === 0) {
  console.log('✅ No same-directory @/ imports found');
} else {
  console.log(`\n⚠ Found ${issues} same-directory import(s) that should use ./`);
  process.exit(1);
}
