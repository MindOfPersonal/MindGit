-- MindGit / GitHub Manager database schema
-- Voer dit uit in MariaDB voordat je de server start.
--
-- mysql -u root -p < schema.sql
-- of via een database management tool.

CREATE DATABASE IF NOT EXISTS github
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE github;

-- Gebruikers voor het dashboard
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  github_user VARCHAR(100) DEFAULT '',
  github_token_encrypted TEXT,
  language VARCHAR(5) NOT NULL DEFAULT 'nl',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Meerdere GitHub accounts per dashboard gebruiker
CREATE TABLE IF NOT EXISTS github_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  label VARCHAR(50) NOT NULL,
  github_user VARCHAR(100) NOT NULL,
  github_token_encrypted TEXT NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_label (user_id, label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Repositories die worden beheerd
CREATE TABLE IF NOT EXISTS repos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  account_id INT DEFAULT NULL,
  name VARCHAR(100) NOT NULL,
  path VARCHAR(500) NOT NULL,
  remote VARCHAR(200) DEFAULT '',
  group_name VARCHAR(100) DEFAULT '',
  favorite TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES github_accounts(id) ON DELETE SET NULL,
  UNIQUE KEY unique_user_path (user_id, path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Instellingen (key/value). Het globale GitHub token wordt versleuteld opgeslagen.
-- Per-gebruiker tokens in de users tabel overschrijven deze waardes.
CREATE TABLE IF NOT EXISTS settings (
  skey VARCHAR(50) PRIMARY KEY,
  svalue TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sync logboek per repository
CREATE TABLE IF NOT EXISTS sync_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  repo_id INT NOT NULL,
  action VARCHAR(50) NOT NULL,
  message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pull requests (cached from GitHub API)
CREATE TABLE IF NOT EXISTS pull_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  repo_id INT NOT NULL,
  pr_number INT NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  state VARCHAR(20) NOT NULL DEFAULT 'open',
  author VARCHAR(100) DEFAULT '',
  head_branch VARCHAR(200) DEFAULT '',
  base_branch VARCHAR(200) DEFAULT '',
  html_url VARCHAR(500) DEFAULT '',
  is_merged TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
  UNIQUE KEY unique_repo_pr (repo_id, pr_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Webhook configuratie per repo
CREATE TABLE IF NOT EXISTS webhooks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  repo_id INT NOT NULL,
  github_webhook_id INT DEFAULT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sessies (Express session store, persistent in MariaDB)
-- Eigen tabelnaam (mindgit_sessions) om niet te botsen met een eventueel
-- al bestaande 'sessions' tabel van een andere applicatie in dezelfde DB.
CREATE TABLE IF NOT EXISTS mindgit_sessions (
  session_id VARCHAR(128) CHARACTER SET utf8mb4 NOT NULL,
  expires BIGINT NOT NULL,
  data MEDIUMTEXT CHARACTER SET utf8mb4,
  PRIMARY KEY (session_id),
  KEY idx_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- API tokens voor de desktop/mobiele app (bearer tokens, gehasht opgeslagen)
CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  expires_at BIGINT NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_api_tokens_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nodes (agents) die repos lokaal beheren
CREATE TABLE IF NOT EXISTS nodes (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Welke repos op welke node gesynct moeten worden
CREATE TABLE IF NOT EXISTS node_repos (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sync taken voor nodes (wachtrij)
CREATE TABLE IF NOT EXISTS node_sync_queue (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Favorieten/tags per repository
CREATE TABLE IF NOT EXISTS repo_tags (
  repo_id INT NOT NULL,
  tag VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_id, tag),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
  KEY idx_repo_tags_tag (tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Opgeslagen dashboard-filters per gebruiker
CREATE TABLE IF NOT EXISTS saved_filters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(80) NOT NULL,
  query VARCHAR(255) NOT NULL DEFAULT '',
  tag VARCHAR(50) NOT NULL DEFAULT '',
  favorite_only TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_filter (user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Web-push subscriptions (per browser/apparaat)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh VARCHAR(255) NOT NULL,
  auth VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_push_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
