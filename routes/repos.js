'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { BROWSE_ROOTS, isWithinRoots } = require('../lib/paths');
const {
  git,
  gitAsync,
  isGitRepo,
  getBranch,
  getBranchAsync,
  hasUncommittedChanges,
  getRemoteShort,
  getRepoStatusAsync,
  getRepoDataAsync,
  syncRepo,
  getContributors,
  getRepoSize,
  getCommitDates,
} = require('../lib/git');
const {
  getUserGitHub,
  setUserGitHub,
  listAccountsMeta,
  listAccountsFull,
  getAccount,
  getDefaultAccount,
  addAccount,
  updateAccount,
  deleteAccount,
  setDefaultAccount,
  getRepoToken,
  detectAccountForRemote,
} = require('../lib/settings');
const { langList, isSupportedLang, DEFAULT_LANG } = require('../lib/i18n');
const { sendNotification } = require('../lib/notify');
const { apiRequest } = require('../lib/github-api');
const { logSync } = require('../lib/db-helpers');
const { GIT_TIMEOUT, GIT_LONG_TIMEOUT, GIT_FETCH_INTERVAL } = require('../lib/constants');
const { isRepoLocal, getOnlineNodeForRepo, getOfflineAgentRepoIds, nodeRepoStatus, nodeRepoData, nodeRepoCommit, nodeRepoDiff } = require('../lib/node-repo');
const { getTagsForRepos, setRepoTags, listTags, getSavedFilters } = require('../lib/repo-meta');
const {
  createNode,
  listNodes,
  getNode,
  updateNode,
  deleteNode,
  assignRepoToNode,
  unassignRepoFromNode,
  getNodeRepos,
  getRepoNodes,
  getUserNodeAssignments,
} = require('../lib/node');
const { setUserTheme, THEMES } = require('../lib/theme');
const { scheduleSyncForNodeRepo, scheduleCloneForNodeRepo, scheduleCreateForNodeRepo, scheduleSyncForAllNodes, dispatchQueryToNode } = require('../lib/sync-orchestrator');

const router = express.Router();

const syncLimiter = require('express-rate-limit')({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: 'Te veel sync requests, probeer later opnieuw.',
});

// Status voor een repo: node-only repo's (pad bestaat niet op de server) halen
// hun status bij een online node, de rest lokaal zoals voorheen.
async function repoStatusWithNode(pool, repo, opts) {
  if (!isRepoLocal(repo)) {
    const st = await nodeRepoStatus(pool, repo.id);
    if (st) return st;
  }
  const { token } = await getRepoToken(pool, repo);
  return getRepoStatusAsync(repo.path, token, opts);
}

// --- Routes ---------------------------------------------------------------

router.get('/', async (req, res) => {
  try {
    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]);
    const accounts = await listAccountsMeta(pool, req.session.user.id);
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const offlineAgentRepoIds = await getOfflineAgentRepoIds(pool, req.session.user.id);

    const tagsByRepo = await getTagsForRepos(pool, repos.map((r) => r.id));
    const enriched = await Promise.all(repos.map(async (r) => {
      const st = await repoStatusWithNode(pool, r, { skipFetch: true });
      const account = r.account_id ? accountById.get(r.account_id) : null;
      return { ...r, ...st, account, tags: tagsByRepo.get(r.id) || [], agentOffline: offlineAgentRepoIds.has(r.id) };
    }));
    const tagList = await listTags(pool, req.session.user.id);
    const savedFilters = await getSavedFilters(pool, req.session.user.id);
    res.render('dashboard', { repos: enriched, token: '', accounts, tagList, savedFilters });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', { repos: [], token: '', accounts: [], tagList: [], savedFilters: [] });
  }
});

router.get('/create', async (req, res) => {
  const accounts = await listAccountsMeta(pool, req.session.user.id);
  const allNodes = await listNodes(pool, req.session.user.id);
  const nodes = (allNodes || []).filter((n) => n.status === 'online');
  res.render('create-repo', { accounts, browseRoot: BROWSE_ROOTS[0] || '/home', nodes });
});

router.post('/create', async (req, res) => {
  const { repoName, description, isPrivate, localPath, groupName, accountId } = req.body;
  const agentId = req.body.agentId ? parseInt(req.body.agentId, 10) : null;

  let targetNode = null;
  if (agentId) {
    try {
      const [n] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [agentId, req.session.user.id]);
      if (!n) {
        req.flash('error', 'Geselecteerde agent bestaat niet.');
        return res.redirect('/repos/create');
      }
      if (n.status !== 'online') {
        req.flash('error', `Agent "${n.name}" is offline.`);
        return res.redirect('/repos/create');
      }
      targetNode = n;
    } catch (err) {
      req.flash('error', 'Agent selectie mislukt.');
      return res.redirect('/repos/create');
    }
  }

  if (!repoName || !localPath) {
    req.flash('error', 'Repository naam en lokaal pad zijn verplicht.');
    return res.redirect('/repos/create');
  }

  // Pad-controle geldt alleen voor de server-modus; bij een gekozen agent is
  // het pad op de doel-machine en moet dit niet op de server gecontroleerd worden.
  if (!targetNode && !isWithinRoots(path.resolve(localPath), BROWSE_ROOTS)) {
    req.flash('error', `Het opgegeven pad valt buiten de toegestane mappen op de server (${BROWSE_ROOTS.join(', ')}). Kies een agent als doel óf gebruik een pad binnen deze mappen.`);
    return res.redirect('/repos/create');
  }

  try {
    let token, githubUser, account_id_for_repo = null;

    if (accountId) {
      const acc = await getAccount(pool, parseInt(accountId, 10), req.session.user.id);
      if (!acc || !acc.token) {
        req.flash('error', 'Geselecteerd GitHub account is ongeldig of heeft geen token.');
        return res.redirect('/repos/create');
      }
      token = acc.token;
      githubUser = acc.githubUser;
      account_id_for_repo = acc.id;
    } else {
      const def = await getDefaultAccount(pool, req.session.user.id);
      if (def) {
        token = def.token;
        githubUser = def.githubUser;
        account_id_for_repo = def.id;
      } else {
        const legacy = await getUserGitHub(pool, req.session.user.id);
        token = legacy.token;
        githubUser = legacy.githubUser;
      }
    }

    if (!token || !githubUser) {
      req.flash('error', 'Stel eerst een GitHub account in via Instellingen.');
      return res.redirect('/repos/settings');
    }

    const created = await apiRequest('POST', '/user/repos', token, {
      name: repoName,
      description: description || `Repo: ${repoName}`,
      private: isPrivate === 'on',
    });

    // Aanmaken op een agent (doel-machine) i.p.v. lokaal op de server
    if (targetNode) {
      // Pad NIET op de server resolven: het is een pad op de doel-machine.
      // path.resolve() op een Windows-pad (D:\...) zou hier onzin geven.
      let baseDir = String(localPath || '').replace(/[\\/]+$/, '');
      if (baseDir.match(/^[A-Za-z]:/) && !baseDir.includes('\\')) {
        baseDir = baseDir.replace(/^([A-Za-z]):/, '$1:\\');
      }
      const sep = targetNode.platform === 'windows' ? '\\' : '/';
      const agentPath = baseDir + sep + repoName;
      const repoRes = await pool.query(
        'INSERT INTO repos (user_id, account_id, name, path, remote, group_name) VALUES (?, ?, ?, ?, ?, ?)',
        [req.session.user.id, account_id_for_repo, repoName, agentPath, `${githubUser}/${repoName}`, groupName || '']
      );
      await assignRepoToNode(pool, targetNode.id, repoRes.insertId, 'bidirectional', false, agentPath);
      await scheduleCreateForNodeRepo(targetNode.id, repoRes.insertId);
      req.flash('success', `Repository "${repoName}" wordt aangemaakt op agent "${targetNode.name}".`);
      return res.redirect('/repos');
    }

    const absolutePath = path.resolve(path.join(localPath, repoName));
    if (!isWithinRoots(absolutePath, BROWSE_ROOTS)) {
      req.flash('error', `Doelpad buiten de toegestane mappen op de server (${BROWSE_ROOTS.join(', ')}). Kies hierboven een agent als doel óf gebruik een pad binnen deze mappen.`);
      return res.redirect('/repos/create');
    }

    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(absolutePath, { recursive: true });
    }

    const remoteUrl = `https://github.com/${githubUser}/${repoName}.git`;

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
      [req.session.user.id, account_id_for_repo, repoName, absolutePath, `${githubUser}/${repoName}`, groupName || '']
    );

    req.flash('success', `Repository "${repoName}" aangemaakt en gesynct!`);
    res.redirect('/repos');
  } catch (err) {
    console.error('Create repo error:', err);
    req.flash('error', 'Fout bij aanmaken. Controleer je instellingen en probeer opnieuw.');
    res.redirect('/repos/create');
  }
});

router.get('/add', async (req, res) => {
  const accounts = await listAccountsMeta(pool, req.session.user.id);
  const allNodes = await listNodes(pool, req.session.user.id);
  const nodes = (allNodes || []).filter((n) => n.status === 'online');
  res.render('add-repo', { accounts, browseRoot: BROWSE_ROOTS[0] || '/home', nodes });
});

// Lijst met bestaande GitHub repositories voor het importeren/toevoegen.
router.get('/github-repos', async (req, res) => {
  try {
    let token = null;
    const accountId = req.query.accountId ? parseInt(req.query.accountId, 10) : null;
    if (accountId) {
      const acc = await getAccount(pool, accountId, req.session.user.id);
      if (acc) token = acc.token;
    }
    if (!token) {
      const def = await getDefaultAccount(pool, req.session.user.id);
      if (def) token = def.token;
    }
    if (!token) {
      const legacy = await getUserGitHub(pool, req.session.user.id);
      token = legacy.token;
    }
    if (!token) return res.status(400).json({ error: 'Geen GitHub account gekoppeld.' });

    const repos = await apiRequest('GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', token);
    const list = (Array.isArray(repos) ? repos : []).map((r) => ({
      fullName: r.full_name,
      name: r.name,
      private: !!r.private,
      description: r.description || '',
      cloneUrl: r.clone_url || '',
    }));
    res.json({ repos: list });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Kon GitHub repositories niet laden.' });
  }
});

router.post('/add', async (req, res) => {
  const { name, localPath, remote, groupName, accountId } = req.body;
  const agentId = req.body.agentId ? parseInt(req.body.agentId, 10) : null;

  let targetNode = null;
  if (agentId) {
    try {
      const [n] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [agentId, req.session.user.id]);
      if (!n) {
        req.flash('error', 'Geselecteerde agent bestaat niet.');
        return res.redirect('/repos/add');
      }
      if (n.status !== 'online') {
        req.flash('error', `Agent "${n.name}" is offline.`);
        return res.redirect('/repos/add');
      }
      targetNode = n;
    } catch (err) {
      req.flash('error', 'Agent selectie mislukt.');
      return res.redirect('/repos/add');
    }
  }

  if (!name || !localPath) {
    req.flash('error', 'Naam en pad zijn verplicht.');
    return res.redirect('/repos/add');
  }

  try {
    let absolutePath;

    if (targetNode) {
      // Pad is op de doel-machine, niet op de server. Niet resolven/valideren.
      absolutePath = String(localPath).replace(/[\\/]+$/, '');
      if (absolutePath.match(/^[A-Za-z]:/) && !absolutePath.includes('\\')) {
        absolutePath = absolutePath.replace(/^([A-Za-z]):/, '$1:\\');
      }
    } else {
      absolutePath = path.resolve(localPath);

      if (!isWithinRoots(absolutePath, BROWSE_ROOTS)) {
        req.flash('error', 'Pad valt buiten de toegestane mappen.');
        return res.redirect('/repos/add');
      }

      if (!fs.existsSync(absolutePath)) {
        req.flash('error', 'Pad bestaat niet.');
        return res.redirect('/repos/add');
      }

      if (!isGitRepo(absolutePath)) {
        await gitAsync('init', absolutePath);
        await gitAsync(['config', 'user.email', 'mindframework@auto.sync'], absolutePath);
        await gitAsync(['config', 'user.name', 'MindFramework Auto-Sync'], absolutePath);
      }
    }

    let remoteShort = '';
    if (remote) {
      remoteShort = remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    }

    let account_id_for_repo = accountId ? parseInt(accountId, 10) : null;
    if (!account_id_for_repo && remoteShort) {
      const detected = await detectAccountForRemote(pool, req.session.user.id, remoteShort);
      if (detected) account_id_for_repo = detected.id;
    }
    if (!account_id_for_repo) {
      const def = await getDefaultAccount(pool, req.session.user.id);
      if (def) account_id_for_repo = def.id;
    }
    if (!account_id_for_repo) account_id_for_repo = null; // voorkom account_id=0 (FK-violatie)

    // Toevoegen op een agent (doel-machine): geen git-operaties op de server.
    // De remote wordt op de agent gezet zodra de sync-taak draait.
    if (targetNode) {
      await pool.query(
        'INSERT INTO repos (user_id, account_id, name, path, remote, group_name) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), remote=VALUES(remote), group_name=VALUES(group_name), account_id=VALUES(account_id)',
        [req.session.user.id, account_id_for_repo, name, absolutePath, remoteShort, groupName || '']
      );
      const [row] = await pool.query('SELECT id FROM repos WHERE user_id = ? AND path = ?', [req.session.user.id, absolutePath]);
      const repoId = row ? row.id : null;
      if (repoId) {
        await assignRepoToNode(pool, targetNode.id, repoId, 'bidirectional', false, absolutePath);
        // Alleen syncen als er een remote is; anders zou de agent een ongeldige
        // remote-URL zetten. Zonder remote blijft het een lokale node-repo.
        if (remoteShort) await scheduleSyncForNodeRepo(targetNode.id, repoId, 'sync');
      }
      req.flash('success', `Repository "${name}" toegevoegd op agent "${targetNode.name}".`);
      return res.redirect('/repos');
    }

    if (remoteShort) {
      const existingRemote = await gitAsync('remote get-url origin', absolutePath);
      const remoteUrl = `https://github.com/${remoteShort}.git`;
      if (existingRemote) await gitAsync(['remote', 'remove', 'origin'], absolutePath);
      await gitAsync(['remote', 'add', 'origin', remoteUrl], absolutePath);
    }

    await pool.query(
      'INSERT INTO repos (user_id, account_id, name, path, remote, group_name) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), remote=VALUES(remote), group_name=VALUES(group_name), account_id=VALUES(account_id)',
      [req.session.user.id, account_id_for_repo, name, absolutePath, remoteShort, groupName || '']
    );

    req.flash('success', `Repository "${name}" toegevoegd!`);
    res.redirect('/repos');
  } catch (err) {
    console.error('Add repo error:', err);
    req.flash('error', 'Fout bij toevoegen. Probeer opnieuw.');
    res.redirect('/repos/add');
  }
});

router.post('/remove/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    await pool.query('DELETE FROM sync_logs WHERE repo_id = ?', [req.params.id]);
    req.flash('success', 'Repository verwijderd.');
    res.redirect('/repos');
  } catch (err) {
    req.flash('error', 'Verwijderen mislukt.');
    res.redirect('/repos');
  }
});

// Update account koppeling voor een bestaande repo
router.post('/edit/:id', async (req, res) => {
  const { accountId, groupName, tags } = req.body;
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!repo) {
      req.flash('error', 'Repository niet gevonden.');
      return res.redirect('/repos');
    }

    const accId = accountId && accountId !== '' ? parseInt(accountId, 10) : null;
    if (accId) {
      const acc = await getAccount(pool, accId, req.session.user.id);
      if (!acc) {
        req.flash('error', 'Ongeldig GitHub account.');
        return res.redirect('/repos/view/' + req.params.id);
      }
    }

    await pool.query('UPDATE repos SET account_id = ?, group_name = ? WHERE id = ? AND user_id = ?',
      [accId, groupName !== undefined ? groupName : repo.group_name, req.params.id, req.session.user.id]);

    if (tags !== undefined) {
      await setRepoTags(pool, repo.id, tags);
    }

    req.flash('success', 'Repository bijgewerkt.');
    res.redirect('/repos/view/' + req.params.id);
  } catch (err) {
    req.flash('error', 'Bijwerken mislukt.');
    res.redirect('/repos/view/' + req.params.id);
  }
});

router.get('/sync-all', (req, res) => res.redirect('/repos'));

router.post('/sync-all', syncLimiter, async (req, res) => {
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
        await sendNotification(pool, repo.name, result.reason || 'unknown', `Sync mislukt: ${result.reason || 'onbekend'}`, repo.user_id);
      }
    }

    req.flash('success', `Sync klaar: ${ok} geslaagd, ${fail} mislukt.`);
    res.redirect('/repos');
  } catch (err) {
    req.flash('error', 'Sync mislukt.');
    res.redirect('/repos');
  }
});

router.post('/sync/:id', syncLimiter, async (req, res) => {
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
      await sendNotification(pool, repo.name, reason, `Sync mislukt: ${reason}`, repo.user_id);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Sync mislukt.' });
  }
});

router.get('/status/:id', async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!repo) return res.status(404).json({ error: 'Repo niet gevonden' });

    const status = await repoStatusWithNode(pool, repo);
    const data = isRepoLocal(repo) ? await getRepoDataAsync(repo.path) : await nodeRepoData(pool, repo.id);
    const cleanRemote = require('../lib/git').cleanRemoteUrl(status.remote);
    status.remote = cleanRemote;

    res.json({ ...repo, ...status, gitData: data });
  } catch (err) {
    res.status(500).json({ error: 'Status niet beschikbaar.' });
  }
});

// Status refresh for the dashboard (git fetch is throttled via GIT_FETCH_INTERVAL)
const refreshCache = new Map();

router.get('/refresh', async (req, res) => {
  try {
    // Check authentication - needed for direct API access
    if (!req.session.user) {
      return res.status(401).json({ error: 'Niet ingelogd.', needsLogin: true });
    }

    const cacheKey = `refresh_${req.session.user.id}`;
    const cached = refreshCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.time < GIT_FETCH_INTERVAL) {
      res.json({ repos: cached.data, fromCache: true });
      return;
    }

    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]);
    const accounts = await listAccountsMeta(pool, req.session.user.id);
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const offlineAgentRepoIds = await getOfflineAgentRepoIds(pool, req.session.user.id);
    const tagsByRepo = await getTagsForRepos(pool, repos.map((r) => r.id));

    const enriched = await Promise.all(repos.map(async (r) => {
      const st = await repoStatusWithNode(pool, r);
      const account = r.account_id ? accountById.get(r.account_id) : null;
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
    res.status(500).json({ error: 'Refresh mislukt.' });
  }
});

router.get('/view/:id', async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!repo) {
      req.flash('error', 'Repository niet gevonden.');
      return res.redirect('/repos');
    }

    const status = await repoStatusWithNode(pool, repo);
    const data = isRepoLocal(repo) ? await getRepoDataAsync(repo.path) : await nodeRepoData(pool, repo.id);

    const logs = await pool.query(
      'SELECT * FROM sync_logs WHERE repo_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );

    const accounts = await listAccountsMeta(pool, req.session.user.id);
    const currentAccount = repo.account_id ? accounts.find((a) => a.id === repo.account_id) : null;
    const tagsByRepo = await getTagsForRepos(pool, [repo.id]);

    res.render('repo-view', {
      repo: { ...repo, ...status },
      tags: tagsByRepo.get(repo.id) || [],
      logs,
      logEntries: data.logEntries,
      changedFiles: data.changedFiles,
      gitStatus: data.gitStatus,
      accounts,
      currentAccount,
      lang: req.session.user && req.session.user.language ? req.session.user.language : DEFAULT_LANG,
    });
  } catch (err) {
    req.flash('error', 'Kon repository niet openen.');
    res.redirect('/repos');
  }
});

// --- Diff viewer & commit detail ----------------------------------------

router.get('/diff/:id', async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!repo) return res.status(404).json({ error: 'Repo niet gevonden' });

    const file = req.query.file;
    if (!file) return res.status(400).json({ error: 'Geen bestand opgegeven' });

    if (!isRepoLocal(repo)) {
      const nodeDiff = await nodeRepoDiff(pool, repo.id, file);
      if (nodeDiff !== null) return res.json({ file, diff: nodeDiff });
    }

    const { token } = await getRepoToken(pool, repo);
    const diff = git(['diff', 'HEAD', '--', file], repo.path, GIT_TIMEOUT, { token })
      || git(['diff', '--staged', '--', file], repo.path, GIT_TIMEOUT, { token })
      || '';
    res.json({ file, diff });
  } catch (err) {
    res.status(500).json({ error: 'Diff niet beschikbaar.' });
  }
});

router.get('/commit/:id', async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!repo) return res.status(404).json({ error: 'Repo niet gevonden' });

    const commit = req.query.commit;
    if (!commit) return res.status(400).json({ error: 'Geen commit hash opgegeven' });

    if (!isRepoLocal(repo)) {
      const nodeCommit = await nodeRepoCommit(pool, repo.id, commit);
      if (nodeCommit) return res.json(nodeCommit);
      return res.status(404).json({ error: 'Commit niet gevonden' });
    }

    const log = git(`log -1 --format="%H%n%an%n%ae%n%ad%n%s%n%b" ${commit}`, repo.path);
    if (!log) return res.status(404).json({ error: 'Commit niet gevonden' });

    const lines = log.split('\n');
    const stat = git(`diff-tree --no-commit-id --name-status -r ${commit}`, repo.path) || '';
    const shortStat = git(`diff-tree --no-commit-id --shortstat -r ${commit}`, repo.path) || '';

    res.json({
      hash: lines[0] || '',
      author: lines[1] || '',
      email: lines[2] || '',
      date: lines[3] || '',
      subject: lines[4] || '',
      body: lines.slice(5).join('\n').trim(),
      files: stat.split('\n').filter(Boolean),
      shortStat: shortStat.trim(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Commit details niet beschikbaar.' });
  }
});

// --- Notificatie webhook endpoints ----------------------------------------

router.get('/accounts', async (req, res) => {
  try {
    const accounts = await listAccountsMeta(pool, req.session.user.id);
    res.render('accounts', { accounts, csrfInput: '' });
  } catch (err) {
    console.error('Accounts page error:', err);
    req.flash('error', 'Kon accounts-pagina niet laden.');
    res.redirect('/repos/settings');
  }
});

router.get('/settings/notifications', async (req, res) => {
  const accounts = await listAccountsMeta(pool, req.session.user.id);
  const [user] = await pool.query('SELECT github_user, language FROM users WHERE id = ?', [req.session.user.id]);
  const currentLang = isSupportedLang(user && user.language) ? user.language : DEFAULT_LANG;
  const { getGlobalSetting } = require('../lib/settings');
  const discordUrl = await getGlobalSetting(pool, 'NOTIFY_DISCORD_URL') || '';
  res.render('notifications', {
    accounts, githubUser: user ? user.github_user : '', langList, currentLang,
    discordUrl,
  });
});

router.post('/settings/notifications', async (req, res) => {
  const { discordUrl } = req.body;
  const { setGlobalSetting } = require('../lib/settings');
  try {
    await setGlobalSetting(pool, 'NOTIFY_DISCORD_URL', discordUrl || '');
    req.flash('success', 'Notificatie-instellingen opgeslagen.');
  } catch (err) {
    req.flash('error', 'Opslaan mislukt.');
  }
  res.redirect('/repos/settings/notifications');
});

router.get('/watch', async (req, res) => {
  try {
    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]);
    const enriched = await Promise.allSettled(repos.map(async (r) => {
      try {
        const { token } = await getRepoToken(pool, r);
        const st = await getRepoStatusAsync(r.path, token);
        return { ...r, ...st };
      } catch (e) {
        // Repo met error, retourneer minimaal basisgegevens
        return { ...r, status: 'error', color: 'red', changes: 0, behindCount: 0, aheadCount: 0 };
      }
    }));
    // Filter alleen succesvolle resultaten
    const successRepos = enriched
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value);
    res.render('watch', { repos: successRepos });
  } catch (err) {
    req.flash('error', 'Kon de watch-pagina niet laden.');
    res.render('watch', { repos: [] });
  }
});

// --- Instellingen: accounts CRUD -----------------------------------------

router.get('/settings', async (req, res) => {
  const accounts = await listAccountsMeta(pool, req.session.user.id);
  const [user] = await pool.query('SELECT github_user, language, theme FROM users WHERE id = ?', [req.session.user.id]);
  const currentLang = isSupportedLang(user && user.language) ? user.language : DEFAULT_LANG;
  const currentTheme = (user && user.theme) || 'glacier';
  res.render('settings', {
    accounts,
    githubUser: user ? user.github_user : '',
    token: '',
    langList,
    currentLang,
    currentTheme,
    availableThemes: THEMES,
  });
});

router.post('/accounts/add', async (req, res) => {
  const { label, githubUser, token, isDefault } = req.body;
  if (!label || !githubUser || !token) {
    req.flash('error', 'Label, GitHub gebruikersnaam en token zijn verplicht.');
    return res.redirect('/repos/settings');
  }
  try {
    await addAccount(pool, req.session.user.id, label, githubUser, token, isDefault === 'on');
    req.flash('success', `Account "${label}" toegevoegd.`);
  } catch (err) {
    req.flash('error', 'Account toevoegen mislukt: ' + (err.message || 'onbekend'));
  }
  res.redirect('/repos/settings');
});

router.post('/accounts/:id/edit', async (req, res) => {
  const { label, githubUser, token, isDefault } = req.body;
  try {
    const fields = {
      label: label !== undefined ? label : undefined,
      githubUser: githubUser !== undefined ? githubUser : undefined,
      token: token && token.length > 0 ? token : undefined,
      isDefault: isDefault === 'on',
    };
    await updateAccount(pool, parseInt(req.params.id, 10), req.session.user.id, fields);
    req.flash('success', 'Account bijgewerkt.');
  } catch (err) {
    req.flash('error', 'Account bijwerken mislukt: ' + (err.message || 'onbekend'));
  }
  res.redirect('/repos/settings');
});

router.post('/accounts/:id/delete', async (req, res) => {
  try {
    const ok = await deleteAccount(pool, parseInt(req.params.id, 10), req.session.user.id);
    req.flash(ok ? 'success' : 'error', ok ? 'Account verwijderd.' : 'Account niet gevonden.');
  } catch (err) {
    req.flash('error', 'Account verwijderen mislukt.');
  }
  res.redirect('/repos/settings');
});

router.post('/accounts/:id/default', async (req, res) => {
  try {
    await setDefaultAccount(pool, parseInt(req.params.id, 10), req.session.user.id);
    req.flash('success', 'Default account gewijzigd.');
  } catch (err) {
    req.flash('error', 'Kon default account niet wijzigen.');
  }
  res.redirect('/repos/settings');
});

// Language preference
router.post('/settings/language', async (req, res) => {
  const { language } = req.body;
  const lang = isSupportedLang(language) ? language : DEFAULT_LANG;
  try {
    await pool.query('UPDATE users SET language = ? WHERE id = ?', [lang, req.session.user.id]);
    if (req.session.user) req.session.user.language = lang;
    req.flash('success', req.app.locals.t ? req.app.locals.t('language.saved') : 'Taalvoorkeur opgeslagen.');
    res.redirect('/repos/settings');
  } catch (err) {
    req.flash('error', 'Opslaan mislukt.');
    res.redirect('/repos/settings');
  }
});

router.post('/settings/theme', async (req, res) => {
  const { theme } = req.body;
  const selectedTheme = THEMES.includes(theme) ? theme : 'glacier';
  try {
    await setUserTheme(pool, req.session.user.id, selectedTheme);
    req.flash('success', 'Thema opgeslagen.');
  } catch (err) {
    req.flash('error', 'Opslaan mislukt.');
  }
  res.redirect('/repos/settings');
});

// Legacy single-token endpoint (backwards compatible, schrijft naar users tabel)
router.post('/settings', async (req, res) => {
  const { token, githubUser } = req.body;
  try {
    await setUserGitHub(pool, req.session.user.id, token, githubUser);
    req.flash('success', 'Instellingen opgeslagen.');
  } catch (err) {
    req.flash('error', 'Opslaan mislukt.');
  }
  res.redirect('/repos/settings');
});

// File browser met whitelist
router.get('/browse', (req, res) => {
  let base = (req.query.path || BROWSE_ROOTS[0] || '/home').replace(/\/+$/, '') || '/';

  try { base = require('../lib/paths').safeResolve(base); } catch { base = BROWSE_ROOTS[0] || '/'; }

  if (!isWithinRoots(base, BROWSE_ROOTS)) {
    return res.status(403).json({
      path: base,
      parent: null,
      entries: [],
      error: 'Toegang geweigerd: pad buiten toegestane mappen.',
    });
  }

  if (!fs.existsSync(base)) {
    return res.json({ path: base, parent: path.dirname(base), entries: [], error: 'Path does not exist' });
  }

  const stat = fs.statSync(base);
  if (!stat.isDirectory()) {
    return res.json({ path: base, parent: path.dirname(base), entries: [], error: 'Not a directory' });
  }

  try {
    const all = fs.readdirSync(base, { withFileTypes: true });
    const dirs = [];
    const files = [];

    for (const entry of all) {
      if (entry.name.startsWith('.') && entry.name !== '.git') continue;
      const full = path.join(base, entry.name);
      try {
        const s = fs.statSync(full);
        if (s.isDirectory()) {
          const hasGit = fs.existsSync(path.join(full, '.git'));
          const dirEntry = { name: entry.name, type: 'dir', path: full, hasGit };
          if (hasGit) dirEntry.remote = getRemoteShort(full) || '';
          dirs.push(dirEntry);
        } else {
          files.push({ name: entry.name, type: 'file', path: full });
        }
      } catch {}
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const entries = [...dirs, ...files];
    const parentPath = base === '/' ? null : path.dirname(base);
    const parent = parentPath && isWithinRoots(parentPath, BROWSE_ROOTS) ? parentPath : null;

    res.json({ path: base, parent, entries, roots: BROWSE_ROOTS });
  } catch (err) {
    res.json({ path: base, parent: null, entries: [], error: 'Kon map niet lezen.' });
  }
});

// Bestandssysteem browse op een agent (voor het aanmaken van repo's op die node)
router.get('/nodes/:id/browse', async (req, res) => {
  try {
    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!node) return res.status(404).json({ error: 'Node niet gevonden.' });
    if (node.status !== 'online') return res.status(409).json({ error: 'Node is offline.' });

    const { MessageType, createBrowsePayload } = require('../agent/lib/agent-protocol');
    const result = await dispatchQueryToNode(node.id, MessageType.BROWSE_DIR, { ...createBrowsePayload(req.query.path || ''), base: node.default_path || '' }, 8000);
    if (!result.success) return res.status(502).json({ error: result.error || 'Node niet bereikbaar.' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Browse mislukt.' });
  }
});

// --- Pull Requests ---------------------------------------------------------

const PR_CACHE_TTL = 5 * 60 * 1000; // 5 minuten cache
const prCache = new Map();
function setCachedApiRequest(key, data) {
  prCache.set(key, { data, time: Date.now() });
}

router.get('/prs', async (req, res) => {
  try {
    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]);
    if (repos.length === 0) {
      return res.render('prs', { pullRequests: [], repos: [], error: null });
    }

    const allPRs = [];
    for (const repo of repos) {
      if (!repo.remote) continue;
      const cacheKey = `prs_${repo.id}`;
      
      // Check cache
      try {
        const cached = prCache.get(cacheKey);
        if (cached && Date.now() - cached.time < PR_CACHE_TTL) {
          for (const pr of cached.data) {
            allPRs.push({
              repoId: repo.id,
              repoName: repo.name,
              repoRemote: repo.remote,
              number: pr.number,
              title: pr.title,
              body: pr.body || '',
              state: pr.state,
              author: pr.user ? pr.user.login : 'unknown',
              headBranch: pr.head ? pr.head.ref : '',
              baseBranch: pr.base ? pr.base.ref : '',
              htmlUrl: pr.html_url || '',
              createdAt: pr.created_at,
              labels: (pr.labels || []).map((l) => l.name),
              mergeable: pr.mergeable,
              draft: pr.draft || false,
            });
          }
          if (allPRs.length > 0) continue; // skip API call if we have cached data for this repo
        }
      } catch (cacheErr) {
        // Cache error, continue without cache
      }

      const { token } = await getRepoToken(pool, repo);
      if (!token) continue;

      try {
        const prs = await apiRequest('GET', `/repos/${repo.remote}/pulls?state=open&per_page=10`, token);
        const repoPRs = [];
        for (const pr of prs) {
          allPRs.push({
            repoId: repo.id,
            repoName: repo.name,
            repoRemote: repo.remote,
            number: pr.number,
            title: pr.title,
            body: pr.body || '',
            state: pr.state,
            author: pr.user ? pr.user.login : 'unknown',
            headBranch: pr.head ? pr.head.ref : '',
            baseBranch: pr.base ? pr.base.ref : '',
            htmlUrl: pr.html_url || '',
            createdAt: pr.created_at,
            labels: (pr.labels || []).map((l) => l.name),
            mergeable: pr.mergeable,
            draft: pr.draft || false,
          });
          repoPRs.push(pr);
        }
        setCachedApiRequest(cacheKey, repoPRs);
      } catch (apiErr) {
        // repo overslaan als API call faalt
      }
    }

    allPRs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.render('prs', { pullRequests: allPRs, repos, error: null });
  } catch (err) {
    console.error('PRs error:', err);
    res.render('prs', { pullRequests: [], repos: [], error: 'Kon pull requests niet ophalen.' });
  }
});

router.post('/prs/:repoId/merge/:number', async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.repoId, req.session.user.id]);
    if (!repo || !repo.remote) return res.status(404).json({ error: 'Repo niet gevonden' });

    const { token } = await getRepoToken(pool, repo);
    if (!token) return res.status(400).json({ error: 'Geen token beschikbaar' });

    const result = await apiRequest('PUT', `/repos/${repo.remote}/pulls/${req.params.number}/merge`, token, {});
    res.json({ ok: true, message: result.message, sha: result.sha });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Merge mislukt' });
  }
});

// --- Activity / Timeline ---------------------------------------------------

router.get('/activity', async (req, res) => {
  try {
    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]);
    const activities = [];
    const { token: globalToken } = await getUserGitHub(pool, req.session.user.id);

    for (const repo of repos) {
      if (!repo.path) continue;

      const logOutput = git('log --oneline --format="%H|%an|%ae|%aI|%s" -30', repo.path);
      if (logOutput) {
        logOutput.split('\n').filter(Boolean).forEach((line) => {
          const parts = line.split('|');
          if (parts.length >= 5) {
            activities.push({
              repoId: repo.id,
              repoName: repo.name,
              type: 'commit',
              hash: parts[0].substring(0, 7),
              author: parts[1],
              email: parts[2],
              date: parts[3],
              message: parts[4],
              detail: '',
            });
          }
        });
      }

      const logs = await pool.query(
        'SELECT action, message, created_at FROM sync_logs WHERE repo_id = ? ORDER BY created_at DESC LIMIT 20',
        [repo.id]
      );
      for (const log of logs) {
        activities.push({
          repoId: repo.id,
          repoName: repo.name,
          type: log.action === 'push' ? 'push' : log.action === 'pull' ? 'pull' : log.action === 'commit' ? 'commit' : 'sync',
          hash: '',
          author: '',
          email: '',
          date: log.created_at,
          message: log.message || '',
          detail: log.action,
        });
      }
    }

    activities.sort((a, b) => new Date(b.date) - new Date(a.date));
    const limited = activities.slice(0, 100);

    res.render('activity', { activities: limited, repos });
  } catch (err) {
    console.error('Activity error:', err);
    res.render('activity', { activities: [], repos: [] });
  }
});

// --- Statistieken ----------------------------------------------------------

router.get('/stats', async (req, res) => {
  try {
    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]);
    const accounts = await listAccountsMeta(pool, req.session.user.id);

    const commitData = [];
    const repoCommitCounts = [];

    for (const repo of repos) {
      if (!repo.path) continue;
      const logOutput = git('log --oneline --format="%H|%an|%ae|%aI|%s" -1000', repo.path);
      let count = 0;
      if (logOutput) {
        const lines = logOutput.split('\n').filter(Boolean);
        count = lines.length;
        for (const line of lines) {
          const parts = line.split('|');
          if (parts.length >= 5) {
            commitData.push({
              repoName: repo.name,
              author: parts[1],
              email: parts[2],
              date: parts[3],
              message: parts[4],
            });
          }
        }
      }
      repoCommitCounts.push({ name: repo.name, count });
    }

    const syncCounts = {};
    for (const repo of repos) {
      const [row] = await pool.query('SELECT COUNT(*) AS c FROM sync_logs WHERE repo_id = ?', [repo.id]);
      syncCounts[repo.name] = row ? Number(row.c) : 0;
    }

    const weeks = {};
    for (const c of commitData) {
      const d = new Date(c.date);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const key = weekStart.toISOString().substring(0, 10);
      if (!weeks[key]) weeks[key] = 0;
      weeks[key]++;
    }
    const weekLabels = Object.keys(weeks).sort().slice(-12);
    const weekValues = weekLabels.map((w) => weeks[w] || 0);

    const accountCommits = {};
    for (const c of commitData) {
      const email = c.email || 'unknown';
      if (!accountCommits[email]) accountCommits[email] = 0;
      accountCommits[email]++;
    }
    const accountLabels = Object.keys(accountCommits);
    const accountValues = accountLabels.map((a) => accountCommits[a]);

    // Contributors, repo-grootte en commit-heatmap (laatste 12 maanden).
    const contributorMap = new Map();
    const repoStats = [];
    const heatmap = {};
    const heatmapStart = new Date();
    heatmapStart.setUTCHours(0, 0, 0, 0);
    heatmapStart.setUTCDate(heatmapStart.getUTCDate() - 364);
    const startKey = heatmapStart.toISOString().slice(0, 10);

    for (const repo of repos) {
      if (!repo.path || !isRepoLocal(repo)) continue;
      const [size, contributions, dates] = await Promise.all([
        getRepoSize(repo.path),
        getContributors(repo.path, 10),
        getCommitDates(repo.path, 2000),
      ]);
      repoStats.push({ name: repo.name, size, favorite: !!repo.favorite });
      for (const c of contributions) {
        const key = c.email || c.name;
        const existing = contributorMap.get(key) || { name: c.name, email: c.email, commits: 0 };
        existing.commits += c.commits;
        contributorMap.set(key, existing);
      }
      for (const iso of dates) {
        const key = String(iso).slice(0, 10);
        if (key >= startKey) heatmap[key] = (heatmap[key] || 0) + 1;
      }
    }

    const topContributors = Array.from(contributorMap.values())
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 10);
    repoStats.sort((a, b) => b.size - a.size);
    const heatmapEndKey = new Date().toISOString().slice(0, 10);

    repoCommitCounts.sort((a, b) => b.count - a.count);
    const mostActiveRepo = repoCommitCounts.length > 0 ? repoCommitCounts[0].name : '-';

    const totalCommits = commitData.length;
    const totalSyncs = Object.values(syncCounts).reduce((a, b) => a + b, 0);

    const jsSafeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

    res.render('stats', {
      repos,
      accounts,
      weekLabels: jsSafeJson(weekLabels),
      weekValues: jsSafeJson(weekValues),
      accountLabels: jsSafeJson(accountLabels),
      accountValues: jsSafeJson(accountValues),
      repoLabels: jsSafeJson(repoCommitCounts.map((r) => r.name)),
      repoValues: jsSafeJson(repoCommitCounts.map((r) => r.count)),
      accountLabelCount: accountLabels.length,
      totalCommits,
      totalSyncs,
      mostActiveRepo,
      topContributors,
      repoStats,
      heatmap,
      heatmapStart: startKey,
      heatmapEnd: heatmapEndKey,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.render('stats', {
      repos: [], accounts: [],
      weekLabels: '[]', weekValues: '[]',
      accountLabels: '[]', accountValues: '[]',
      repoLabels: '[]', repoValues: '[]',
      totalCommits: 0, totalSyncs: 0, mostActiveRepo: '-',
      topContributors: [], repoStats: [], heatmap: {},
      heatmapStart: new Date().toISOString().slice(0, 10),
      heatmapEnd: new Date().toISOString().slice(0, 10),
    });
  }
});

// --- Webhook beheer --------------------------------------------------------

router.get('/settings/webhooks', async (req, res) => {
  try {
    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]);
    const host = req.headers.host || 'localhost:' + (process.env.PORT || '3050');
    const webhookUrl = `${req.protocol}://${host}/api/webhook/github`;
    res.render('webhooks', { repos, webhookUrl });
  } catch (err) {
    console.error('Webhooks error:', err);
    res.render('webhooks', { repos: [], webhookUrl: '' });
  }
});

// --- Nodes (Agent Management) ---------------------------------------------

router.get('/nodes', async (req, res) => {
  try {
    const nodes = await listNodes(pool, req.session.user.id);
    const accounts = await listAccountsMeta(pool, req.session.user.id);
    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]);

    const nodesWithRepos = await Promise.all(nodes.map(async (n) => {
      const nodeRepos = await getNodeRepos(pool, n.id);
      return { ...n, repos: nodeRepos };
    }));

    const nodeKey = req.session.pendingNodeKey || '';
    delete req.session.pendingNodeKey;

    res.render('nodes', { nodes: nodesWithRepos, accounts, repos, nodeKey });
  } catch (err) {
    console.error('Nodes page error:', err);
    res.render('nodes', { nodes: [], accounts: [], repos: [], nodeKey: '' });
  }
});

router.post('/nodes/add', async (req, res) => {
  const { name, platform } = req.body;
  if (!name) {
    req.flash('error', 'Node naam is verplicht.');
    return res.redirect('/repos/nodes');
  }
  try {
    const node = await createNode(pool, req.session.user.id, name, platform);
    req.session.pendingNodeKey = node.nodeKey;
    req.flash('success', `Node "${name}" aangemaakt. Kopieer de Node Key hieronder.`);
    res.redirect('/repos/nodes');
  } catch (err) {
    req.flash('error', 'Node aanmaken mislukt: ' + (err.message || 'onbekend'));
    res.redirect('/repos/nodes');
  }
});

router.post('/nodes/:id/edit', async (req, res) => {
  const { name, platform, defaultPath } = req.body;
  try {
    await updateNode(pool, req.params.id, req.session.user.id, {
      name,
      platform,
      default_path: (defaultPath || '').trim() || null,
    });
    req.flash('success', 'Node bijgewerkt.');
  } catch (err) {
    req.flash('error', 'Node bijwerken mislukt: ' + (err.message || 'onbekend'));
  }
  res.redirect('/repos/nodes');
});

router.post('/nodes/:id/delete', async (req, res) => {
  try {
    await deleteNode(pool, req.params.id, req.session.user.id);
    req.flash('success', 'Node verwijderd.');
  } catch (err) {
    req.flash('error', 'Node verwijderen mislukt.');
  }
  res.redirect('/repos/nodes');
});

router.post('/nodes/:id/assign-repo', async (req, res) => {
  const { repoId, syncDirection, autoSync, nodePath } = req.body;
  if (!repoId) {
    req.flash('error', 'Repository is verplicht.');
    return res.redirect('/repos/nodes');
  }
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [repoId, req.session.user.id]);
    if (!repo) {
      req.flash('error', 'Repository niet gevonden.');
      return res.redirect('/repos/nodes');
    }
    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!node) {
      req.flash('error', 'Node niet gevonden.');
      return res.redirect('/repos/nodes');
    }
    await assignRepoToNode(pool, node.id, repo.id, syncDirection, autoSync === 'on', nodePath);
    req.flash('success', `Repository "${repo.name}" toegewezen aan node "${node.name}".`);
  } catch (err) {
    req.flash('error', 'Toewijzing mislukt: ' + (err.message || 'onbekend'));
  }
  res.redirect('/repos/nodes');
});

router.post('/nodes/:id/clone-repo/:repoId', async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.repoId, req.session.user.id]);
    if (!repo) return res.status(404).json({ error: 'Repo niet gevonden' });

    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!node) return res.status(404).json({ error: 'Node niet gevonden' });

    await scheduleCloneForNodeRepo(node.id, repo.id);
    res.json({ ok: true, queued: true });
  } catch (err) {
    res.status(500).json({ error: 'Clone inplannen mislukt.' });
  }
});

router.post('/nodes/:id/create-repo', async (req, res) => {
  const { repoName, description, isPrivate, nodePath, accountId, groupName } = req.body;

  if (!repoName || !nodePath) {
    req.flash('error', 'Repository naam en pad op de node zijn verplicht.');
    return res.redirect('/repos/nodes');
  }

  try {
    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!node) {
      req.flash('error', 'Node niet gevonden.');
      return res.redirect('/repos/nodes');
    }

    let token, githubUser, account_id_for_repo = null;

    if (accountId) {
      const acc = await getAccount(pool, parseInt(accountId, 10), req.session.user.id);
      if (!acc || !acc.token) {
        req.flash('error', 'Geselecteerd GitHub account is ongeldig.');
        return res.redirect('/repos/nodes');
      }
      token = acc.token;
      githubUser = acc.githubUser;
      account_id_for_repo = acc.id;
    } else {
      const def = await getDefaultAccount(pool, req.session.user.id);
      if (def) {
        token = def.token;
        githubUser = def.githubUser;
        account_id_for_repo = def.id;
      } else {
        const legacy = await getUserGitHub(pool, req.session.user.id);
        token = legacy.token;
        githubUser = legacy.githubUser;
      }
    }

    if (!token || !githubUser) {
      req.flash('error', 'Stel eerst een GitHub account in.');
      return res.redirect('/repos/nodes');
    }

    const created = await apiRequest('POST', '/user/repos', token, {
      name: repoName,
      description: description || `Repo: ${repoName}`,
      private: !!isPrivate,
    });

    const remoteShort = `${githubUser}/${repoName}`;

    const result = await pool.query(
      'INSERT INTO repos (user_id, account_id, name, path, remote, group_name) VALUES (?, ?, ?, ?, ?, ?)',
      [req.session.user.id, account_id_for_repo, repoName, nodePath, remoteShort, groupName || '']
    );
    const repoId = result.insertId;

    await assignRepoToNode(pool, node.id, repoId, 'bidirectional', false, nodePath);
    await scheduleCreateForNodeRepo(node.id, repoId);

    req.flash('success', `Repository "${repoName}" wordt aangemaakt op node "${node.name}". ${created.html_url || ''}`);
  } catch (err) {
    console.error('Create repo on node error:', err);
    req.flash('error', 'Repo aanmaken op node mislukt: ' + (err.message || 'onbekend'));
  }
  res.redirect('/repos/nodes');
});

router.post('/nodes/:id/unassign-repo/:repoId', async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.repoId, req.session.user.id]);
    if (!repo) {
      req.flash('error', 'Repository niet gevonden.');
      return res.redirect('/repos/nodes');
    }
    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!node) {
      req.flash('error', 'Node niet gevonden.');
      return res.redirect('/repos/nodes');
    }
    await unassignRepoFromNode(pool, node.id, repo.id);
    req.flash('success', `Repository "${repo.name}" losgekoppeld van node "${node.name}".`);
  } catch (err) {
    req.flash('error', 'Loskoppelen mislukt.');
  }
  res.redirect('/repos/nodes');
});

router.post('/nodes/:id/sync-repo/:repoId', async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.repoId, req.session.user.id]);
    if (!repo) return res.status(404).json({ error: 'Repo niet gevonden' });

    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!node) return res.status(404).json({ error: 'Node niet gevonden' });

    await scheduleSyncForNodeRepo(node.id, repo.id, 'sync');
    res.json({ ok: true, queued: true });
  } catch (err) {
    res.status(500).json({ error: 'Sync inplannen mislukt.' });
  }
});

router.post('/repos/:id/sync-all-nodes', async (req, res) => {
  try {
    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!repo) return res.status(404).json({ error: 'Repo niet gevonden' });

    await scheduleSyncForAllNodes(repo.id, 'sync');
    res.json({ ok: true, queued: true });
  } catch (err) {
    res.status(500).json({ error: 'Sync inplannen mislukt.' });
  }
});

module.exports = router;
