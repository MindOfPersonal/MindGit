'use strict';

const { columnExists } = require('./db-helpers');

/**
 * Idempotente migraties voor de features die later aan MindGit zijn toegevoegd:
 * favorieten/tags, opgeslagen filters, web-push subscriptions en de
 * staging/commit-UI. Wordt bij het opstarten aangeroepen vanuit lib/seed.js.
 */
async function migrateFeatureTables(pool) {
  // --- repos.favorite ----------------------------------------------------
  if (!(await columnExists('repos', 'favorite'))) {
    await pool.query('ALTER TABLE repos ADD COLUMN favorite TINYINT(1) NOT NULL DEFAULT 0');
    console.log('[MIGRATIE] Kolom repos.favorite toegevoegd.');
  }

  // --- repo tags ---------------------------------------------------------
  await pool.query(`CREATE TABLE IF NOT EXISTS repo_tags (
    repo_id INT NOT NULL,
    tag VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (repo_id, tag),
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
    KEY idx_repo_tags_tag (tag)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // --- opgeslagen dashboard-filters -------------------------------------
  await pool.query(`CREATE TABLE IF NOT EXISTS saved_filters (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(80) NOT NULL,
    query VARCHAR(255) NOT NULL DEFAULT '',
    tag VARCHAR(50) NOT NULL DEFAULT '',
    favorite_only TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_filter (user_id, name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // --- web-push subscriptions -------------------------------------------
  await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint_hash CHAR(64) NOT NULL PRIMARY KEY,
    user_id INT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_push_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

module.exports = { migrateFeatureTables };
