'use strict';

const crypto = require('crypto');
const webpush = require('web-push');
const { encrypt, decrypt } = require('./crypto');

const SETTING_PUBLIC = 'VAPID_PUBLIC_KEY';
const SETTING_PRIVATE = 'VAPID_PRIVATE_KEY';

function endpointHash(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex');
}

/**
 * Zorg dat er VAPID-sleutels bestaan. De public key is publiek; de private
 * key wordt AES-GCM versleuteld in de settings-tabel opgeslagen.
 */
async function ensureVapid(pool) {
  const rows = await pool.query('SELECT skey, svalue FROM settings WHERE skey IN (?, ?)', [SETTING_PUBLIC, SETTING_PRIVATE]);
  const map = new Map(rows.map((r) => [r.skey, r.svalue]));
  let publicKey = map.get(SETTING_PUBLIC) || '';
  let privateKey = '';
  try {
    privateKey = map.get(SETTING_PRIVATE) ? decrypt(map.get(SETTING_PRIVATE)) : '';
  } catch {
    privateKey = '';
  }

  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    await pool.query(
      'INSERT INTO settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue)',
      [SETTING_PUBLIC, publicKey]
    );
    await pool.query(
      'INSERT INTO settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue)',
      [SETTING_PRIVATE, encrypt(privateKey)]
    );
  }

  return { publicKey, privateKey };
}

async function getPublicKey(pool) {
  const { publicKey } = await ensureVapid(pool);
  return publicKey;
}

async function saveSubscription(pool, userId, sub) {
  const endpoint = sub && sub.endpoint;
  const keys = sub && sub.keys;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    throw new Error('Ongeldige push-subscription.');
  }
  if (String(endpoint).length > 2000) throw new Error('Push-endpoint is te lang.');
  const hash = endpointHash(endpoint);
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint_hash, user_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), p256dh=VALUES(p256dh), auth=VALUES(auth)`,
    [hash, userId, endpoint, keys.p256dh, keys.auth]
  );
  return true;
}

async function removeSubscription(pool, userId, endpoint) {
  if (!endpoint) return false;
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?', [endpointHash(endpoint), userId]);
  return true;
}

async function countSubscriptions(pool, userId) {
  const [row] = await pool.query('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?', [userId]);
  return row ? Number(row.c) : 0;
}

/**
 * Stuur een web-push notificatie naar alle subscriptions van een gebruiker.
 * Verlopen subscriptions (404/410) worden opgeruimd.
 */
async function sendPushToUser(pool, userId, payload) {
  if (!userId) return { sent: 0, failed: 0 };
  let vapid;
  try {
    vapid = await ensureVapid(pool);
  } catch {
    return { sent: 0, failed: 0 };
  }

  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@mindgit.local';
  try {
    webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
  } catch {
    return { sent: 0, failed: 0 };
  }

  const subs = await pool.query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
  let sent = 0;
  let failed = 0;
  for (const s of subs) {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      sent++;
    } catch (err) {
      failed++;
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        try {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ?', [endpointHash(s.endpoint)]);
        } catch { /* niet fataal */ }
      }
    }
  }
  return { sent, failed };
}

module.exports = {
  ensureVapid,
  getPublicKey,
  saveSubscription,
  removeSubscription,
  countSubscriptions,
  sendPushToUser,
};
