"use strict";
// Description:
//   Automated deploy — listens for CD pipeline messages, validates the
//   GitHub release artifact, then deploys.
//
//   The deploy tag is the source of truth.  Hubot derives env, app, repo,
//   and the release URL from it.  The human-readable URL in the message
//   is ignored — it's there so people can click it.
//
//   Fallback: if no structured tag, Hubot extracts env + app identifier
//   from the text and deploys latest.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var _a, _b, _c;
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const https = __importStar(require("https"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const util_1 = require("util");
const child_process_1 = require("child_process");
const exec = (0, util_1.promisify)(child_process_1.exec);
// ── Configuration ────────────────────────────────────────────────────────────
const DEPLOY_SCRIPT = (_a = process.env.DEPLOY_SCRIPT) !== null && _a !== void 0 ? _a : '/home/hubot/DeploymentScripts/hubot/deploy.sh';
const DEPLOY_TIMEOUT = 600000; // 10 min
// Agora CI bot — Slack-verified bot_id, not spoofable.
const DEPLOY_BOT_ID = (_b = process.env.AGORA_BOT_ID) !== null && _b !== void 0 ? _b : 'B0AMQKWT77W';
const GITHUB_ORG = 'sonarmd';
const ALLOWED_CHANNELS = new Set(((_c = process.env.DEPLOY_CHANNELS) !== null && _c !== void 0 ? _c : 'ops,deployments,ops-dev').split(','));
// Identifier → repo name.
const APP_MAP = {
    api: 'triggr_api',
    fe: 'frontend',
    mobile: 'frontend-patient-app',
    cdk: 'infra-cdk',
};
// ── Tag parsing ──────────────────────────────────────────────────────────────
// Tag format: {env}-{identifier}-v?{version}-b{build}
// Examples:   stg-api-1.0.0-b81   prd-fe-v2.3.1-b44   dev-mobile-v0.1.0-b3
const TAG_PATTERN = /\b(dev|stg|prd)-(\w+)-v?([\d.]+)-b(\d+)\b/;
function parseTag(text) {
    const m = text.match(TAG_PATTERN);
    if (!m)
        return null;
    const [tag, env, identifier] = m;
    const repo = APP_MAP[identifier];
    if (!repo)
        return null;
    return { env, identifier, repo, tag };
}
// ── Fallback parsing (env + identifier, no structured tag) ───────────────────
function parseFallback(text) {
    const envMatch = text.match(/\b(dev|stg|prd)\b/i);
    if (!envMatch)
        return null;
    const env = envMatch[1].toLowerCase();
    const knownIds = Object.keys(APP_MAP);
    const identifier = knownIds.find((id) => new RegExp(`\\b${id}\\b`, 'i').test(text));
    if (!identifier)
        return null;
    return { env, identifier, repo: APP_MAP[identifier] };
}
// ── Host env detection ───────────────────────────────────────────────────────
const hostname = os.hostname();
const hostEnv = (() => {
    const seg = hostname.split(/[-.]/)[1];
    if (seg === 'sonarmd')
        return 'prd';
    return seg !== null && seg !== void 0 ? seg : '';
})();
// ── GitHub API helpers ───────────────────────────────────────────────────────
function ghApi(apiPath, token) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.github.com',
            path: apiPath,
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'hubot-deploy-triggr',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    parsed._status = res.statusCode;
                    resolve(parsed);
                }
                catch (_a) {
                    reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}
function downloadFile(url, dest, token) {
    return new Promise((resolve, reject) => {
        const file = (0, fs_1.createWriteStream)(dest);
        const req = https.request(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/octet-stream',
                'User-Agent': 'hubot-deploy-triggr',
            },
        }, (res) => {
            if (res.statusCode === 302 && res.headers.location) {
                file.close();
                const redirect = https.get(res.headers.location, (r2) => {
                    r2.pipe(file);
                    file.on('finish', () => { file.close(); resolve(dest); });
                    r2.on('error', reject);
                });
                redirect.on('error', reject);
                return;
            }
            if (res.statusCode !== 200) {
                file.close();
                reject(new Error(`Asset download failed: HTTP ${res.statusCode}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(dest); });
        });
        req.on('error', reject);
        req.end();
    });
}
function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = (0, crypto_1.createHash)('sha256');
        const stream = (0, fs_1.createReadStream)(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
async function validateRelease(repo, tag, token) {
    var _a, _b;
    const release = await ghApi(`/repos/${GITHUB_ORG}/${repo}/releases/tags/${tag}`, token);
    if (release._status === 404) {
        return { ok: false, reason: `Release \`${tag}\` not found in \`${GITHUB_ORG}/${repo}\`` };
    }
    if (release._status !== 200) {
        return { ok: false, reason: `GitHub API error ${release._status} fetching release` };
    }
    const commitSha = release.target_commitish;
    if (!commitSha || commitSha.length < 7) {
        return { ok: false, reason: `Release \`${tag}\` has no valid commit SHA` };
    }
    const assets = (_a = release.assets) !== null && _a !== void 0 ? _a : [];
    if (assets.length === 0) {
        return { ok: false, reason: `Release \`${tag}\` has no assets` };
    }
    const tarAsset = (_b = assets.find((a) => a.name.endsWith('.tar.gz'))) !== null && _b !== void 0 ? _b : assets[0];
    return {
        ok: true,
        release: {
            commitSha,
            assetUrl: tarAsset.url,
            assetName: tarAsset.name,
        },
    };
}
// ── Main plugin ──────────────────────────────────────────────────────────────
const TRIGGER = /\b(dev|stg|prd)\b/i;
module.exports = (robot) => {
    robot.hear(TRIGGER, async (msg) => {
        var _a, _b;
        const botId = (_a = msg.message.rawMessage) === null || _a === void 0 ? void 0 : _a.bot_id;
        if (botId !== DEPLOY_BOT_ID)
            return;
        const channel = msg.message.room;
        if (!ALLOWED_CHANNELS.has(channel))
            return;
        const text = (_b = msg.message.text) !== null && _b !== void 0 ? _b : '';
        // ── Try structured tag first ───────────────────────────────────────────
        const ctx = parseTag(text);
        if (ctx) {
            const { env, identifier, repo, tag } = ctx;
            if (env !== hostEnv)
                return;
            msg.send(`:eyes: Matched deploy tag \`${tag}\` on \`${hostname}\` (env: \`${hostEnv}\`)`);
            robot.logger.info(`[deploy] tag: ${tag} | env: ${env} | app: ${identifier} (${repo})`);
            const token = process.env.GITHUB_TOKEN;
            if (!token) {
                msg.send(':x: Deploy blocked — `GITHUB_TOKEN` not configured.');
                return;
            }
            msg.send(`:hourglass_flowing_sand: Validating \`${tag}\` in \`${GITHUB_ORG}/${repo}\`...`);
            const result = await validateRelease(repo, tag, token);
            if (!result.ok) {
                robot.logger.error(`[deploy] ${result.reason}`);
                msg.send(`:x: Deploy blocked — ${result.reason}`);
                return;
            }
            const { commitSha, assetUrl, assetName } = result.release;
            // Download and verify
            const stagingDir = path.join(STAGING_BASE, tag);
            if (!path.resolve(stagingDir).startsWith(STAGING_BASE + path.sep)) {
                msg.send(`:x: Deploy blocked — invalid tag \`${tag}\``);
                return;
            }
            (0, fs_1.mkdirSync)(stagingDir, { recursive: true });
            const assetPath = path.join(stagingDir, assetName);
            try {
                await downloadFile(assetUrl, assetPath, token);
            }
            catch (err) {
                msg.send(`:x: Download failed — ${err.message}`);
                cleanup(assetPath, stagingDir);
                return;
            }
            const fileHash = await sha256File(assetPath);
            robot.logger.info(`[deploy] SHA256: ${fileHash} | commit: ${commitSha}`);
            const releaseUrl = `https://github.com/${GITHUB_ORG}/${repo}/releases/${tag}`;
            msg.send(`:rocket: Deploying \`${repo}\` → \`${env}\`\n` +
                `Tag: \`${tag}\` | Commit: \`${commitSha.slice(0, 8)}\` | SHA256: \`${fileHash.slice(0, 12)}...\``);
            await runDeploy(msg, robot, identifier, env, tag, releaseUrl);
            cleanup(assetPath, stagingDir);
            return;
        }
        // ── Fallback: env + identifier, construct URL ─────────────────────────
        const fallback = parseFallback(text);
        if (!fallback)
            return;
        const { env, identifier, repo } = fallback;
        if (env !== hostEnv)
            return;
        msg.send(`:eyes: Matched fallback deploy \`${identifier}\` on \`${hostname}\` (env: \`${hostEnv}\`)`);
        const tag = 'latest';
        const releaseUrl = `https://github.com/${GITHUB_ORG}/${repo}/releases/${tag}`;
        robot.logger.info(`[deploy] fallback | env: ${env} | app: ${identifier} | ${releaseUrl}`);
        msg.send(`:rocket: Deploying \`${repo}\` → \`${env}\` (no structured tag — using latest)`);
        await runDeploy(msg, robot, identifier, env, tag, releaseUrl);
    });
};
// ── Deploy execution ─────────────────────────────────────────────────────────
async function runDeploy(msg, robot, identifier, env, tag, artifactUrl) {
    var _a;
    try {
        const args = [
            'sudo', '--non-interactive',
            DEPLOY_SCRIPT,
            'hubot',
            identifier,
            env,
            tag || 'latest',
            artifactUrl,
        ];
        const { stdout, stderr } = await exec(args.join(' '), { timeout: DEPLOY_TIMEOUT });
        if (stderr)
            robot.logger.info(`[deploy] stderr: ${stderr}`);
        const recap = extractRecap(stdout);
        msg.send(`:white_check_mark: Deploy SUCCESS — \`${identifier}\` \`${tag || 'latest'}\` → \`${env}\`\n` +
            `\`\`\`\n${recap}\n\`\`\``);
    }
    catch (err) {
        robot.logger.error(`[deploy] failed: ${err.message}`);
        const tail = ((_a = err.stdout) !== null && _a !== void 0 ? _a : '').split('\n').slice(-30).join('\n');
        msg.send(`:x: Deploy FAILED — \`${identifier}\` \`${tag || 'latest'}\` → \`${env}\`\n` +
            `\`\`\`\n${tail || err.stderr || err.message}\n\`\`\``);
    }
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function extractRecap(stdout) {
    const lines = stdout.split('\n');
    const idx = lines.findIndex((l) => l.includes('PLAY RECAP'));
    if (idx >= 0)
        return lines.slice(idx, idx + 10).join('\n');
    return lines.slice(-10).join('\n');
}
const STAGING_BASE = path.join(os.tmpdir(), 'hubot-deploy');
function cleanup(file, dir) {
    try {
        (0, fs_1.unlinkSync)(file);
    }
    catch ( /* already gone */_a) { /* already gone */ }
    try {
        (0, fs_1.rmdirSync)(dir);
    }
    catch ( /* not empty or already gone — leave it */_b) { /* not empty or already gone — leave it */ }
}
