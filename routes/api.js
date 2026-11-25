'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { encrypt, decrypt } = require('../lib/crypto');
const { BROWSE_ROOTS, isWithinRoots } = require('../lib/paths');
const {
  isGitRepo,
  getBranchAsync,
  getRepoStatusAsync,
  getRepoDataAsync,
  syncRepo,
  gitAsync,
  listBranches,
  switchBranch,
  resolveConflict,
  createBranch,
  deleteBranch,
  renameBranch,
} = require('../lib/git');
const { getUserGitHub, setUserGitHub, listAccountsMeta, addAccount, updateAccount, deleteAccount, setDefaultAccount, getDefaultAccount, getAccount, getRepoToken, detectAccountForRemote } = require('../lib/settings');
const { langList, isSupportedLang, DEFAULT_LANG } = require('../lib/i18n');
const { apiRequest } = require('../lib/github-api');
const { logSync } = require('../lib/db-helpers');
const { GIT_LONG_TIMEOUT } = require('../lib/constants');
const { isRepoLocal, getOnlineNodeForRepo, nodeRepoStatus, nodeRepoData, nodeRepoBranches, nodeSwitchBranch } = require('../lib/node-repo');
const {
  hashNodeKey,
  generateNodeKey,
  createNode,
  listNodes,
  getNode,
  updateNode,
  deleteNode,
  assignRepoToNode,
  unassignRepoFromNode,
  getNodeRepos,
  getRepoNodes,
  getNodeAssignment,
  getUserNodeAssignments,
  getNodeTokenForRepo,
  queueSyncTask,
  getNodeByKeyHash,
  updateNodeHeartbeat,
} = require('../lib/node');
const { scheduleSyncForNodeRepo, scheduleCloneForNodeRepo, scheduleCreateForNodeRepo, scheduleSyncForAllNodes } = require('../lib/sync-orchestrator');

const router = express.Router();

// Rate limiting for API endpoints to prevent abuse
const apiLimiter = require('express-rate-limit')({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // limit each IP to 60 requests per windowMs
  message: 'Te veel requests vanaf dit IP, probeer later opnieuw.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Token-gebaseerde auth voor desktop/mobiel (geen CORS/SameSite issues).
// Tokens worden gehashed (sha256) opgeslagen in de `api_tokens` tabel zodat
// ze server-restarts overleven. Alleen de hash wordt opgeslagen, nooit het token zelf.
const crypto = require('crypto');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function getTokenUser(req) {
  if (req.session?.user) return req.session.user;
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const hash = hashToken(match[1]);
  try {
    const now = Date.now();
    const rows = await pool.query(
      'SELECT u.id, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND (t.expires_at IS NULL OR t.expires_at > ?)',
      [hash, now]
    );
    return rows && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

function apiOk(data) {
  return { success: true, data };
}

function apiErr(message, code) {
  return { success: false, error: message, code: code || 'ERROR' };
}

const isApiAuth = async (req, res, next) => {
  try {
    const user = await getTokenUser(req);
    if (!user) {
      return res.status(401).json(apiErr('Niet ingelogd.', 'UNAUTHORIZED'));
    }
    req.sessionUser = user;
    next();
  } catch {
    return res.status(500).json(apiErr('Auth mislukt.', 'SERVER_ERROR'));
  }
};

function defaultServerRepoRoot() {
  return BROWSE_ROOTS[0] || path.resolve('.');
}

function serverRepoPath(username, repoName) {
  return path.resolve(path.join(defaultServerRepoRoot(), 'MindGitRepos', username, repoName));
}

// --- Auth ---------------------------------------------------------------

router.post('/auth/login', apiLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json(apiErr('Gebruikersnaam en wachtwoord zijn verplicht.', 'MISSING_CREDENTIALS'));
  }

  try {
    const rows = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows && rows.length ? rows[0] : null;

    const dummyHash = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8.5z6J1l4n9QjQ4nQ4nQ4nQ4nQ4nQ';
    const valid = user ? await bcrypt.compare(password, user.password) : await bcrypt.compare(password, dummyHash);

    if (!user || !valid) {
      return res.status(401).json(apiErr('Ongeldige inloggegevens.', 'INVALID_CREDENTIALS'));
    }

    req.session.user = { id: user.id, username: user.username };
    req.sessionUser = req.session.user;
    const token = crypto.randomBytes(32).toString('hex');
    const tokenTtlMs = parseInt(process.env.API_TOKEN_TTL_MS || '604800000', 10); // default 7 dagen
    const expiresAt = tokenTtlMs > 0 ? Date.now() + tokenTtlMs : null;
    await pool.query(
      'INSERT INTO api_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), expires_at = VALUES(expires_at)',
      [hashToken(token), user.id, expiresAt]
    );
    return res.json(apiOk({ id: user.id, username: user.username, token, expires_at: expiresAt }));
  } catch (err) {
    console.error('API login error:', err);
    return res.status(500).json(apiErr('Inloggen mislukt.', 'SERVER_ERROR'));
  }
});

router.post('/auth/logout', isApiAuth, async (req, res) => {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) {
    try { await pool.query('DELETE FROM api_tokens WHERE token_hash = ?', [hashToken(match[1])]); } catch {}
  }

  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json(apiOk(null));
  });
});

router.get('/auth/me', isApiAuth, (req, res) => {
  res.json(apiOk({ id: req.sessionUser.id, username: req.sessionUser.username }));
});

// --- Repos --------------------------------------------------------------

// Status voor een repo: node-only repo's (pad bestaat niet op de server) halen
// hun status bij een online node, de rest lokaal zoals voorheen.
async function apiRepoStatus(pool, repo) {
  if (!isRepoLocal(repo)) {
    const st = await nodeRepoStatus(pool, repo.id);
    if (st) return st;
  }
  const { token } = await getRepoToken(pool, repo);
  return getRepoStatusAsync(repo.path, token);
}

router.get('/repos', isApiAuth, async (req, res) => {
  try {
    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.sessionUser.id]);
    const data = [];
    for (const r of repos) {
      const status = await apiRepoStatus(pool, r);
      data.push({
        ...r,
        ...status,
        changes: status.changes,
        behind_count: status.behindCount,
        ahead_count: status.aheadCount,
        branch: status.branch,
        gitData: isRepoLocal(r) ? await getRepoDataAsync(r.path) : { gitStatus: '', changedFiles: '', logEntries: '' },
      });
    }
    res.json(apiOk(data));
  } catch (err) {
    res.status(500).json(apiErr('Kan repositories niet ophalen.', 'SERVER_ERROR'));
  }
});

router.get('/repos/:id', isApiAuth, async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    const status = await apiRepoStatus(pool, repo);
    const data = isRepoLocal(repo) ? await getRepoDataAsync(repo.path) : await nodeRepoData(pool, repo.id);
    const logs = await pool.query(
      'SELECT * FROM sync_logs WHERE repo_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );

    res.json(apiOk({
      ...repo,
      ...status,
      changes: status.changes,
      behind_count: status.behindCount,
      ahead_count: status.aheadCount,
      branch: status.branch,
      gitData: data,
      logs,
    }));
  } catch (err) {
    res.status(500).json(apiErr('Kan repository niet ophalen.', 'SERVER_ERROR'));
  }
});

router.get('/repos/:id/status', isApiAuth, async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    const status = await apiRepoStatus(pool, repo);

    res.json(apiOk({
      is_git_repo: status.status !== 'no-git',
      branch: status.branch || '',
      changes: status.changes || 0,
      has_uncommitted: (status.changes || 0) > 0,
      ahead: status.aheadCount || 0,
      behind: status.behindCount || 0,
      status_text: status.statusText || '',
    }));
  } catch (err) {
    res.status(500).json(apiErr('Kan status niet ophalen.', 'SERVER_ERROR'));
  }
});

router.post('/repos', isApiAuth, async (req, res) => {
  const { name, path: localPath, remote, groupName, accountId } = req.body;

  if (!name || !localPath) {
    return res.status(400).json(apiErr('Naam en pad zijn verplicht.', 'MISSING_FIELDS'));
  }

  try {
    const absolutePath = path.resolve(localPath);

    if (!fs.existsSync(absolutePath)) {
      return res.status(400).json(apiErr('Lokaal pad bestaat niet op de server.', 'PATH_NOT_FOUND'));
    }

    if (!isWithinRoots(absolutePath, BROWSE_ROOTS)) {
      return res.status(403).json(apiErr('Pad valt buiten de toegestane mappen.', 'PATH_NOT_ALLOWED'));
    }

    if (!isGitRepo(absolutePath)) {
      await gitAsync('init', absolutePath);
      await gitAsync(['config', 'user.email', 'mindframework@auto.sync'], absolutePath);
      await gitAsync(['config', 'user.name', 'MindFramework Auto-Sync'], absolutePath);
    }

    let remoteShort = '';
    if (remote) {
      remoteShort = remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
      const existingRemote = await gitAsync('remote get-url origin', absolutePath);
      const remoteUrl = `https://github.com/${remoteShort}.git`;
      if (existingRemote) await gitAsync(['remote', 'remove', 'origin'], absolutePath);
      await gitAsync(['remote', 'add', 'origin', remoteUrl], absolutePath);
    }

    let account_id_for_repo = accountId ? parseInt(accountId, 10) : null;
    if (!account_id_for_repo && remoteShort) {
      const detected = await detectAccountForRemote(pool, req.sessionUser.id, remoteShort);
      if (detected) account_id_for_repo = detected.id;
    }
    if (!account_id_for_repo) {
      const def = await getDefaultAccount(pool, req.sessionUser.id);
      if (def) account_id_for_repo = def.id;
    }
    if (!account_id_for_repo) account_id_for_repo = null; // voorkom account_id=0 (FK-violatie)

    await pool.query(
      'INSERT INTO repos (user_id, account_id, name, path, remote, group_name) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), remote=VALUES(remote), group_name=VALUES(group_name), account_id=VALUES(account_id)',
      [req.sessionUser.id, account_id_for_repo, name, absolutePath, remoteShort, groupName || '']
    );

    res.json(apiOk({ name, path: absolutePath, remote: remoteShort, group_name: groupName || '', account_id: account_id_for_repo }));
  } catch (err) {
    console.error('API add repo error:', err);
    res.status(500).json(apiErr('Kan repository niet toevoegen.', 'SERVER_ERROR'));
  }
});

router.post('/repos/create', isApiAuth, async (req, res) => {
  const { repoName, description, isPrivate, groupName, accountId } = req.body;

  if (!repoName) {
    return res.status(400).json(apiErr('Repository naam is verplicht.', 'MISSING_FIELDS'));
  }

  try {
    let token, githubUser, account_id_for_repo = null;

    if (accountId) {
      const acc = await getAccount(pool, parseInt(accountId, 10), req.sessionUser.id);
      if (!acc || !acc.token) {
        return res.status(400).json(apiErr('Geselecteerd GitHub account is ongeldig.', 'INVALID_ACCOUNT'));
      }
      token = acc.token;
      githubUser = acc.githubUser;
      account_id_for_repo = acc.id;
    } else {
      const def = await getDefaultAccount(pool, req.sessionUser.id);
      if (def) {
        token = def.token;
        githubUser = def.githubUser;
        account_id_for_repo = def.id;
      } else {
        const legacy = await getUserGitHub(pool, req.sessionUser.id);
        token = legacy.token;
        githubUser = legacy.githubUser;
      }
    }

    if (!token || !githubUser) {
      return res.status(400).json(apiErr('Stel eerst een GitHub account in.', 'MISSING_SETTINGS'));
    }

    const created = await apiRequest('POST', '/user/repos', token, {
      name: repoName,
      description: description || `Repo: ${repoName}`,
      private: !!isPrivate,
    });

    const remoteShort = `${githubUser}/${repoName}`;
    const absolutePath = serverRepoPath(req.sessionUser.username, repoName);

    if (!isWithinRoots(absolutePath, BROWSE_ROOTS)) {
      return res.status(403).json(apiErr('Doelpad valt buiten de toegestane mappen.', 'PATH_NOT_ALLOWED'));
    }

    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(absolutePath, { recursive: true });
    }

    const remoteUrl = `https://github.com/${remoteShort}.git`;

    if (!isGitRepo(absolutePath)) {
      await gitAsync('init', absolutePath);
      await gitAsync(['config', 'user.email', 'mindframework@auto.sync'], absolutePath);
      await gitAsync(['config', 'user.name', 'MindFramework Auto-Sync'], absolutePath);
      await gitAsync(['remote', 'add', 'origin', remoteUrl], absolutePath);

      const files = fs.readdirSync(absolutePath).filter((f) => !f.startsWith('.'));
      if (files.length === 0) {
        fs.writeFileSync(path.join(absolutePath, 'README.md'), `# ${repoName}\n\n${description || ''}\n`);
      }
      await gitAsync(['add', '-A'], absolutePath);
      await gitAsync(['commit', '-m', 'Initial commit'], absolutePath);
    } else {
      const existing = await gitAsync('remote get-url origin', absolutePath);
      if (!existing || !existing.includes('github.com')) {
        if (existing) await gitAsync(['remote', 'remove', 'origin'], absolutePath);
        await gitAsync(['remote', 'add', 'origin', remoteUrl], absolutePath);
      }
    }

    const branch = await getBranchAsync(absolutePath);
    await gitAsync(['push', '-u', 'origin', branch], absolutePath, GIT_LONG_TIMEOUT, { token });

    await pool.query(
      'INSERT INTO repos (user_id, account_id, name, path, remote, group_name) VALUES (?, ?, ?, ?, ?, ?)',
      [req.sessionUser.id, account_id_for_repo, repoName, absolutePath, remoteShort, groupName || '']
    );

    const [repo] = await pool.query('SELECT * FROM repos WHERE user_id = ? AND remote = ?', [req.sessionUser.id, remoteShort]);

    res.json(apiOk({ id: repo.id, name: repoName, path: absolutePath, remote: remoteShort, group_name: groupName || '', account_id: account_id_for_repo, html_url: created.html_url }));
  } catch (err) {
    console.error('API create repo error:', err);
    res.status(500).json(apiErr('Kan repository niet aanmaken op GitHub.', 'SERVER_ERROR'));
  }
});

router.post('/repos/:id/sync', isApiAuth, async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    const io = req.app.get('io');
    const { commitMessage } = req.body;

    if (!isRepoLocal(repo)) {
      const nodeId = await getOnlineNodeForRepo(pool, repo.id);
      if (nodeId) {
        await scheduleSyncForNodeRepo(nodeId, repo.id, 'sync', commitMessage, 5);
        return res.json(apiOk({ ok: true, queued: true, nodeId }));
      }
    }

    const { token } = await getRepoToken(pool, repo);
    const result = await syncRepo(repo, token, { io, log: logSync, commitMessage });

    res.json(apiOk(result));
  } catch (err) {
    res.status(500).json(apiErr('Sync mislukt.', 'SERVER_ERROR'));
  }
});

// --- Branches -----------------------------------------------------------

router.get('/repos/:id/branches', isApiAuth, async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    if (!isRepoLocal(repo)) {
      const nodeBranches = await nodeRepoBranches(pool, repo.id);
      if (nodeBranches) return res.json(apiOk(nodeBranches));
    }

    const result = await listBranches(repo.path);
    res.json(apiOk(result));
  } catch (err) {
    res.status(500).json(apiErr('Kan branches niet ophalen.', 'SERVER_ERROR'));
  }
});

router.post('/repos/:id/branches/switch', isApiAuth, async (req, res) => {
  const { branch } = req.body;
  if (!branch) return res.status(400).json(apiErr('Branch naam is verplicht.', 'MISSING_FIELDS'));

  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    if (!isRepoLocal(repo)) {
      const result = await nodeSwitchBranch(pool, repo.id, branch);
      if (result) return res.json(apiOk(result));
    }

    const result = await switchBranch(repo.path, branch);
    if (!result.ok) {
      return res.status(400).json(apiErr(`Kan niet switchen naar ${branch}. Controleer of er geen ongecommitte wijzigingen zijn.`, 'SWITCH_FAILED'));
    }
    res.json(apiOk({ current: result.current, output: result.output }));
  } catch (err) {
    res.status(500).json(apiErr('Branch switch mislukt.', 'SERVER_ERROR'));
  }
});

router.post('/repos/:id/branches/create', isApiAuth, async (req, res) => {
  const { name, from } = req.body;
  if (!name) return res.status(400).json(apiErr('Branch naam is verplicht.', 'MISSING_FIELDS'));
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));
    if (!isRepoLocal(repo)) return res.status(409).json(apiErr('Branch-beheer is alleen lokaal op de server beschikbaar.', 'NODE_ONLY'));
    const { token } = await getRepoToken(pool, repo);
    const result = await createBranch(repo.path, name, from, token);
    if (!result.ok) return res.status(400).json(apiErr(result.error, 'CREATE_FAILED'));
    res.json(apiOk(result));
  } catch (err) {
    res.status(500).json(apiErr('Branch aanmaken mislukt.', 'SERVER_ERROR'));
  }
});

router.post('/repos/:id/branches/delete', isApiAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json(apiErr('Branch naam is verplicht.', 'MISSING_FIELDS'));
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));
    if (!isRepoLocal(repo)) return res.status(409).json(apiErr('Branch-beheer is alleen lokaal op de server beschikbaar.', 'NODE_ONLY'));
    const { token } = await getRepoToken(pool, repo);
    const result = await deleteBranch(repo.path, name, token);
    if (!result.ok) return res.status(400).json(apiErr(result.error, 'DELETE_FAILED'));
    res.json(apiOk(result));
  } catch (err) {
    res.status(500).json(apiErr('Branch verwijderen mislukt.', 'SERVER_ERROR'));
  }
});

router.post('/repos/:id/branches/rename', isApiAuth, async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json(apiErr('Oude en nieuwe branch naam zijn verplicht.', 'MISSING_FIELDS'));
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));
    if (!isRepoLocal(repo)) return res.status(409).json(apiErr('Branch-beheer is alleen lokaal op de server beschikbaar.', 'NODE_ONLY'));
    const { token } = await getRepoToken(pool, repo);
    const result = await renameBranch(repo.path, from, to, token);
    if (!result.ok) return res.status(400).json(apiErr(result.error, 'RENAME_FAILED'));
    res.json(apiOk(result));
  } catch (err) {
    res.status(500).json(apiErr('Branch hernoemen mislukt.', 'SERVER_ERROR'));
  }
});

// --- Conflict resolution ------------------------------------------------

router.post('/repos/:id/resolve-conflict', isApiAuth, async (req, res) => {
  const { strategy } = req.body;
  if (!['ours', 'theirs', 'abort'].includes(strategy)) {
    return res.status(400).json(apiErr('Strategie moet ours, theirs of abort zijn.', 'INVALID_STRATEGY'));
  }

  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    const { token } = await getRepoToken(pool, repo);
    const result = await resolveConflict(repo.path, strategy, token);

    if (!result.ok) {
      if (result.error === 'PUSH_FAILED') {
        return res.status(400).json(apiErr('Push mislukt na conflict oplossing.', 'PUSH_FAILED'));
      }
      if (result.error === 'MERGE_FAILED') {
        const msg = result.file
          ? `Kon bestand niet oplossen: ${result.file}`
          : 'Kon conflict niet automatisch oplossen. Los handmatig op.';
        return res.status(400).json(apiErr(msg, 'MERGE_FAILED'));
      }
      return res.status(400).json(apiErr('Conflict oplossing mislukt.', result.error || 'MERGE_FAILED'));
    }

    res.json(apiOk(result));
  } catch (err) {
    res.status(500).json(apiErr('Conflict oplossing mislukt.', 'SERVER_ERROR'));
  }
});

// --- Settings -----------------------------------------------------------

router.get('/settings', isApiAuth, async (req, res) => {
  try {
    const [user] = await pool.query('SELECT github_user, language FROM users WHERE id = ?', [req.sessionUser.id]);
    const accounts = await listAccountsMeta(pool, req.sessionUser.id);
    res.json(apiOk({
      githubUser: user ? user.github_user : '',
      accounts,
      language: isSupportedLang(user && user.language) ? user.language : DEFAULT_LANG,
      languages: langList,
    }));
  } catch (err) {
    res.status(500).json(apiErr('Kan instellingen niet ophalen.', 'SERVER_ERROR'));
  }
});

router.get('/settings/token', isApiAuth, async (req, res) => {
  try {
    const { token } = await getUserGitHub(pool, req.sessionUser.id);
    res.json(apiOk({ token }));
  } catch (err) {
    res.status(500).json(apiErr('Kan token niet ophalen.', 'SERVER_ERROR'));
  }
});

router.post('/settings', isApiAuth, async (req, res) => {
  const { token, githubUser } = req.body;
  try {
    await setUserGitHub(pool, req.sessionUser.id, token, githubUser);
    res.json(apiOk(null));
  } catch (err) {
    res.status(500).json(apiErr('Opslaan mislukt.', 'SERVER_ERROR'));
  }
});

router.post('/settings/language', isApiAuth, async (req, res) => {
  const { language } = req.body;
  const lang = isSupportedLang(language) ? language : DEFAULT_LANG;
  try {
    await pool.query('UPDATE users SET language = ? WHERE id = ?', [lang, req.sessionUser.id]);
    if (req.session.user) req.session.user.language = lang;
    res.json(apiOk({ language: lang }));
  } catch (err) {
    res.status(500).json(apiErr('Opslaan mislukt.', 'SERVER_ERROR'));
  }
});

// --- Accounts (multi-account) ---------------------------------------------

router.get('/accounts', isApiAuth, async (req, res) => {
  try {
    const accounts = await listAccountsMeta(pool, req.sessionUser.id);
    res.json(apiOk(accounts));
  } catch (err) {
    res.status(500).json(apiErr('Kan accounts niet ophalen.', 'SERVER_ERROR'));
  }
});

router.post('/accounts', isApiAuth, async (req, res) => {
  const { label, githubUser, token, isDefault } = req.body;
  if (!label || !githubUser || !token) {
    return res.status(400).json(apiErr('Label, githubUser en token zijn verplicht.', 'MISSING_FIELDS'));
  }
  try {
    const acc = await addAccount(pool, req.sessionUser.id, label, githubUser, token, !!isDefault);
    res.json(apiOk({ id: acc.id, label: acc.label, githubUser: acc.githubUser, isDefault: acc.isDefault }));
  } catch (err) {
    res.status(500).json(apiErr('Account toevoegen mislukt: ' + (err.message || ''), 'SERVER_ERROR'));
  }
});

router.put('/accounts/:id', isApiAuth, async (req, res) => {
  const { label, githubUser, token, isDefault } = req.body;
  try {
    const fields = {
      label: label !== undefined ? label : undefined,
      githubUser: githubUser !== undefined ? githubUser : undefined,
      token: token && token.length > 0 ? token : undefined,
      isDefault: !!isDefault,
    };
    const acc = await updateAccount(pool, parseInt(req.params.id, 10), req.sessionUser.id, fields);
    if (!acc) return res.status(404).json(apiErr('Account niet gevonden.', 'NOT_FOUND'));
    res.json(apiOk({ id: acc.id, label: acc.label, githubUser: acc.githubUser, isDefault: acc.isDefault }));
  } catch (err) {
    res.status(500).json(apiErr('Account bijwerken mislukt.', 'SERVER_ERROR'));
  }
});

router.delete('/accounts/:id', isApiAuth, async (req, res) => {
  try {
    const ok = await deleteAccount(pool, parseInt(req.params.id, 10), req.sessionUser.id);
    if (!ok) return res.status(404).json(apiErr('Account niet gevonden.', 'NOT_FOUND'));
    res.json(apiOk(null));
  } catch (err) {
    res.status(500).json(apiErr('Account verwijderen mislukt.', 'SERVER_ERROR'));
  }
});

router.post('/accounts/:id/default', isApiAuth, async (req, res) => {
  try {
    const ok = await setDefaultAccount(pool, parseInt(req.params.id, 10), req.sessionUser.id);
    if (!ok) return res.status(404).json(apiErr('Account niet gevonden.', 'NOT_FOUND'));
    res.json(apiOk(null));
  } catch (err) {
    res.status(500).json(apiErr('Default wijzigen mislukt.', 'SERVER_ERROR'));
  }
});

// --- Nodes (Agent Management) -------------------------------------------

// Node auth middleware (for agent connections)
async function authenticateNode(req, res, next) {
  const nodeKey = req.headers['x-node-key'];
  if (!nodeKey) {
    return res.status(401).json(apiErr('Node key required', 'UNAUTHORIZED'));
  }
  const nodeKeyHash = hashNodeKey(nodeKey);
  const node = await getNodeByKeyHash(pool, nodeKeyHash);
  if (!node) {
    return res.status(401).json(apiErr('Invalid node key', 'UNAUTHORIZED'));
  }
  req.node = node;
  next();
}

// Get node by key hash is afkomstig uit lib/node.js (zie imports bovenaan).

router.get('/nodes', isApiAuth, async (req, res) => {
  try {
    const nodes = await listNodes(pool, req.sessionUser.id);
    const nodesWithRepos = await Promise.all(nodes.map(async (n) => {
      const repos = await getNodeRepos(pool, n.id);
      return { ...n, repos: repos.map(r => ({ id: r.repo_id, name: r.name, sync_direction: r.sync_direction, auto_sync: r.auto_sync, last_synced: r.last_synced, last_status: r.last_status })) };
    }));
    res.json(apiOk(nodesWithRepos));
  } catch (err) {
    res.status(500).json(apiErr('Kan nodes niet ophalen.', 'SERVER_ERROR'));
  }
});

router.post('/nodes', isApiAuth, async (req, res) => {
  const { name, platform } = req.body;
  if (!name) {
    return res.status(400).json(apiErr('Node naam is verplicht.', 'MISSING_FIELDS'));
  }
  try {
    const node = await createNode(pool, req.sessionUser.id, name, platform);
    res.json(apiOk(node));
  } catch (err) {
    res.status(500).json(apiErr('Node aanmaken mislukt: ' + (err.message || ''), 'SERVER_ERROR'));
  }
});

router.get('/nodes/:id', isApiAuth, async (req, res) => {
  try {
    const node = await getNode(pool, req.params.id, req.sessionUser.id);
    if (!node) return res.status(404).json(apiErr('Node niet gevonden.', 'NOT_FOUND'));
    const repos = await getNodeRepos(pool, node.id);
    res.json(apiOk({ ...node, repos }));
  } catch (err) {
    res.status(500).json(apiErr('Kan node niet ophalen.', 'SERVER_ERROR'));
  }
});

router.put('/nodes/:id', isApiAuth, async (req, res) => {
  const { name, platform, defaultPath } = req.body;
  try {
    const node = await updateNode(pool, req.params.id, req.sessionUser.id, {
      name,
      platform,
      default_path: defaultPath !== undefined ? (String(defaultPath).trim() || null) : undefined,
    });
    if (!node) return res.status(404).json(apiErr('Node niet gevonden.', 'NOT_FOUND'));
    res.json(apiOk(node));
  } catch (err) {
    res.status(500).json(apiErr('Node bijwerken mislukt.', 'SERVER_ERROR'));
  }
});

router.delete('/nodes/:id', isApiAuth, async (req, res) => {
  try {
    const ok = await deleteNode(pool, req.params.id, req.sessionUser.id);
    if (!ok) return res.status(404).json(apiErr('Node niet gevonden.', 'NOT_FOUND'));
    res.json(apiOk(null));
  } catch (err) {
    res.status(500).json(apiErr('Node verwijderen mislukt.', 'SERVER_ERROR'));
  }
});

router.post('/nodes/:id/assign-repo', isApiAuth, async (req, res) => {
  const { repoId, syncDirection, autoSync, nodePath } = req.body;
  if (!repoId) {
    return res.status(400).json(apiErr('Repo ID is verplicht.', 'MISSING_FIELDS'));
  }
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [repoId, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!node) return res.status(404).json(apiErr('Node niet gevonden.', 'NOT_FOUND'));

    await assignRepoToNode(pool, node.id, repo.id, syncDirection, autoSync, nodePath);
    res.json(apiOk({ nodeId: node.id, repoId: repo.id, syncDirection, autoSync, nodePath }));
  } catch (err) {
    res.status(500).json(apiErr('Repo toewijzen mislukt.', 'SERVER_ERROR'));
  }
});

router.delete('/nodes/:id/assign-repo/:repoId', isApiAuth, async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.repoId, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!node) return res.status(404).json(apiErr('Node niet gevonden.', 'NOT_FOUND'));

    await unassignRepoFromNode(pool, node.id, repo.id);
    res.json(apiOk(null));
  } catch (err) {
    res.status(500).json(apiErr('Repo toewijzing verwijderen mislukt.', 'SERVER_ERROR'));
  }
});

router.get('/nodes/:id/repos', isApiAuth, async (req, res) => {
  try {
    const repos = await getNodeRepos(pool, req.params.id);
    res.json(apiOk(repos));
  } catch (err) {
    res.status(500).json(apiErr('Kan node repos niet ophalen.', 'SERVER_ERROR'));
  }
});

// Bestandssysteem browse op een node (voor het aanmaken van repo's op die agent)
router.get('/nodes/:id/browse', isApiAuth, async (req, res) => {
  try {
    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!node) return res.status(404).json(apiErr('Node niet gevonden.', 'NOT_FOUND'));
    if (node.status !== 'online') return res.status(409).json(apiErr('Node is offline.', 'NODE_OFFLINE'));
    const { MessageType, createBrowsePayload } = require('../agent/lib/agent-protocol');
    const { dispatchQueryToNode } = require('../lib/sync-orchestrator');
    const result = await dispatchQueryToNode(node.id, MessageType.BROWSE_DIR, { ...createBrowsePayload(req.query.path || ''), base: node.default_path || '' }, 8000);
    if (!result.success) return res.status(502).json(apiErr(result.error || 'Node niet bereikbaar.', 'NODE_ERROR'));
    res.json(apiOk(result));
  } catch (err) {
    res.status(500).json(apiErr('Browse mislukt.', 'SERVER_ERROR'));
  }
});

router.get('/repos/:id/nodes', isApiAuth, async (req, res) => {
  try {
    const nodes = await getRepoNodes(pool, req.params.id);
    res.json(apiOk(nodes));
  } catch (err) {
    res.status(500).json(apiErr('Kan repo nodes niet ophalen.', 'SERVER_ERROR'));
  }
});

router.post('/nodes/:id/sync', isApiAuth, async (req, res) => {
  const { repoId, action, commitMessage } = req.body;
  if (!repoId) {
    return res.status(400).json(apiErr('Repo ID is verplicht.', 'MISSING_FIELDS'));
  }
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [repoId, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!node) return res.status(404).json(apiErr('Node niet gevonden.', 'NOT_FOUND'));

    await scheduleSyncForNodeRepo(node.id, repo.id, action || 'sync', commitMessage);
    res.json(apiOk({ nodeId: node.id, repoId: repo.id, queued: true }));
  } catch (err) {
    res.status(500).json(apiErr('Sync inplannen mislukt.', 'SERVER_ERROR'));
  }
});

router.post('/nodes/:id/clone-repo/:repoId', isApiAuth, async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.repoId, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!node) return res.status(404).json(apiErr('Node niet gevonden.', 'NOT_FOUND'));

    const assignment = await getNodeAssignment(pool, node.id, repo.id);
    if (!assignment) return res.status(400).json(apiErr('Repo is niet toegewezen aan deze node.', 'NOT_ASSIGNED'));

    await scheduleCloneForNodeRepo(node.id, repo.id);
    res.json(apiOk({ nodeId: node.id, repoId: repo.id, queued: true }));
  } catch (err) {
    res.status(500).json(apiErr('Clone inplannen mislukt.', 'SERVER_ERROR'));
  }
});

router.post('/nodes/:id/create-repo', isApiAuth, async (req, res) => {
  const { repoName, description, isPrivate, nodePath, accountId, groupName } = req.body;

  if (!repoName) {
    return res.status(400).json(apiErr('Repository naam is verplicht.', 'MISSING_FIELDS'));
  }
  if (!nodePath) {
    return res.status(400).json(apiErr('Pad op de node is verplicht.', 'MISSING_FIELDS'));
  }

  try {
    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!node) return res.status(404).json(apiErr('Node niet gevonden.', 'NOT_FOUND'));

    let token, githubUser, account_id_for_repo = null;

    if (accountId) {
      const acc = await getAccount(pool, parseInt(accountId, 10), req.sessionUser.id);
      if (!acc || !acc.token) {
        return res.status(400).json(apiErr('Geselecteerd GitHub account is ongeldig.', 'INVALID_ACCOUNT'));
      }
      token = acc.token;
      githubUser = acc.githubUser;
      account_id_for_repo = acc.id;
    } else {
      const def = await getDefaultAccount(pool, req.sessionUser.id);
      if (def) {
        token = def.token;
        githubUser = def.githubUser;
        account_id_for_repo = def.id;
      } else {
        const legacy = await getUserGitHub(pool, req.sessionUser.id);
        token = legacy.token;
        githubUser = legacy.githubUser;
      }
    }

    if (!token || !githubUser) {
      return res.status(400).json(apiErr('Stel eerst een GitHub account in.', 'MISSING_SETTINGS'));
    }

    const created = await apiRequest('POST', '/user/repos', token, {
      name: repoName,
      description: description || `Repo: ${repoName}`,
      private: !!isPrivate,
    });

    const remoteShort = `${githubUser}/${repoName}`;

    const resInsert = await pool.query(
      'INSERT INTO repos (user_id, account_id, name, path, remote, group_name) VALUES (?, ?, ?, ?, ?, ?)',
      [req.sessionUser.id, account_id_for_repo, repoName, nodePath, remoteShort, groupName || '']
    );
    const repoId = resInsert.insertId;

    await assignRepoToNode(pool, node.id, repoId, 'bidirectional', false, nodePath);
    await scheduleCreateForNodeRepo(node.id, repoId);

    res.json(apiOk({ id: repoId, name: repoName, path: nodePath, remote: remoteShort, nodeId: node.id, queued: true, html_url: created.html_url }));
  } catch (err) {
    console.error('API create repo on node error:', err);
    res.status(500).json(apiErr('Kan repository niet aanmaken op node.', 'SERVER_ERROR'));
  }
});

router.post('/repos/:id/sync-all-nodes', isApiAuth, async (req, res) => {
  const { action, commitMessage } = req.body;
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.sessionUser.id]);
    if (!repo) return res.status(404).json(apiErr('Repository niet gevonden.', 'NOT_FOUND'));

    await scheduleSyncForAllNodes(repo.id, action || 'sync', commitMessage);
    res.json(apiOk({ repoId: repo.id, queued: true }));
  } catch (err) {
    res.status(500).json(apiErr('Sync inplannen mislukt.', 'SERVER_ERROR'));
  }
});

// Agent endpoint for node registration (called by agent on startup)
router.post('/agent/register', authenticateNode, async (req, res) => {
  try {
    const { platform, gitVersion, capabilities } = req.body;
    await updateNodeHeartbeat(pool, req.node.node_key_hash, platform, gitVersion, capabilities);
    res.json(apiOk({ nodeId: req.node.id, registered: true }));
  } catch (err) {
    res.status(500).json(apiErr('Registratie mislukt.', 'SERVER_ERROR'));
  }
});

// Agent heartbeat endpoint
router.post('/agent/heartbeat', authenticateNode, async (req, res) => {
  try {
    const { platform, gitVersion, capabilities } = req.body;
    await updateNodeHeartbeat(pool, req.node.node_key_hash, platform, gitVersion, capabilities);
    res.json(apiOk({ ok: true }));
  } catch (err) {
    res.status(500).json(apiErr('Heartbeat mislukt.', 'SERVER_ERROR'));
  }
});

// Helper updateNodeHeartbeat komt uit lib/node.js (zie imports bovenaan).

module.exports = router;
