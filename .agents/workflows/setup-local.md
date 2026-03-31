---
description: Set up local dev environment on a fresh machine (node, deps, symlinks, builds)
---

# /setup-local workflow

Run this when setting up BrainBank on a new machine, or when `npm test` fails with `Cannot find package '@brainbank/*'` or `does not provide an export named`.

// turbo-all

## Prerequisites

Node.js ≥18 must be installed. The project's `package.json` requires `"node": ">=18"`.

## Steps

### 1. Install all dependencies

```bash
npm install --legacy-peer-deps
```

Wait for native deps to compile (2-5 minutes). This also auto-symlinks all workspace packages and runs the `postinstall` script to link the local `brainbank` core.

### 2. Build core + all plugins

```bash
npm run build
```

### 3. Verify

```bash
npx tsc --noEmit
```

Must exit with 0 errors.

```bash
npm test
```

All ~200 tests must pass.

### 4. Confirm

Tell the user: "✅ Local environment ready. `tsc` clean, `npm test` passing."

---

## When to re-run specific steps

| Symptom | Fix |
|---------|-----|
| `Cannot find package '@brainbank/code'` | Re-run step 1 |
| `does not provide an export named 'X'` | Re-run step 2 |
| Changed core exports (`src/index.ts`) | Re-run step 2 |
| Changed plugin source | Re-run `npm run build` |
