'use strict';

require('dotenv').config();
const pool = require('../db');
const { migrateNodeTables } = require('../lib/migrate-nodes');

async function run() {
  try {
    console.log('[MIGRATIE] Start node/agent tabellen migratie...');
    await migrateNodeTables(pool);
    console.log('[MIGRATIE] Voltooid.');
    process.exit(0);
  } catch (err) {
    console.error('Migratie fout:', err);
    process.exit(1);
  }
}

run();