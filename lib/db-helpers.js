'use strict';

const pool = require('../db');

async function logSync(repoId, action, message) {
  try {
    await pool.query('INSERT INTO sync_logs (repo_id, action, message) VALUES (?, ?, ?)', [repoId, action, message]);
  } catch (err) {
    console.error('Failed to log sync:', err);
  }
}

async function columnExists(table, column) {
  try {
    const rows = await pool.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column]
    );
    return rows && rows.length > 0;
  } catch (err) {
    console.error('Failed to check column exists:', err);
    return false;
  }
}

async function ensureApiTokenTable() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS api_tokens (
      token_hash CHAR(64) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL,
      expires_at BIGINT NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_api_tokens_user (user_id)
    )`);
  } catch (err) {
    console.error('Failed to create api_tokens table:', err);
  }

  // Migratie voor bestaande installs: voeg de expires_at-kolom toe indien nodig
  if (!(await columnExists('api_tokens', 'expires_at'))) {
    try {
      await pool.query('ALTER TABLE api_tokens ADD COLUMN expires_at BIGINT NULL DEFAULT NULL');
    } catch (err) {
      // kolom bestaat mogelijk al (race), ignore
    }
  }
}

// Verwijder vervallen API-tokens.
async function cleanupApiTokens() {
  try {
    await pool.query('DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < ?', [Date.now()]);
  } catch (err) {
    console.error('Failed to cleanup API tokens:', err);
  }
}

// Verwijder oude sync_logs-rijen ouder dan de ingestelde retentie (default 90 dagen).
const { SYNC_LOG_RETENTION_DAYS } = require('./constants');
async function cleanupOldSyncLogs() {
  const days = parseInt(SYNC_LOG_RETENTION_DAYS, 10);
  if (!days || days <= 0) return;
  try {
    await pool.query(
      'DELETE FROM sync_logs WHERE created_at < (NOW() - INTERVAL ? DAY)',
      [days]
    );
  } catch (err) {
    console.error('Failed to cleanup old sync logs:', err);
  }
}

module.exports = { logSync, columnExists, cleanupApiTokens, cleanupOldSyncLogs, ensureApiTokenTable };
