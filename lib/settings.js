'use strict';

const { encrypt, decrypt } = require('./crypto');

async function getGlobalSetting(pool, key) {
  const rows = await pool.query('SELECT svalue FROM settings WHERE skey = ?', [key]);
  return rows && rows.length && rows[0].svalue ? rows[0].svalue : '';
}

async function setGlobalSetting(pool, key, value) {
  await pool.query(
    'INSERT INTO settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue)',
    [key, value]
  );
}

/**
 * Haal de legacy single-account GitHub credentials op voor een gebruiker
 * (users.github_user + github_token_encrypted), met fallback naar de globale
 * settings-tabel. Wordt gebruikt als fallback voor repos zonder account_id.
 */
async function getUserGitHub(pool, userId) {
  const [user] = await pool.query(
    'SELECT github_user, github_token_encrypted FROM users WHERE id = ?',
    [userId]
  );

  let token = '';
  let githubUser = '';

  if (user && user.github_token_encrypted) {
    try {
      token = decrypt(user.github_token_encrypted);
    } catch (e) {
      token = '';
    }
  }
  if (user && user.github_user) {
    githubUser = user.github_user;
  }

  if (!token) {
    const globalToken = await getGlobalSetting(pool, 'token');
    if (globalToken) {
      try {
        token = decrypt(globalToken);
      } catch (e) {
        token = '';
      }
    }
  }
  if (!githubUser) {
    githubUser = await getGlobalSetting(pool, 'githubUser');
  }

  return { token, githubUser };
}

async function setUserGitHub(pool, userId, token, githubUser) {
  const updates = [];
  const values = [];
  if (token !== undefined) {
    updates.push('github_token_encrypted = ?');
    values.push(token ? encrypt(token) : '');
  }
  if (githubUser !== undefined) {
    updates.push('github_user = ?');
    values.push(githubUser || '');
  }
  if (updates.length === 0) return;
  values.push(userId);
  await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
}

// --- Multi-account API ----------------------------------------------------

/**
 * Lijst alle accounts van een gebruiker (zonder de token te ontsleutelen).
 * Voor UI-weergave; de token blijft versleuteld in de response.
 */
async function listAccountsMeta(pool, userId) {
  const rows = await pool.query(
    'SELECT id, label, github_user, is_default, created_at FROM github_accounts WHERE user_id = ? ORDER BY is_default DESC, id ASC',
    [userId]
  );
  return rows || [];
}

/**
 * Lijst alle accounts van een gebruiker met ontsleutelde token.
 * Alleen server-side gebruiken; de token wordt nooit naar de client gestuurd.
 */
async function listAccountsFull(pool, userId) {
  const rows = await pool.query(
    'SELECT id, label, github_user, github_token_encrypted, is_default, created_at FROM github_accounts WHERE user_id = ? ORDER BY is_default DESC, id ASC',
    [userId]
  );
  return (rows || []).map((r) => {
    let token = '';
    try {
      token = r.github_token_encrypted ? decrypt(r.github_token_encrypted) : '';
    } catch (e) {
      token = '';
    }
    return {
      id: r.id,
      label: r.label,
      githubUser: r.github_user,
      token,
      isDefault: !!r.is_default,
      createdAt: r.created_at,
    };
  });
}

/**
 * Haal één account op (met ontsleutelde token). Alleen het account zelf
 * of door de eigenaar (user_id) worden gehaald.
 */
async function getAccount(pool, accountId, userId) {
  const [acc] = await pool.query(
    'SELECT id, user_id, label, github_user, github_token_encrypted, is_default FROM github_accounts WHERE id = ?' +
      (userId != null ? ' AND user_id = ?' : ''),
    userId != null ? [accountId, userId] : [accountId]
  );
  if (!acc) return null;
  let token = '';
  try {
    token = acc.github_token_encrypted ? decrypt(acc.github_token_encrypted) : '';
  } catch (e) {
    token = '';
  }
  return {
    id: acc.id,
    userId: acc.user_id,
    label: acc.label,
    githubUser: acc.github_user,
    token,
    isDefault: !!acc.is_default,
  };
}

/**
 * Default account van een gebruiker. Retourneert null indien geen accounts.
 */
async function getDefaultAccount(pool, userId) {
  const rows = await pool.query(
    'SELECT id FROM github_accounts WHERE user_id = ? ORDER BY is_default DESC, id ASC LIMIT 1',
    [userId]
  );
  if (!rows || rows.length === 0) return null;
  return getAccount(pool, rows[0].id, userId);
}

/**
 * Voeg een nieuw account toe. Indien het het eerste account is, wordt het
 * automatisch de default. Wordt isDefault=1 meegegeven, dan wordt dit account
 * de nieuwe default en worden andere accounts van deze user op isDefault=0 gezet.
 */
async function addAccount(pool, userId, label, githubUser, token, isDefault) {
  if (!label || !githubUser || !token) {
    throw new Error('label, githubUser en token zijn verplicht');
  }

  const countRows = await pool.query(
    'SELECT COUNT(*) AS c FROM github_accounts WHERE user_id = ?',
    [userId]
  );
  const isFirst = !countRows || !countRows[0] || countRows[0].c === 0;
  const makeDefault = isFirst || !!isDefault;

  if (makeDefault) {
    await pool.query('UPDATE github_accounts SET is_default = 0 WHERE user_id = ?', [userId]);
  }

  const res = await pool.query(
    `INSERT INTO github_accounts (user_id, label, github_user, github_token_encrypted, is_default)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, label, githubUser, encrypt(token), makeDefault ? 1 : 0]
  );

  const insertId = res && res.insertId ? res.insertId : null;
  return getAccount(pool, insertId, userId);
}

/**
 * Update een bestaand account. Velden die undefined zijn worden overgeslagen.
 * Indien token leeg string is, wordt de bestaande token behouden.
 */
async function updateAccount(pool, accountId, userId, fields) {
  const acc = await getAccount(pool, accountId, userId);
  if (!acc) throw new Error('Account niet gevonden');

  const updates = [];
  const values = [];

  if (fields.label !== undefined && fields.label) {
    updates.push('label = ?');
    values.push(fields.label);
  }
  if (fields.githubUser !== undefined && fields.githubUser) {
    updates.push('github_user = ?');
    values.push(fields.githubUser);
  }
  if (fields.token !== undefined && fields.token) {
    updates.push('github_token_encrypted = ?');
    values.push(encrypt(fields.token));
  }

  if (updates.length > 0) {
    values.push(accountId);
    await pool.query(`UPDATE github_accounts SET ${updates.join(', ')} WHERE id = ?`, values);
  }

  if (fields.isDefault === true) {
    await pool.query('UPDATE github_accounts SET is_default = 0 WHERE user_id = ?', [userId]);
    await pool.query('UPDATE github_accounts SET is_default = 1 WHERE id = ?', [accountId]);
  }

  return getAccount(pool, accountId, userId);
}

/**
 * Verwijder een account. Repos die aan dit account gekoppeld waren krijgen
 * account_id = NULL (ON DELETE SET NULL). Indien het account de default was,
 * wordt het eerstvolgende bestaande account de nieuwe default.
 */
async function deleteAccount(pool, accountId, userId) {
  const acc = await getAccount(pool, accountId, userId);
  if (!acc) return false;

  await pool.query('DELETE FROM github_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);

  // Indien dit de default was, promoot de eerstvolgende
  if (acc.isDefault) {
    const remaining = await pool.query(
      'SELECT id FROM github_accounts WHERE user_id = ? ORDER BY id LIMIT 1',
      [userId]
    );
    if (remaining && remaining.length > 0) {
      await pool.query('UPDATE github_accounts SET is_default = 1 WHERE id = ?', [remaining[0].id]);
    }
  }

  return true;
}

/**
 * Zet een ander account als default voor deze gebruiker.
 */
async function setDefaultAccount(pool, accountId, userId) {
  const acc = await getAccount(pool, accountId, userId);
  if (!acc) return false;
  await pool.query('UPDATE github_accounts SET is_default = 0 WHERE user_id = ?', [userId]);
  await pool.query('UPDATE github_accounts SET is_default = 1 WHERE id = ? AND user_id = ?', [accountId, userId]);
  return true;
}

/**
 * Haal de token + githubUser op die bij een specifieke repo hoort.
 * Volgorde: repo.account_id -> github_accounts, anders fallback op
 * legacy getUserGitHub via user_id.
 */
async function getRepoToken(pool, repo) {
  if (!repo) return { token: '', githubUser: '' };

  if (repo.account_id) {
    const acc = await getAccount(pool, repo.account_id, repo.user_id);
    if (acc && acc.token) {
      return { token: acc.token, githubUser: acc.githubUser };
    }
  }

  // Fallback: legacy single token
  return getUserGitHub(pool, repo.user_id);
}

/**
 * Detecteer welk account van een gebruiker hoort bij een gegeven remote (owner/repo).
 * Retourneert het account of null. Handig bij het toevoegen van bestaande repos.
 */
async function detectAccountForRemote(pool, userId, remoteShort) {
  if (!remoteShort) return null;
  const owner = remoteShort.split('/')[0];
  if (!owner) return null;
  const accounts = await listAccountsFull(pool, userId);
  return accounts.find((a) => a.githubUser && a.githubUser.toLowerCase() === owner.toLowerCase()) || null;
}

module.exports = {
  getGlobalSetting,
  setGlobalSetting,
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
  getUserTheme: require('./theme').getUserTheme,
  setUserTheme: require('./theme').setUserTheme,
};