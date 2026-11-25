'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(__dirname, '..', 'backups');

const BACKUP_RE = /^mindgit-[0-9]{8}-[0-9]{6}\.sql\.gz$/;

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  return BACKUP_DIR;
}

function isSafeBackupName(name) {
  return typeof name === 'string' && BACKUP_RE.test(name) && path.basename(name) === name;
}

function backupPath(name) {
  if (!isSafeBackupName(name)) throw new Error('Ongeldige back-up naam.');
  return path.join(BACKUP_DIR, name);
}

function timestampName(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = d || new Date();
  return `mindgit-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.sql.gz`;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Maak een gecomprimeerde mysqldump van de MindGit-database.
 * Het wachtwoord gaat via MYSQL_PWD (niet via argv, zodat het niet in ps staat).
 */
async function createBackup(pool, opts) {
  opts = opts || {};
  ensureBackupDir();

  const name = timestampName();
  const file = backupPath(name);
  const dbName = process.env.DB_NAME || 'github';
  const args = [
    `--host=${process.env.DB_HOST || 'localhost'}`,
    `--user=${process.env.DB_USER || 'github'}`,
    '--single-transaction',
    '--quick',
    '--routines',
    '--events',
    '--triggers',
    '--no-tablespaces',
    '--default-character-set=utf8mb4',
    dbName,
  ];

  await new Promise((resolve, reject) => {
    const dump = spawn('mysqldump', args, {
      env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const gzip = zlib.createGzip({ level: 9 });
    const out = fs.createWriteStream(file, { mode: 0o600 });
    let stderr = '';
    let dumpCode = null;

    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    dump.on('error', reject);
    gzip.on('error', reject);
    out.on('error', reject);

    dump.stdout.pipe(gzip).pipe(out);
    dump.on('close', (code) => {
      dumpCode = code;
      if (code !== 0) {
        reject(new Error(stderr.trim() || `mysqldump stopte met code ${code}`));
      }
    });
    out.on('close', () => {
      if (dumpCode === 0) resolve();
    });
  });

  const stat = await fs.promises.stat(file);
  const sha256 = await sha256File(file);

  let tableCounts = {};
  try {
    const tables = await pool.query('SHOW TABLES');
    const key = tables.length ? Object.keys(tables[0])[0] : null;
    if (key) {
      for (const row of tables) {
        const table = row[key];
        if (!/^[A-Za-z0-9_]+$/.test(table)) continue;
        try {
          const [c] = await pool.query(`SELECT COUNT(*) AS c FROM \`${table}\``);
          tableCounts[table] = Number(c.c);
        } catch {
          // tabel kan tijdens dump verdwijnen
        }
      }
    }
  } catch {
    tableCounts = {};
  }

  const manifest = {
    name,
    createdAt: new Date().toISOString(),
    database: dbName,
    size: stat.size,
    sha256,
    appVersion: require('../package.json').version,
    tableCounts,
  };
  await fs.promises.writeFile(file.replace(/\.sql\.gz$/, '.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  return manifest;
}

async function listBackups() {
  ensureBackupDir();
  let entries = [];
  try {
    entries = await fs.promises.readdir(BACKUP_DIR);
  } catch {
    return [];
  }
  const backups = [];
  for (const name of entries) {
    if (!isSafeBackupName(name)) continue;
    try {
      const file = path.join(BACKUP_DIR, name);
      const stat = await fs.promises.stat(file);
      let manifest = null;
      try {
        manifest = JSON.parse(await fs.promises.readFile(file.replace(/\.sql\.gz$/, '.json'), 'utf-8'));
      } catch {
        manifest = null;
      }
      backups.push({ name, size: stat.size, createdAt: stat.mtime, manifest });
    } catch {
      // sla onleesbare entries over
    }
  }
  return backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function deleteBackup(name) {
  const file = backupPath(name);
  await fs.promises.rm(file, { force: true });
  await fs.promises.rm(file.replace(/\.sql\.gz$/, '.json'), { force: true });
  return true;
}

/**
 * Valideer een back-up zonder hem te restoren: gzip-integriteit, dump-header,
 * aanwezigheid van kern-tabellen, dump-voet en optioneel de sha256 uit het
 * manifest. Zo weet je dat een bestand bruikbaar is zonder productie aan te raken.
 */
async function validateBackup(name) {
  const file = backupPath(name);
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail: detail || '' });

  let stat;
  try {
    stat = await fs.promises.stat(file);
    add(true, 'Bestand aanwezig', `${Math.round(stat.size / 1024)} KB`);
  } catch {
    add(false, 'Bestand aanwezig', 'niet gevonden');
    return { ok: false, checks };
  }

  // Lees in chunks: eerste en laatste deel voor de checks, plus volledige
  // sha256 en gzip-validatie via een stream.
  let head = '';
  let tail = '';
  let sha = crypto.createHash('sha256');
  let truncated = false;
  let sawUsers = false;
  let sawRepos = false;

  await new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => sha.update(chunk));
    input.on('error', reject);
    gunzip.on('error', () => { truncated = true; resolve(); });
    gunzip.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      if (head.length < 8192) head += text.slice(0, 8192 - head.length);
      tail = (tail + text).slice(-8192);
      if (!sawUsers && text.includes('CREATE TABLE `users`')) sawUsers = true;
      if (!sawRepos && text.includes('CREATE TABLE `repos`')) sawRepos = true;
    });
    gunzip.on('end', resolve);
    input.pipe(gunzip);
  });

  add(!truncated, 'Gzip-integriteit', truncated ? 'bestand is beschadigd of afgekapt' : 'OK');
  add(/-- (MariaDB|MySQL) dump/.test(head), 'Dump-header', 'mysqldump header gevonden');
  add(sawUsers, 'Tabel users aanwezig');
  add(sawRepos, 'Tabel repos aanwezig');
  add(/Dump completed/.test(tail), 'Dump-voet', 'dump is volledig afgesloten');

  const actualSha = sha.digest('hex');
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.promises.readFile(file.replace(/\.sql\.gz$/, '.json'), 'utf-8'));
  } catch {
    manifest = null;
  }
  if (manifest && manifest.sha256) {
    add(manifest.sha256 === actualSha, 'SHA-256 manifest', manifest.sha256 === actualSha ? 'klopt' : 'komt niet overeen');
  } else {
    add(true, 'SHA-256 manifest', 'geen manifest gevonden (overgeslagen)');
  }

  return { ok: checks.every((c) => c.ok), checks, sha256: actualSha, size: stat.size };
}

async function cleanupOldBackups(days) {
  const retention = parseInt(days || process.env.BACKUP_RETENTION_DAYS || '14', 10);
  if (!retention || retention <= 0) return 0;
  const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const b of await listBackups()) {
    if (new Date(b.createdAt).getTime() < cutoff) {
      try { await deleteBackup(b.name); removed++; } catch { /* niet fataal */ }
    }
  }
  return removed;
}

module.exports = {
  BACKUP_DIR,
  createBackup,
  listBackups,
  deleteBackup,
  validateBackup,
  cleanupOldBackups,
  isSafeBackupName,
};
