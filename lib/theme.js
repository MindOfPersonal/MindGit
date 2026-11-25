'use strict';

const DEFAULT_THEME = 'glacier';
const THEMES = ['glacier', 'kerst', 'dark'];

const THEME_CSS = {
  glacier: `
:root {
  --bg-primary: #0a0a1a;
  --bg-secondary: #12122a;
  --bg-tertiary: #1a1a3a;
  --bg-card: #1e1e4a;
  --bg-hover: #25255a;
  --bg-input: rgba(10, 10, 26, 0.7);
  --border: rgba(100, 100, 200, 0.15);
  --border-light: rgba(150, 150, 250, 0.25);
  --text-primary: #e8e8ff;
  --text-secondary: #b0b0d0;
  --text-muted: #8888a8;
  --accent: #7b68ee;
  --accent-hover: #9386ff;
  --accent-2: #00e0ff;
  --accent-glow: rgba(123, 104, 238, 0.18);
  --accent-soft: rgba(123, 104, 238, 0.10);
  --green: #22e48a;
  --green-bg: rgba(34, 228, 138, 0.12);
  --yellow: #ffd166;
  --yellow-bg: rgba(255, 209, 102, 0.12);
  --orange: #ff9f43;
  --orange-bg: rgba(255, 159, 67, 0.12);
  --red: #ff5f6d;
  --red-bg: rgba(255, 95, 109, 0.12);
  --cyan: #00d4ff;
  --cyan-bg: rgba(0, 212, 255, 0.12);
  --glass-bg: rgba(255, 255, 255, 0.045);
  --glass-bg-hover: rgba(255, 255, 255, 0.075);
  --glass-border: rgba(255, 255, 255, 0.10);
  --glass-blur: blur(18px) saturate(150%);
  --glass-shadow: 0 10px 36px rgba(0, 0, 0, 0.45);
}
`,
  kerst: `
:root {
  --bg-primary: #0a0a1a;
  --bg-secondary: #1a101a;
  --bg-tertiary: #2a1a2a;
  --bg-card: #332633;
  --bg-hover: #3d283d;
  --bg-input: rgba(26, 10, 26, 0.7);
  --border: rgba(200, 150, 255, 0.20);
  --border-light: rgba(255, 180, 255, 0.30);
  --text-primary: #fff5ff;
  --text-secondary: #e6ccff;
  --text-muted: #ccccd9;
  --accent: #ff99cc;
  --accent-hover: #ffb3d9;
  --accent-2: #ff66b2;
  --accent-glow: rgba(255, 153, 204, 0.20);
  --accent-soft: rgba(255, 153, 204, 0.15);
  --green: #22e48a;
  --green-bg: rgba(34, 228, 138, 0.12);
  --yellow: #ffd166;
  --yellow-bg: rgba(255, 209, 102, 0.12);
  --orange: #ff9f43;
  --orange-bg: rgba(255, 159, 67, 0.12);
  --red: #ff5f6d;
  --red-bg: rgba(255, 95, 109, 0.12);
  --cyan: #00e0ff;
  --cyan-bg: rgba(0, 224, 255, 0.12);
  --christmas-tree: #228b22;
  --christmas-gift: #ff4500;
  --christmas-snow: #ffffff;
  --christmas-snow-bg: rgba(255, 255, 255, 0.08);
  --glass-bg: rgba(255, 255, 255, 0.04);
  --glass-bg-hover: rgba(255, 255, 255, 0.08);
  --glass-border: rgba(255, 255, 255, 0.15);
  --glass-blur: blur(18px) saturate(150%);
  --glass-shadow: 0 10px 36px rgba(0, 0, 0, 0.50);
}
`,
  dark: `
:root {
  --bg-primary: #05050d;
  --bg-secondary: #0a0a16;
  --bg-tertiary: #101022;
  --bg-card: #0d0d1b;
  --bg-hover: #16162c;
  --bg-input: rgba(8, 8, 18, 0.7);
  --border: rgba(255, 255, 255, 0.08);
  --border-light: rgba(255, 255, 255, 0.16);
  --text-primary: #f4f4fa;
  --text-secondary: #a5a5bd;
  --text-muted: #70708a;
  --accent: #8b7cff;
  --accent-hover: #a195ff;
  --accent-2: #2fd6ff;
  --accent-glow: rgba(139, 124, 255, 0.18);
  --accent-soft: rgba(139, 124, 255, 0.10);
  --green: #22e48a;
  --green-bg: rgba(34, 228, 138, 0.12);
  --yellow: #ffd166;
  --yellow-bg: rgba(255, 209, 102, 0.12);
  --orange: #ff9f43;
  --orange-bg: rgba(255, 159, 67, 0.12);
  --red: #ff5f6d;
  --red-bg: rgba(255, 95, 109, 0.12);
  --cyan: #39d7ff;
  --cyan-bg: rgba(57, 215, 255, 0.12);
  --glass-bg: rgba(255, 255, 255, 0.045);
  --glass-bg-hover: rgba(255, 255, 255, 0.075);
  --glass-border: rgba(255, 255, 255, 0.10);
  --glass-blur: blur(18px) saturate(150%);
  --glass-shadow: 0 10px 36px rgba(0, 0, 0, 0.45);
}
`,
  light: `
:root {
  --bg-primary: #ffffff;
  --bg-secondary: #f8f9fa;
  --bg-tertiary: #e9ecef;
  --bg-card: #ffffff;
  --bg-hover: #f1f3f4;
  --bg-input: rgba(248, 249, 250, 0.7);
  --border: rgba(0, 0, 0, 0.08);
  --border-light: rgba(0, 0, 0, 0.12);
  --text-primary: #1a1a1a;
  --text-secondary: #5a5a5a;
  --text-muted: #8a8a8a;
  --accent: #4a6bff;
  --accent-hover: #5a7bff;
  --accent-2: #22e48a;
  --accent-glow: rgba(74, 107, 255, 0.15);
  --accent-soft: rgba(74, 107, 255, 0.10);
  --green: #228b22;
  --green-bg: rgba(34, 139, 34, 0.10);
  --yellow: #fd7e14;
  --yellow-bg: rgba(253, 126, 20, 0.10);
  --orange: #fd7e14;
  --orange-bg: rgba(253, 126, 20, 0.10);
  --red: #dc3545;
  --red-bg: rgba(220, 53, 69, 0.10);
  --cyan: #0d6efd;
  --cyan-bg: rgba(13, 110, 253, 0.10);
  --glass-bg: rgba(255, 255, 255, 0.95);
  --glass-bg-hover: rgba(255, 255, 255, 0.98);
  --glass-border: rgba(0, 0, 0, 0.08);
  --glass-blur: blur(8px) saturate(150%);
  --glass-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
`,
};

const THEME_CSS_OVERRIDES = {
  glacier: ``,
  kerst: `
body {
  background:
    radial-gradient(1200px 700px at 110% -10%, rgba(255, 153, 204, 0.15), transparent 60%),
    radial-gradient(1000px 620px at -10% 115%, rgba(255, 69, 0, 0.08), transparent 55%),
    radial-gradient(760px 520px at 50% 0%, rgba(255, 153, 204, 0.06), transparent 60%),
    radial-gradient(600px 400px at 90% 60%, rgba(255, 69, 0, 0.04), transparent 55%),
    var(--bg-primary);
}

.sidebar::before,
.main-content::before {
  content: '';
  position: absolute;
  pointer-events: none;
  top: 0; left: 0; right: 0; bottom: 0;
  background: 
    radial-gradient(circle at 20% 20%, var(--christmas-snow-bg), transparent 20%),
    radial-gradient(circle at 80% 20%, var(--christmas-snow-bg), transparent 20%),
    radial-gradient(circle at 30% 60%, var(--christmas-tree, 0.1), transparent 15%),
    radial-gradient(circle at 70% 60%, var(--christmas-gift, 0.1), transparent 15%);
  z-index: -1;
}

.btn-primary {
  background: linear-gradient(135deg, var(--christmas-gift), var(--christmas-tree));
  box-shadow: 0 6px 20px rgba(255, 69, 0, 0.30);
}
`,
  dark: ``,
};

function getThemeCss(theme) {
  const base = THEME_CSS[theme] || THEME_CSS[DEFAULT_THEME];
  const overrides = THEME_CSS_OVERRIDES[theme] || '';
  return base + overrides;
}

async function getUserTheme(pool, userId) {
  try {
    const rows = await pool.query('SELECT theme FROM users WHERE id = ?', [userId]);
    if (rows && rows.length && rows[0].theme && THEMES.includes(rows[0].theme)) {
      return rows[0].theme;
    }
  } catch {
    // Database error, return default
  }
  return DEFAULT_THEME;
}

async function setUserTheme(pool, userId, theme) {
  if (!THEMES.includes(theme)) theme = DEFAULT_THEME;
  await pool.query('UPDATE users SET theme = ? WHERE id = ?', [theme, userId]);
  return theme;
}

function isGlobalChristmasEnabled(pool) {
  return pool.query('SELECT svalue as enabled FROM settings WHERE skey = ?', ['THEME_KERST_ENABLED'])
    .then(rows => rows && rows.length && rows[0].enabled === '1')
    .catch(() => false);
}

async function getGlobalChristmasStatus(pool) {
  try {
    const rows = await pool.query('SELECT svalue as enabled FROM settings WHERE skey = ?', ['THEME_KERST_ENABLED']);
    return rows && rows.length && rows[0].enabled === '1';
  } catch {
    return false;
  }
}

async function setGlobalChristmasStatus(pool, enabled) {
  await pool.query(
    'INSERT INTO settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)',
    ['THEME_KERST_ENABLED', enabled ? '1' : '0']
  );
}

module.exports = {
  DEFAULT_THEME,
  THEMES,
  getThemeCss,
  getUserTheme,
  setUserTheme,
  isGlobalChristmasEnabled,
  getGlobalChristmasStatus,
  setGlobalChristmasStatus,
};