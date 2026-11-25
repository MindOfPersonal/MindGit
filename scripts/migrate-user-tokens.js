'use strict';

require('dotenv').config();
const pool = require('../db');
const { getGlobalSetting } = require('../lib/settings');
const { columnExists } = require('../lib/db-helpers');

async function run() {
  try {
    if (!(await columnExists(pool, 'users', 'github_user'))) {
      await pool.query('ALTER TABLE users ADD COLUMN github_user VARCHAR(100) DEFAULT \'\'');
      console.log('users.github_user toegevoegd');
    }
    if (!(await columnExists(pool, 'users', 'github_token_encrypted'))) {
      await pool.query('ALTER TABLE users ADD COLUMN github_token_encrypted TEXT');
      console.log('users.github_token_encrypted toegevoegd');
    }
    if (!(await columnExists(pool, 'repos', 'group_name'))) {
      await pool.query('ALTER TABLE repos ADD COLUMN group_name VARCHAR(100) DEFAULT \'\'');
      console.log('repos.group_name toegevoegd');
    }

    const globalToken = await getGlobalSetting(pool, 'token');
    const globalUser = await getGlobalSetting(pool, 'githubUser');

    if (globalUser) {
      await pool.query('UPDATE users SET github_user = ? WHERE github_user = \'\' OR github_user IS NULL', [globalUser]);
      console.log('Globale github_user gekopieerd naar gebruikers zonder eigen waarde.');
    }
    if (globalToken) {
      await pool.query('UPDATE users SET github_token_encrypted = ? WHERE github_token_encrypted IS NULL OR github_token_encrypted = \'\'', [globalToken]);
      console.log('Globale token gekopieerd naar gebruikers zonder eigen token.');
    }

    console.log('Migratie voltooid.');
    process.exit(0);
  } catch (err) {
    console.error('Migratie fout:', err);
    process.exit(1);
  }
}

run();
