<div align="center">

# <img alt="MindGit" src="https://img.shields.io/badge/MindGit-Repository%20Manager-7C6CFF?style=for-the-badge&logo=git&logoColor=white&labelColor=0D0D1A" />

### a self-hosted Git repository manager with multi-account GitHub support, live auto-sync and a slick web dashboard.

[![License: MIT](https://img.shields.io/badge/License-MIT-7C6CFF?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.x-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![MariaDB](https://img.shields.io/badge/MariaDB-10%2B-003545?style=flat-square&logo=mariadb&logoColor=white)](https://mariadb.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-010101?style=flat-square&logo=socket.io&logoColor=white)](https://socket.io/)
[![PM2](https://img.shields.io/badge/PM2-ready-2E0331?style=flat-square&logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)

[![GitHub stars](https://img.shields.io/github/stars/MindOfDaanNL/MindGit?style=social)](https://github.com/MindOfDaanNL/MindGit/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/MindOfDaanNL/MindGit?style=social)](https://github.com/MindOfDaanNL/MindGit/network/members)
[![GitHub issues](https://img.shields.io/github/issues/MindOfDaanNL/MindGit?style=social)](https://github.com/MindOfDaanNL/MindGit/issues)
[![GitHub last commit](https://img.shields.io/github/last-commit/MindOfDaanNL/MindGit?style=social)](https://github.com/MindOfDaanNL/MindGit/commits)

<p>
  <a href="#-features">✨ Features</a> •
  <a href="#-screenshots">📸 Screenshots</a> •
  <a href="#-quick-start">🚀 Quick Start</a> •
  <a href="#-installation">📦 Installation</a> •
  <a href="#-configuration">⚙️ Configuration</a> •
  <a href="#-multi-account">🔐 Multi-Account</a> •
  <a href="#-api-reference">📡 API Reference</a> •
  <a href="#-cli">💻 CLI</a> •
  <a href="#-security">🛡️ Security</a> •
  <a href="#-project-structure">📁 Structure</a> •
  <a href="#-faq">❓ FAQ</a> •
  <a href="#-license">📄 License</a>
</p>

<p>
  <strong>📚 Full documentation:</strong>
  <a href="./Docs/README.md">Docs/</a> —
  <a href="./Docs/INSTALL.md">Install</a> ·
  <a href="./Docs/CONFIGURATION.md">Config</a> ·
  <a href="./Docs/MULTI_ACCOUNT.md">Multi-Account</a> ·
  <a href="./Docs/API.md">API</a> ·
  <a href="./Docs/SECURITY.md">Security</a> ·
  <a href="./Docs/CLI.md">CLI</a> ·
  <a href="./Docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="./Docs/NODES.md">Nodes</a> ·
  <a href="./Docs/TROUBLESHOOTING.md">Troubleshooting</a> ·
  <a href="./Docs/CONTRIBUTING.md">Contributing</a> ·
  <a href="./Docs/CHANGELOG.md">Changelog</a>
</p>

</div>

---

## ✨ Features

### Core
- 🗂️ **Multi-repository dashboard** — manage all your local Git repos from a single panel
- 🔐 **Multi-account GitHub support** — link as many GitHub accounts (token + username) as you need
- 🎯 **Per-repo account binding** — each repo is tied to exactly one GitHub account via a dropdown on create/add
- 🤖 **Create repos via the GitHub API** — new repo, local folder, initial commit and `push -u origin` in one flow
- 📂 **Visual folder browser** — pick local paths with a breadcrumb-driven browser (whitelisted via `BROWSE_ROOTS`)
- 🔄 **Manual & automatic sync** — commit → pull → push, with merge-conflict detection
- 📡 **Live auto-sync watch mode** — Socket.IO powered, scans every 15s and pushes when changes appear
- 🌿 **Branch switcher** — list and switch branches from the repo view
- ⚖️ **Conflict resolution** — choose `ours` / `theirs` / `abort` from the UI when a merge fails
- 📊 **Status badges** — up-to-date, uncommitted, ahead/behind counts, per-repo account badge
- 🖥️ **Nodes (agents)** — clone, sync and create repos on *other* machines over WebSocket, with a standalone agent and per-repo direction/auto-sync (see [Nodes](./Docs/NODES.md))
- 🌐 **Multi-language UI** — Dutch and English built-in, switchable per user and persisted in the database

### Security
- 🔒 **AES-256-GCM encrypted tokens** — GitHub tokens never leave your DB in plaintext
- 🧂 **bcrypt password hashing** for dashboard users
- 🛡️ **CSRF protection** on every non-GET request
- 🚧 **Path-traversal protection** via `BROWSE_ROOTS` whitelist
- ⏱️ **Rate limiting** on login (10 / 15 min) and sync endpoints (30 / min)
- 🪪 **Token injected per git command** via `http.extraHeader` — never saved in the remote URL
- 🔁 **Migrations** — legacy plaintext tokens are auto-encrypted on startup

### UX
- 🌓 **Dark theme** out of the box
- 🔎 **Live search** across repositories by name/group/remote
- 📈 **Stats cards** — total, up-to-date, action-needed, not-linked
- 🧩 **Group / tag** system for organising repos
- 📜 **Real-time sync console** with coloured git output
- ✏️ **Custom commit messages** — write your own message or leave empty for auto-generated timestamp
- ⏳ **Loading states** — sync buttons show progress and are disabled during sync
- 🛑 **Sync-all confirmation** — confirm before bulk-syncing all repositories
- 📄 **Diff viewer** — click any changed file to see a coloured diff
- 📋 **Commit detail view** — click any commit for author, date, files, and stats
- 🔔 **Discord notifications** — webhook integration for sync failure alerts
- ⏰ **Flash messages** auto-dismiss after 5 seconds
- 📱 **Responsive layout** — improved mobile experience for repo cards and navigation

<details>
<summary><b>📖 Detailed feature list</b></summary>

| Area | Capability |
| --- | --- |
| **Accounts** | Add / edit / delete / set-default GitHub accounts per dashboard user |
| **Accounts** | Auto-detect matching account when adding a repo whose remote owner equals one of your accounts |
| **Repos** | Create new (remote + local + commit + push in one flow) |
| **Repos** | Add existing local folder (init if needed, attach remote, auto-bind account) |
| **Repos** | Edit account + group after the fact via the repo-view form |
| **Repos** | Remove from dashboard (does NOT delete local files, only the DB row) |
| **Sync** | Manual single-repo sync with optional custom commit message |
| **Sync** | Bulk sync-all with confirmation dialog |
| **Diff** | Click any changed file to view a syntax-coloured diff in a modal |
| **Commits** | Click any commit for author, date, subject, body, files and stats |
| **Notifications** | Discord webhook for sync failure and conflict alerts |
| **Sync** | Per-repo auto-sync (15s interval, Socket.IO room) |
| **Sync** | Global auto-sync watch page (15s interval across all repos) |
| **Branches** | List all branches, switch from repo-view |
| **Conflicts** | Detect merge conflicts, abort, or resolve with ours/theirs |
| **Logs** | Last 50 sync log rows shown per repo |
| **CLI** | Standalone TUI menu (`node github.js`) backed by `github-repos.json` |
| **API** | JSON API under `/api/*` for building your own clients |
| **Nodes** | Assign repos to remote agents; sync/clone/create with per-repo direction (bidirectional/pull/push) |
| **Nodes** | Standalone agent package downloadable at `/agent/download`; auto-sync every 15s per node |

</details>

---

## 📸 Screenshots

> The dashboard, repo view, settings screen and auto-sync watch page are all dark-themed and rendered with EJS. Add your own screenshots here by dropping image files into the repo and referencing them below.

| Dashboard | Repo View |
| --- | --- |
| ![Dashboard](https://cdn.discordapp.com/attachments/1502276789412561020/1574952405341184000/image.png?ex=6b07843a&is=6b0632ba&hm=dadfe497ed005f1c9309f2dfad70743da31c1bbe08da13fee24f1c05b2599b0f?text=Dashboard+view) | ![Repo View](https://via.placeholder.com/640x360/0D0D1A/17A2B8?text=Repo+view) |

| Settings (accounts) | Auto-Sync Watch |
| --- | --- |
| ![Settings](https://via.placeholder.com/640x360/0D0D1A/28A745?text=Settings) | ![Watch](https://via.placeholder.com/640x360/0D0D1A/E040FB?text=Auto-Sync+Watch) |

---

## 📑 Table of Contents

- [Features](#-features)
- [Screenshots](#-screenshots)
- [Quick Start](#-quick-start)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Multi-Account Workflow](#-multi-account)
- [API Reference](#-api-reference)
- [CLI](#-cli)
- [Security](#-security)
- [Project Structure](#-project-structure)
- [PM2 Commands](#-pm2-commands)
- [Migration (existing installs)](#-migration-existing-installs)
- [FAQ](#-faq)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🚀 Quick Start

The fastest way to get MindGit running locally:

```bash
# 1. Clone
git clone https://github.com/MindOfDaanNL/MindGit.git
cd MindGit

# 2. Install deps
npm install

# 3. Create the database
mysql -u root -p < schema.sql

# 4. Copy & fill in environment config
cp .env.example .env
# Edit .env with: DB credentials, SESSION_SECRET, BROWSE_ROOTS
# Generate an encryption key for GitHub tokens:
node scripts/generate-key.js
# (paste the output into TOKEN_ENCRYPTION_KEY in .env)

# 5. Create an admin user
node -e "const bcrypt=require('bcryptjs'),pool=require('./db'); bcrypt.hash('your-password',10).then(h=>pool.query('INSERT INTO users (username,password) VALUES (?,?)',['admin',h]).then(()=>{console.log('User created');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)}));"

# 6. Run
npm start
```

Open <http://localhost:3050> (or the `PORT` from your `.env`), log in with `admin` / `your-password`, then head to **Instellingen** (Settings) to add your first GitHub account.

---

## 📦 Installation

### Prerequisites

| Tool | Version | Required |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | 18+ | ✅ |
| [MariaDB](https://mariadb.org/) or MySQL | 10+ | ✅ |
| [Git](https://git-scm.com/) | any recent | ✅ |
| [PM2](https://pm2.keymetrics.io/) | latest | ⚠️ recommended for production |

### Step-by-step

1. **Clone and install**
   ```bash
   git clone https://github.com/MindOfDaanNL/MindGit.git
   cd MindGit
   npm install
   ```

2. **Create the database** — this creates the `github` database with the following tables:
   - `users` — dashboard users
   - `github_accounts` — your linked GitHub accounts (multi-account support)
   - `repos` — managed repositories (with `account_id` FK)
   - `settings` — global key/value fallback settings
   - `sync_logs` — per-repo sync history

   ```bash
   mysql -u root -p < schema.sql
   ```

3. **Configure environment** — copy the example and fill in your values:
   ```bash
   cp .env.example .env
   ```
   See the [Configuration](#-configuration) section for every variable.

4. **Generate an encryption key** — used to AES-256-GCM encrypt GitHub tokens at rest:
   ```bash
   node scripts/generate-key.js
   ```
   Paste the output into `TOKEN_ENCRYPTION_KEY` in `.env`.

5. **Create an admin user**:
   ```bash
   node -e "const bcrypt=require('bcryptjs'),pool=require('./db'); bcrypt.hash('your-password',10).then(h=>pool.query('INSERT INTO users (username,password) VALUES (?,?)',['admin',h]).then(()=>{console.log('User created');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)}));"
   ```

6. **Start the server**:
   ```bash
   # Local dev
   npm start

   # Production with PM2
   pm2 start server.js --name MindGit
   pm2 save
   pm2 startup
   ```

7. **Link your GitHub accounts** — log in, open **Instellingen**, add one or more accounts (label + username + token). See [Multi-Account](#-multi-account).

---

## ⚙️ Configuration

All configuration lives in `.env`. Copy `.env.example` and edit it.

| Variable | Description | Example |
| --- | --- | --- |
| `DB_HOST` | MariaDB host | `localhost` |
| `DB_USER` | MariaDB user | `mindgit` |
| `DB_PASSWORD` | MariaDB password | `super-secret` |
| `DB_NAME` | MariaDB database name | `github` |
| `DB_CONNECTION_LIMIT` | Pool size | `10` |
| `SESSION_SECRET` | Long random string used to sign session cookies | `x9f2...zz` |
| `TOKEN_ENCRYPTION_KEY` | 32-byte key for AES-256-GCM token encryption. Generate with `node scripts/generate-key.js` | `base64-or-hex-string` |
| `PORT` | HTTP port to listen on | `3050` |
| `BROWSE_ROOTS` | Comma-separated whitelist of absolute paths the folder browser is allowed to read | `/home/you,/var/repos` |
| `GITHUB_TOKEN` | Optional global fallback token (seeded into `settings` on startup if empty) | `ghp_...` |
| `GITHUB_USER` | Optional global fallback GitHub username | `MindOfDaanNL` |
| `NODE_ENV` | Set to `production` to enable secure cookies + `sameSite=none` | `production` |

> ⚠️ **Never commit `.env`.** It is already in `.gitignore`. Keep your encryption key, session secret and tokens private.

---

## 🔐 Multi-Account

MindGit lets you link **multiple GitHub accounts per dashboard user**. Each account has:

- A **label** (e.g. "Personal", "Work", "MindFramework")
- A **GitHub username** (e.g. `MindOfDaanNL`)
- A **Personal Access Token** with `repo` scope (stored AES-256-GCM encrypted)
- An **is-default** flag — used when no explicit account is chosen

### Workflow

1. **Add accounts** in **Settings**.
2. **Create a new repo** — pick the account from a dropdown. The remote URL and API calls use that account's token and username.
3. **Add an existing repo** — either:
   - Pick an account explicitly, or
   - Leave it on **"Auto-detect from remote"** — MindGit inspects the remote's owner and auto-binds the matching account if one exists.
4. **Change account later** — open the repo view and use the "Account & group" form.
5. The **dashboard** shows a `@username` badge on every card so you can see at a glance which account owns it.

### Account routes (web)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/repos/accounts/add` | Create a new account |
| `POST` | `/repos/accounts/:id/edit` | Edit an account (token optional — leave blank to keep current) |
| `POST` | `/repos/accounts/:id/delete` | Delete an account (linked repos fall back to legacy user token) |
| `POST` | `/repos/accounts/:id/default` | Mark an account as default |
| `POST` | `/repos/edit/:id` | Update the account/group binding of an existing repo |

### How tokens are used during sync

The git layer (`lib/git.js`) injects the token **per command** via `-c http.extraHeader=Authorization: Basic <base64>` — the remote URL **never** contains the token. Each repo's sync uses `getRepoToken(pool, repo)` which walks:

1. `repo.account_id` → the bound account's token
2. (fallback) the legacy `users.github_user` + `github_token_encrypted`
3. (fallback) the global `settings.token` + `settings.githubUser`

---

## 📡 API Reference

The server exposes a session-authenticated JSON API under `/api/*`. Auth works via either the session cookie (browser) **or** an `Authorization: Bearer <token>` header returned by `/api/auth/login`.

### Auth

| Method | Endpoint | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | `{ username, password }` | Log in, returns `{ id, username, token }` |
| `POST` | `/api/auth/logout` | — | Invalidate the bearer token |
| `GET` | `/api/auth/me` | — | Current user info |

### Repos

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/repos` | List all repos for the current user (with live status) |
| `GET` | `/api/repos/:id` | Repo detail (status + last 50 logs) |
| `GET` | `/api/repos/:id/status` | Fresh git status |
| `POST` | `/api/repos` | Add existing local repo. Body: `name, path, remote, groupName, accountId` |
| `POST` | `/api/repos/create` | Create new repo on GitHub + locally. Body: `repoName, description, isPrivate, groupName, accountId` |
| `POST` | `/api/repos/:id/sync` | Trigger a sync for one repo |
| `GET` | `/api/repos/:id/branches` | List branches |
| `POST` | `/api/repos/:id/branches/switch` | Body: `{ branch }` |
| `POST` | `/api/repos/:id/resolve-conflict` | Body: `{ strategy: 'ours' \| 'theirs' \| 'abort' }` |

### Settings & Accounts

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/settings` | Legacy github_user + accounts list |
| `GET` | `/api/settings/token` | Legacy fallback token |
| `POST` | `/api/settings` | Update legacy single-token |
| `GET` | `/api/accounts` | List all accounts (without tokens) |
| `POST` | `/api/accounts` | Add account. Body: `label, githubUser, token, isDefault` |
| `PUT` | `/api/accounts/:id` | Edit account. Body: `label, githubUser, token, isDefault` |
| `DELETE` | `/api/accounts/:id` | Delete account |
| `POST` | `/api/accounts/:id/default` | Mark as default |

> All non-GET routes require a valid CSRF token (sent automatically for browser sessions; for API clients you can use the Bearer token flow which is CSRF-exempt).

### Example: listing accounts

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3050/api/accounts
```

```json
{
  "success": true,
  "data": [
    { "id": 1, "label": "Standaard", "github_user": "MindOfDaanNL", "is_default": 1 },
    { "id": 2, "label": "Werk",      "github_user": "MindFramework", "is_default": 0 }
  ]
}
```

---

## 💻 CLI

MindGit ships with a standalone terminal menu backed by `github-repos.json` (not the database):

```bash
node github.js
```

Features:
- Create a new repo (GitHub API + local clone)
- Add existing repos
- Remove repos from the config
- One-shot sync-all
- Continuous watch mode (15s scan, stop with `q`)
- Set your GitHub token

> `github-repos.json` is git-ignored because it stores the token in plaintext. Use the web dashboard for production setups where tokens are encrypted at rest.

---

## 🛡️ Security

### Token storage
- Tokens are encrypted with **AES-256-GCM** using `TOKEN_ENCRYPTION_KEY` from `.env`.
- Each encryption produces a fresh random IV + auth tag.
- Detection of legacy plaintext values is automatic — they are re-encrypted on first startup (see `lib/seed.js`).

### Git authentication
- Tokens are **NOT** stored in remote URLs (`https://<token>@github.com/...`).
- Instead, every git invocation receives `-c http.extraHeader=Authorization: Basic <base64(token:x-oauth-basic)>`.
- Remote URLs are written as `https://github.com/<owner>/<repo>.git` (token-free).

### Web security
- **CSRF**: double-submit cookie pattern. Every non-GET request must carry a matching `XSRF-TOKEN` cookie + `_csrf` body/header.
- **Sessions**: HTTP-only, `sameSite=lax` (dev) or `sameSite=none; secure` (production when `NODE_ENV=production`).
- **Rate limiting**: 10 login attempts per 15 min per IP, 30 sync requests per min per IP, 500 total requests per 15 min per IP.
- **Path traversal**: `/repos/browse` is hard-scoped to `BROWSE_ROOTS`. Any path outside is rejected with `403`.
- **Password hashing**: bcrypt with cost factor 10. Login uses a dummy hash comparison to avoid username enumeration via timing.

---

## 📁 Project Structure

```
MindGit/
├── server.js              # Express app + Socket.IO + session middleware
├── db.js                  # MariaDB connection pool
├── github.js              # Standalone CLI (uses github-repos.json, not the DB)
├── schema.sql             # Database schema (users, github_accounts, repos, settings, sync_logs)
├── package.json
├── .env.example           # Configuration template (copy to .env)
├── .gitignore
│
├── lib/
│   ├── crypto.js          # AES-256-GCM encrypt/decrypt for tokens
│   ├── csrf.js            # CSRF middleware
│   ├── error.js           # 404 + error handlers
│   ├── git.js             # Safe git executor (token via http.extraHeader, no shell)
│   ├── i18n.js            # NL/EN translation dictionary (~200 keys), t(), clientStrings()
│   ├── notify.js          # Slack & Discord webhook notification dispatcher
│   ├── paths.js           # BROWSE_ROOTS whitelist helpers
│   ├── seed.js            # Encrypt legacy tokens + seed .env values + migrate users.language on startup
│   └── settings.js        # Multi-account CRUD + getRepoToken
│
├── routes/
│   ├── auth.js            # Login / logout (web)
│   ├── repos.js          # Dashboard, create/add/edit repos, accounts CRUD, browse, sync (web)
│   └── api.js            # JSON API (auth, repos, branches, conflicts, settings, accounts)
│
├── agent/                # Standalone agent for remote nodes (Windows/Linux/macOS)
│   ├── index.js          # Agent: connects to coordinator over raw WebSocket
│   ├── lib/              # agent-protocol.js (shared message protocol, self-contained)
│   └── scripts/          # install-linux.sh, install-windows.bat
│
├── views/                # EJS templates (dark theme)
│   ├── partials/         # header.ejs (modal + flash auto-dismiss), footer.ejs
│   ├── dashboard.ejs
│   ├── create-repo.ejs
│   ├── add-repo.ejs
│   ├── repo-view.ejs     # clickable files (diff) + commits (detail)
│   ├── settings.ejs
│   ├── notifications.ejs # Slack & Discord webhook config
│   ├── watch.ejs
│   ├── login.ejs
│   └── error.ejs
│
├── public/               # Static assets
│   ├── style.css         # Theme + accounts UI
│   └── app.js            # Sidebar / mobile nav
│
└── scripts/
    ├── generate-key.js    # Generate a TOKEN_ENCRYPTION_KEY
    ├── migrate-accounts.js    # Migrate legacy single-token → multi-account
    └── migrate-user-tokens.js # Earlier migration (per-user token columns)
```

---

## 📟 PM2 Commands

```bash
pm2 start server.js --name MindGit
pm2 save
pm2 startup

# Common ops
pm2 status
pm2 logs MindGit
pm2 restart MindGit
pm2 stop MindGit
pm2 delete MindGit
pm2 monit
```

---

## 🔁 Migration (existing installs)

If you are upgrading from the legacy single-token model (`users.github_user` + `users.github_token_encrypted`), run:

```bash
node scripts/migrate-accounts.js
```

This one-shot script will:

1. Create the `github_accounts` table if it doesn't exist.
2. Add the `repos.account_id` column + FK if missing.
3. Copy any per-user legacy token into a **default account** labelled "Standaard".
4. Bind all existing repos (without `account_id`) to that new default account.
5. Fall back to global `settings.token` + `settings.githubUser` for users who never had a per-user token.
6. Ensure every user has exactly one default account.

> New installs do **not** need to run this script — `schema.sql` is already up to date. Running it is harmless though.

---

## ❓ FAQ

<details>
<summary><b>Can I use GitHub OAuth instead of Personal Access Tokens?</b></summary>

Not currently. MindGit uses PATs because they work seamlessly with the git CLI via `http.extraHeader`. OAuth would require a callback flow and an OAuth app; the per-repo auto-sync loop also needs long-lived credentials. PATs with `repo` scope are the simplest path.
</details>

<details>
<summary><b>What happens if I delete an account that has repos bound to it?</b></summary>

The `ON DELETE SET NULL` foreign key sets `repos.account_id = NULL` for those repos. Sync then falls back to the legacy `users.github_token_encrypted`, and finally to the global `settings.token`. No repos or local files are lost.
</details>

<details>
<summary><b>Does MindGit read or write files inside my repos?</b></summary>

Only via `git`. MindGit never edits your source files directly — it only runs git commands (`add -A`, `commit`, `pull`, `push`, `fetch`, etc.). The folder browser in `/repos/browse` only lists entries, never modifies them.
</details>

<details>
<summary><b>Is my token ever sent to the client?</b></summary>

No. The web `GET /repos/settings` route returns an empty `token` field. The API route `GET /api/settings/token` returns the fallback token (used by trusted desktop clients); account tokens themselves are never returned to any client.
</details>

<details>
<summary><b>Can multiple dashboard users share the same GitHub account?</b></summary>

Yes. Each dashboard user has their own `github_accounts` rows, so two users can independently link the same GitHub username + token without interfering with each other.
</details>

<details>
<summary><b>How do I rotate a token?</b></summary>

Open **Settings** → click **Bewerken** on the account → paste the new token in the "Nieuwe token" field → save. Leave the field blank to keep the current token.
</details>

<details>
<summary><b>Why a separate <code>github_accounts</code> table instead of just <code>users.github_user</code>?</b></summary>

Because one dashboard user may legitimately own multiple GitHub identities (personal, work, client projects). The new table makes this first-class, while the legacy columns are kept as a single-account fallback for backwards compatibility.
</details>

<details>
<summary><b>How do I change the UI language?</b></summary>

Go to **Settings** → the first card is "Taal / Language". Choose Nederlands or English. The preference is saved per user in the database and persists across sessions. API clients can use `POST /api/settings/language` with `{ "language": "en" }`.
</details>

<details>
<summary><b>Can I add more languages?</b></summary>

Yes. Add your translations to `lib/i18n.js` — add a new top-level key (e.g. `fr`) with the same keys as `nl` and `en`, then add the code to the `langList` array. No external libraries or build steps needed.
</details>

---

## 🤝 Contributing

Contributions are welcome. The flow is the standard one:

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit with a clear message: `git commit -m "feat: add my feature"`
4. Push: `git push origin feat/my-feature`
5. Open a Pull Request

### Code style

- CommonJS (`require`), `'use strict'` at the top of every module
- No shell-execution in git helpers — always `spawnSync` with `shell: false` (see `lib/git.js`)
- No hardcoded absolute paths in routes/views — read from `BROWSE_ROOTS`

### Running tests

There is no formal test suite yet. At minimum, run a syntax check after changes:

```bash
node --check server.js
node --check lib/*.js routes/*.js scripts/*.js
```

---

## 📄 License

Released under the [MIT License](LICENSE).

<div align="center">

---

<p>
  <a href="https://github.com/MindOfDaanNL/MindGit">⭐ Star</a> •
  <a href="https://github.com/MindOfDaanNL/MindGit/issues">🐛 Report a bug</a> •
  <a href="https://github.com/MindOfDaanNL/MindGit/fork">🍴 Fork</a>
</p>

<p>
  <sub>Built by <a href="https://github.com/MindOfDaanNL">MindDevelopment - 2026</a>
</p>

</div>
