'use strict';

/**
 * File browsing routes
 * Handles: server-side browse, node browse, path validation
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../../db');
const { BROWSE_ROOTS, isWithinRoots } = require('../../lib/paths');
const { getRemoteShort } = require('../../lib/git');
const { getNodeOnlineForRepo, getOfflineAgentRepoIds } = require('../../lib/node-repo');
const { MessageType, createBrowsePayload, dispatchQueryToNode } = require('../../lib/sync-orchestrator');
const { getRepoToken } = require('../../lib/settings');
const { getRepoStatusWithNode } = require('../../lib/repo-helpers');

const router = express.Router();

// --- Server-side File Browser ----------------------------------------------

router.get('/browse', (req, res, next) => {
  try {
    let base = (req.query.path || BROWSE_ROOTS[0] || '/home').replace(/\/+$/, '') || '/';

    if (process.platform === 'win32' && base.match(/^[A-Za-z]:/)) {
      if (!base.includes('\\')) {
        base = base.replace(/^([A-Za-z]):/, '$1:\\');
      } else {
        base = base.replace(/\\/g, path.sep);
      }
    }

    try { base = require('../../lib/paths').safeResolve(base); } catch { base = BROWSE_ROOTS[0] || '/'; }

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
    next(err);
  }
});

// --- Node-side File Browser ------------------------------------------------

router.get('/nodes/:id/browse', async (req, res, next) => {
  try {
    const [node] = await pool.query('SELECT * FROM nodes WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!node) return res.status(404).json({ error: 'Node niet gevonden.' });
    if (node.status !== 'online') return res.status(409).json({ error: 'Node is offline.' });

    let nodePath = req.query.path || '';
    if (nodePath.match(/^[A-Za-z]:/) && !nodePath.includes('\\')) {
      nodePath = String(nodePath).replace(/^([A-Za-z]):/, '$1:\\');
    }

    const result = await dispatchQueryToNode(node.id, MessageType.BROWSE_DIR, { ...createBrowsePayload(nodePath), base: node.default_path || '' }, 8000);
    if (!result.success) return res.status(502).json({ error: result.error || 'Node niet bereikbaar.' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;