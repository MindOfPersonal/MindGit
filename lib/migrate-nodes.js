'use strict';

const { columnExists } = require('./db-helpers');

async function tableExists(pool, tableName) {
  const rows = await pool.query(
    'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [tableName]
  );
  return rows && rows.length > 0;
}

async function migrateNodeTables(pool) {
  // nodes tabel
  if (!(await tableExists(pool, 'nodes'))) {
    await pool.query(`
      CREATE TABLE nodes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        node_key_hash CHAR(64) NOT NULL UNIQUE,
        platform ENUM('windows','linux','macos','unknown') DEFAULT 'unknown',
        git_version VARCHAR(50) DEFAULT '',
        capabilities JSON,
        last_seen TIMESTAMP NULL,
        status ENUM('online','offline','stale') DEFAULT 'offline',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        KEY idx_nodes_user (user_id),
        KEY idx_nodes_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  // node_repos tabel
  if (!(await tableExists(pool, 'node_repos'))) {
    await pool.query(`
      CREATE TABLE node_repos (
        node_id INT NOT NULL,
        repo_id INT NOT NULL,
        sync_direction ENUM('pull','push','bidirectional') DEFAULT 'bidirectional',
        auto_sync TINYINT(1) NOT NULL DEFAULT 0,
        node_path VARCHAR(500) DEFAULT NULL,
        last_synced TIMESTAMP NULL,
        last_status ENUM('success','failed','conflict','pending') DEFAULT 'pending',
        last_error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (node_id, repo_id),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
        KEY idx_node_repos_repo (repo_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } else if (!(await columnExists('node_repos', 'node_path'))) {
    try {
      await pool.query('ALTER TABLE node_repos ADD COLUMN node_path VARCHAR(500) DEFAULT NULL');
    } catch {
      // kolom bestaat mogelijk al (race)
    }
  }

  // default_path kolom op nodes (standaard browse-map / root voor de agent)
  if (!(await columnExists('nodes', 'default_path'))) {
    try {
      await pool.query('ALTER TABLE nodes ADD COLUMN default_path VARCHAR(500) DEFAULT NULL');
    } catch {
      // kolom bestaat mogelijk al (race)
    }
  }

  // node_sync_queue tabel
  if (!(await tableExists(pool, 'node_sync_queue'))) {
    await pool.query(`
      CREATE TABLE node_sync_queue (
        id INT AUTO_INCREMENT PRIMARY KEY,
        node_id INT NOT NULL,
        repo_id INT NOT NULL,
        action ENUM('sync','pull','push','fetch','clone','create') DEFAULT 'sync',
        commit_message VARCHAR(500),
        priority INT NOT NULL DEFAULT 5,
        status ENUM('queued','running','done','failed') DEFAULT 'queued',
        result JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
        KEY idx_queue_node_status (node_id, status),
        KEY idx_queue_priority (priority, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } else {
    const queueCol = await pool.query(
      "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'node_sync_queue' AND COLUMN_NAME = 'action'"
    );
    const colType = queueCol && queueCol[0] ? queueCol[0].COLUMN_TYPE : '';
    if (colType && !colType.includes('clone')) {
      try {
        await pool.query(`ALTER TABLE node_sync_queue MODIFY COLUMN action ENUM('sync','pull','push','fetch','clone','create') DEFAULT 'sync'`);
      } catch {
        // enum-uitbreiding mislukt; niet fataal
      }
    }
  }
}

module.exports = { migrateNodeTables };