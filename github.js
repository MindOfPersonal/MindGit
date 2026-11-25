const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const readline = require('readline');
const { apiRequest } = require('./lib/github-api');
const {
  git: gitLib,
  isGitRepo,
  getBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
} = require('./lib/git');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const CONFIG_PATH = path.join(__dirname, 'github-repos.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const initial = { token: '', githubUser: '', repos: [] };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function rl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const iface = rl();
    iface.question(question, (answer) => {
      iface.close();
      resolve(answer.trim());
    });
  });
}

function git(cmd, cwd) {
  return gitLib(cmd, cwd);
}

function gitStream(cmd, cwd) {
  return new Promise((resolve) => {
    const proc = exec(`git ${cmd}`, { cwd, encoding: 'utf-8' }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.stdout?.pipe(process.stdout);
    proc.stderr?.pipe(process.stderr);
  });
}

function getStatus(repoPath) {
  if (!isGitRepo(repoPath)) return 'no-git';

  const status = git('status --porcelain', repoPath);
  const changes = status ? status.split('\n').filter(Boolean).length : 0;

  const branch = getBranch(repoPath);
  const remote = git('remote get-url origin', repoPath);
  if (!remote) return changes > 0 ? 'changes-no-remote' : 'ok-no-remote';

  git('fetch origin 2>/dev/null', repoPath);
  const behind = git(`rev-list --count ${branch}..origin/${branch} 2>/dev/null`, repoPath);
  const ahead = git(`rev-list --count origin/${branch}..${branch} 2>/dev/null`, repoPath);

  const behindCount = behind ? parseInt(behind) : 0;
  const aheadCount = ahead ? parseInt(ahead) : 0;

  return { changes, behindCount, aheadCount, branch, remote };
}

async function syncRepo(repo, token) {
  const p = repo.path;
  const name = repo.name;

  if (!isGitRepo(p)) {
    console.log(`  ${C.red}[SKIP]${C.reset} ${name}: geen git repository`);
    return { ok: false, reason: 'no-git' };
  }

  if (!repo.remote) {
    console.log(`  ${C.yellow}[SKIP]${C.reset} ${name}: geen remote ingesteld`);
    return { ok: false, reason: 'no-remote' };
  }

  const remoteUrl = `https://${token ? token + '@' : ''}github.com/${repo.remote}.git`;
  const existingRemote = git('remote get-url origin', p);
  if (!existingRemote || !existingRemote.includes('github.com')) {
    if (existingRemote) git('remote remove origin', p);
    git(`remote add origin ${remoteUrl}`, p);
  } else if (token && !existingRemote.includes('@')) {
    git('remote set-url origin ' + remoteUrl, p);
  }

  git(`config user.email "mindframework@auto.sync"`, p);
  git(`config user.name "MindFramework Auto-Sync"`, p);

  const branch = getBranch(p);

  if (hasUncommittedChanges(p)) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    git('add -A', p);
    const commitResult = git(`commit -m "auto-sync: ${now}"`, p);
    if (commitResult === null) {
      console.log(`  ${C.yellow}[OK]${C.reset} ${name}: geen wijzigingen om te committen`);
    } else {
      console.log(`  ${C.green}[COMMIT]${C.reset} ${name}: wijzigingen gecommit`);
    }
  }

  git('fetch origin 2>/dev/null', p);
  const behind = git(`rev-list --count ${branch}..origin/${branch} 2>/dev/null`, p);
  const behindCount = behind ? parseInt(behind) : 0;
  const ahead = git(`rev-list --count origin/${branch}..${branch} 2>/dev/null`, p);
  const aheadCount = ahead ? parseInt(ahead) : 0;

  if (behindCount > 0) {
    console.log(`  ${C.cyan}[PULL]${C.reset} ${name}: remote wijzigingen ophalen (${behindCount} commits)`);
    const pullResult = git(`pull --no-edit --no-rebase origin ${branch}`, p);
    if (pullResult === null) {
      const conflictFiles = git('diff --name-only --diff-filter=U', p);
      if (conflictFiles) {
        console.log(`  ${C.red}[CONFLICT]${C.reset} ${name}: merge conflicten in:\n    ${conflictFiles.split('\n').join('\n    ')}`);
        git('merge --abort 2>/dev/null', p);
        return { ok: false, reason: 'conflict' };
      }
      console.log(`  ${C.red}[ERROR]${C.reset} ${name}: pull mislukt`);
      return { ok: false, reason: 'pull-failed' };
    }
    console.log(`  ${C.green}[MERGED]${C.reset} ${name}: remote wijzigingen gemerged`);
  }

  const aheadAfter = git(`rev-list --count origin/${branch}..${branch} 2>/dev/null`, p);
  const aheadAfterCount = aheadAfter ? parseInt(aheadAfter) : 0;

  if (aheadAfterCount > 0) {
    console.log(`  ${C.magenta}[PUSH]${C.reset} ${name}: ${aheadAfterCount} commits pushen...`);
    const pushResult = git(`push origin ${branch}`, p);
    if (pushResult === null) {
      console.log(`  ${C.red}[ERROR]${C.reset} ${name}: push mislukt`);
      return { ok: false, reason: 'push-failed' };
    }
    console.log(`  ${C.green}[PUSHED]${C.reset} ${name}: succesvol gepusht`);
  }

  if (aheadAfterCount === 0 && !hasUncommittedChanges(p) && behindCount === 0) {
    console.log(`  ${C.dim}[UP-TO-DATE]${C.reset} ${name}`);
  }

  return { ok: true };
}

async function syncAll(repos, token) {
  console.log(`\n${C.bold}${C.cyan}=== Sync Alle Repositories ===${C.reset}\n`);
  let ok = 0, fail = 0;
  for (const repo of repos) {
    const result = await syncRepo(repo, token);
    result.ok ? ok++ : fail++;
  }
  console.log(`\n${C.bold}Klaar: ${C.green}${ok} geslaagd${C.reset}, ${C.red}${fail} mislukt${C.reset}\n`);
  return { ok, fail };
}

async function watchMode(repos, token) {
  const INTERVAL = 15;

  console.log(`\n${C.bold}${C.magenta}=== Watch Modus Actief ===${C.reset}`);
  console.log(`${C.dim}Scan elke ${INTERVAL}s op wijzigingen. Druk ${C.bold}q + Enter${C.reset}${C.dim} om te stoppen.${C.reset}\n`);

  console.log(`${C.dim}Gemonitorde repos:${C.reset}`);
  for (const r of repos) {
    console.log(`  ${C.cyan}${r.name}${C.reset} ${C.dim}→ ${r.path}${C.reset}`);
  }
  console.log('');

  let running = true;
  let tick = 0;

  const check = async () => {
    if (!running) return;
    tick++;
    const ts = new Date().toLocaleTimeString('nl-NL', { hour12: false });
    let hadWork = false;

    for (const repo of repos) {
      if (hasUncommittedChanges(repo.path)) {
        if (!hadWork) {
          console.log(`\n${C.bold}[${ts}]${C.reset}`);
          hadWork = true;
        }
        await syncRepo(repo, token);
      } else {
        const gitStatus = getStatus(repo.path);
        if (typeof gitStatus === 'object' && (gitStatus.behindCount > 0 || gitStatus.aheadCount > 0)) {
          if (!hadWork) {
            console.log(`\n${C.bold}[${ts}]${C.reset}`);
            hadWork = true;
          }
          await syncRepo(repo, token);
        }
      }
    }

    if (!hadWork && tick % 4 === 0) {
      process.stdout.write(`${C.dim}.${C.reset}`);
    }
  };

  if (readline.emitKeypressEvents) {
    readline.emitKeypressEvents(process.stdin);
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  const onKey = (str, key) => {
    if (key && key.name === 'q') {
      running = false;
      console.log(`\n\n${C.yellow}Watch modus gestopt.${C.reset}\n`);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.removeListener('keypress', onKey);
    }
  };
  process.stdin.on('keypress', onKey);

  check();
  const interval = setInterval(check, INTERVAL * 1000);

  while (running) {
    await new Promise((r) => setTimeout(r, 500));
  }

  clearInterval(interval);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.removeListener('keypress', onKey);
}

async function createNewRepo(config) {
  console.log(`\n${C.bold}${C.green}=== Nieuwe Repository Aanmaken ===${C.reset}\n`);

  if (!config.token) {
    console.log(`${C.red}Geen GitHub token ingesteld.${C.reset}`);
    const token = await ask(`${C.yellow}GitHub Personal Access Token:${C.reset} `);
    if (!token) return;
    config.token = token;
    saveConfig(config);
    console.log(`${C.green}Token opgeslagen.${C.reset}\n`);
  }

  if (!config.githubUser) {
    const username = await ask(`${C.yellow}GitHub gebruikersnaam:${C.reset} `);
    if (!username) return;
    config.githubUser = username;
    saveConfig(config);
  }

  const repoName = await ask(`${C.yellow}Repository naam (bv. mf_server):${C.reset} `);
  if (!repoName) return;

  const description = await ask(`${C.yellow}Beschrijving (optioneel):${C.reset} `);

  const privInput = await ask(`${C.yellow}Private repository? (j/n, default: n):${C.reset} `);
  const isPrivate = privInput.toLowerCase() === 'j' || privInput.toLowerCase() === 'y';

  console.log(`\n${C.cyan}Repository aanmaken op GitHub...${C.reset}`);

  try {
    const created = await apiRequest('POST', '/user/repos', config.token, {
      name: repoName,
      description: description || `FiveM server: ${repoName}`,
      private: isPrivate,
    });

    console.log(`${C.green}Repository aangemaakt: ${C.bold}${created.html_url}${C.reset}`);

    const localPath = await ask(`\n${C.yellow}Lokaal pad voor ${repoName}:${C.reset} `);
    if (!localPath) return;

    const absolutePath = path.resolve(localPath);

    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(absolutePath, { recursive: true });
      console.log(`${C.green}Directory aangemaakt: ${absolutePath}${C.reset}`);
    }

    const remoteUrl = `https://${config.token}@github.com/${config.githubUser}/${repoName}.git`;

    if (!isGitRepo(absolutePath)) {
      git('init', absolutePath);
      git('config user.email "mindframework@auto.sync"', absolutePath);
      git('config user.name "MindFramework Auto-Sync"', absolutePath);
      git(`remote add origin ${remoteUrl}`, absolutePath);

      const files = fs.readdirSync(absolutePath).filter(f => !f.startsWith('.'));
      if (files.length > 0) {
        git('add -A', absolutePath);
        git('commit -m "Initial commit"', absolutePath);
        console.log(`${C.green}Bestaande bestanden gecommit.${C.reset}`);
      } else {
        fs.writeFileSync(path.join(absolutePath, 'README.md'), `# ${repoName}\n\n${description || 'FiveM server resource'}\n`);
        git('add -A', absolutePath);
        git('commit -m "Initial commit"', absolutePath);
        console.log(`${C.green}README.md aangemaakt en gecommit.${C.reset}`);
      }
    } else {
      const existing = git('remote get-url origin', absolutePath);
      if (!existing || !existing.includes('github.com')) {
        if (existing) git('remote remove origin', absolutePath);
        git(`remote add origin ${remoteUrl}`, absolutePath);
      }
    }

    const branch = getBranch(absolutePath);
    console.log(`${C.cyan}Pushen naar GitHub (branch: ${branch})...${C.reset}`);
    git(`push -u origin ${branch} 2>&1`, absolutePath);

    const existingIdx = config.repos.findIndex(
      (r) => r.path === absolutePath || r.name === repoName
    );
    if (existingIdx >= 0) {
      config.repos[existingIdx] = {
        name: repoName,
        path: absolutePath,
        remote: `${config.githubUser}/${repoName}`,
      };
    } else {
      config.repos.push({
        name: repoName,
        path: absolutePath,
        remote: `${config.githubUser}/${repoName}`,
      });
    }

    saveConfig(config);
    console.log(`\n${C.green}${C.bold}Klaar! ${repoName} is toegevoegd en gesynct.${C.reset}\n`);

  } catch (err) {
    console.log(`\n${C.red}Fout bij aanmaken repo: ${err.message}${C.reset}\n`);
  }
}

async function addExistingRepo(config) {
  console.log(`\n${C.bold}${C.cyan}=== Bestaande Repository Toevoegen ===${C.reset}\n`);

  const name = await ask(`${C.yellow}Naam voor deze repo (bv. "Discord Bot"):${C.reset} `);
  if (!name) return;

  const localPath = await ask(`${C.yellow}Lokaal pad:${C.reset} `);
  if (!localPath) return;

  const absolutePath = path.resolve(localPath);

  if (!fs.existsSync(absolutePath)) {
    console.log(`${C.red}Pad bestaat niet: ${absolutePath}${C.reset}\n`);
    return;
  }

  if (!isGitRepo(absolutePath)) {
    const initGit = await ask(`${C.yellow}Geen .git gevonden. Initialiseren? (j/n):${C.reset} `);
    if (initGit.toLowerCase() === 'j' || initGit.toLowerCase() === 'y') {
      git('init', absolutePath);
      git('config user.email "mindframework@auto.sync"', absolutePath);
      git('config user.name "MindFramework Auto-Sync"', absolutePath);
    } else {
      console.log(`${C.red}Overgeslagen (geen git repo).${C.reset}\n`);
      return;
    }
  }

  let remote = git('remote get-url origin', absolutePath);
  let remoteShort = '';

  if (remote) {
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    remoteShort = match ? match[1] : '';
    console.log(`${C.dim}Remote gevonden: ${remoteShort}${C.reset}`);
  }

  if (!remoteShort) {
    if (!config.githubUser) {
      config.githubUser = await ask(`${C.yellow}GitHub gebruikersnaam:${C.reset} `);
      if (!config.githubUser) return;
      saveConfig(config);
    }
    const repoName = await ask(`${C.yellow}GitHub repo naam:${C.reset} `);
    if (!repoName) return;
    remoteShort = `${config.githubUser}/${repoName}`;

    const remoteUrl = config.token
      ? `https://${config.token}@github.com/${remoteShort}.git`
      : `https://github.com/${remoteShort}.git`;

    if (remote) git('remote remove origin', absolutePath);
    git(`remote add origin ${remoteUrl}`, absolutePath);
  }

  const existing = config.repos.findIndex((r) => r.path === absolutePath);
  if (existing >= 0) {
    config.repos[existing] = { name, path: absolutePath, remote: remoteShort };
  } else {
    config.repos.push({ name, path: absolutePath, remote: remoteShort });
  }

  saveConfig(config);
  console.log(`${C.green}${C.bold}Repository "${name}" toegevoegd!${C.reset}\n`);
}

async function removeRepo(config) {
  if (config.repos.length === 0) {
    console.log(`\n${C.yellow}Geen repositories om te verwijderen.${C.reset}\n`);
    return;
  }

  console.log(`\n${C.bold}${C.red}=== Repository Verwijderen ===${C.reset}\n`);
  config.repos.forEach((r, i) => {
    console.log(`  ${C.bold}${i + 1}.${C.reset} ${r.name} ${C.dim}(${r.path})${C.reset}`);
  });

  const choice = await ask(`\n${C.yellow}Nummer om te verwijderen (of Enter om te annuleren):${C.reset} `);
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= config.repos.length) {
    console.log(`${C.yellow}Geannuleerd.${C.reset}\n`);
    return;
  }

  const removed = config.repos.splice(idx, 1)[0];
  saveConfig(config);
  console.log(`${C.green}"${removed.name}" verwijderd uit config.${C.reset}\n`);
}

async function setToken(config) {
  console.log(`\n${C.bold}${C.yellow}=== GitHub Token Instellen ===${C.reset}\n`);
  if (config.token) {
    console.log(`${C.dim}Huidige token: ${config.token.substring(0, 10)}...${C.reset}\n`);
  }
  const token = await ask(`${C.yellow}GitHub Personal Access Token (of Enter om te behouden):${C.reset} `);
  if (token) {
    config.token = token;
    saveConfig(config);
    console.log(`${C.green}Token opgeslagen.${C.reset}\n`);
  }
}

function printHeader() {
  console.clear();
  console.log(`${C.bold}${C.cyan}╔══════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║   MindFramework GitHub Manager       ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════╝${C.reset}\n`);
}

async function mainMenu() {
  let config = loadConfig();

  while (true) {
    printHeader();

    if (config.token) {
      console.log(`${C.green}Token:${C.reset} ${config.token.substring(0, 10)}... ${C.dim}(ingesteld)${C.reset}`);
    } else {
      console.log(`${C.red}Token: niet ingesteld (nodig voor API calls)${C.reset}`);
    }
    console.log(`${C.green}User:${C.reset}  ${config.githubUser || C.dim + '(niet ingesteld)' + C.reset}`);

    console.log(`\n${C.bold}Repositories:${C.reset}`);
    if (config.repos.length === 0) {
      console.log(`  ${C.dim}(geen repositories toegevoegd)${C.reset}`);
    } else {
      config.repos.forEach((r, i) => {
        const status = getStatus(r.path);
        let icon = '';
        if (status === 'no-git') icon = `${C.red}[!]${C.reset}`;
        else if (status === 'changes-no-remote') icon = `${C.yellow}[?]${C.reset}`;
        else if (status === 'ok-no-remote') icon = `${C.dim}[?]${C.reset}`;
        else if (status.changes > 0 && status.behindCount > 0) icon = `${C.yellow}[⇅]${C.reset}`;
        else if (status.changes > 0) icon = `${C.yellow}[↑]${C.reset}`;
        else if (status.behindCount > 0) icon = `${C.cyan}[↓]${C.reset}`;
        else icon = `${C.green}[✓]${C.reset}`;
        console.log(`  ${C.bold}${i + 1}.${C.reset} ${icon} ${r.name} ${C.dim}(${r.path})${C.reset}`);
      });
    }

    console.log(`\n${C.bold}Opties:${C.reset}`);
    console.log(`  ${C.bold}1.${C.reset} Nieuwe repository aanmaken (GitHub API + lokaal)`);
    console.log(`  ${C.bold}2.${C.reset} Bestaande repository toevoegen`);
    console.log(`  ${C.bold}3.${C.reset} Repository verwijderen uit lijst`);
    console.log(`  ${C.bold}4.${C.reset} ${C.green}Sync alle repositories (eenmalig)${C.reset}`);
    console.log(`  ${C.bold}5.${C.reset} ${C.magenta}Watch modus (continue sync elke 15s)${C.reset}`);
    console.log(`  ${C.bold}6.${C.reset} GitHub token instellen`);
    console.log(`  ${C.bold}0.${C.reset} Afsluiten`);

    const choice = await ask(`\n${C.yellow}Keuze:${C.reset} `);

    switch (choice) {
      case '1':
        await createNewRepo(config);
        config = loadConfig();
        break;
      case '2':
        await addExistingRepo(config);
        config = loadConfig();
        break;
      case '3':
        await removeRepo(config);
        config = loadConfig();
        break;
      case '4':
        if (config.repos.length === 0) {
          console.log(`\n${C.yellow}Voeg eerst repositories toe (optie 1 of 2).${C.reset}\n`);
          await ask('Druk Enter om door te gaan...');
        } else {
          await syncAll(config.repos, config.token);
          await ask('Druk Enter om door te gaan...');
        }
        break;
      case '5':
        if (config.repos.length === 0) {
          console.log(`\n${C.yellow}Voeg eerst repositories toe (optie 1 of 2).${C.reset}\n`);
          await ask('Druk Enter om door te gaan...');
        } else {
          await watchMode(config.repos, config.token);
        }
        break;
      case '6':
        await setToken(config);
        config = loadConfig();
        break;
      case '0':
        console.log(`\n${C.cyan}Tot ziens!${C.reset}\n`);
        process.exit(0);
      default:
        console.log(`\n${C.red}Ongeldige keuze.${C.reset}`);
        await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

mainMenu().catch((err) => {
  console.error(`${C.red}Fout: ${err.message}${C.reset}`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(1);
});
