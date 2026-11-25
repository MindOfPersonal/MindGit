'use strict';

// Hulp-functies om repos die (alleen) op een node bestaan te beheren vanuit het
// dashboard. Een node-only repo heeft een pad (repos.path / node_repos.node_path)
// dat op de SERVER niet bestaat; alle git-operaties (status/sync/branches) moeten
// dan naar de node gaan i.p.v. lokaal op de server.

const { isGitRepo } = require('./git');
const { getNodeTokenForRepo } = require('./node');
const {
  MessageType,
  createStatusPayload,
  createBranchesPayload,
  createRepoDataPayload,
  createCommitPayload,
  createDiffPayload,
  createSwitchBranchPayload,
} = require('../agent/lib/agent-protocol');
const { dispatchQueryToNode } = require('./sync-orchestrator');

/** Bestaat deze repo als git-repo op de server zelf? */
function isRepoLocal(repo) {
  try {
    return isGitRepo(repo && repo.path);
  } catch {
    return false;
  }
}

/** Eerste online node waar deze repo aan is toegewezen, of null. */
async function getOnlineNodeForRepo(pool, repoId) {
  const rows = await pool.query(
    `SELECT nr.node_id
     FROM node_repos nr
     JOIN nodes n ON n.id = nr.node_id
     WHERE nr.repo_id = ? AND n.status = 'online'
     ORDER BY nr.last_synced DESC
     LIMIT 1`,
    [repoId]
  );
  return rows[0] ? rows[0].node_id : null;
}

/**
 * Repo-ids die alleen aan OFFLINE agents zijn toegewezen (en dus niet via een
 * online agent beheerd worden). Die komen op het dashboard in een aparte
 * "Agent Offline"-lijst i.p.v. in "Action Needed".
 */
async function getOfflineAgentRepoIds(pool, userId) {
  const offline = await pool.query(
    `SELECT DISTINCT nr.repo_id
     FROM node_repos nr
     JOIN nodes n ON n.id = nr.node_id
     WHERE n.user_id = ? AND n.status <> 'online'`,
    [userId]
  );
  const ids = new Set((offline || []).map((r) => r.repo_id));
  const online = await pool.query(
    `SELECT DISTINCT nr.repo_id
     FROM node_repos nr
     JOIN nodes n ON n.id = nr.node_id
     WHERE n.user_id = ? AND n.status = 'online'`,
    [userId]
  );
  for (const r of online || []) ids.delete(r.repo_id);
  return ids;
}

/** Retry voor read-only node-queries (tijdens een lopende sync kan een node even "busy" zijn). */
async function withNodeRetry(fn, attempts = 4, delayMs = 800) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (last && last.success) return last;
    const err = last && last.error;
    if (err && err !== 'Agent busy with another task' && err !== 'Node query timeout' && err !== 'Node not connected') {
      return last;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

/** Zet een node-status om naar hetzelfde formaat als getRepoStatus (server-lokaal). */
function mapNodeStatus(s) {
  if (!s) return null;
  let color = 'green', icon = '\u2713';
  if (s.status === 'no-git') { color = 'red'; icon = '!'; }
  else if (s.changes > 0 && s.behindCount > 0) { color = 'orange'; icon = '\u21C5'; }
  else if (s.changes > 0) { color = 'yellow'; icon = '\u2191'; }
  else if (s.behindCount > 0) { color = 'cyan'; icon = '\u2193'; }
  return {
    status: s.status,
    icon,
    color,
    changes: s.changes || 0,
    behindCount: s.behindCount || 0,
    aheadCount: s.aheadCount || 0,
    branch: s.branch || '',
    remote: s.remote || '',
  };
}

/** Haal de git-status van een repo op via een online node (of een neutrale status als dat niet kan). */
async function nodeRepoStatus(pool, repoId) {
  const nodeId = await getOnlineNodeForRepo(pool, repoId);
  if (!nodeId) {
    return { status: 'node-offline', icon: '?', color: 'gray', changes: 0, behindCount: 0, aheadCount: 0, branch: '', remote: '' };
  }
  const t = await getNodeTokenForRepo(pool, nodeId, repoId);
  if (!t || !t.token) {
    return { status: 'node-unknown', icon: '?', color: 'gray', changes: 0, behindCount: 0, aheadCount: 0, branch: '', remote: '' };
  }
  const payload = createStatusPayload({
    id: repoId,
    path: t.repo.node_path || t.repo.path,
    remote: t.repo.remote,
  }, t.token);
  const res = await withNodeRetry(() => dispatchQueryToNode(nodeId, MessageType.GET_STATUS, payload));
  if (!res.success || !res.status) {
    return { status: 'node-unknown', icon: '?', color: 'gray', changes: 0, behindCount: 0, aheadCount: 0, branch: '', remote: '' };
  }
  return mapNodeStatus(res.status);
}

/**
 * Haal de volledige git-data (status, gewijzigde bestanden, commit-log) van een
 * node-only repo op. Vorm is identiek aan lib/git.js getRepoData(Async).
 */
async function nodeRepoData(pool, repoId) {
  const empty = { gitStatus: '', changedFiles: '', logEntries: '' };
  const nodeId = await getOnlineNodeForRepo(pool, repoId);
  if (!nodeId) return empty;
  const t = await getNodeTokenForRepo(pool, nodeId, repoId);
  if (!t || !t.token) return empty;
  const payload = createRepoDataPayload({
    id: repoId,
    path: t.repo.node_path || t.repo.path,
  }, t.token);
  const res = await withNodeRetry(() => dispatchQueryToNode(nodeId, MessageType.GET_REPO_DATA, payload));
  if (!res.success || !res.gitData) return empty;
  return {
    gitStatus: res.gitData.gitStatus || '',
    changedFiles: res.gitData.changedFiles || '',
    logEntries: res.gitData.logEntries || '',
  };
}

/** Haal commit-details van een node-only repo op. */
async function nodeRepoCommit(pool, repoId, commit) {
  const nodeId = await getOnlineNodeForRepo(pool, repoId);
  if (!nodeId) return null;
  const t = await getNodeTokenForRepo(pool, nodeId, repoId);
  if (!t || !t.token) return null;
  const payload = createCommitPayload({
    id: repoId,
    path: t.repo.node_path || t.repo.path,
  }, t.token, commit);
  const res = await dispatchQueryToNode(nodeId, MessageType.GET_COMMIT, payload);
  if (!res.success || !res.commit) return null;
  return res.commit;
}

/** Haal de diff van één bestand van een node-only repo op. */
async function nodeRepoDiff(pool, repoId, file) {
  const nodeId = await getOnlineNodeForRepo(pool, repoId);
  if (!nodeId) return null;
  const t = await getNodeTokenForRepo(pool, nodeId, repoId);
  if (!t || !t.token) return null;
  const payload = createDiffPayload({
    id: repoId,
    path: t.repo.node_path || t.repo.path,
  }, t.token, file);
  const res = await dispatchQueryToNode(nodeId, MessageType.GET_DIFF, payload);
  if (!res.success) return null;
  return res.diff || '';
}

/** Haal de branch-lijst van een repo op via een online node. */
async function nodeRepoBranches(pool, repoId) {
  const nodeId = await getOnlineNodeForRepo(pool, repoId);
  if (!nodeId) return { branches: [], current: '' };
  const t = await getNodeTokenForRepo(pool, nodeId, repoId);
  if (!t || !t.token) return { branches: [], current: '' };
  const payload = createBranchesPayload({
    id: repoId,
    path: t.repo.node_path || t.repo.path,
  }, t.token);
  const res = await withNodeRetry(() => dispatchQueryToNode(nodeId, MessageType.GET_BRANCHES, payload));
  if (!res.success) return { branches: [], current: '' };
  return { branches: res.branches || [], current: res.current || '' };
}

/** Wissel van branch op een online node. */
async function nodeSwitchBranch(pool, repoId, branch) {
  const nodeId = await getOnlineNodeForRepo(pool, repoId);
  if (!nodeId) return null;
  const t = await getNodeTokenForRepo(pool, nodeId, repoId);
  if (!t || !t.token) return null;
  const payload = createSwitchBranchPayload({
    id: repoId,
    path: t.repo.node_path || t.repo.path,
  }, t.token, branch);
  const res = await dispatchQueryToNode(nodeId, MessageType.SWITCH_BRANCH, payload);
  if (!res.success) return null;
  return { ok: true, current: res.current || branch };
}

module.exports = {
  isRepoLocal,
  getOnlineNodeForRepo,
  getOfflineAgentRepoIds,
  nodeRepoStatus,
  nodeRepoData,
  nodeRepoCommit,
  nodeRepoDiff,
  nodeRepoBranches,
  nodeSwitchBranch,
};