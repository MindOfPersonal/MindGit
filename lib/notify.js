'use strict';

const https = require('https');
const http = require('http');
const { getGlobalSetting } = require('./settings');

function sendWebhook(url, payload) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    try {
      const parsed = new URL(url);
      const data = JSON.stringify(payload);
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'User-Agent': 'MindGit/1.3',
        },
      };
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request(opts, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(true);
          } else {
            console.warn(`[NOTIFY] Webhook failed: ${res.statusCode} ${res.statusMessage}`);
            resolve(false);
          }
        });
      });
      req.on('error', (err) => {
        console.warn(`[NOTIFY] Webhook error: ${err.message}`);
        resolve(false);
      });
      req.setTimeout(10000, () => {
        console.warn('[NOTIFY] Webhook timeout');
        req.destroy();
        resolve(false);
      });
      req.write(data);
      req.end();
    } catch (err) {
      console.warn(`[NOTIFY] Webhook catch: ${err.message}`);
      resolve(false);
    }
  });
}

async function sendDiscord(webhookUrl, repoName, status, details) {
  if (!webhookUrl) return;
  const color = status === 'success' ? 0x00e676 : status === 'conflict' ? 0xff9100 : 0xff5252;
  await sendWebhook(webhookUrl, {
    embeds: [{
      title: `MindGit: ${repoName}`,
      description: details,
      color,
      fields: [
        { name: 'Status', value: status, inline: true },
        { name: 'Repository', value: repoName, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function sendNotification(pool, repoName, status, details, userId) {
  try {
    const discordUrl = await getGlobalSetting(pool, 'NOTIFY_DISCORD_URL');
    if (discordUrl) {
      await sendDiscord(discordUrl, repoName, status, details);
    }
    if (discordUrl) {
      console.info `[NOTIFY] Discord webhook configured: ${discordUrl.substring(0, 20)}... for repo: ${repoName}`;
    }
  } catch {
    // Discord mag niet crashen
  }

  if (userId) {
    try {
      const { sendPushToUser } = require('./push');
      const failed = status !== 'success';
      await sendPushToUser(pool, userId, {
        title: failed ? `MindGit: sync mislukt` : `MindGit: ${repoName}`,
        body: `${repoName} — ${details || status}`,
        status,
        repoName,
        url: '/repos',
        tag: `mindgit-${repoName}`,
      });
    } catch {
      // web push mag niet crashen
    }
  }
}

module.exports = { sendNotification };
