# Publishing Rules

## Prerequisites
- Always verify npm auth (`npm whoami`) BEFORE attempting any publish
- This project does NOT use npm workspaces — packages must be explicitly linked via `npm link`

## Package Linking (required before tests/builds)
1. Build core: `npm run build:core` → `npm link`
2. Each package: `cd packages/<name> && npm link brainbank --force && npm run build && npm link`
3. MCP extra deps: `cd packages/mcp && npm link @brainbank/code @brainbank/git @brainbank/docs --force`
4. Root links: `npm link @brainbank/code @brainbank/git @brainbank/docs @brainbank/mcp @brainbank/memory`

> `--force` is required for `@brainbank/code` due to tree-sitter peer dep conflicts.

## Build Order
Always build in dependency order: core → packages. Packages depend on core's `dist/` for DTS generation.

## Publish Order
1. `brainbank` (core)
2. `@brainbank/code`, `@brainbank/git`, `@brainbank/docs` (peer dep: core)
3. `@brainbank/memory` (peer dep: core)
4. `@brainbank/mcp` (deps: core + code + git + docs) — **always last**

## Scoped Packages
- First publish always needs `--access public`
- After first publish, `npm publish` is enough

## Peer Dependencies
- code/git/docs/memory have `brainbank` as peerDependency
- MCP has code/git/docs as regular dependencies
- When bumping core, verify peer dep ranges in packages still match
