'use strict';

/**
 * Shared repository helper functions
 * Extracted from routes/repos.js for reusability and maintainability
 */

const { getRepoStatusWithNode } = require('./node-repo');
const { getRepoToken } = require('./settings');
const { getRepoStatusAsync, getRepoDataAsync } = require('./git');
const { getTagsForRepos, getSavedFilters } = require('./repo-meta');
const { getOfflineAgentRepoIds } = require('./node-repo');

/**
 * Get comprehensive repo status, with node fallback for node-only repos
 */
async function getRepoStatusWithNode(pool, repo, opts = {}) {
  const { skipFetch = false } = opts;
  
  if (!isRepoLocal(repo)) {
    const st = await require('./node-repo').nodeRepoStatus(pool, repo.id);
    if (st) return st;
  }
  
  const { token } = await getRepoToken(pool, repo);
  return getRepoStatusAsync(repo.path, token, { skipFetch });
}

/**
 * Check if repo exists locally (on the server)
 */
function isRepoLocal(repo) {
  try {
    return require('./git').isGitRepo(repo && repo.path);
  } catch {
    return false;
  }
}

/**
 * Enrich repos with status, tags, account info
 */
async function enrichRepos(pool, repos, userId) {
  const accounts = await listAccountsMeta(pool, userId);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const offlineAgentRepoIds = await getOfflineAgentRepoIds(pool, userId);
  const tagsByRepo = await getTagsForRepos(pool, repos.map((r) => r.id));
  const savedFilters = await getSavedFilters(pool, userId);

  return repos.map(async (r) => {
    const st = await getRepoStatusWithNode(pool, r, { skipFetch: true });
    const account = r.account_id ? accountsById.get(r.account_id) : null;
    return {
      ...r,
      ...st,
      account,
      tags: tagsByRepo.get(r.id) || [],
      agentOffline: offlineAgentRepoIds.has(r.id),
    };
  });
}

/**
 * Build enriched repo response for API
 */
async function buildRepoResponse(pool, repo, userId) {
  const status = await getRepoStatusWithNode(pool, repo);
  const data = isRepoLocal(repo) 
    ? await getRepoDataAsync(repo.path) 
    : await require('./node-repo').nodeRepoData(pool, repo.id);
  const tags = await getTagsForRepos(pool, [repo.id]);

  return {
    ...repo,
    ...status,
    changes: status.changes,
    behind_count: status.behindCount,
    ahead_count: status.aheadCount,
    branch: status.branch,
    gitData: data,
    tags: tags.get(repo.id) || [],
  };
}

async function listAccountsMeta(pool, userId) {
  const rows = await pool.query(
    'SELECT id, label, github_user, is_default, created_at FROM github_accounts WHERE user_id = ? ORDER BY is_default DESC, id ASC',
    [userId]
  );
  return rows || [];
}

module.exports = {
  getRepoStatusWithNode,
  isRepoLocal,
  enrichRepos,
  buildRepoResponse,
  listAccountsMeta,
};