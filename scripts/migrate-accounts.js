'use strict';

require('dotenv').config();
const pool = require('../db');
const { getGlobalSetting } = require('../lib/settings');
const { encrypt, decrypt, isEncrypted } = require('../lib/crypto');
const { columnExists } = require('../lib/db-helpers');

async function tableExists(tableName) {
  const rows = await pool.query(
    'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [tableName]
  );
  return rows && rows.length > 0;
}

async function run() {
  try {
    if (!(await tableExists('github_accounts'))) {
      await pool.query(`
        CREATE TABLE github_accounts (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          label VARCHAR(50) NOT NULL,
          github_user VARCHAR(100) NOT NULL,
          github_token_encrypted TEXT NOT NULL,
          is_default TINYINT(1) NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY unique_user_label (user_id, label)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('[MIGRATIE] Tabel github_accounts aangemaakt.');
    } else {
      console.log('[MIGRATIE] Tabel github_accounts bestond al.');
    }

    if (!(await columnExists(pool, 'repos', 'account_id'))) {
      await pool.query('ALTER TABLE repos ADD COLUMN account_id INT DEFAULT NULL');
      console.log('[MIGRATIE] Kolom repos.account_id toegevoegd.');
    } else {
      console.log('[MIGRATIE] Kolom repos.account_id bestond al.');
    }

    try {
      await pool.query(
        'ALTER TABLE repos ADD CONSTRAINT fk_repos_account FOREIGN KEY (account_id) REFERENCES github_accounts(id) ON DELETE SET NULL'
      );
      console.log('[MIGRATIE] FK repos.account_id -> github_accounts toegevoegd.');
    } catch (e) {
      // FK bestaat waarschijnlijk al, negeer
    }

    const users = await pool.query(
      'SELECT id, github_user, github_token_encrypted FROM users'
    );

    let legacyMigrated = 0;
    for (const u of users || []) {
      if (!u.github_token_encrypted) continue;

      const existing = await pool.query(
        'SELECT id FROM github_accounts WHERE user_id = ? LIMIT 1',
        [u.id]
      );
      if (existing && existing.length > 0) continue;

      const tokenEnc = u.github_token_encrypted;
      let insertRes;
      if (!isEncrypted(tokenEnc)) {
        const plain = tokenEnc;
        const enc = encrypt(plain);
        insertRes = await pool.query(
          'INSERT INTO github_accounts (user_id, label, github_user, github_token_encrypted, is_default) VALUES (?, ?, ?, ?, 1)',
          [u.id, 'Standaard', u.github_user || 'GitHub', enc]
        );
      } else {
        insertRes = await pool.query(
          'INSERT INTO github_accounts (user_id, label, github_user, github_token_encrypted, is_default) VALUES (?, ?, ?, ?, 1)',
          [u.id, 'Standaard', u.github_user || 'GitHub', tokenEnc]
        );
      }

      const newAccountId = insertRes && insertRes.insertId ? insertRes.insertId : null;
      if (newAccountId === null) {
        console.warn(`[MIGRATIE] Gebruiker ${u.id}: kon insertId niet bepalen, sla over.`);
        continue;
      }
      const res = await pool.query(
        'UPDATE repos SET account_id = ? WHERE user_id = ? AND (account_id IS NULL OR account_id = 0)',
        [newAccountId, u.id]
      );
      const affected = res && res.affectedRows ? res.affectedRows : 0;
      console.log(`[MIGRATIE] Gebruiker ${u.id}: default account #${newAccountId} aangemaakt, ${affected} repos gekoppeld.`);
      legacyMigrated++;
    }

    if (legacyMigrated === 0) {
      console.log('[MIGRATIE] Geen legacy users met eigen token om te migreren.');
    }

    const globalTokenRaw = await getGlobalSetting(pool, 'token');
    const globalUser = await getGlobalSetting(pool, 'githubUser');

    if (globalTokenRaw) {
      let plainToken = '';
      try {
        plainToken = isEncrypted(globalTokenRaw) ? decrypt(globalTokenRaw) : globalTokenRaw;
      } catch (e) {
        plainToken = globalTokenRaw;
      }

      const usersWithoutAccount = await pool.query(
        'SELECT id FROM users u WHERE NOT EXISTS (SELECT 1 FROM github_accounts ga WHERE ga.user_id = u.id)'
      );

      for (const u of usersWithoutAccount || []) {
        const enc = encrypt(plainToken);
        const insertRes = await pool.query(
          'INSERT INTO github_accounts (user_id, label, github_user, github_token_encrypted, is_default) VALUES (?, ?, ?, ?, 1)',
          [u.id, 'Standaard', globalUser || 'GitHub', enc]
        );
        const newAccountId = insertRes && insertRes.insertId ? insertRes.insertId : null;
        if (newAccountId === null) {
          console.warn(`[MIGRATIE] Gebruiker ${u.id}: kon insertId niet bepalen, sla over.`);
          continue;
        }
        await pool.query(
          'UPDATE repos SET account_id = ? WHERE user_id = ? AND (account_id IS NULL OR account_id = 0)',
          [newAccountId, u.id]
        );
        console.log(`[MIGRATIE] Gebruiker ${u.id}: global token gemigreerd naar default account #${newAccountId}.`);
      }
    }

    const usersWithAccounts = await pool.query(
      'SELECT user_id FROM github_accounts GROUP BY user_id'
    );
    for (const row of usersWithAccounts || []) {
      const defaults = await pool.query(
        'SELECT id FROM github_accounts WHERE user_id = ? AND is_default = 1',
        [row.user_id]
      );
      if (!defaults || defaults.length === 0) {
        const first = await pool.query(
          'SELECT id FROM github_accounts WHERE user_id = ? ORDER BY id LIMIT 1',
          [row.user_id]
        );
        if (first && first.length > 0) {
          await pool.query('UPDATE github_accounts SET is_default = 1 WHERE id = ?', [first[0].id]);
          console.log(`[MIGRATIE] Gebruiker ${row.user_id}: account ${first[0].id} benoemd tot default.`);
        }
      } else if (defaults.length > 1) {
        const keep = defaults[0].id;
        await pool.query(
          'UPDATE github_accounts SET is_default = 0 WHERE user_id = ? AND id != ?',
          [row.user_id, keep]
        );
        console.log(`[MIGRATIE] Gebruiker ${row.user_id}: meerdere defaults gevonden, alleen ${keep} behouden.`);
      }
    }

    console.log('[MIGRATIE] voltooid.');
    process.exit(0);
  } catch (err) {
    console.error('Migratie fout:', err);
    process.exit(1);
  }
}

run();
