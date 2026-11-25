'use strict';

const express = require('express');
const pool = require('../db');
const { apiRequest } = require('../lib/github-api');
const { getRepoToken } = require('../lib/settings');

const cache = new Map();
const CACHE_TTL = 60000; // 1 minute cache for GitHub API responses

const router = express.Router();

async function listRepos(req) {
  return pool.query('SELECT * FROM repos WHERE user_id = ? ORDER BY group_name, name', [req.session.user.id]);
}

function cachedApiRequest(key, fn) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;
  return fn();
}

async function setCachedApiRequest(key, data, fn) {
  cache.set(key, { data, time: Date.now() });
  return data;
}

function back(req, res, path, type, message) {
  req.flash(type, message);
  res.redirect(path);
}

// --- Issues ---------------------------------------------------------------

router.get('/issues', async (req, res) => {
  const state = req.query.state === 'closed' ? 'closed' : 'open';
  const repoFilter = req.query.repo ? parseInt(req.query.repo, 10) : null;
  const repos = await listRepos(req);
  const issues = [];

  for (const repo of repos) {
    if (!repo.remote) continue;
    if (repoFilter && repo.id !== repoFilter) continue;
    const cacheKey = `issues_${repo.id}_${state}`;
    try {
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.time < CACHE_TTL) {
        for (const issue of cached.data) {
          if (issue.pull_request) continue;
          issues.push(issue);
        }
        if (issues.length > 0) continue; // skip API call if we have cached data
      }
    } catch {}

    const { token } = await getRepoToken(pool, repo);
    if (!token) continue;
    try {
      const rows = await apiRequest('GET', `/repos/${repo.remote}/issues?state=${state}&per_page=25&sort=updated`, token);
      const issueList = Array.isArray(rows) ? rows : [];
      // Cache the result (remove PRs before caching)
      const toCache = issueList.filter((issue) => !issue.pull_request);
      try { await setCachedApiRequest(cacheKey, toCache, () => {}); } catch {}
      for (const issue of issueList) {
        if (issue.pull_request) continue;
        issues.push({
          repoId: repo.id,
          repoName: repo.name,
          repoRemote: repo.remote,
          number: issue.number,
          title: issue.title,
          body: issue.body || '',
          state: issue.state,
          author: issue.user ? issue.user.login : 'unknown',
          comments: issue.comments || 0,
          labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
          htmlUrl: issue.html_url || '',
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
        });
      }
    } catch {
      // repo overslaan bij API-fout
    }
  }

  issues.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.render('issues', { issues, repos, state, repoFilter });
});

router.post('/issues/:repoId/create', async (req, res) => {
  const { repo, token } = await repoWithToken(req);
  if (!repo || !token) return back(req, res, '/repos/issues', 'error', 'Repository of token niet gevonden.');
  const title = String(req.body.title || '').trim();
  if (!title) return back(req, res, '/repos/issues', 'error', 'Titel is verplicht.');
  try {
    const issue = await apiRequest('POST', `/repos/${repo.remote}/issues`, token, {
      title,
      body: String(req.body.body || ''),
    });
    back(req, res, '/repos/issues', 'success', `Issue #${issue.number} aangemaakt.`);
  } catch (err) {
    back(req, res, '/repos/issues', 'error', 'Issue aanmaken mislukt: ' + err.message);
  }
});

router.post('/issues/:repoId/:number/close', async (req, res) => {
  const { repo, token } = await repoWithToken(req);
  if (!repo || !token) return back(req, res, '/repos/issues', 'error', 'Repository of token niet gevonden.');
  try {
    await apiRequest('PATCH', `/repos/${repo.remote}/issues/${req.params.number}`, token, { state: 'closed' });
    back(req, res, '/repos/issues', 'success', `Issue #${req.params.number} gesloten.`);
  } catch (err) {
    back(req, res, '/repos/issues', 'error', 'Sluiten mislukt: ' + err.message);
  }
});

router.post('/issues/:repoId/:number/reopen', async (req, res) => {
  const { repo, token } = await repoWithToken(req);
  if (!repo || !token) return back(req, res, '/repos/issues?state=closed', 'error', 'Repository of token niet gevonden.');
  try {
    await apiRequest('PATCH', `/repos/${repo.remote}/issues/${req.params.number}`, token, { state: 'open' });
    back(req, res, '/repos/issues?state=closed', 'success', `Issue #${req.params.number} heropend.`);
  } catch (err) {
    back(req, res, '/repos/issues?state=closed', 'error', 'Heropenen mislukt: ' + err.message);
  }
});

router.post('/issues/:repoId/:number/comment', async (req, res) => {
  const { repo, token } = await repoWithToken(req);
  if (!repo || !token) return back(req, res, '/repos/issues', 'error', 'Repository of token niet gevonden.');
  const body = String(req.body.body || '').trim();
  if (!body) return back(req, res, '/repos/issues', 'error', 'Reactie is leeg.');
  try {
    await apiRequest('POST', `/repos/${repo.remote}/issues/${req.params.number}/comments`, token, { body });
    back(req, res, '/repos/issues', 'success', `Reactie geplaatst op #${req.params.number}.`);
  } catch (err) {
    back(req, res, '/repos/issues', 'error', 'Reactie plaatsen mislukt: ' + err.message);
  }
});

// --- Releases & tags ------------------------------------------------------

router.get('/releases', async (req, res) => {
  const repos = await listRepos(req);
  const data = [];

  for (const repo of repos) {
    if (!repo.remote) continue;
    const cacheKey = `releases_${repo.id}`;
    
    const entry = { repo, releases: [], tags: [], error: null };
    
    try {
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.time < CACHE_TTL) {
        entry.releases = cached.data.releases || [];
        entry.tags = cached.data.tags || [];
        data.push(entry);
        continue;
      }
    } catch {}

    const { token } = await getRepoToken(pool, repo);
    if (!token) {
      data.push(entry);
      continue;
    }
    try {
      const releases = await apiRequest('GET', `/repos/${repo.remote}/releases?per_page=10`, token);
      entry.releases = (Array.isArray(releases) ? releases : []).map((r) => ({
        id: r.id,
        tag: r.tag_name,
        name: r.name || r.tag_name,
        draft: r.draft,
        prerelease: r.prerelease,
        author: r.author ? r.author.login : '',
        htmlUrl: r.html_url || '',
        createdAt: r.created_at,
        publishedAt: r.published_at,
      }));
      const tags = await apiRequest('GET', `/repos/${repo.remote}/tags?per_page=25`, token);
      entry.tags = (Array.isArray(tags) ? tags : []).map((t) => t.name);
      try { await setCachedApiRequest(cacheKey, { releases: entry.releases, tags: entry.tags }, () => {}); } catch {}
    } catch (err) {
      entry.error = err.message;
    }
    data.push(entry);
  }

  res.render('releases', { repoData: data });
});

router.post('/releases/:repoId/create', async (req, res) => {
  const { repo, token } = await repoWithToken(req);
  if (!repo || !token) return back(req, res, '/repos/releases', 'error', 'Repository of token niet gevonden.');
  const tag = String(req.body.tag || '').trim();
  if (!tag) return back(req, res, '/repos/releases', 'error', 'Tag is verplicht.');
  try {
    await apiRequest('POST', `/repos/${repo.remote}/releases`, token, {
      tag_name: tag,
      name: String(req.body.name || tag).trim(),
      body: String(req.body.body || ''),
      draft: req.body.draft === 'on',
      prerelease: req.body.prerelease === 'on',
    });
    back(req, res, '/repos/releases', 'success', `Release ${tag} aangemaakt.`);
  } catch (err) {
    back(req, res, '/repos/releases', 'error', 'Release aanmaken mislukt: ' + err.message);
  }
});

router.post('/releases/:repoId/:releaseId/delete', async (req, res) => {
  const { repo, token } = await repoWithToken(req);
  if (!repo || !token) return back(req, res, '/repos/releases', 'error', 'Repository of token niet gevonden.');
  try {
    await apiRequest('DELETE', `/repos/${repo.remote}/releases/${req.params.releaseId}`, token);
    back(req, res, '/repos/releases', 'success', 'Release verwijderd.');
  } catch (err) {
    back(req, res, '/repos/releases', 'error', 'Release verwijderen mislukt: ' + err.message);
  }
});

// --- GitHub Actions -------------------------------------------------------

router.get('/actions', async (req, res) => {
  const repos = await listRepos(req);
  const data = [];

  for (const repo of repos) {
    if (!repo.remote) continue;
    const cacheKey = `actions_${repo.id}`;
    
    const entry = { repo, runs: [], error: null };
    
    try {
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.time < CACHE_TTL) {
        entry.runs = cached.data.runs || [];
        data.push(entry);
        continue;
      }
    } catch {}

    const { token } = await getRepoToken(pool, repo);
    if (!token) {
      data.push(entry);
      continue;
    }
    try {
      const result = await apiRequest('GET', `/repos/${repo.remote}/actions/runs?per_page=10`, token);
      entry.runs = ((result && result.workflow_runs) || []).map((r) => ({
        id: r.id,
        name: r.name || (r.workflow && r.workflow.name) || 'workflow',
        runNumber: r.run_number,
        event: r.event,
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        actor: r.actor ? r.actor.login : '',
        htmlUrl: r.html_url || '',
        createdAt: r.created_at,
      }));
      try { await setCachedApiRequest(cacheKey, { runs: entry.runs }, () => {}); } catch {}
    } catch (err) {
      entry.error = err.message;
    }
    data.push(entry);
  }

  res.render('actions', { repoData: data });
});

router.post('/actions/:repoId/:runId/rerun', async (req, res) => {
  const { repo, token } = await repoWithToken(req);
  if (!repo || !token) return back(req, res, '/repos/actions', 'error', 'Repository of token niet gevonden.');
  try {
    await apiRequest('POST', `/repos/${repo.remote}/actions/runs/${req.params.runId}/rerun-failed-jobs`, token, {});
    back(req, res, '/repos/actions', 'success', 'Workflow opnieuw gestart.');
  } catch (err) {
    back(req, res, '/repos/actions', 'error', 'Opnieuw starten mislukt: ' + err.message);
  }
});

module.exports = router;
