'use strict';

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GIT_TIMEOUT, GIT_LONG_TIMEOUT, GIT_FETCH_INTERVAL, GIT_FETCH_CONCURRENCY, GIT_USER_EMAIL, GIT_USER_NAME } = require('./constants');

// ============================================================================
// Git helper functions (gebaseerd op shared/git-common.js)
// ============================================================================

function tokenize(cmd) {
  const args = [];
  let i = 0;
  const len = cmd.length;
  while (i < len) {
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) break;
    let token = '';
    let quote = null;
    while (i < len) {
      const ch = cmd[i];
      if (quote) {
        if (ch === quote) {
          quote = null;
          i++;
          continue;
        }
        token += ch;
        i++;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
      } else if (/\s/.test(ch)) {
        break;
      } else {
        token += ch;
        i++;
      }
    }
    args.push(token);
  }
  return args;
}

function buildAuthArgs(token) {
  if (!token) return [];
  const auth = Buffer.from(`${token}:x-oauth-basic`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${auth}`];
}

function cleanRemoteUrl(remoteRaw) {
  if (!remoteRaw) return '';
  return String(remoteRaw)
    .trim()
    .replace(/^(https?:\/\/)[^/@\s]+@/i, '$1')
    .replace(/\.git$/i, '');
}

function parseCount(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function computeStatusKey(changes, behindCount) {
  if (changes > 0 && behindCount > 0) return 'both';
  if (changes > 0) return 'changes';
  if (behindCount > 0) return 'behind';
  return 'clean';
}

const STATUS_META = Object.freeze({
  clean: { icon: '\u2713', color: 'green' },
  both: { icon: '\u21C5', color: 'orange' },
  changes: { icon: '\u2191', color: 'yellow' },
  behind: { icon: '\u21C3', color: 'cyan' },
});

function buildStatus(input) {
  const changes = Number(input && input.changes) || 0;
  const behindCount = Number(input && input.behindCount) || 0;
  const aheadCount = Number(input && input.aheadCount) || 0;
  const statusKey = computeStatusKey(changes, behindCount);
  return {
    status: statusKey,
    icon: STATUS_META[statusKey].icon,
    color: STATUS_META[statusKey].color,
    changes,
    behindCount,
    aheadCount,
    branch: (input && input.branch) || '',
    remote: (input && input.remote) || '',
    fetchedAt: (input && input.fetchedAt) || null,
  };
}

function noGitStatus() {
  return {
    status: 'no-git',
    icon: '!',
    color: 'red',
    changes: 0,
    behindCount: 0,
    aheadCount: 0,
    branch: '',
    remote: '',
    fetchedAt: null,
  };
}

function noRemoteStatus(input) {
  const changes = Number(input && input.changes) || 0;
  const hasChanges = changes > 0;
  return {
    status: hasChanges ? 'changes-no-remote' : 'ok-no-remote',
    icon: '?',
    color: hasChanges ? 'orange' : 'gray',
    changes,
    behindCount: 0,
    aheadCount: 0,
    branch: (input && input.branch) || '',
    remote: '',
    fetchedAt: (input && input.fetchedAt) || null,
  };
}

function createFetchThrottle(intervalMs) {
  const interval = Number(intervalMs) > 0 ? Number(intervalMs) : 0;
  const lastAttempt = new Map();
  const lastSuccess = new Map();

  return {
    shouldFetch(key, opts) {
      if (opts && opts.skipFetch) return false;
      const now = Date.now();
      const last = lastAttempt.get(key) || 0;
      if (now - last < interval) return false;
      lastAttempt.set(key, now);
      return true;
    },
    markSuccess(key) {
      const now = Date.now();
      lastAttempt.set(key, now);
      lastSuccess.set(key, now);
    },
    markFailure(key) {
      lastAttempt.delete(key);
    },
    lastFetchAt(key) {
      return lastSuccess.get(key) || null;
    },
    reset(key) {
      if (key === undefined) {
        lastAttempt.clear();
        lastSuccess.clear();
      } else {
        lastAttempt.delete(key);
        lastSuccess.delete(key);
      }
    },
  };
}

// Eén gedeelde fetch-throttle per proces. markFailure() geeft het slot vrij
// zodat een mislukte fetch bij de volgende status-call opnieuw probeert.
const fetchThrottle = createFetchThrottle(GIT_FETCH_INTERVAL);

// Laatst berekende ahead/behind per repo. Zonder deze cache zou een status-call
// binnen het fetch-interval 0 tonen in plaats van de laatst bekende waarden.
const statusCache = new Map();

/**
 * Voer een git-commando uit ZONDER shell.
 * cmd mag een string (wordt getokenizeerd) of een string[] zijn.
 * opts.token wordt gebruikt om een tijdelijke Authorization header mee te sturen.
 * Geeft getrimde stdout terug, of null bij falen.
 */
function git(cmd, cwd, timeout, opts) {
  opts = opts || {};
  const args = Array.isArray(cmd) ? cmd.slice() : tokenize(String(cmd));
  if (opts.token) {
    args.unshift(...buildAuthArgs(opts.token));
  }
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeout || GIT_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    if (result.error || result.status !== 0) return null;
    return (result.stdout || '').trim();
  } catch (err) {
    return null;
  }
}

function isGitRepo(dir) {
  if (!dir || typeof dir !== 'string') return false;
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function getBranch(repoPath) {
  const branch = git('rev-parse --abbrev-ref HEAD', repoPath);
  return branch || 'main';
}

function hasUncommittedChanges(repoPath) {
  const status = git('status --porcelain', repoPath);
  return status !== null && status.length > 0;
}

function hasUnpushedCommits(repoPath, token) {
  const branch = getBranch(repoPath);
  const remote = git('remote get-url origin', repoPath);
  if (!remote) return false;
  git('fetch origin', repoPath, GIT_LONG_TIMEOUT, { token });
  const ahead = git(`rev-list --count origin/${branch}..${branch}`, repoPath);
  return ahead !== null && parseInt(ahead, 10) > 0;
}

function getRemoteShort(repoPath) {
  const remote = git('remote get-url origin', repoPath);
  if (!remote) return '';
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match ? match[1] : '';
}

function getRepoStatus(repoPath, token, opts) {
  opts = opts || {};
  if (!isGitRepo(repoPath)) {
    return noGitStatus();
  }

  const status = git('status --porcelain', repoPath);
  const changes = status ? status.split('\n').filter(Boolean).length : 0;

  const branch = getBranch(repoPath);
  const remoteRaw = git('remote get-url origin', repoPath);
  if (!remoteRaw) {
    return noRemoteStatus({ changes, branch });
  }

  let behindCount = 0, aheadCount = 0;
  const cached = statusCache.get(repoPath);
  if (cached && cached.branch === branch) {
    behindCount = cached.behindCount;
    aheadCount = cached.aheadCount;
  }

  if (fetchThrottle.shouldFetch(repoPath, opts)) {
    const fetched = git('fetch origin', repoPath, GIT_LONG_TIMEOUT, { token });
    if (fetched === null) fetchThrottle.markFailure(repoPath);
    else fetchThrottle.markSuccess(repoPath);

    // Ook bij een mislukte fetch de bestaande origin-refs tonen; de throttle
    // staat intussen een nieuwe poging toe.
    behindCount = parseCount(git(`rev-list --count ${branch}..origin/${branch}`, repoPath));
    aheadCount = parseCount(git(`rev-list --count origin/${branch}..${branch}`, repoPath));
    statusCache.set(repoPath, { branch, behindCount, aheadCount });
  }

  return buildStatus({
    changes,
    behindCount,
    aheadCount,
    branch,
    remote: cleanRemoteUrl(remoteRaw),
    fetchedAt: fetchThrottle.lastFetchAt(repoPath),
  });
}

function gitAsync(cmd, cwd, timeout, opts) {
  return gitAsyncRaw(cmd, cwd, timeout, opts).then((out) => (out === null ? null : out.trim()));
}

/**
 * Zoals gitAsync, maar zonder de output te trimmen. Nodig voor porcelain -z
 * output, waarbij entries met een leading spatie (unstaged changes) anders
 * corrupt raken.
 */
function gitAsyncRaw(cmd, cwd, timeout, opts) {
  return new Promise((resolve) => {
    opts = opts || {};
    const args = Array.isArray(cmd) ? cmd.slice() : tokenize(String(cmd));
    if (opts.token) args.unshift(...buildAuthArgs(opts.token));
    const proc = spawn('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeout || GIT_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => resolve(code === 0 ? stdout : null));
    proc.on('error', () => resolve(null));
  });
}

// Globale rem op het aantal gelijktijdige `git fetch`-processen. Zonder deze
// limiet start een dashboard-refresh voor tientallen repo's even zoveel
// netwerkprocessen tegelijk, wat GitHub én de machine onnodig belast.
let activeFetches = 0;
const fetchQueue = [];

function withFetchSlot(fn) {
  return new Promise((resolve) => {
    const run = () => {
      activeFetches++;
      Promise.resolve()
        .then(fn)
        .then(resolve, (result) => {
          if (result === null) resolve(null);
        })
        .catch((err) => {
          console.error('[FETCH SLOT] Error in fetch slot:', err.message || err);
          resolve(null);
        })
        .finally(() => {
          activeFetches--;
          const next = fetchQueue.shift();
          if (next) next();
        });
    };
    if (activeFetches < GIT_FETCH_CONCURRENCY) run();
    else fetchQueue.push(run);
  });
}

function fetchOrigin(repoPath, token, timeout) {
  return withFetchSlot(() => gitAsync('fetch origin', repoPath, timeout || GIT_LONG_TIMEOUT, { token }));
}

async function getRepoStatusAsync(repoPath, token, opts) {
  opts = opts || {};
  if (!isGitRepo(repoPath)) {
    return noGitStatus();
  }

  const [statusOut, branch, remoteRaw] = await Promise.all([
    gitAsync('status --porcelain', repoPath),
    gitAsync('rev-parse --abbrev-ref HEAD', repoPath),
    gitAsync('remote get-url origin', repoPath),
  ]);

  const changes = statusOut ? statusOut.split('\n').filter(Boolean).length : 0;
  const resolvedBranch = branch || 'main';

  if (!remoteRaw) {
    return noRemoteStatus({ changes, branch: resolvedBranch });
  }

  let behindCount = 0, aheadCount = 0;
  const cached = statusCache.get(repoPath);
  if (cached && cached.branch === resolvedBranch) {
    behindCount = cached.behindCount;
    aheadCount = cached.aheadCount;
  }

  if (fetchThrottle.shouldFetch(repoPath, opts)) {
    const fetched = await fetchOrigin(repoPath, token);
    if (fetched === null) fetchThrottle.markFailure(repoPath);
    else fetchThrottle.markSuccess(repoPath);

    // Ook bij een mislukte fetch de bestaande origin-refs tonen; de throttle
    // staat intussen een nieuwe poging toe.
    const [behind, ahead] = await Promise.all([
      gitAsync(`rev-list --count ${resolvedBranch}..origin/${resolvedBranch}`, repoPath),
      gitAsync(`rev-list --count origin/${resolvedBranch}..${resolvedBranch}`, repoPath),
    ]);
    behindCount = parseCount(behind);
    aheadCount = parseCount(ahead);
    statusCache.set(repoPath, { branch: resolvedBranch, behindCount, aheadCount });
  }

  return buildStatus({
    changes,
    behindCount,
    aheadCount,
    branch: resolvedBranch,
    remote: cleanRemoteUrl(remoteRaw),
    fetchedAt: fetchThrottle.lastFetchAt(repoPath),
  });
}

function getRepoData(repoPath) {
  if (!isGitRepo(repoPath)) return { gitStatus: '', changedFiles: '', logEntries: '' };

  const gitStatus = git('status --porcelain', repoPath) || '';
  const logEntries = git('log --oneline -20', repoPath) || '';

  let changedFiles = '';
  const headCommit = git('rev-parse HEAD', repoPath);
  if (headCommit) {
    const parent = git('rev-parse HEAD~1', repoPath);
    if (parent) {
      changedFiles = git(`diff --name-status ${parent}..${headCommit}`, repoPath) || '';
    }
    if (!changedFiles) {
      changedFiles = git('diff --name-status --staged', repoPath)
        || git('diff --name-status', repoPath) || '';
    }
  } else {
    changedFiles = git('diff --cached --name-status', repoPath) || '';
  }

  return { gitStatus, changedFiles, logEntries };
}

/**
 * Async variant van getRepoData die de event-loop niet blokkeert. Gebruik deze
 * in request-/socketpaden; de sync variant is alleen bedoeld voor CLI-scripts.
 */
async function getRepoDataAsync(repoPath) {
  if (!isGitRepo(repoPath)) return { gitStatus: '', changedFiles: '', logEntries: '' };

  const [statusOut, logOut, headCommit] = await Promise.all([
    gitAsync('status --porcelain', repoPath),
    gitAsync('log --oneline -20', repoPath),
    gitAsync('rev-parse HEAD', repoPath),
  ]);

  const gitStatus = statusOut || '';
  const logEntries = logOut || '';

  let changedFiles = '';
  if (headCommit) {
    const parent = await gitAsync('rev-parse HEAD~1', repoPath);
    if (parent) {
      changedFiles = (await gitAsync(`diff --name-status ${parent}..${headCommit}`, repoPath)) || '';
    }
    if (!changedFiles) {
      changedFiles = (await gitAsync('diff --name-status --staged', repoPath))
        || (await gitAsync('diff --name-status', repoPath)) || '';
    }
  } else {
    changedFiles = (await gitAsync('diff --cached --name-status', repoPath)) || '';
  }

  return { gitStatus, changedFiles, logEntries };
}

/**
 * Synchroniseer een enkele repo met zijn GitHub remote.
 *
 * @param {object} repo  - { id, name, path, remote }
 * @param {string} token - GitHub token
 * @param {object} [opts]
 * @param {object} [opts.io]   - Socket.IO instance voor live logs
 * @param {function} [opts.log] - async (repoId, action, message) => void  (naar DB)
 * @returns {Promise<{ok:boolean, reason?:string, logs:array}>}
 */
async function syncRepo(repo, token, opts) {
  opts = opts || {};
  const io = opts.io;
  const dbLog = opts.log || (async () => {});
  const p = repo.path;
  const name = repo.name;
  const repoId = repo.id;
  const logs = [];

  const emit = (msg, type) => {
    logs.push({ msg, type });
    if (io) io.to(`repo-${repoId}`).emit('sync-log', { msg, type });
  };

  // Async variant van hasUncommittedChanges, zonder de event-loop te blokkeren.
  const hasChanges = async () => {
    const status = await gitAsync('status --porcelain', p);
    return status !== null && status.length > 0;
  };

  if (!isGitRepo(p)) {
    emit(`[SKIP] ${name}: geen git repository`, 'warning');
    await dbLog(repoId, 'sync', 'SKIP: geen git repository');
    return { ok: false, reason: 'no-git', logs };
  }

  if (!repo.remote) {
    emit(`[SKIP] ${name}: geen remote ingesteld`, 'warning');
    await dbLog(repoId, 'sync', 'SKIP: geen remote');
    return { ok: false, reason: 'no-remote', logs };
  }

  // Remote altijd opslaan zonder token (veiligheid). Corrigeer ook een bestaande
  // origin die niet klopt (bijv. alleen de owner-URL i.p.v. owner/repo).
  const remoteUrl = `https://github.com/${repo.remote}.git`;
  const existingRemote = await gitAsync('remote get-url origin', p);
  const normalized = (u) => String(u || '').replace(/\.git$/, '');
  if (!existingRemote) {
    await gitAsync(['remote', 'add', 'origin', remoteUrl], p);
  } else if (existingRemote.includes('@') || normalized(existingRemote) !== normalized(remoteUrl)) {
    await gitAsync(['remote', 'set-url', 'origin', remoteUrl], p);
  }

  await gitAsync(['config', 'user.email', GIT_USER_EMAIL], p);
  await gitAsync(['config', 'user.name', GIT_USER_NAME], p);

  const branch = await gitAsync('rev-parse --abbrev-ref HEAD', p) || 'main';

  if (await hasChanges()) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await gitAsync(['add', '-A'], p);
    const commitMsg = opts.commitMessage || `auto-sync: ${now}`;
    const commitResult = await gitAsync(['commit', '-m', commitMsg], p);
    if (commitResult !== null) {
      emit(`[COMMIT] ${name}: ${commitMsg}`, 'success');
      await dbLog(repoId, 'commit', commitMsg);
    }
  }

  const fetchOk = await fetchOrigin(p, token);
  if (fetchOk === null) fetchThrottle.markFailure(p);
  else fetchThrottle.markSuccess(p);
  const behind = await gitAsync(`rev-list --count ${branch}..origin/${branch}`, p);
  const behindCount = behind ? parseInt(behind, 10) : 0;

  if (behindCount > 0) {
    emit(`[PULL] ${name}: remote wijzigingen ophalen (${behindCount} commits)`, 'info');
    let pullResult = await gitAsync(['pull', '--no-edit', '--no-rebase', 'origin', branch], p, GIT_LONG_TIMEOUT, { token });
    if (pullResult === null) {
      // Retry met --allow-unrelated-histories voor het geval de remote
      // een eigen initiële commit heeft (bv. GitHub README).
      pullResult = await gitAsync(['pull', '--allow-unrelated-histories', '--no-edit', '--no-rebase', 'origin', branch], p, GIT_LONG_TIMEOUT, { token });
    }
    if (pullResult === null) {
      const conflictFiles = await gitAsync(['diff', '--name-only', '--diff-filter=U'], p);
      if (conflictFiles) {
        emit(`[CONFLICT] ${name}: merge conflicten`, 'danger');
        await gitAsync(['merge', '--abort'], p);
        await dbLog(repoId, 'sync', 'CONFLICT: merge conflicten');
        return { ok: false, reason: 'conflict', logs };
      }
      emit(`[ERROR] ${name}: pull mislukt`, 'danger');
      await dbLog(repoId, 'sync', 'ERROR: pull mislukt');
      return { ok: false, reason: 'pull-failed', logs };
    }
    emit(`[MERGED] ${name}: remote wijzigingen gemerged`, 'success');
    await dbLog(repoId, 'pull', `Merged ${behindCount} commits`);
  }

  const aheadAfter = await gitAsync(`rev-list --count origin/${branch}..${branch}`, p);
  const aheadAfterCount = aheadAfter ? parseInt(aheadAfter, 10) : 0;

  if (aheadAfterCount > 0) {
    emit(`[PUSH] ${name}: ${aheadAfterCount} commits pushen...`, 'info');
    const pushResult = await gitAsync(['push', 'origin', branch], p, GIT_LONG_TIMEOUT, { token });
    if (pushResult === null) {
      emit(`[ERROR] ${name}: push mislukt`, 'danger');
      await dbLog(repoId, 'sync', 'ERROR: push mislukt');
      return { ok: false, reason: 'push-failed', logs };
    }
    emit(`[PUSHED] ${name}: succesvol gepusht`, 'success');
    await dbLog(repoId, 'push', `Pushed ${aheadAfterCount} commits`);
  }

  if (aheadAfterCount === 0 && !(await hasChanges()) && behindCount === 0) {
    emit(`[UP-TO-DATE] ${name}`, 'muted');
    await dbLog(repoId, 'sync', 'UP-TO-DATE');
  }

  // Ververs de statuscache met de situatie na de sync, zodat een status-call
  // binnen het fetch-interval de juiste (en niet de oude) waarden toont.
  const [behindFinal, aheadFinal] = await Promise.all([
    gitAsync(`rev-list --count ${branch}..origin/${branch}`, p),
    gitAsync(`rev-list --count origin/${branch}..${branch}`, p),
  ]);
  statusCache.set(p, {
    branch,
    behindCount: parseCount(behindFinal),
    aheadCount: parseCount(aheadFinal),
  });

  return { ok: true, logs };
}

// --- Staging / selectief committen ---------------------------------------

const STATUS_LABELS = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed',
  C: 'copied', T: 'typechange', U: 'conflict', '?': 'untracked',
};

function statusLabel(x, y) {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict';
  const code = x !== ' ' && x !== '?' ? x : y;
  return STATUS_LABELS[code] || 'modified';
}

/**
 * Parse `git status --porcelain -z` output. Retourneert per bestand de
 * index/worktree-status, of het gestaged is en of het untracked is.
 */
function parseStatusZ(out) {
  if (!out) return [];
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const item = {
      path: entry.slice(3),
      index: x,
      worktree: y,
      status: statusLabel(x, y),
      staged: x !== ' ' && x !== '?',
      untracked: x === '?' && y === '?',
      conflict: statusLabel(x, y) === 'conflict',
    };
    if (x === 'R' || x === 'C') item.origPath = parts[++i] || '';
    files.push(item);
  }
  return files;
}

const SENSITIVE_BASENAMES = new Set([
  '.env', '.env.local', '.env.production', '.npmrc', '.netrc',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'credentials.json',
]);
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks'];
const BULKY_EXTENSIONS = ['.zip', '.tar', '.gz', '.7z', '.rar', '.iso', '.dmg', '.exe', '.msi', '.bin', '.sqlite', '.sql', '.db', '.mp4', '.mov', '.mp3'];
const BULKY_DIRS = ['node_modules/', 'dist/', 'build/', '.next/', 'vendor/', 'coverage/'];
const LARGE_FILE_BYTES = 5 * 1024 * 1024;

function isSafeRepoFile(repoPath, file) {
  if (!file || typeof file !== 'string') return null;
  if (file.includes('\0')) return null;
  const root = path.resolve(repoPath);
  const abs = path.resolve(root, file);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * Bestandsstatus + waarschuwingen (secrets, grote bestanden, build-output).
 */
async function getChangedFilesDetailed(repoPath) {
  if (!isGitRepo(repoPath)) return { files: [], warnings: [] };
  const raw = await gitAsyncRaw(['status', '--porcelain', '-z'], repoPath);
  const files = parseStatusZ(raw);
  const warnings = [];

  for (const f of files) {
    const abs = isSafeRepoFile(repoPath, f.path);
    if (!abs) continue;
    const base = path.basename(f.path).toLowerCase();
    const lower = f.path.toLowerCase();
    let reason = '';
    if (SENSITIVE_BASENAMES.has(base) || SENSITIVE_EXTENSIONS.some((ext) => base.endsWith(ext))) {
      reason = 'secret';
    } else if (BULKY_DIRS.some((dir) => lower.startsWith(dir) || lower.includes('/' + dir))) {
      reason = 'build-output';
    } else if (BULKY_EXTENSIONS.some((ext) => base.endsWith(ext))) {
      reason = 'bulky';
    }
    if (reason) {
      warnings.push({ path: f.path, reason });
      continue;
    }
    try {
      const stat = await fs.promises.stat(abs);
      if (stat.isFile() && stat.size > LARGE_FILE_BYTES) {
        warnings.push({ path: f.path, reason: 'large', size: stat.size });
      }
    } catch {
      // bestand kan intussen verwijderd zijn
    }
  }

  return { files, warnings };
}

async function stageFiles(repoPath, files) {
  const safe = (files || []).map((f) => isSafeRepoFile(repoPath, f)).filter(Boolean);
  if (!safe.length) return { ok: false, error: 'Geen geldige bestanden opgegeven.' };
  const out = await gitAsync(['add', '-A', '--', ...safe], repoPath);
  return out === null
    ? { ok: false, error: 'Stagen mislukt.' }
    : { ok: true };
}

async function unstageFiles(repoPath, files) {
  const safe = (files || []).map((f) => isSafeRepoFile(repoPath, f)).filter(Boolean);
  if (!safe.length) return { ok: false, error: 'Geen geldige bestanden opgegeven.' };
  const hasHead = (await gitAsync('rev-parse --verify HEAD', repoPath)) !== null;
  const out = hasHead
    ? await gitAsync(['reset', 'HEAD', '--', ...safe], repoPath)
    : await gitAsync(['rm', '-r', '--cached', '--ignore-unmatch', '--', ...safe], repoPath);
  return out === null
    ? { ok: false, error: 'Unstagen mislukt.' }
    : { ok: true };
}

async function discardFiles(repoPath, files) {
  const safe = (files || []).map((f) => isSafeRepoFile(repoPath, f)).filter(Boolean);
  if (!safe.length) return { ok: false, error: 'Geen geldige bestanden opgegeven.' };

  const hasHead = (await gitAsync('rev-parse --verify HEAD', repoPath)) !== null;
  let ok = true;

  for (const abs of safe) {
    const rel = path.relative(path.resolve(repoPath), abs);
    const tracked = (await gitAsync(['ls-files', '--error-unmatch', '--', rel], repoPath)) !== null;
    if (tracked) {
      const out = hasHead
        ? await gitAsync(['restore', '--source=HEAD', '--staged', '--worktree', '--', rel], repoPath)
        : await gitAsync(['rm', '-r', '--cached', '--ignore-unmatch', '--', rel], repoPath);
      if (out === null) { ok = false; continue; }
      if (!hasHead) {
        try { await fs.promises.rm(abs, { recursive: true, force: true }); } catch { ok = false; }
      }
    } else {
      // Untracked bestand/map: verwijderen met git clean (blijft binnen repo).
      const out = await gitAsync(['clean', '-f', '-d', '--', rel], repoPath);
      if (out === null) ok = false;
    }
  }

  return ok ? { ok: true } : { ok: false, error: 'Sommige bestanden konden niet worden teruggezet.' };
}

/**
 * Commit alleen de geselecteerde bestanden. Bestaande staging wordt eerst
 * geleegd, zodat er geen onbedoelde bestanden meegaan.
 */
async function commitSelected(repoPath, files, message) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'Commit-bericht is verplicht.' };
  const safe = (files || []).map((f) => isSafeRepoFile(repoPath, f)).filter(Boolean);
  if (!safe.length) return { ok: false, error: 'Selecteer minimaal één bestand.' };

  const hasHead = (await gitAsync('rev-parse --verify HEAD', repoPath)) !== null;
  if (hasHead) await gitAsync(['reset', 'HEAD', '--', '.'], repoPath);
  else await gitAsync(['rm', '-r', '--cached', '--ignore-unmatch', '--', '.'], repoPath);

  const staged = await gitAsync(['add', '-A', '--', ...safe], repoPath);
  if (staged === null) return { ok: false, error: 'Stagen mislukt.' };

  const out = await gitAsync(['commit', '-m', msg], repoPath);
  if (out === null) return { ok: false, error: 'Commit mislukt (mogelijk geen wijzigingen of een git-hook blokkeert).' };
  return { ok: true, output: out };
}

// --- .gitignore -----------------------------------------------------------

async function readGitignore(repoPath) {
  try {
    return await fs.promises.readFile(path.join(repoPath, '.gitignore'), 'utf-8');
  } catch {
    return '';
  }
}

async function writeGitignore(repoPath, content) {
  const target = path.join(path.resolve(repoPath), '.gitignore');
  const root = path.resolve(repoPath);
  if (!target.startsWith(root + path.sep)) return { ok: false, error: 'Ongeldig pad.' };
  const text = String(content || '').replace(/\r\n/g, '\n');
  if (text.length > 64 * 1024) return { ok: false, error: '.gitignore is te groot (max 64 KB).' };
  try {
    await fs.promises.writeFile(target, text, 'utf-8');
    return { ok: true };
  } catch {
    return { ok: false, error: 'Schrijven van .gitignore mislukt.' };
  }
}

// --- Branches -------------------------------------------------------------

function isValidBranchName(name) {
  if (!name || typeof name !== 'string' || name.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false;
  if (name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  return true;
}

async function createBranch(repoPath, name, from, token) {
  if (!isValidBranchName(name)) return { ok: false, error: 'Ongeldige branch-naam.' };
  const base = from || (await gitAsync('rev-parse --abbrev-ref HEAD', repoPath)) || 'main';
  const out = await gitAsync(['checkout', '-b', name, base], repoPath);
  if (out === null) return { ok: false, error: `Kan branch ${name} niet aanmaken.` };
  const remote = await gitAsync('remote get-url origin', repoPath);
  if (remote) {
    await gitAsync(['push', '-u', 'origin', name], repoPath, GIT_LONG_TIMEOUT, { token });
  }
  return { ok: true, branch: name };
}

async function deleteBranch(repoPath, name, token) {
  if (!isValidBranchName(name)) return { ok: false, error: 'Ongeldige branch-naam.' };
  const current = await gitAsync('rev-parse --abbrev-ref HEAD', repoPath);
  if (current === name) return { ok: false, error: 'Kan de huidige branch niet verwijderen.' };
  const out = await gitAsync(['branch', '-D', name], repoPath);
  if (out === null) return { ok: false, error: `Kan branch ${name} niet verwijderen.` };
  const remote = await gitAsync('remote get-url origin', repoPath);
  if (remote) {
    await gitAsync(['push', 'origin', '--delete', name], repoPath, GIT_LONG_TIMEOUT, { token });
  }
  return { ok: true };
}

async function renameBranch(repoPath, from, to, token) {
  if (!isValidBranchName(from) || !isValidBranchName(to)) {
    return { ok: false, error: 'Ongeldige branch-naam.' };
  }
  const current = await gitAsync('rev-parse --abbrev-ref HEAD', repoPath);
  const args = current === from ? ['branch', '-m', to] : ['branch', '-m', from, to];
  const out = await gitAsync(args, repoPath);
  if (out === null) return { ok: false, error: `Kan branch ${from} niet hernoemen.` };
  const remote = await gitAsync('remote get-url origin', repoPath);
  if (remote) {
    await gitAsync(['push', '-u', 'origin', to], repoPath, GIT_LONG_TIMEOUT, { token });
    await gitAsync(['push', 'origin', '--delete', from], repoPath, GIT_LONG_TIMEOUT, { token });
  }
  return { ok: true, branch: to };
}

// --- Branches (async, voor het API-requestpad) ---------------------------

async function getBranchAsync(repoPath) {
  const branch = await gitAsync('rev-parse --abbrev-ref HEAD', repoPath);
  return branch || 'main';
}

async function listBranches(repoPath) {
  const [list, current] = await Promise.all([
    gitAsync('branch -a', repoPath),
    getBranchAsync(repoPath),
  ]);
  const branches = (list || '')
    .split('\n')
    .map((b) => b.replace(/^\*?\s*/, '').trim())
    .filter(Boolean);
  return { current, branches };
}

async function switchBranch(repoPath, branch) {
  if (!isValidBranchName(branch)) return { ok: false, error: 'INVALID_BRANCH' };
  const output = await gitAsync(['checkout', branch], repoPath);
  if (output === null) return { ok: false, error: 'SWITCH_FAILED' };
  // Andere branch betekent andere ahead/behind: cache en fetch-throttle vervallen.
  statusCache.delete(repoPath);
  fetchThrottle.reset(repoPath);
  return { ok: true, current: await getBranchAsync(repoPath), output };
}

// --- Conflictoplossing (async) -------------------------------------------

/**
 * Lost een merge-conflict op met de opgegeven strategie. Alle git-aanroepen
 * zijn async, zodat een trage remote de event loop niet blokkeert.
 * Retourneert { ok, error?, ... } met error-codes die de route kan mappen.
 */
async function resolveConflict(repoPath, strategy, token) {
  if (!['ours', 'theirs', 'abort'].includes(strategy)) {
    return { ok: false, error: 'INVALID_STRATEGY' };
  }

  const branch = await getBranchAsync(repoPath);

  const fetched = await gitAsync('fetch origin', repoPath, GIT_TIMEOUT, { token });
  if (fetched === null) fetchThrottle.markFailure(repoPath);
  else fetchThrottle.markSuccess(repoPath);

  if (strategy === 'abort') {
    await gitAsync(['merge', '--abort'], repoPath);
    return { ok: true, aborted: true, current: await getBranchAsync(repoPath) };
  }

  const status = await gitAsync('status --porcelain', repoPath);
  if (status) {
    await gitAsync(['add', '-A'], repoPath);
    await gitAsync(['commit', '-m', 'auto-sync: resolve'], repoPath);
  }

  const mergeResult = await gitAsync(
    ['merge', '--allow-unrelated-histories', '-s', 'recursive', '-X', strategy, '--no-edit', `origin/${branch}`],
    repoPath,
    GIT_LONG_TIMEOUT,
    { token }
  );

  if (mergeResult === null) {
    const unmerged = await gitAsync(['diff', '--name-only', '--diff-filter=U'], repoPath);
    if (!unmerged) {
      await gitAsync(['merge', '--abort'], repoPath);
      return { ok: false, error: 'MERGE_FAILED' };
    }

    const files = unmerged.split('\n').map((f) => f.trim()).filter(Boolean);
    for (const file of files) {
      const statusLine = (await gitAsync(['status', '--porcelain', '--', file], repoPath)) || '';
      const xy = statusLine.replace(/^\s*/, '').substring(0, 2);
      let resolved;
      if (strategy === 'ours') {
        resolved = xy[0] === 'D'
          ? (await gitAsync(['rm', '--', file], repoPath)) !== null
          : (await gitAsync(['checkout', '--ours', '--', file], repoPath)) !== null;
      } else {
        resolved = xy[1] === 'D'
          ? (await gitAsync(['rm', '--', file], repoPath)) !== null
          : (await gitAsync(['checkout', '--theirs', '--', file], repoPath)) !== null;
      }
      if (!resolved) {
        await gitAsync(['merge', '--abort'], repoPath);
        return { ok: false, error: 'MERGE_FAILED', file };
      }
    }

    await gitAsync(['add', '-A'], repoPath);
    const commit = await gitAsync(['commit', '-m', `auto-sync: resolve (${strategy})`], repoPath);
    if (commit === null) {
      await gitAsync(['merge', '--abort'], repoPath);
      return { ok: false, error: 'MERGE_FAILED' };
    }
  }

  const pushResult = await gitAsync(['push', 'origin', branch], repoPath, GIT_LONG_TIMEOUT, { token });
  if (pushResult === null) return { ok: false, error: 'PUSH_FAILED' };

  // Na een geslaagde merge + push is de lokale branch gelijk aan origin.
  statusCache.set(repoPath, { branch, behindCount: 0, aheadCount: 0 });

  return { ok: true, current: await getBranchAsync(repoPath), branch, strategy };
}

// --- Statistieken ---------------------------------------------------------

function parseCountObjects(out) {
  if (!out) return 0;
  const map = {};
  for (const line of out.split('\n')) {
    const [key, value] = line.split(':').map((s) => s && s.trim());
    if (key && value) map[key] = parseInt(value, 10) || 0;
  }
  return ((map.size || 0) + (map['size-pack'] || 0)) * 1024;
}

async function getRepoSize(repoPath) {
  const out = await gitAsync('count-objects -v', repoPath);
  return parseCountObjects(out);
}

async function getContributors(repoPath, limit) {
  const out = await gitAsync('log --format=%an|%ae --all', repoPath);
  if (!out) return [];
  const counts = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [name, email] = line.split('|');
    const key = `${name || 'Onbekend'}|${email || ''}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, commits]) => {
      const [name, email] = key.split('|');
      return { name, email, commits };
    })
    .sort((a, b) => b.commits - a.commits)
    .slice(0, limit || 10);
}

async function getCommitDates(repoPath, limit) {
  const out = await gitAsync(`log -n ${Math.max(1, limit || 2000)} --format=%aI`, repoPath);
  if (!out) return [];
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

module.exports = {
  git,
  gitAsync,
  gitAsyncRaw,
  tokenize,
  isGitRepo,
  getBranch,
  getBranchAsync,
  hasUncommittedChanges,
  hasUnpushedCommits,
  getRemoteShort,
  getRepoStatus,
  getRepoStatusAsync,
  getRepoData,
  getRepoDataAsync,
  syncRepo,
  cleanRemoteUrl,
  parseStatusZ,
  getChangedFilesDetailed,
  stageFiles,
  unstageFiles,
  discardFiles,
  commitSelected,
  readGitignore,
  writeGitignore,
  isValidBranchName,
  listBranches,
  switchBranch,
  resolveConflict,
  createBranch,
  deleteBranch,
  renameBranch,
  getRepoSize,
  getContributors,
  getCommitDates,
};
