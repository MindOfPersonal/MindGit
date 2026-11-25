'use strict';

const { encrypt, isEncrypted } = require('./crypto');
const { DEFAULT_LANG, isSupportedLang } = require('./i18n');
const { columnExists } = require('./db-helpers');
const { migrateNodeTables } = require('./migrate-nodes');
const { migrateFeatureTables } = require('./migrate-features');

async function migratePlaintextToken(pool) {
  try {
    const rows = await pool.query(
      "SELECT svalue FROM settings WHERE skey = 'token' AND svalue IS NOT NULL AND svalue != ''"
    );
    if (!rows || rows.length === 0) return;

    const value = rows[0].svalue;
    if (value && !isEncrypted(value)) {
      await pool.query("UPDATE settings SET svalue = ? WHERE skey = 'token'", [encrypt(value)]);
      console.log('[MIGRATIE] GitHub token in database is nu versleuteld.');
    }
  } catch (e) {
    console.warn('Kon plaintext token migratie niet uitvoeren:', e.message);
  }
}

async function migrateLanguageColumn(pool) {
  try {
    if (!(await columnExists('users', 'language'))) {
      await pool.query("ALTER TABLE users ADD COLUMN language VARCHAR(5) NOT NULL DEFAULT 'nl'");
      console.log('[MIGRATIE] Kolom users.language toegevoegd (default: nl).');
    } else {
      await pool.query("UPDATE users SET language = 'nl' WHERE language IS NULL OR language = ''");
    }
  } catch (e) {
    console.warn('Kon users.language migratie niet uitvoeren:', e.message);
  }
}

async function migrateThemeColumn(pool) {
  try {
    if (!(await columnExists('users', 'theme'))) {
      await pool.query("ALTER TABLE users ADD COLUMN theme VARCHAR(20) NOT NULL DEFAULT 'glacier'");
      console.log('[MIGRATIE] Kolom users.theme toegevoegd (default: glacier).');
    } else {
      // Converteer light theme naar glacier (light is verwijderd)
      const result = await pool.query("UPDATE users SET theme = 'glacier' WHERE theme = 'light'");
      if (result.affectedRows > 0) {
        console.log(`[MIGRATIE] ${result.affectedRows} gebruiker(s) met 'light' theme geconverteerd naar 'glacier'.`);
      }
    }
  } catch (e) {
    console.warn('Kon users.theme migratie niet uitvoeren:', e.message);
  }
}

async function seedSettingsFromEnv(pool) {
  await migratePlaintextToken(pool);
  await migrateLanguageColumn(pool);
  await migrateThemeColumn(pool);

  // Nodes/agents tabellen aanmaken als ze ontbreken (idempotent)
  try {
    await migrateNodeTables(pool);
  } catch (e) {
    console.warn('Kon node-tabellen niet migreren:', e.message);
  }

  // Favorieten, tags, opgeslagen filters en push-subscriptions
  try {
    await migrateFeatureTables(pool);
  } catch (e) {
    console.warn('Kon feature-tabellen niet migreren:', e.message);
  }

  const seeds = [];
  if (process.env.GITHUB_TOKEN) seeds.push(['token', encrypt(process.env.GITHUB_TOKEN)]);
  if (process.env.GITHUB_USER) seeds.push(['githubUser', process.env.GITHUB_USER]);

  for (const [key, value] of seeds) {
    const rows = await pool.query('SELECT svalue FROM settings WHERE skey = ?', [key]);
    if (rows && rows.length > 0 && rows[0].svalue) continue;
    await pool.query(
      'INSERT INTO settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue)',
      [key, value]
    );
  }
}

module.exports = { seedSettingsFromEnv, migrateLanguageColumn, migrateThemeColumn, columnExists };
