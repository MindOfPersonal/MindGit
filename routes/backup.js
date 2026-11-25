'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const {
  BACKUP_DIR,
  createBackup,
  listBackups,
  deleteBackup,
  validateBackup,
  isSafeBackupName,
} = require('../lib/backup');
const {
  getPublicKey,
  saveSubscription,
  removeSubscription,
  countSubscriptions,
  sendPushToUser,
} = require('../lib/push');
const { getTagsForRepos } = require('../lib/repo-meta');

const router = express.Router();

// --- Back-up beheer -------------------------------------------------------

router.get('/settings/backup', async (req, res) => {
  let backups = [];
  let error = null;
  try {
    backups = await listBackups();
  } catch (err) {
    error = err.message;
  }
  res.render('backup', {
    backups,
    backupDir: BACKUP_DIR,
    retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10),
    intervalHours: parseInt(process.env.BACKUP_INTERVAL_HOURS || '0', 10),
    error,
  });
});

router.post('/settings/backup/create', async (req, res) => {
  try {
    const manifest = await createBackup(pool);
    req.flash('success', `Back-up gemaakt: ${manifest.name} (${Math.round(manifest.size / 1024)} KB).`);
  } catch (err) {
    req.flash('error', 'Back-up maken mislukt: ' + err.message);
  }
  res.redirect('/repos/settings/backup');
});

router.post('/settings/backup/:name/validate', async (req, res) => {
  try {
    if (!isSafeBackupName(req.params.name)) {
      return res.status(400).json({ ok: false, error: 'Ongeldige bestandsnaam.' });
    }
    const result = await validateBackup(req.params.name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/settings/backup/:name/delete', async (req, res) => {
  try {
    if (!isSafeBackupName(req.params.name)) throw new Error('Ongeldige bestandsnaam.');
    await deleteBackup(req.params.name);
    req.flash('success', 'Back-up verwijderd.');
  } catch (err) {
    req.flash('error', 'Verwijderen mislukt: ' + err.message);
  }
  res.redirect('/repos/settings/backup');
});

router.get('/settings/backup/download/:name', (req, res) => {
  if (!isSafeBackupName(req.params.name)) return res.status(400).send('Ongeldige bestandsnaam.');
  const file = path.join(BACKUP_DIR, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).send('Back-up niet gevonden.');
  res.download(file, req.params.name);
});

// --- Export ---------------------------------------------------------------

router.get('/export/repos.json', async (req, res) => {
  try {
    const repos = await pool.query(
      'SELECT id, name, path, remote, group_name, favorite, account_id, created_at FROM repos WHERE user_id = ? ORDER BY group_name, name',
      [req.session.user.id]
    );
    const tags = await getTagsForRepos(pool, repos.map((r) => r.id));
    const data = {
      exportedAt: new Date().toISOString(),
      repos: repos.map((r) => ({ ...r, tags: tags.get(r.id) || [] })),
    };
    res.setHeader('Content-Disposition', 'attachment; filename="mindgit-repos.json"');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Export mislukt: ' + err.message });
  }
});

router.get('/export/sync-logs.csv', async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT r.name AS repo, l.action, l.message, l.created_at
       FROM sync_logs l JOIN repos r ON r.id = l.repo_id
       WHERE r.user_id = ? ORDER BY l.created_at DESC LIMIT 10000`,
      [req.session.user.id]
    );
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['repo,action,message,created_at'];
    for (const row of rows) {
      lines.push([row.repo, row.action, row.message, row.created_at].map(esc).join(','));
    }
    res.setHeader('Content-Disposition', 'attachment; filename="mindgit-sync-logs.csv"');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: 'Export mislukt: ' + err.message });
  }
});

router.get('/export/settings.json', async (req, res) => {
  try {
    const rows = await pool.query('SELECT skey, svalue FROM settings ORDER BY skey');
    const secretKey = /(token|secret|key|password|vapid)/i;
    const settings = {};
    for (const row of rows) {
      // Nooit secrets of versleutelde waarden exporteren.
      settings[row.skey] = secretKey.test(row.skey) || String(row.svalue || '').startsWith('enc:')
        ? '[REDACTED]'
        : row.svalue;
    }
    const accounts = await pool.query(
      'SELECT id, label, github_user, is_default, created_at FROM github_accounts WHERE user_id = ?',
      [req.session.user.id]
    );
    const data = {
      exportedAt: new Date().toISOString(),
      settings,
      accounts,
    };
    res.setHeader('Content-Disposition', 'attachment; filename="mindgit-settings.json"');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Export mislukt: ' + err.message });
  }
});

// --- Web push -------------------------------------------------------------

router.get('/settings/push/status', async (req, res) => {
  try {
    const publicKey = await getPublicKey(pool);
    const count = await countSubscriptions(pool, req.session.user.id);
    res.json({ ok: true, publicKey, count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/settings/push/subscribe', async (req, res) => {
  try {
    await saveSubscription(pool, req.session.user.id, req.body.subscription || req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/settings/push/unsubscribe', async (req, res) => {
  try {
    await removeSubscription(pool, req.session.user.id, req.body.endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/settings/push/test', async (req, res) => {
  try {
    const result = await sendPushToUser(pool, req.session.user.id, {
      title: 'MindGit testmelding',
      body: 'Web push is correct geconfigureerd.',
      status: 'success',
      url: '/repos',
      tag: 'mindgit-test',
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
