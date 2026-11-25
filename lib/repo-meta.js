'use strict';

const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_REPO = 20;

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw || '').trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_REPO) break;
  }
  return out;
}

async function getTagsForRepos(pool, repoIds) {
  const map = new Map();
  if (!repoIds || repoIds.length === 0) return map;
  const rows = await pool.query(
    `SELECT repo_id, tag FROM repo_tags WHERE repo_id IN (${repoIds.map(() => '?').join(',')}) ORDER BY tag`,
    repoIds
  );
  for (const row of rows) {
    if (!map.has(row.repo_id)) map.set(row.repo_id, []);
    map.get(row.repo_id).push(row.tag);
  }
  return map;
}

async function setRepoTags(pool, repoId, tags) {
  const normalized = normalizeTags(tags);
  await pool.query('DELETE FROM repo_tags WHERE repo_id = ?', [repoId]);
  for (const tag of normalized) {
    await pool.query('INSERT IGNORE INTO repo_tags (repo_id, tag) VALUES (?, ?)', [repoId, tag]);
  }
  return normalized;
}

async function addRepoTags(pool, repoIds, tags) {
  const normalized = normalizeTags(tags);
  if (!repoIds.length || !normalized.length) return 0;
  let count = 0;
  for (const repoId of repoIds) {
    for (const tag of normalized) {
      await pool.query('INSERT IGNORE INTO repo_tags (repo_id, tag) VALUES (?, ?)', [repoId, tag]);
      count++;
    }
  }
  return count;
}

async function listTags(pool, userId) {
  const rows = await pool.query(
    `SELECT t.tag, COUNT(*) AS c
     FROM repo_tags t JOIN repos r ON r.id = t.repo_id
     WHERE r.user_id = ?
     GROUP BY t.tag ORDER BY c DESC, t.tag ASC`,
    [userId]
  );
  return rows.map((r) => ({ tag: r.tag, count: Number(r.c) }));
}

async function getSavedFilters(pool, userId) {
  const rows = await pool.query(
    'SELECT id, name, query, tag, favorite_only, created_at FROM saved_filters WHERE user_id = ? ORDER BY name ASC',
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    query: r.query || '',
    tag: r.tag || '',
    favoriteOnly: !!r.favorite_only,
  }));
}

module.exports = {
  normalizeTags,
  getTagsForRepos,
  setRepoTags,
  addRepoTags,
  listTags,
  getSavedFilters,
};
