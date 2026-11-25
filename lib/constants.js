'use strict';

module.exports = {
  GIT_TIMEOUT: parseInt(process.env.GIT_TIMEOUT || '15000', 10),
  GIT_LONG_TIMEOUT: parseInt(process.env.GIT_LONG_TIMEOUT || '30000', 10),
  AUTO_SYNC_INTERVAL: parseInt(process.env.AUTO_SYNC_INTERVAL || '15000', 10),
  GIT_FETCH_INTERVAL: parseInt(process.env.GIT_FETCH_INTERVAL || '15000', 10),
  GIT_FETCH_CONCURRENCY: parseInt(process.env.GIT_FETCH_CONCURRENCY || '4', 10),
  SYNC_LOG_RETENTION_DAYS: parseInt(process.env.SYNC_LOG_RETENTION_DAYS || '90', 10),
  NODE_STALE_AFTER_MS: parseInt(process.env.NODE_STALE_AFTER_MS || '90000', 10),
  NODE_SWEEP_INTERVAL_MS: parseInt(process.env.NODE_SWEEP_INTERVAL_MS || '30000', 10),
  GIT_USER_EMAIL: 'mindframework@auto.sync',
  GIT_USER_NAME: 'MindFramework Auto-Sync',
};
