'use strict';

// ---------------------------------------------------------------------------
// Gedeelde git-helpers voor server en agent.
//
// Dit bestand is de ENIGE bron van waarheid. De agent is een zelfstandig
// deploybaar npm-pakket en kan daarom niet buiten zijn eigen map requiren.
// Daarom staat er een byte-identieke kopie in agent/src/git/common.js.
// Regenereer die kopie met: npm run sync:shared
// De root-test controleert dat beide bestanden identiek zijn.
// ---------------------------------------------------------------------------

/**
 * Tokenizeer een git-commando string naar een veilige args-array.
 * Ondersteunt dubbele en enkele aanhalingstekens (zoals shell-quoting),
 * maar de executie zelf gebeurt ZONDER shell, dus command-injection via
 * paden is niet mogelijk.
 */
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

/**
 * Bouw een Basic auth header voor Git HTTPS operaties zonder het token
 * permanent in de remote URL op te slaan.
 */
function buildAuthArgs(token) {
  if (!token) return [];
  const auth = Buffer.from(`${token}:x-oauth-basic`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${auth}`];
}

/**
 * Verwijder credentials uit een remote-URL voordat die aan de UI wordt
 * getoond. Ondersteunt elke host (niet alleen github.com) en zowel
 * https:// als http://. De rest van de URL blijft intact.
 */
function cleanRemoteUrl(remoteRaw) {
  if (!remoteRaw) return '';
  return String(remoteRaw)
    .trim()
    .replace(/^(https?:\/\/)[^/@\s]+@/i, '$1')
    .replace(/\.git$/i, '');
}

/** Parse een `git rev-list --count`-resultaat naar een niet-negatief getal. */
function parseCount(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Bepaal de status-sleutel op basis van lokale wijzigingen en commits die
 * de remote achterlopen. Centraal zodat server en agent nooit verschillend
 * classificeren.
 */
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
  behind: { icon: '\u2193', color: 'cyan' },
});

/**
 * Bouw een uniform statusobject. `fetchedAt` is het tijdstip (epoch ms) van
 * de laatste geslaagde fetch, of null als er nog nooit gefetcht is.
 */
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

/**
 * Throttle voor `git fetch`, gedeeld door server en agent.
 *
 * - shouldFetch() reserveert direct een slot zodat gelijktijdige aanroepen
 *   niet allemaal tegelijk fetchen (stampede-bescherming).
 * - markSuccess() legt het slaagtijdstip vast (voor `fetchedAt`).
 * - markFailure() geeft het slot direct vrij, zodat een mislukte fetch bij
 *   de volgende aanroep opnieuw geprobeerd wordt in plaats van 15 seconden
 *   lang als "zojuist gefetcht" te gelden.
 */
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

module.exports = {
  tokenize,
  buildAuthArgs,
  cleanRemoteUrl,
  parseCount,
  computeStatusKey,
  STATUS_META,
  buildStatus,
  noGitStatus,
  noRemoteStatus,
  createFetchThrottle,
};
