'use strict';

const express = require('express');
const pool = require('../db');
const { isRepoLocal, getOnlineNodeForRepo } = require('../lib/node-repo');
const { getRepoToken } = require('../lib/settings');
const { logSync } = require('../lib/db-helpers');
const {
  gitAsync,
  getChangedFilesDetailed,
  stageFiles,
  unstageFiles,
  discardFiles,
  commitSelected,
  readGitignore,
  writeGitignore,
  getBranch,
  syncRepo,
} = require('../lib/git');
const { setRepoTags, addRepoTags } = require('../lib/repo-meta');
const { GIT_LONG_TIMEOUT } = require('../lib/constants');
const { scheduleSyncForNodeRepo } = require('../lib/sync-orchestrator');

const router = express.Router();

async function loadRepo(req) {
  const rows = await pool.query('SELECT * FROM repos WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
  return rows && rows[0] ? rows[0] : null;
}

function localOnly(res, repo) {
  if (!isRepoLocal(repo)) {
    res.status(409).json({ ok: false, error: 'Deze repository staat alleen op een agent; staging is alleen lokaal op de server beschikbaar.' });
    return true;
  }
  return false;
}

// --- Staging / selectief committen ---------------------------------------

router.get('/changes/:id', async (req, res) => {
  try {
    const repo = await loadRepo(req);
    if (!repo) return res.status(404).json({ ok: false, error: 'Repository niet gevonden.' });
    if (localOnly(res, repo)) return;

    const [{ files, warnings }, gitignore] = await Promise.all([
      getChangedFilesDetailed(repo.path),
      readGitignore(repo.path),
    ]);
    res.json({ ok: true, files, warnings, gitignore, branch: getBranch(repo.path) });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Kon wijzigingen niet laden.' });
  }
});

router.post('/changes/:id/stage', async (req, res) => {
  const repo = await loadRepo(req);
  if (!repo) return res.status(404).json({ ok: false, error: 'Repository niet gevonden.' });
  if (localOnly(res, repo)) return;
  const result = await stageFiles(repo.path, req.body.files);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/changes/:id/unstage', async (req, res) => {
  const repo = await loadRepo(req);
  if (!repo) return res.status(404).json({ ok: false, error: 'Repository niet gevonden.' });
  if (localOnly(res, repo)) return;
  const result = await unstageFiles(repo.path, req.body.files);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/changes/:id/discard', async (req, res) => {
  const repo = await loadRepo(req);
  if (!repo) return res.status(404).json({ ok: false, error: 'Repository niet gevonden.' });
  if (localOnly(res, repo)) return;
  const result = await discardFiles(repo.path, req.body.files);
  if (result.ok) await logSync(repo.id, 'discard', `Wijzigingen teruggezet: ${(req.body.files || []).join(', ')}`);
  res.status(result.ok ? 200 : 400).json(result);
});

router.post('/changes/:id/commit', async (req, res) => {
  try {
    const repo = await loadRepo(req);
    if (!repo) return res.status(404).json({ ok: false, error: 'Repository niet gevonden.' });
    if (localOnly(res, repo)) return;

    const { message, files, push } = req.body;
    const result = await commitSelected(repo.path, files, message);
    if (!result.ok) return res.status(400).json(result);

    await logSync(repo.id, 'commit', message);

    let pushed = false;
    if (push) {
      const { token } = await getRepoToken(pool, repo);
      const branch = getBranch(repo.path);
      const pushOut = await gitAsync(['push', 'origin', branch], repo.path, GIT_LONG_TIMEOUT, { token });
      pushed = pushOut !== null;
      if (pushed) await logSync(repo.id, 'push', `Pushed ${branch}`);
    }

    res.json({ ok: true, pushed });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Committen mislukt.' });
  }
});

// --- .gitignore -----------------------------------------------------------

router.get('/gitignore/:id', async (req, res) => {
  const repo = await loadRepo(req);
  if (!repo) return res.status(404).json({ ok: false, error: 'Repository niet gevonden.' });
  if (localOnly(res, repo)) return;
  res.json({ ok: true, content: await readGitignore(repo.path) });
});

router.post('/gitignore/:id', async (req, res) => {
  const repo = await loadRepo(req);
  if (!repo) return res.status(404).json({ ok: false, error: 'Repository niet gevonden.' });
  if (localOnly(res, repo)) return;
  const result = await writeGitignore(repo.path, req.body.content);
  if (result.ok) await logSync(repo.id, 'gitignore', '.gitignore bijgewerkt');
  res.status(result.ok ? 200 : 400).json(result);
});

// --- Favorieten & tags ----------------------------------------------------

router.post('/favorite/:id', async (req, res) => {
  try {
    const repo = await loadRepo(req);
    if (!repo) return res.status(404).json({ ok: false, error: 'Repository niet gevonden.' });
    const next = repo.favorite ? 0 : 1;
    await pool.query('UPDATE repos SET favorite = ? WHERE id = ? AND user_id = ?', [next, repo.id, req.session.user.id]);
    res.json({ ok: true, favorite: !!next });
  } catch {
    res.status(500).json({ ok: false, error: 'Favoriet wisselen mislukt.' });
  }
});

router.post('/tags/:id', async (req, res) => {
  try {
    const repo = await loadRepo(req);
    if (!repo) return res.status(404).json({ ok: false, error: 'Repository niet gevonden.' });
    const tags = await setRepoTags(pool, repo.id, req.body.tags);
    res.json({ ok: true, tags });
  } catch {
    res.status(500).json({ ok: false, error: 'Tags opslaan mislukt.' });
  }
});

// --- Bulk-acties ----------------------------------------------------------

router.post('/bulk', async (req, res) => {
  const action = String(req.body.action || '');
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids])
    .map((id) => parseInt(id, 10))
    .filter((id) => Number.isSafeInteger(id) && id > 0);

  if (!ids.length) {
    req.flash('error', 'Selecteer minimaal één repository.');
    return res.redirect('/repos');
  }

  try {
    const placeholders = ids.map(() => '?').join(',');
    const repos = await pool.query(
      `SELECT * FROM repos WHERE id IN (${placeholders}) AND user_id = ?`,
      [...ids, req.session.user.id]
    );
    if (!repos.length) {
      req.flash('error', 'Geen geldige repositories geselecteerd.');
      return res.redirect('/repos');
    }
    const ownedIds = repos.map((r) => r.id);

    if (action === 'remove') {
      await pool.query(
        `DELETE FROM repos WHERE id IN (${ownedIds.map(() => '?').join(',')}) AND user_id = ?`,
        [...ownedIds, req.session.user.id]
      );
      req.flash('success', `${repos.length} repository's verwijderd.`);
    } else if (action === 'favorite' || action === 'unfavorite') {
      await pool.query(
        `UPDATE repos SET favorite = ? WHERE id IN (${ownedIds.map(() => '?').join(',')})`,
        [action === 'favorite' ? 1 : 0, ...ownedIds]
      );
      req.flash('success', `${repos.length} repository's bijgewerkt.`);
    } else if (action === 'tag') {
      await addRepoTags(pool, ownedIds, req.body.tags);
      req.flash('success', `Tags toegevoegd aan ${repos.length} repository's.`);
    } else if (action === 'sync') {
      const io = req.app.get('io');
      const commitMessage = req.body.commitMessage || '';
      let ok = 0;
      let fail = 0;
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
        if (result.ok) ok++;
        else fail++;
        if (!result.ok) {
          const { sendNotification } = require('../lib/notify');
          await sendNotification(pool, repo.name, result.reason || 'unknown', `Sync mislukt: ${result.reason || 'onbekend'}`, repo.user_id);
        }
      }
      req.flash(fail ? 'error' : 'success', `Bulk sync klaar: ${ok} geslaagd, ${fail} mislukt.`);
    } else {
      req.flash('error', 'Onbekende bulk-actie.');
    }
  } catch (err) {
    req.flash('error', 'Bulk-actie mislukt: ' + (err.message || 'onbekend'));
  }

  res.redirect('/repos');
});

// --- Opgeslagen filters ---------------------------------------------------

router.post('/filters', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) {
    req.flash('error', 'Geef het filter een naam.');
    return res.redirect('/repos');
  }
  try {
    await pool.query(
      `INSERT INTO saved_filters (user_id, name, query, tag, favorite_only)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE query=VALUES(query), tag=VALUES(tag), favorite_only=VALUES(favorite_only)`,
      [
        req.session.user.id,
        name,
        String(req.body.query || '').slice(0, 255),
        String(req.body.tag || '').slice(0, 50),
        req.body.favoriteOnly === 'on' || req.body.favoriteOnly === '1' ? 1 : 0,
      ]
    );
    req.flash('success', `Filter "${name}" opgeslagen.`);
  } catch {
    req.flash('error', 'Filter opslaan mislukt.');
  }
  res.redirect('/repos');
});

router.post('/filters/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM saved_filters WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    req.flash('success', 'Filter verwijderd.');
  } catch {
    req.flash('error', 'Filter verwijderen mislukt.');
  }
  res.redirect('/repos');
});

module.exports = router;
