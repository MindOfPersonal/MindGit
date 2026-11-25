'use strict';

/**
 * Main dashboard routes
 * Handles: dashboard home, repos list, refresh, status updates
 */

const express = require('express');
const pool = require('../../db');
const { BROWSE_ROOTS, isWithinRoots } = require('../../lib/paths');
const { getRepoStatusWithNode } = require('../../lib/repo-helpers');
const { getTagsForRepos, getSavedFilters } = require('../../lib/repo-meta');
const { getOfflineAgentRepoIds } = require('../../lib/node-repo');

const router = express.Router();

// --- Dashboard Home ---------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const [repos, accounts, accountsById] = await Promise.all([
      pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]),
      listAccountsMeta(pool, req.session.user.id),
      (async () => {
        const accounts = await listAccountsMeta(pool, req.session.user.id);
        return new Map(accounts.map((a) => [a.id, a]));
      })(),
    ]);

    const offlineAgentRepoIds = await getOfflineAgentRepoIds(pool, req.session.user.id);
    const tagsByRepo = await getTagsForRepos(pool, repos.map((r) => r.id));
    const savedFilters = await getSavedFilters(pool, req.session.user.id);

    const enriched = await Promise.all(repos.map(async (r) => {
      const st = await getRepoStatusWithNode(pool, r, { skipFetch: true });
      const account = r.account_id ? accountsById.get(r.account_id) : null;
      return { ...r, ...st, account, tags: tagsByRepo.get(r.id) || [], agentOffline: offlineAgentRepoIds.has(r.id) };
    }));

    res.render('dashboard', { repos: enriched, token: '', accounts, tagList: [], savedFilters });
  } catch (err) {
    next(err);
  }
});

// --- Refresh Status ---------------------------------------------------------

const refreshCache = new Map();
const { GIT_FETCH_INTERVAL } = require('../../lib/constants');

router.get('/refresh', async (req, res, next) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Niet ingelogd.', needsLogin: true });
    }

    const cacheKey = `refresh_${req.session.user.id}`;
    const cached = refreshCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.time < GIT_FETCH_INTERVAL) {
      return res.json({ repos: cached.data, fromCache: true });
    }

    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]);
    const accounts = await listAccountsMeta(pool, req.session.user.id);
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    const offlineAgentRepoIds = await getOfflineAgentRepoIds(pool, req.session.user.id);
    const tagsByRepo = await getTagsForRepos(pool, repos.map((r) => r.id));

    // Import here to avoid circular dependency
    const { getRepoStatusAsync, getRepoDataAsync } = require('../../lib/git');
    const { repoStatusWithNode } = require('../../lib/node-repo');

    const enriched = await Promise.all(repos.map(async (r) => {
      const st = await repoStatusWithNode(pool, r);
      const account = r.account_id ? accountsById.get(r.account_id) : null;
      return {
        id: r.id, name: r.name, path: r.path, remote: r.remote, group_name: r.group_name || '',
        account,
        favorite: !!r.favorite,
        tags: tagsByRepo.get(r.id) || [],
        agentOffline: offlineAgentRepoIds.has(r.id),
        status: st.status, color: st.color, changes: st.changes, behindCount: st.behindCount,
        aheadCount: st.aheadCount, branch: st.branch, fetchedAt: st.fetchedAt || null,
      };
    }));

    refreshCache.set(cacheKey, { data: enriched, time: now });
    res.json({ repos: enriched, fromCache: false });
  } catch (err) {
    next(err);
  }
});

// --- Helper functions ---

async function listAccountsMeta(pool, userId) {
  const rows = await pool.query(
    'SELECT id, label, github_user, is_default, created_at FROM github_accounts WHERE user_id = ? ORDER BY is_default DESC, id ASC',
    [userId]
  );
  return rows || [];
}

module.exports = router;