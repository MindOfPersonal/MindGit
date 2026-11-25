'use strict';

/**
 * Repository sync routes
 * Handles: single sync, bulk sync, sync-all, node sync
 */

const express = require('express');
const pool = require('../../db');
const { syncRepo, getRepoStatusAsync, getRepoDataAsync } = require('../../lib/git');
const { getRepoToken } = require('../../lib/settings');
const { getOnlineNodeForRepo, nodeRepoStatus, nodeRepoData } = require('../../lib/node-repo');
const { scheduleSyncForNodeRepo, scheduleSyncForAllNodes } = require('../../lib/sync-orchestrator');
const { sendNotification } = require('../../lib/notify');
const { logSync } = require('../../lib/db-helpers');

const syncLimiter = require('express-rate-limit')({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: 'Te veel sync requests, probeer later opnieuw.',
});

const router = express.Router();

// --- Single Repo Sync -------------------------------------------------------

router.post('/sync/:id', syncLimiter, async (req, res, next) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!repo) return res.status(404).json({ error: 'Repo niet gevonden' });

    const io = req.app.get('io');
    const { commitMessage } = req.body;

    if (!isRepoLocal(repo)) {
      const nodeId = await getOnlineNodeForRepo(pool, repo.id);
      if (nodeId) {
        await scheduleSyncForNodeRepo(nodeId, repo.id, 'sync', commitMessage, 5);
        if (io) io.to(`repo-${repo.id}`).emit('sync-log', { msg: 'Sync naar node gepland', type: 'info' });
        return res.json({ ok: true, queued: true, nodeId });
      }
    }

    const { token } = await getRepoToken(pool, repo);
    const result = await syncRepo(repo, token, { io, log: logSync, commitMessage });

    if (io) {
      const st = await getRepoStatusAsync(repo.path, token);
      const rd = await getRepoDataAsync(repo.path);
      io.to(`repo-${repo.id}`).emit('repo-update', {
        id: repo.id, name: repo.name, path: repo.path, remote: repo.remote, status: st, gitData: rd,
      });
    }

    if (!result.ok) {
      const reason = result.reason || 'unknown';
      await sendNotification(pool, repo.name, reason, `Sync mislukt: ${reason}`, req.session.user.id);
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- Bulk Sync --------------------------------------------------------------

router.get('/sync-all', (req, res) => res.redirect('/repos'));

router.post('/sync-all', syncLimiter, async (req, res, next) => {
  try {
    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ?', [req.session.user.id]);
    const io = req.app.get('io');
    const { commitMessage } = req.body;
    let ok = 0, fail = 0;

    for (const repo of repos) {
      if (!isRepoLocal(repo)) {
        const nodeId = await getOnlineNodeForRepo(pool, repo.id);
        if (nodeId) {
          await scheduleSyncForNodeRepo(nodeId, repo.id, 'sync', commitMessage, 5);
          ok++;
          continue;
        }
      }

      const { token } = await getRepoToken(pool, repo);
      const result = await syncRepo(repo, token, { io, log: logSync, commitMessage });

      if (io) {
        const st = await getRepoStatusAsync(repo.path, token);
        const rd = await getRepoDataAsync(repo.path);
        io.to(`repo-${repo.id}`).emit('repo-update', {
          id: repo.id, name: repo.name, path: repo.path, remote: repo.remote, status: st, gitData: rd,
        });
      }

      if (result.ok) { ok++; } else { fail++;
        await sendNotification(pool, repo.name, result.reason || 'unknown', `Sync mislukt: ${result.reason || 'onbekend'}`, req.session.user.id);
      }
    }

    req.flash('success', `Sync klaar: ${ok} geslaagd, ${fail} mislukt.`);
    res.redirect('/repos');
  } catch (err) {
    next(err);
  }
});

// --- Sync All Nodes ---------------------------------------------------------

router.post('/repos/:id/sync-all-nodes', async (req, res, next) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!repo) return res.status(404).json({ error: 'Repo niet gevonden' });

    await scheduleSyncForAllNodes(repo.id, 'sync');
    res.json({ ok: true, queued: true });
  } catch (err) {
    next(err);
  }
});

function isRepoLocal(repo) {
  try {
    return require('../../lib/git').isGitRepo(repo && repo.path);
  } catch {
    return false;
  }
}

module.exports = router;