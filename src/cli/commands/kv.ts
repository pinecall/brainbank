/**
 * brainbank kv add|search|list|trim|clear — Dynamic KV collection management
 */

import { c, args, getFlag } from '../utils.ts';
import { createBrain } from '../factory.ts';

export async function cmdKv(): Promise<void> {
    const sub = args[1];

    // ── add ─────────────────────────────────────────
    if (sub === 'add') {
        const collName = args[2];
        const content = args.slice(3).filter(a => !a.startsWith('--')).join(' ');
        const metaRaw = getFlag('meta');

        if (!collName || !content) {
            console.log(c.red("Usage: brainbank kv add <collection> <content> [--meta '{\"key\":\"val\"}']"));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.initialize();
        const coll = brain.collection(collName);
        const meta = metaRaw ? JSON.parse(metaRaw) : {};
        const id = await coll.add(content, meta);
        console.log(c.green(`✓ Added item #${id} to '${collName}'`));
        brain.close();
        return;
    }

    // ── search ──────────────────────────────────────
    if (sub === 'search') {
        const collName = args[2];
        const query = args.slice(3).filter(a => !a.startsWith('--')).join(' ');
        const k = parseInt(getFlag('k') || '5', 10);
        const mode = (getFlag('mode') as any) || 'hybrid';

        if (!collName || !query) {
            console.log(c.red('Usage: brainbank kv search <collection> <query> [--k 5] [--mode hybrid|keyword|vector]'));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.initialize();
        const coll = brain.collection(collName);
        const results = await coll.search(query, { k, mode });

        if (results.length === 0) {
            console.log(c.yellow('  No results found.'));
        } else {
            console.log(c.bold(`\n━━━ ${collName}: "${query}" ━━━\n`));
            for (const r of results) {
                const score = Math.round((r.score ?? 0) * 100);
                console.log(`  ${c.cyan(`[${score}%]`)} ${r.content}`);
                if (Object.keys(r.metadata).length > 0) {
                    console.log(`    ${c.dim(JSON.stringify(r.metadata))}`);
                }
            }
        }
        brain.close();
        return;
    }

    // ── list ────────────────────────────────────────
    if (sub === 'list') {
        const collName = args[2];
        const limit = parseInt(getFlag('limit') || '20', 10);

        if (!collName) {
            const brain = await createBrain();
            await brain.initialize();
            const names = brain.listCollectionNames();
            if (names.length === 0) {
                console.log(c.yellow('  No KV collections found.'));
            } else {
                console.log(c.bold('\n━━━ KV Collections ━━━\n'));
                for (const n of names) {
                    const coll = brain.collection(n);
                    console.log(`  ${c.cyan(n)} — ${coll.count()} items`);
                }
            }
            brain.close();
            return;
        }

        const brain = await createBrain();
        await brain.initialize();
        const coll = brain.collection(collName);
        const items = coll.list({ limit });
        if (items.length === 0) {
            console.log(c.yellow(`  Collection '${collName}' is empty.`));
        } else {
            console.log(c.bold(`\n━━━ ${collName} (${coll.count()} items) ━━━\n`));
            for (const item of items) {
                const age = Math.round((Date.now() / 1000 - item.createdAt) / 60);
                console.log(`  #${item.id} ${c.dim(`(${age}m ago)`)} ${item.content.slice(0, 80)}`);
            }
        }
        brain.close();
        return;
    }

    // ── trim ────────────────────────────────────────
    if (sub === 'trim') {
        const collName = args[2];
        const keep = parseInt(getFlag('keep') || '0', 10);

        if (!collName || keep <= 0) {
            console.log(c.red('Usage: brainbank kv trim <collection> --keep <n>'));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.initialize();
        const coll = brain.collection(collName);
        const result = await coll.trim({ keep });
        console.log(c.green(`✓ Trimmed ${result.removed} items from '${collName}' (kept ${keep})`));
        brain.close();
        return;
    }

    // ── clear ───────────────────────────────────────
    if (sub === 'clear') {
        const collName = args[2];
        if (!collName) {
            console.log(c.red('Usage: brainbank kv clear <collection>'));
            process.exit(1);
        }

        const brain = await createBrain();
        await brain.initialize();
        const coll = brain.collection(collName);
        const before = coll.count();
        coll.clear();
        console.log(c.green(`✓ Cleared ${before} items from '${collName}'`));
        brain.close();
        return;
    }

    console.log(c.red('Usage: brainbank kv <add|search|list|trim|clear>'));
    process.exit(1);
}
