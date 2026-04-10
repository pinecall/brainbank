#!/usr/bin/env node

/**
 * BrainBank — CLI Entry Point
 *
 * Dispatcher that routes commands to their handler modules.
 */

import { args, c } from './utils.ts';
import { cmdIndex } from './commands/index.ts';
import { cmdCollection } from './commands/collection.ts';
import { cmdKv } from './commands/kv.ts';
import { cmdDocs, cmdDocSearch } from './commands/docs.ts';
import { cmdSearch, cmdHybridSearch, cmdKeywordSearch } from './commands/search.ts';
import { cmdContext } from './commands/context.ts';
import { cmdFiles } from './commands/files.ts';
import { cmdStats } from './commands/stats.ts';
import { cmdReembed } from './commands/reembed.ts';
import { cmdWatch } from './commands/watch.ts';
import { cmdMcp } from './commands/mcp.ts';
import { cmdDaemon } from './commands/daemon.ts';
import { cmdStatus } from './commands/status.ts';
import { showHelp } from './commands/help.ts';

const command = args[0];

async function main(): Promise<void> {
    switch (command) {
        case 'index':       return cmdIndex();
        case 'collection':  return cmdCollection();
        case 'kv':          return cmdKv();
        case 'docs':        return cmdDocs();
        case 'dsearch':     return cmdDocSearch();
        case 'search':      return cmdSearch();
        case 'hsearch':     return cmdHybridSearch();
        case 'ksearch':     return cmdKeywordSearch();
        case 'context':     return cmdContext();
        case 'files':       return cmdFiles();
        case 'stats':       return cmdStats();
        case 'reembed':     return cmdReembed();
        case 'watch':       return cmdWatch();
        case 'mcp':         return cmdMcp();
        case 'serve':        return cmdMcp(); // backward compat
        case 'daemon':      return cmdDaemon();
        case 'status':      return cmdStatus();
        case 'help':
        case '--help':
        case '-h':
            showHelp();
            break;
        default:
            if (command) console.log(c.red(`Unknown command: ${command}\n`));
            showHelp();
            process.exit(command ? 1 : 0);
    }
}

main().catch(err => {
    console.error(c.red(`Error: ${err.message}`));
    if (process.env.BRAINBANK_DEBUG) console.error(err.stack);
    process.exit(1);
});
