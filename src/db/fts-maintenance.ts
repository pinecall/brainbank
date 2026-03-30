/**
 * BrainBank — FTS Maintenance
 *
 * Centralized maintenance operations for FTS5 indices.
 * Extracted from KeywordSearch to separate search from maintenance.
 */

import type { Database } from './database.ts';

export class FTSMaintenance {
    constructor(private _db: Database) { }

    /** Rebuild all FTS5 indices from their content tables. */
    rebuild(): void {
        try {
            this._db.prepare("INSERT INTO fts_code(fts_code) VALUES('rebuild')").run();
            this._db.prepare("INSERT INTO fts_commits(fts_commits) VALUES('rebuild')").run();
            this._db.prepare("INSERT INTO fts_patterns(fts_patterns) VALUES('rebuild')").run();
        } catch { }
    }
}
