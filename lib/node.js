'use strict';

const crypto = require('crypto');
const { encrypt, decrypt } = require('./crypto');
const { getRepoToken } = require('./settings');
const { logSync } = require('./db-helpers');

function hashNodeKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateNodeKey() {
  return crypto.randomBytes(32).toString('hex');
}

async function createNode(pool, userId, name, platform) {
  const nodeKey = generateNodeKey();
  const nodeKeyHash = hashNodeKey(nodeKey);

  const res = await pool.query(
    `INSERT INTO nodes (user_id, name, node_key_hash, platform)
     VALUES (?, ?, ?, ?)`,
    [userId, name, nodeKeyHash, platform || 'unknown']
  );

  const nodeId = res.insertId;
  return { id: nodeId, name, nodeKey, platform: platform || 'unknown' };
}

async function listNodes(pool, userId) {
  const rows = await pool.query(
`SELECT id, name, platform, default_path, git_version, capabilities, last_seen, status, created_at
    FROM nodes WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
  return rows || [];
}

async function getNode(pool, nodeId, userId) {
  const [node] = await pool.query(
    `SELECT id, user_id, name, platform, default_path, git_version, capabilities, last_seen, status, created_at
     FROM nodes WHERE id = ? AND user_id = ?`,
    [nodeId, userId]
  );
  return node || null;
}

async function getNodeByKeyHash(pool, nodeKeyHash) {
  const [node] = await pool.query(
    `SELECT id, user_id, name, platform, default_path, git_version, capabilities, last_seen, status
     FROM nodes WHERE node_key_hash = ?`,
    [nodeKeyHash]
  );
  return node || null;
}

async function updateNode(pool, nodeId, userId, fields) {
  const allowed = ['name', 'platform', 'git_version', 'capabilities', 'default_path'];
  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (updates.length === 0) return getNode(pool, nodeId, userId);

  try {
    values.push(nodeId, userId);
    await pool.query(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, values);
    return getNode(pool, nodeId, userId);
  } catch (err) {
    console.error('Failed to update node:', err);
    return getNode(pool, nodeId, userId);
  }
}

async function deleteNode(pool, nodeId, userId) {
  const res = await pool.query('DELETE FROM nodes WHERE id = ? AND user_id = ?', [nodeId, userId]);
  return res.affectedRows > 0;
}

async function updateNodeHeartbeat(pool, nodeKeyHash, platform, gitVersion, capabilities) {
  const updateFields = {
    last_seen: new Date(),
    status: 'online'
  };
  if (platform) updateFields.platform = platform;
  if (gitVersion) updateFields.git_version = gitVersion;
  if (capabilities) updateFields.capabilities = JSON.stringify(capabilities);

  const updates = Object.keys(updateFields).map(k => `${k} = ?`);
  const values = Object.values(updateFields);
  values.push(nodeKeyHash);

  await pool.query(`UPDATE nodes SET ${updates.join(', ')} WHERE node_key_hash = ?`, values);
}

async function setNodeOffline(pool, nodeId) {
  await pool.query('UPDATE nodes SET status = ? WHERE id = ?', ['offline', nodeId]);
}

/**
 * Zet bij serverstart alle nodes op offline. De WebSocket-verbindingen zijn na
 * een herstart immers weg, terwijl de status in de database op 'online' kan
 * zijn blijven staan. Zonder deze reset probeert de dispatcher taken te sturen
 * naar nodes die niet verbonden zijn.
 */
async function resetAllNodesOffline(pool) {
  const res = await pool.query("UPDATE nodes SET status = 'offline' WHERE status <> 'offline'");
  return res.affectedRows || 0;
}

/**
 * Vangnet voor half-open verbindingen: nodes die na een netwerkstoring of
 * harde crash geen heartbeat meer sturen, worden na `maxAgeSeconds` offline
 * gezet. Dit draait naast de WS ping/pong-livenesscheck.
 */
async function sweepStaleNodes(pool, maxAgeSeconds) {
  const seconds = Number(maxAgeSeconds) > 0 ? Number(maxAgeSeconds) : 90;
  const cutoff = new Date(Date.now() - seconds * 1000);
  const res = await pool.query(
    "UPDATE nodes SET status = 'offline' WHERE status = 'online' AND (last_seen IS NULL OR last_seen < ?)",
    [cutoff]
  );
  return res.affectedRows || 0;
}

async function assignRepoToNode(pool, nodeId, repoId, syncDirection, autoSync, nodePath) {
  await pool.query(
    `INSERT INTO node_repos (node_id, repo_id, sync_direction, auto_sync, node_path)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE sync_direction = VALUES(sync_direction), auto_sync = VALUES(auto_sync), node_path = VALUES(node_path)`,
    [nodeId, repoId, syncDirection || 'bidirectional', autoSync ? 1 : 0, nodePath || null]
  );
}

async function getNodeAssignment(pool, nodeId, repoId) {
  const [assignment] = await pool.query(
    `SELECT nr.*, r.name, r.path, r.remote, r.account_id, r.group_name, r.user_id
     FROM node_repos nr
     JOIN repos r ON r.id = nr.repo_id
     WHERE nr.node_id = ? AND nr.repo_id = ?`,
    [nodeId, repoId]
  );
  return assignment || null;
}

async function unassignRepoFromNode(pool, nodeId, repoId) {
  await pool.query('DELETE FROM node_repos WHERE node_id = ? AND repo_id = ?', [nodeId, repoId]);
}

async function getNodeRepos(pool, nodeId) {
  const rows = await pool.query(
    `SELECT nr.*, r.name, r.path, r.remote, r.account_id, r.group_name
     FROM node_repos nr
     JOIN repos r ON r.id = nr.repo_id
     WHERE nr.node_id = ?`,
    [nodeId]
  );
  return rows || [];
}

async function getRepoNodes(pool, repoId) {
  const rows = await pool.query(
    `SELECT nr.*, n.name, n.platform, n.status, n.last_seen
     FROM node_repos nr
     JOIN nodes n ON n.id = nr.node_id
     WHERE nr.repo_id = ?`,
    [repoId]
  );
  return rows || [];
}

async function getUserNodeAssignments(pool, userId) {
  const rows = await pool.query(
    `SELECT nr.node_id, nr.repo_id, nr.sync_direction, nr.auto_sync, nr.last_synced, nr.last_status, nr.last_error,
            n.name as node_name, n.platform, n.status as node_status,
            r.name as repo_name, r.path, r.remote, r.account_id
     FROM node_repos nr
     JOIN nodes n ON n.id = nr.node_id
     JOIN repos r ON r.id = nr.repo_id
     WHERE n.user_id = ? AND r.user_id = ?
     ORDER BY n.name, r.name`,
    [userId, userId]
  );
  return rows || [];
}

async function updateNodeRepoStatus(pool, nodeId, repoId, status, error) {
  try {
    const fields = ['last_synced = NOW()', 'last_status = ?'];
    const values = [status];
    if (error !== undefined) {
      fields.push('last_error = ?');
      values.push(error);
    }
    values.push(nodeId, repoId);
    await pool.query(`UPDATE node_repos SET ${fields.join(', ')} WHERE node_id = ? AND repo_id = ?`, values);
  } catch (err) {
    console.error('Failed to update node repo status:', err);
  }
}

async function queueSyncTask(pool, nodeId, repoId, action, commitMessage, priority) {
  try {
    await pool.query(
      `INSERT INTO node_sync_queue (node_id, repo_id, action, commit_message, priority)
       VALUES (?, ?, ?, ?, ?)`,
      [nodeId, repoId, action || 'sync', commitMessage || null, priority || 5]
    );
  } catch (err) {
    console.error('Failed to queue sync task:', err);
    throw err;
  }
}

async function getNextQueueTask(pool, nodeId) {
  const [task] = await pool.query(
    `SELECT * FROM node_sync_queue
     WHERE node_id = ? AND status = 'queued'
     ORDER BY priority ASC, created_at ASC
     LIMIT 1`,
    [nodeId]
  );
  return task || null;
}

async function claimQueueTask(pool, taskId, nodeId) {
  const res = await pool.query(
    `UPDATE node_sync_queue
     SET status = 'running', started_at = NOW()
     WHERE id = ? AND node_id = ? AND status = 'queued'`,
    [taskId, nodeId]
  );
  return res.affectedRows > 0;
}

async function completeQueueTask(pool, taskId, nodeId, success, result) {
  await pool.query(
    `UPDATE node_sync_queue
     SET status = ?, completed_at = NOW(), result = ?
     WHERE id = ? AND node_id = ?`,
    [success ? 'done' : 'failed', JSON.stringify(result || {}), taskId, nodeId]
  );
}

async function getNodeTokenForRepo(pool, nodeId, repoId) {
  const assignment = await getNodeAssignment(pool, nodeId, repoId);
  if (!assignment) return null;

  const { token, githubUser } = await getRepoToken(pool, assignment);
  return { token, githubUser, repo: assignment };
}

module.exports = {
  hashNodeKey,
  generateNodeKey,
  createNode,
  listNodes,
  getNode,
  getNodeByKeyHash,
  updateNode,
  deleteNode,
  updateNodeHeartbeat,
  setNodeOffline,
  resetAllNodesOffline,
  sweepStaleNodes,
  assignRepoToNode,
  unassignRepoFromNode,
  getNodeAssignment,
  getNodeRepos,
  getRepoNodes,
  getUserNodeAssignments,
  updateNodeRepoStatus,
  queueSyncTask,
  getNextQueueTask,
  claimQueueTask,
  completeQueueTask,
  getNodeTokenForRepo,
};