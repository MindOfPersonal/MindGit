'use strict';

const { WebSocketServer } = require('ws');
const pool = require('../db');
const {
  hashNodeKey,
  getNodeByKeyHash,
  getNodeTokenForRepo,
  queueSyncTask,
  getNextQueueTask,
  claimQueueTask,
  completeQueueTask,
  updateNodeRepoStatus,
  updateNodeHeartbeat,
  setNodeOffline,
} = require('./node');
const { sendNotification } = require('./notify');
const { MessageType, createMessage, parseMessage } = require('../agent/lib/agent-protocol');
const { registerSecret } = require('../agent/src/redact');
const { NODE_SWEEP_INTERVAL_MS } = require('./constants');

const TASK_TIMEOUT_MS = 120000;

let io = null;
const nodeSockets = new Map();
const pendingTasks = new Map();

function setSocketIO(socketIO) {
  io = socketIO;
}

function getNodeSocket(nodeId) {
  return nodeSockets.get(nodeId);
}

// --- Raw WebSocket server voor agents --------------------------------------

function setupAgentWebSocket(server) {
  const agentWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/agent') return; // Socket.IO handelt /socket.io zelf af
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      agentWss.emit('connection', ws, req);
    });
  });

  agentWss.on('connection', (ws, req) => {
    handleAgentConnection(ws, req).catch((err) => {
      console.error('[AGENT WS] Connection error:', err.message);
      try { ws.close(1011, 'Internal error'); } catch { /* ignore */ }
    });
  });

  // Liveness-check: de agent beantwoordt een ping automatisch met pong.
  // Zonder deze check blijft een half-open verbinding (netwerkstoring, harde
  // crash) eindeloos "open" en lijkt de node online terwijl taken time-outen.
  const livenessTimer = setInterval(() => {
    for (const [nodeId, ws] of nodeSockets) {
      if (ws.isAlive === false) {
        console.warn(`[NODE] node ${nodeId} reageert niet op ping; verbinding wordt gesloten`);
        try { ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        try { ws.terminate(); } catch { /* ignore */ }
      }
    }
  }, NODE_SWEEP_INTERVAL_MS);
  if (typeof livenessTimer.unref === 'function') livenessTimer.unref();

  return agentWss;
}

function platformFromAgent(p) {
  if (!p) return 'unknown';
  const map = { win32: 'windows', darwin: 'macos', linux: 'linux' };
  return map[p] || p;
}

async function handleAgentConnection(ws, req) {
  const nodeKey = req.headers['x-node-key'];
  if (!nodeKey) {
    ws.close(4001, 'Node key required');
    return;
  }

  registerSecret(nodeKey);
  const nodeKeyHash = hashNodeKey(nodeKey);
  const node = await getNodeByKeyHash(pool, nodeKeyHash);
  if (!node) {
    ws.close(4001, 'Invalid node key');
    return;
  }

  nodeSockets.set(node.id, ws);
  ws.nodeId = node.id;
  ws.nodeKeyHash = nodeKeyHash;

  // Ping/pong-liveness: ws stuurt automatisch een pong terug op een ping.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const touch = () => updateNodeHeartbeat(pool, nodeKeyHash).catch(() => {});
  await touch();

  console.log(`[NODE] "${node.name}" (id ${node.id}) verbonden`);

  ws.on('message', (data) => {
    const msg = parseMessage(data);
    if (!msg) return;
    touch();
    handleAgentMessage(node, msg, ws).catch((err) => {
      console.error('[AGENT WS] Message handling error:', err.message);
    });
  });

  ws.on('close', () => {
    nodeSockets.delete(node.id);
    setNodeOffline(pool, node.id).catch(() => {});
    rejectPendingForNode(node.id);
    console.log(`[NODE] "${node.name}" (id ${node.id}) verbinding verbroken`);
  });

  ws.on('error', (err) => {
    console.error('[AGENT WS] Socket error:', err.message);
  });
}

async function handleAgentMessage(node, msg, ws) {
  const { type, payload, correlationId } = msg;

  switch (type) {
    case MessageType.AGENT_INFO:
      await updateNodeHeartbeat(pool, ws.nodeKeyHash, platformFromAgent(payload && payload.platform), payload && payload.gitVersion, {
        arch: payload && payload.arch,
        hostname: payload && payload.hostname,
        cwd: payload && payload.cwd,
        nodeVersion: payload && payload.nodeVersion,
      });
      ws.send(JSON.stringify(createMessage(MessageType.AGENT_INFO, { nodeId: node.id, name: node.name }, correlationId)));
      break;

    case MessageType.HEARTBEAT:
      // last_seen wordt al bijgewerkt via touch(); geen extra actie nodig
      break;

    case MessageType.TASK_STARTED:
    case MessageType.TASK_PROGRESS:
      if (io) io.to(`node-${node.id}`).emit('agent-task', { correlationId, type, ...(payload || {}) });
      break;

    case MessageType.CONFLICT_DETECTED:
      if (payload && payload.repoId) {
        await updateNodeRepoStatus(pool, node.id, payload.repoId, 'conflict', null).catch(() => {});
      }
      break;

    case MessageType.TASK_COMPLETED:
    case MessageType.TASK_FAILED:
      resolvePending(correlationId, { ...(payload || {}), ok: type === MessageType.TASK_COMPLETED });
      break;

    case MessageType.REPO_STATUS:
    case MessageType.BRANCHES_LIST:
    case MessageType.ERROR:
    default:
      if (io) io.to(`node-${node.id}`).emit('agent-event', { type, ...(payload || {}) });
  }
}

function resolvePending(correlationId, result) {
  const pending = pendingTasks.get(correlationId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingTasks.delete(correlationId);
  pending.resolve(result);
}

function rejectPendingForNode(nodeId) {
  const toReject = [];
  for (const [correlationId, pending] of pendingTasks.entries()) {
    if (pending.nodeId === nodeId) {
      toReject.push({ correlationId, pending });
    }
  }
  for (const { correlationId, pending } of toReject) {
    clearTimeout(pending.timeout);
    pendingTasks.delete(correlationId);
    pending.resolve({ success: false, error: 'Node disconnected' });
  }
}

function mapActionToMessageType(action) {
  switch (action) {
    case 'sync': return MessageType.SYNC_REPO;
    case 'clone': return MessageType.CLONE_REPO;
    case 'create': return MessageType.CREATE_REPO;
    case 'fetch': return MessageType.FETCH_REPO;
    case 'pull': return MessageType.PULL_REPO;
    case 'push': return MessageType.PUSH_REPO;
    default: return MessageType.SYNC_REPO;
  }
}

async function dispatchTaskToNode(nodeId, task) {
  const ws = getNodeSocket(nodeId);
  if (!ws) {
    return { success: false, error: 'Node not connected' };
  }

  const assignment = await getNodeTokenForRepo(pool, nodeId, task.repo_id);
  if (!assignment || !assignment.token) {
    return { success: false, error: 'No token available for repo' };
  }

  const correlationId = `task_${task.id}_${Date.now()}`;
  const messageType = mapActionToMessageType(task.action);
  const payload = {
    repoId: task.repo_id,
    repoName: assignment.repo.name,
    repoPath: assignment.repo.node_path || assignment.repo.path,
    remote: assignment.repo.remote,
    token: assignment.token,
    githubUser: assignment.githubUser,
    commitMessage: task.commit_message,
    action: task.action,
    syncDirection: assignment.repo.sync_direction || 'bidirectional',
  };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingTasks.delete(correlationId);
      resolve({ success: false, error: 'Task dispatch timeout' });
    }, TASK_TIMEOUT_MS);

    pendingTasks.set(correlationId, { resolve, timeout, nodeId });
    ws.send(JSON.stringify(createMessage(messageType, payload, correlationId)), (err) => {
      // Always clear timeout and cleanup on send error to prevent double-resolution
      clearTimeout(timeout);
      if (err) {
        pendingTasks.delete(correlationId);
        resolve({ success: false, error: 'Failed to send task to node' });
      }
      // Note: If send succeeds but no response comes, the timeout will cleanup
    });
  });
}

/**
 * Stuur een "query"-bericht (get_status, get_branches, switch_branch) naar een
 * node en wacht op het antwoord. Anders dan dispatchTaskToNode gaat dit niet via
 * de wachtrij maar direct, bedoeld voor dashboard-operaties op node-only repo's.
 */
function dispatchQueryToNode(nodeId, messageType, payload, timeoutMs) {
  const ws = getNodeSocket(nodeId);
  if (!ws) {
    return Promise.resolve({ success: false, error: 'Node not connected' });
  }

  const correlationId = `query_${messageType}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingTasks.delete(correlationId);
      resolve({ success: false, error: 'Node query timeout' });
    }, timeoutMs || 30000);

    pendingTasks.set(correlationId, { resolve, timeout, nodeId });
    ws.send(JSON.stringify(createMessage(messageType, payload, correlationId)), (err) => {
      if (err) {
        clearTimeout(timeout);
        pendingTasks.delete(correlationId);
        resolve({ success: false, error: 'Failed to send query to node' });
      }
    });
  });
}

async function processQueue() {
  try {
    const nodes = await pool.query('SELECT id FROM nodes WHERE status = ?', ['online']);
    for (const node of nodes) {
      const task = await getNextQueueTask(pool, node.id);
      if (!task) continue;

      const claimed = await claimQueueTask(pool, task.id, node.id);
      if (!claimed) continue;

      const [repo] = await pool.query('SELECT * FROM repos WHERE id = ?', [task.repo_id]);
      if (!repo) {
        await completeQueueTask(pool, task.id, node.id, false, { error: 'Repo not found' });
        continue;
      }

      const result = await dispatchTaskToNode(node.id, { ...task, repo });
      await completeQueueTask(pool, task.id, node.id, result.success, result);

      if (result.success && result.status) {
        await updateNodeRepoStatus(pool, node.id, repo.id, 'success', null);
        if (io) {
          io.to(`node-${node.id}`).emit('repo-status', { repoId: repo.id, ...result.status });
          io.to(`user-${repo.user_id}`).emit('node-repo-status', { nodeId: node.id, repoId: repo.id, ...result.status });
        }
      } else {
        await updateNodeRepoStatus(pool, node.id, repo.id, 'failed', result.error);
        await sendNotification(pool, repo.name, 'failed', `Node sync failed: ${result.error}`, repo.user_id);
        if (io) {
          io.to(`node-${node.id}`).emit('repo-error', { repoId: repo.id, error: result.error });
        }
      }
    }
  } catch (err) {
    console.error('[SYNC ORCHESTRATOR] Queue processing error:', err);
  }
}

async function scheduleSyncForNodeRepo(nodeId, repoId, action, commitMessage, priority) {
  await queueSyncTask(pool, nodeId, repoId, action || 'sync', commitMessage, priority);
}

async function scheduleCloneForNodeRepo(nodeId, repoId, priority) {
  await queueSyncTask(pool, nodeId, repoId, 'clone', null, priority);
}

async function scheduleCreateForNodeRepo(nodeId, repoId, priority) {
  await queueSyncTask(pool, nodeId, repoId, 'create', null, priority);
}

async function scheduleSyncForAllNodes(repoId, action, commitMessage) {
  const assignments = await pool.query(
    `SELECT nr.node_id FROM node_repos nr
     JOIN nodes n ON n.id = nr.node_id
     WHERE nr.repo_id = ? AND n.status = 'online'`,
    [repoId]
  );

  for (const { node_id } of assignments) {
    await queueSyncTask(pool, node_id, repoId, action, commitMessage, 5);
  }
}

async function triggerAutoSync() {
  const assignments = await pool.query(
    `SELECT nr.node_id, nr.repo_id FROM node_repos nr
     JOIN nodes n ON n.id = nr.node_id
     WHERE nr.auto_sync = 1 AND n.status = 'online'`
  );

  for (const { node_id, repo_id } of assignments) {
    await queueSyncTask(pool, node_id, repo_id, 'sync', null, 10);
  }
}

function broadcastToNode(nodeId, event, data) {
  const socket = getNodeSocket(nodeId);
  if (socket) socket.send(JSON.stringify(createMessage(MessageType[event] || event, data)));
}

function broadcastToUser(userId, event, data) {
  if (io) io.to(`user-${userId}`).emit(event, data);
}

function broadcastToRepoRoom(repoId, event, data) {
  if (io) io.to(`repo-${repoId}`).emit(event, data);
}

module.exports = {
  setSocketIO,
  setupAgentWebSocket,
  getNodeSocket,
  dispatchTaskToNode,
  dispatchQueryToNode,
  processQueue,
  scheduleSyncForNodeRepo,
  scheduleCloneForNodeRepo,
  scheduleCreateForNodeRepo,
  scheduleSyncForAllNodes,
  triggerAutoSync,
  broadcastToNode,
  broadcastToUser,
  broadcastToRepoRoom,
};