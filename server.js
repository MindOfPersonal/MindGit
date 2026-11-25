'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');

const pool = require('./db');
const {
  getRepoStatusAsync,
  getRepoDataAsync,
  hasUncommittedChanges,
  syncRepo,
} = require('./lib/git');
const { csrfMiddleware, enforceCsrf } = require('./lib/csrf');
const { notFound, errorHandler } = require('./lib/error');
const { seedSettingsFromEnv } = require('./lib/seed');
const { getUserGitHub, getRepoToken } = require('./lib/settings');
const MariaSessionStore = require('./lib/sessionStore');
const { DEFAULT_LANG, makeT, clientStrings, isSupportedLang } = require('./lib/i18n');
const { logSync, ensureApiTokenTable, cleanupApiTokens, cleanupOldSyncLogs } = require('./lib/db-helpers');
const { AUTO_SYNC_INTERVAL, NODE_STALE_AFTER_MS, NODE_SWEEP_INTERVAL_MS } = require('./lib/constants');
const { setSocketIO, setupAgentWebSocket, processQueue, triggerAutoSync } = require('./lib/sync-orchestrator');
const { resetAllNodesOffline, sweepStaleNodes } = require('./lib/node');
const { getUserTheme, setUserTheme, getThemeCss, THEMES, getGlobalChristmasStatus, setGlobalChristmasStatus } = require('./lib/theme');

const corsMiddleware = require('cors')({
  origin: true,
  credentials: true,
  exposedHeaders: ['Set-Cookie'],
});

const authRoutes = require('./routes/auth');
const repoRoutes = require('./routes/repos');
const repoToolsRoutes = require('./routes/repo-tools');
const githubRoutes = require('./routes/github');
const backupRoutes = require('./routes/backup');
const apiRoutes = require('./routes/api');
const { cleanupOldBackups, createBackup } = require('./lib/backup');

// --- Rate limiting --------------------------------------------------------

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Te veel requests vanaf dit IP, probeer later opnieuw.',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: 'Te veel inlogpogingen, probeer later opnieuw.',
});

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

app.use(require('helmet')({
  contentSecurityPolicy: false,
}));

const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const sessionSecret = process.env.SESSION_SECRET;
const weakSessionSecret = !sessionSecret
  || sessionSecret.startsWith('verander-mij')
  || sessionSecret.length < 32;

if (weakSessionSecret) {
  if (isProduction) {
    // Geen stille fallback in productie: een voorspelbare signing key maakt
    // het mogelijk om geldige sessiecookies te vervalsen.
    throw new Error(
      'SESSION_SECRET ontbreekt of is te zwak (minimaal 32 tekens en niet de standaardwaarde). '
      + 'Stel een sterke waarde in via .env voordat de app in productie start.'
    );
  }
  console.warn('\x1b[33m[WAARSCHUWING] SESSION_SECRET is niet ingesteld of is nog de standaardwaarde. Stel een sterke waarde in via .env.\x1b[0m');
}

const SESSION_TTL = parseInt(process.env.SESSION_TTL_MS || '7200000', 10);

const sessionStore = new MariaSessionStore({ ttl: Math.floor(SESSION_TTL / 1000) });

const sessionMiddleware = session({
  secret: sessionSecret || 'dev-only-insecure-secret-please-overwrite',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: SESSION_TTL,
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
  },
});

// Socket.IO met session support
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin || '';
    const host = req.headers.host || '';
    try {
      callback(null, !origin || new URL(origin).host === host);
    } catch {
      callback(null, false);
    }
  },
});

io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, (err) => {
    if (err) return next(err);
    if (!socket.request.session?.user) return next(new Error('Login required'));
    next();
  });
});

// Agent WebSocket endpoint (raw ws, geen Socket.IO) - auth via X-Node-Key header
// Agents verbinden naar ws(s)://host/agent
setupAgentWebSocket(server);

setSocketIO(io);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(globalLimiter);
app.use(sessionMiddleware);

app.use(express.urlencoded({ extended: true }));
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    if (req.path === '/api/webhook/github') req.rawBody = Buffer.from(buf);
  },
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/agent/scripts', express.static(path.join(__dirname, 'agent/scripts')));

// Downloadbaar agent-pakket (tar.gz) zodat een node-machine niet het hele
// project nodig heeft. Bevat geen secrets (node_modules wordt uitgesloten).
app.get('/agent/download', (req, res) => {
  const { spawn } = require('child_process');
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="mindgit-agent.tar.gz"');
  const tar = spawn('tar', ['-czf', '-', '-C', path.join(__dirname, 'agent'), '--exclude=node_modules', '--exclude=.env', '.']);
  tar.stdout.pipe(res);
  tar.on('error', (err) => {
    console.error('[AGENT DOWNLOAD]', err.message);
    if (!res.headersSent) res.status(500).end('Could not create agent package');
  });
  tar.on('close', (code) => {
    if (code !== 0) {
      console.error('[AGENT DOWNLOAD] tar exited with code', code);
      if (!res.headersSent) res.status(500).end('Could not create agent package');
    }
  });
});

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/repos/browse') && !req.path.startsWith('/repos/diff') && !req.path.startsWith('/repos/commit')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use('/login', authLimiter);

app.use(corsMiddleware);

app.use(flash());

const crypto = require('crypto');

// Verifieer de GitHub webhook-handtekening (X-Hub-Signature-256) tegen het
// geconfigureerde secret. Voorkomt dat onbevoegden een push-event kunnen
// nabootsen en de server zomaar laten pullen/pushen.
function verifyWebhookSignature(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    // Geen secret ingesteld => weiger op productie, laat door in dev met warning.
    if (process.env.NODE_ENV === 'production') return false;
    console.warn('[WEBHOOK] GITHUB_WEBHOOK_SECRET niet ingesteld; webhooks onbeveiligd (dev).');
    return null; // null = "niet geconfigureerd" (dev: gewoon doorlaten)
  }
  const header = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'] || '';
  const prefix = req.headers['x-hub-signature-256'] ? 'sha256=' : 'sha1=';
  if (!header) return false;
  const algo = req.headers['x-hub-signature-256'] ? 'sha256' : 'sha1';
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
  const expected = crypto.createHmac(algo, secret).update(raw).digest('hex');
  if (!header.startsWith(prefix)) return false;
  const supplied = header.slice(prefix.length);
  if (!/^[0-9a-f]+$/i.test(supplied) || supplied.length !== expected.length) return false;
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(supplied, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Webhook endpoint voor GitHub push events (geen CSRF nodig; wel signature)
app.post('/api/webhook/github', async (req, res) => {
  const event = req.headers['x-github-event'];
  if (!event) return res.status(400).json({ error: 'Missing X-GitHub-Event header' });

  const sigValid = verifyWebhookSignature(req);
  if (sigValid === false) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  if (event !== 'push') return res.status(200).json({ ok: true, ignored: event });

  const payload = req.body;
  const remoteShort = payload.repository && payload.repository.full_name;
  if (!remoteShort) return res.status(200).json({ ok: true, ignored: 'no-repo' });

  try {
    const repos = await pool.query('SELECT * FROM repos WHERE remote = ?', [remoteShort]);
    const socketIO = req.app.get('io');

    for (const repo of repos) {
      const { token } = await getRepoToken(pool, repo);
      await syncRepo(repo, token, { io: socketIO, log: logSync });
      if (socketIO) {
        const st = await getRepoStatusAsync(repo.path, token);
        const rd = await getRepoDataAsync(repo.path);
        socketIO.to(`repo-${repo.id}`).emit('repo-update', {
          id: repo.id, name: repo.name, path: repo.path, remote: repo.remote,
          status: st, gitData: rd,
        });
        socketIO.to(`user-watch-${repo.user_id}`).emit('repo-update', {
          id: repo.id, name: repo.name, path: repo.path, remote: repo.remote,
          status: st, gitData: rd,
        });
      }
    }

    res.status(200).json({ ok: true, synced: repos.length });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Desktopclients gebruiken een bearer-token. Browser-sessies mogen de API alleen
// vanaf dezelfde origin gebruiken; CORS alleen voorkomt geen cross-site POSTs.
app.use('/api', (req, res, next) => {
  if (!req.session?.user || /^Bearer\s+/i.test(req.headers.authorization || '')) return next();
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site request denied' });
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        return res.status(403).json({ error: 'Cross-site request denied' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid origin' });
    }
  }
  next();
}, apiRoutes);

app.use(csrfMiddleware());
app.use(enforceCsrf());

app.use((req, res, next) => {
  res.locals.messages = req.flash();
  res.locals.user = req.session.user || null;
  if (res.locals.csrfToken) {
    res.cookie('XSRF-TOKEN', res.locals.csrfToken, { httpOnly: false, sameSite: 'lax' });
  }
  next();
});

// --- Theme middleware ------------------------------------------------------
app.use(async (req, res, next) => {
  const globalChristmas = await getGlobalChristmasStatus(pool);
  let theme = req.session.user ? await getUserTheme(pool, req.session.user.id) : 'glacier';
  
  // Override with Christmas theme if enabled and before Dec 26
  const today = new Date();
  const isChristmasSeason = today.getMonth() === 11 && today.getDate() <= 26;
  if (globalChristmas && isChristmasSeason) {
    theme = 'kerst';
  }
  
  res.locals.theme = theme;
  res.locals.themeCss = getThemeCss(theme);
  res.locals.availableThemes = THEMES;
  res.locals.christmasEnabledGlobally = globalChristmas;
  next();
});

// Theme CSS endpoint
app.get('/theme.css', async (req, res) => {
  const theme = req.session.user ? await getUserTheme(pool, req.session.user.id) : 'glacier';
  res.setHeader('Content-Type', 'text/css');
  res.send(getThemeCss(theme));
});

// --- i18n middleware ------------------------------------------------------
app.use((req, res, next) => {
  const lang = req.session.user && isSupportedLang(req.session.user.language)
    ? req.session.user.language
    : DEFAULT_LANG;
  res.locals.lang = lang;
  res.locals.t = makeT(lang);
  res.locals.i18nClient = clientStrings(lang);
  next();
});

const isAuth = (req, res, next) => {
  if (!req.session.user) {
    // Alleen flashmelding weergeven als de gebruiker niet op login pagina is
    if (req.path !== '/login') {
      req.flash('error', 'Je moet ingelogd zijn.');
    }
    return res.redirect('/login');
  }
  next();
};

app.use('/', authRoutes);
app.use('/repos', isAuth, repoRoutes);
app.use('/repos', isAuth, repoToolsRoutes);
app.use('/repos', isAuth, githubRoutes);
app.use('/repos', isAuth, backupRoutes);

app.get('/', isAuth, (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', isAuth, (req, res) => res.redirect('/repos'));

// --- Socket.IO synchronisatie logica --------------------------------------

const autoSyncTimers = new Map();

function getSessionUser(socket) {
  return socket.request && socket.request.session ? socket.request.session.user : null;
}

async function emitAllRepoStatusForUser(socket, userId) {
  try {
    const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [userId]);
    for (const r of repos) {
      const { token } = await getRepoToken(pool, r);
      const st = await getRepoStatusAsync(r.path, token, { skipFetch: true });
      const rd = await getRepoDataAsync(r.path);
      socket.emit('repo-update', {
        id: r.id, name: r.name, path: r.path, remote: r.remote,
        status: st, gitData: rd,
      });
    }
  } catch (e) {
    // niet fataal
  }
}

let globalWatchInterval = null;
let globalWatchCount = 0;

io.on('connection', (socket) => {
  const user = getSessionUser(socket);

  socket.on('join-repo', async (repoId) => {
    const id = Number(repoId);
    if (!user || !Number.isSafeInteger(id) || id <= 0) return;
    try {
      const rows = await pool.query('SELECT id FROM repos WHERE id = ? AND user_id = ?', [id, user.id]);
      if (rows.length) socket.join(`repo-${id}`);
    } catch (err) {
      console.error('[SOCKET] join-repo failed:', err);
    }
  });

  socket.on('leave-repo', (repoId) => {
    if (repoId != null) socket.leave(`repo-${repoId}`);
  });

  socket.on('auto-sync-start', async (repoId) => {
    if (!user) return;
    const key = `repo-${repoId}`;
    if (autoSyncTimers.has(key)) return;

    const [repo] = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [repoId, user.id]);
    if (!repo) return;

    const { token } = await getRepoToken(pool, repo);

    socket.join(key);
    io.to(key).emit('sync-log', { msg: 'Auto-sync gestart. Scan elke 15 seconden...', type: 'info' });
    io.to(key).emit('auto-sync-status', { active: true });

    const tick = async () => {
      const result = await syncRepo(repo, token, { io, log: logSync });
      if (result.logs && result.logs.length > 1) {
        const st = await getRepoStatusAsync(repo.path, token);
        const rd = await getRepoDataAsync(repo.path);
        io.to(key).emit('repo-update', {
          id: repo.id, name: repo.name, path: repo.path, remote: repo.remote,
          status: st, gitData: rd,
        });
      }
    };

    tick().catch(() => {});
    const interval = setInterval(() => tick().catch(() => {}), AUTO_SYNC_INTERVAL);
    autoSyncTimers.set(key, interval);
  });

  socket.on('auto-sync-stop', async (repoId) => {
    const id = Number(repoId);
    if (!user || !Number.isSafeInteger(id) || id <= 0) return;
    try {
      const rows = await pool.query('SELECT id FROM repos WHERE id = ? AND user_id = ?', [id, user.id]);
      if (!rows.length) return;
      const key = `repo-${id}`;
      if (autoSyncTimers.has(key)) {
        clearInterval(autoSyncTimers.get(key));
        autoSyncTimers.delete(key);
        io.to(key).emit('sync-log', { msg: 'Auto-sync gestopt.', type: 'warning' });
        io.to(key).emit('auto-sync-status', { active: false });
      }
    } catch (err) {
      console.error('[SOCKET] auto-sync-stop failed:', err);
    }
  });

  socket.on('join-watch', async () => {
    if (!user) return;
    socket.join(`user-watch-${user.id}`);
    socket.join('watch-all');
    globalWatchCount++;
    if (!globalWatchInterval) {
      globalWatchInterval = setInterval(async () => {
        try {
          const users = await pool.query('SELECT DISTINCT user_id FROM repos WHERE user_id IS NOT NULL');
          for (const { user_id: uid } of users) {
            const repos = await pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [uid]);
            for (const repo of repos) {
              const { token } = await getRepoToken(pool, repo);
              const result = await syncRepo(repo, token, { io, log: logSync });
              if (result.logs && result.logs.length > 1) {
                const st = await getRepoStatusAsync(repo.path, token);
                const rd = await getRepoDataAsync(repo.path);
                io.to(`user-watch-${uid}`).emit('repo-update', {
                  id: repo.id, name: repo.name, path: repo.path, remote: repo.remote,
                  status: st, gitData: rd,
                });
                io.to(`repo-${repo.id}`).emit('repo-update', {
                  id: repo.id, name: repo.name, path: repo.path, remote: repo.remote,
                  status: st, gitData: rd,
                });
              }
            }
          }
        } catch (e) {
          // interval laat-draaiende; niet laten crashen
        }
      }, AUTO_SYNC_INTERVAL);
      io.to('watch-all').emit('sync-log', { msg: 'Global Auto-Sync actief. Scan elke 15 seconden.', type: 'info' });
    }
    await emitAllRepoStatusForUser(socket, user.id);
  });

  socket.on('leave-watch', () => {
    if (user) socket.leave(`user-watch-${user.id}`);
    socket.leave('watch-all');
    globalWatchCount = Math.max(0, globalWatchCount - 1);
    if (globalWatchCount <= 0 && globalWatchInterval) {
      clearInterval(globalWatchInterval);
      globalWatchInterval = null;
      globalWatchCount = 0;
      io.to('watch-all').emit('sync-log', { msg: 'Global Auto-Sync gestopt.', type: 'warning' });
    }
  });

  socket.on('disconnect', () => {
    const wasWatching = socket.rooms && socket.rooms.has('watch-all');
    if (wasWatching) {
      globalWatchCount = Math.max(0, globalWatchCount - 1);
      if (globalWatchCount <= 0 && globalWatchInterval) {
        clearInterval(globalWatchInterval);
        globalWatchInterval = null;
        globalWatchCount = 0;
      }
    }
  });
});

app.set('io', io);

// Error handlers (moeten als laatste)
app.use(notFound);
app.use(errorHandler);

const PORT = parseInt(process.env.PORT || '3050', 10);
const HOST = process.env.HOST || '0.0.0.0';

(async () => {
  try {
    await seedSettingsFromEnv(pool);
  } catch (e) {
    console.warn('Kon seed/migratie niet uitvoeren:', e.message);
  }

  try {
    await sessionStore._ensureTable();
    setInterval(() => sessionStore.clearExpired(), 60 * 60 * 1000);
  } catch (e) {
    console.warn('Kon session store niet initialiseren:', e.message);
  }

  try {
    await ensureApiTokenTable();
  } catch (e) {
    console.warn('Kon api_tokens tabel niet initialiseren:', e.message);
  }

  try {
    await cleanupApiTokens();
    setInterval(() => cleanupApiTokens(), 6 * 60 * 60 * 1000); // elke 6u
  } catch (e) {
    console.warn('Kon vervallen API tokens niet opruimen:', e.message);
  }

  try {
    await cleanupOldSyncLogs();
    setInterval(() => cleanupOldSyncLogs(), 24 * 60 * 60 * 1000); // dagelijks
  } catch (e) {
    console.warn('Kon oude sync_logs niet opruimen:', e.message);
  }

  // Back-ups: dagelijkse retentie-cleanup + optionele automatische back-up.
  try {
    await cleanupOldBackups();
    setInterval(() => cleanupOldBackups().catch(() => {}), 24 * 60 * 60 * 1000);
    const backupIntervalHours = parseInt(process.env.BACKUP_INTERVAL_HOURS || '0', 10);
    if (backupIntervalHours > 0) {
      setInterval(() => {
        createBackup(pool)
          .then((m) => console.log(`[BACKUP] Automatische back-up gemaakt: ${m.name}`))
          .catch((e) => console.error('[BACKUP] Automatische back-up mislukt:', e.message));
      }, backupIntervalHours * 60 * 60 * 1000);
    }
  } catch (e) {
    console.warn('Kon back-up schema niet initialiseren:', e.message);
  }

  // Sync queue processor voor nodes
  setInterval(() => {
    processQueue().catch(e => console.error('[SYNC QUEUE] Error:', e));
  }, 5000);

  // Node-status: na een herstart zijn alle WebSocket-verbindingen weg, dus de
  // in de DB achtergebleven 'online'-status is ongeldig.
  try {
    const resetCount = await resetAllNodesOffline(pool);
    if (resetCount > 0) {
      console.log(`[NODES] ${resetCount} node(s) op offline gezet bij startup`);
    }
  } catch (e) {
    console.warn('Kon node-statussen niet resetten:', e.message);
  }

  // Vangnet voor half-open verbindingen die geen nette close afvuren.
  setInterval(() => {
    sweepStaleNodes(pool, Math.ceil(NODE_STALE_AFTER_MS / 1000))
      .then((n) => {
        if (n > 0) console.log(`[NODES] ${n} node(s) offline gezet wegens verouderde heartbeat`);
      })
      .catch((e) => console.error('[NODES] Sweep mislukt:', e.message));
  }, NODE_SWEEP_INTERVAL_MS);

  // Auto-sync trigger voor nodes (elke 15 seconden)
  setInterval(() => {
    triggerAutoSync().catch(e => console.error('[AUTO SYNC NODES] Error:', e));
  }, AUTO_SYNC_INTERVAL);

  server.listen(PORT, HOST, () => {
    console.log(`GitHub Manager draait op http://${HOST}:${PORT}`);
  });
})();

process.on('SIGINT', () => {
  for (const [, interval] of autoSyncTimers.entries()) {
    clearInterval(interval);
  }
  autoSyncTimers.clear();
  if (globalWatchInterval) clearInterval(globalWatchInterval);
  process.exit(0);
});
