'use strict';

const session = require('express-session');
const pool = require('../db');

class MariaSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    // ttl in seconden; standaard 2 uur
    this.ttl = (options.ttl || 7200) * 1000;
    this._tableReady = this._ensureTable();
  }

  async _ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mindgit_sessions (
        session_id VARCHAR(128) CHARACTER SET utf8mb4 NOT NULL,
        expires BIGINT NOT NULL,
        data MEDIUMTEXT CHARACTER SET utf8mb4,
        PRIMARY KEY (session_id),
        KEY idx_expires (expires)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async get(sid, callback) {
    try {
      await this._tableReady;
      const rows = await pool.query(
        'SELECT session_id, expires, data FROM mindgit_sessions WHERE session_id = ?',
        [sid]
      );
      if (!rows.length) return callback(null, null);

      const row = rows[0];
      if (row.expires && row.expires < Date.now()) {
        await this.destroy(sid, () => {});
        return callback(null, null);
      }

      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  async set(sid, sess, callback) {
    try {
      await this._tableReady;
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + this.ttl;
      const data = JSON.stringify(sess);
      await pool.query(
        'REPLACE INTO mindgit_sessions (session_id, expires, data) VALUES (?, ?, ?)',
        [sid, expires, data]
      );
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async touch(sid, sess, callback) {
    try {
      await this._tableReady;
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + this.ttl;
      await pool.query(
        'UPDATE mindgit_sessions SET expires = ? WHERE session_id = ?',
        [expires, sid]
      );
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async destroy(sid, callback) {
    try {
      await this._tableReady;
      await pool.query('DELETE FROM mindgit_sessions WHERE session_id = ?', [sid]);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  async clearExpired(callback) {
    try {
      await this._tableReady;
      await pool.query('DELETE FROM mindgit_sessions WHERE expires < ?', [Date.now()]);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }
}

module.exports = MariaSessionStore;
