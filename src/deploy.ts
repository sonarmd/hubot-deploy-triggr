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

import { createHash } from 'crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { exec as execCb } from 'child_process';

const exec = promisify(execCb);

// ── Configuration ────────────────────────────────────────────────────────────

const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT
  ?? '/home/hubot/DeploymentScripts/hubot/deploy.sh';
const DEPLOY_TIMEOUT = 600_000; // 10 min

// Agora CI bot — Slack-verified bot_id, not spoofable.
const DEPLOY_BOT_ID = process.env.AGORA_BOT_ID ?? 'B0AMQKWT77W';

const GITHUB_ORG = 'sonarmd';

const ALLOWED_CHANNELS = new Set(
  (process.env.DEPLOY_CHANNELS ?? 'ops,deployments,ops-dev').split(','),
);

// Identifier → repo name.
const APP_MAP: Record<string, string> = {
  api:    'triggr_api',
  fe:     'frontend',
  mobile: 'frontend-patient-app',
  cdk:    'infra-cdk',
};

// ── Deploy context ───────────────────────────────────────────────────────────

interface DeployContext {
  env: string;
  identifier: string;
  repo: string;
  tag: string;
}

// ── Tag parsing ──────────────────────────────────────────────────────────────

// Tag format: {env}-{identifier}-v?{version}-b{build}
// Examples:   stg-api-1.0.0-b81   prd-fe-v2.3.1-b44   dev-mobile-v0.1.0-b3
const TAG_PATTERN = /\b(dev|stg|prd)-(\w+)-v?([\d.]+)-b(\d+)\b/;

function parseTag(text: string): DeployContext | null {
  const m = text.match(TAG_PATTERN);
  if (!m) return null;

  const [tag, env, identifier] = m;
  const repo = APP_MAP[identifier];
  if (!repo) return null;

  return { env, identifier, repo, tag };
}

// ── Fallback parsing (env + identifier, no structured tag) ───────────────────

function parseFallback(text: string): { env: string; identifier: string; repo: string } | null {
  const envMatch = text.match(/\b(dev|stg|prd)\b/i);
  if (!envMatch) return null;
  const env = envMatch[1].toLowerCase();

  const knownIds = Object.keys(APP_MAP);
  const identifier = knownIds.find((id) =>
    new RegExp(`\\b${id}\\b`, 'i').test(text),
  );
  if (!identifier) return null;

  return { env, identifier, repo: APP_MAP[identifier] };
}

// ── Host env detection ───────────────────────────────────────────────────────

const hostname = os.hostname();
const hostEnv = (() => {
  const seg = hostname.split(/[-.]/)[1];
  if (seg === 'sonarmd') return 'prd';
  return seg ?? '';
})();

// ── GitHub API helpers ───────────────────────────────────────────────────────

function ghApi(apiPath: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: apiPath,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'hubot-deploy-triggr',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            parsed._status = res.statusCode;
            resolve(parsed);
          } catch {
            reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function downloadFile(url: string, dest: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const req = https.request(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/octet-stream',
          'User-Agent': 'hubot-deploy-triggr',
        },
      },
      (res) => {
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
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── Release validation ───────────────────────────────────────────────────────

interface ValidatedRelease {
  commitSha: string;
  assetUrl: string;
  assetName: string;
}

interface DeployManifestBundle {
  name: string;
  path: string;
  target: string;
  hosts: string[];
}

interface DeployManifest {
  app: string;
  bundles: DeployManifestBundle[];
}

interface DeployPlanItem {
  makeTarget: string;
  deployTag: string;
  artifactUrl: string;
  deployBundle: string;
  deployHosts: string;
  deployEnv: string;
  displayName: string;
}

async function validateRelease(
  repo: string,
  tag: string,
  token: string,
): Promise<{ ok: true; release: ValidatedRelease } | { ok: false; reason: string }> {
  const release = await ghApi(
    `/repos/${GITHUB_ORG}/${repo}/releases/tags/${tag}`,
    token,
  );

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

  const assets: any[] = release.assets ?? [];
  if (assets.length === 0) {
    return { ok: false, reason: `Release \`${tag}\` has no assets` };
  }

  const tarAsset = assets.find((a: any) => a.name.endsWith('.tar.gz')) ?? assets[0];

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

module.exports = (robot: any) => {
  robot.hear(TRIGGER, async (msg: any) => {
    const botId = msg.message.rawMessage?.bot_id;
    if (botId !== DEPLOY_BOT_ID) return;

    const channel = msg.message.room;
    if (!ALLOWED_CHANNELS.has(channel)) return;

    const text = msg.message.text ?? '';

    // ── Try structured tag first ───────────────────────────────────────────
    const ctx = parseTag(text);

    if (ctx) {
      const { env, identifier, repo, tag } = ctx;
      if (env !== hostEnv) return;

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
      mkdirSync(stagingDir, { recursive: true });
      const assetPath = path.join(stagingDir, assetName);

      try {
        await downloadFile(assetUrl, assetPath, token);
      } catch (err: any) {
        msg.send(`:x: Download failed — ${err.message}`);
        cleanup(assetPath, stagingDir);
        return;
      }

      const fileHash = await sha256File(assetPath);
      robot.logger.info(`[deploy] SHA256: ${fileHash} | commit: ${commitSha}`);

      const releaseUrl = `https://github.com/${GITHUB_ORG}/${repo}/releases/${tag}`;

      msg.send(
        `:rocket: Deploying \`${repo}\` → \`${env}\`\n` +
        `Tag: \`${tag}\` | Commit: \`${commitSha.slice(0, 8)}\` | SHA256: \`${fileHash.slice(0, 12)}...\``,
      );

      const deployPlan = await resolveDeployPlan({
        identifier,
        env,
        tag,
        artifactUrl: assetUrl,
        assetPath,
        stagingDir,
      });

      await runDeployPlan(msg, robot, identifier, deployPlan);
      cleanup(assetPath, stagingDir);
      return;
    }

    // ── Fallback: env + identifier, construct URL ─────────────────────────
    // No structured tag, no validated release → deploy.sh's URL check will
    // reject the human releaseUrl. Fallback is best-effort; it will fail
    // at the deploy.sh gate but Hubot still logs for visibility.
    const fallback = parseFallback(text);
    if (!fallback) return;

    const { env, identifier, repo } = fallback;
    if (env !== hostEnv) return;

    msg.send(`:eyes: Matched fallback deploy \`${identifier}\` on \`${hostname}\` (env: \`${hostEnv}\`)`);

    const tag = 'latest';
    const releaseUrl = `https://github.com/${GITHUB_ORG}/${repo}/releases/${tag}`;

    robot.logger.info(`[deploy] fallback | env: ${env} | app: ${identifier} | ${releaseUrl}`);
    msg.send(`:rocket: Deploying \`${repo}\` → \`${env}\` (no structured tag — using latest)`);

    await runDeployPlan(msg, robot, identifier, [
      createDefaultDeployPlanItem(identifier, env, tag, releaseUrl),
    ]);
  });
};

// ── Deploy execution ─────────────────────────────────────────────────────────

async function runDeployPlan(
  msg: any,
  robot: any,
  identifier: string,
  deployPlan: DeployPlanItem[],
): Promise<void> {
  for (const item of deployPlan) {
    await runDeployItem(msg, robot, identifier, item);
  }
}

async function runDeployItem(
  msg: any,
  robot: any,
  identifier: string,
  planItem: DeployPlanItem,
): Promise<void> {
  try {
    // deploy.sh contract (7 positional args — strict):
    //   <caller> <make_target> <deploy_tag> <artifact_url> <deploy_bundle> <deploy_hosts> <deploy_env>
    const {
      makeTarget,
      deployTag,
      artifactUrl,
      deployBundle,
      deployHosts,
      deployEnv,
      displayName,
    } = planItem;

    // Use execFile-style quoting via shell-escaping so empty positional
    // args survive. Quote every arg defensively.
    const escape = shellEscape;
    const cmd = [
      'sudo', '--non-interactive',
      DEPLOY_SCRIPT,
      escape('hubot'),
      escape(makeTarget),
      escape(deployTag),
      escape(artifactUrl),
      escape(deployBundle),
      escape(deployHosts),
      escape(deployEnv),
    ].join(' ');

    robot.logger.info(`[deploy] exec: ${cmd}`);

    const { stdout, stderr } = await exec(cmd, { timeout: DEPLOY_TIMEOUT });

    if (stderr) robot.logger.info(`[deploy] stderr: ${stderr}`);

    const recap = extractRecap(stdout);
    msg.send(
      `:white_check_mark: Deploy SUCCESS — \`${identifier}\` \`${deployTag || 'latest'}\` → \`${deployEnv}\` (${displayName})\n` +
      `\`\`\`\n${recap}\n\`\`\``,
    );
  } catch (err: any) {
    robot.logger.error(`[deploy] failed: ${err.message}`);
    const tail = (err.stdout ?? '').split('\n').slice(-30).join('\n');
    msg.send(
      `:x: Deploy FAILED — \`${identifier}\` \`${planItem.deployTag || 'latest'}\` → \`${planItem.deployEnv}\` (${planItem.displayName})\n` +
      `\`\`\`\n${tail || err.stderr || err.message}\n\`\`\``,
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function resolveDeployPlan(params: {
  identifier: string;
  env: string;
  tag: string;
  artifactUrl: string;
  assetPath: string;
  stagingDir: string;
}): Promise<DeployPlanItem[]> {
  const fallbackItem = createDefaultDeployPlanItem(
    params.identifier,
    params.env,
    params.tag,
    params.artifactUrl,
  );

  const manifest = await readReleaseManifest(params.assetPath, params.stagingDir);
  if (manifest) {
    const manifestPlan = await resolveManifestDeployPlan({
      env: params.env,
      tag: params.tag,
      artifactUrl: params.artifactUrl,
      stagingDir: params.stagingDir,
    }, manifest);
    if (manifestPlan.length > 0) {
      return manifestPlan;
    }
  }

  return [fallbackItem];
}

function createDefaultDeployPlanItem(
  identifier: string,
  env: string,
  tag: string,
  artifactUrl: string,
): DeployPlanItem {
  return {
    makeTarget: `${identifier}_${env}`,
    deployTag: tag || 'latest',
    artifactUrl,
    deployBundle: '',
    deployHosts: '',
    deployEnv: env,
    displayName: `${identifier}_${env}`,
  };
}

async function resolveManifestDeployPlan(params: {
  env: string;
  tag: string;
  artifactUrl: string;
  stagingDir: string;
}, manifest: DeployManifest): Promise<DeployPlanItem[]> {
  const extractedReleaseDir = path.join(params.stagingDir, 'release');
  const planItems: DeployPlanItem[] = [];

  for (const bundle of manifest.bundles.filter(requiresPreparedDeployTarget)) {
    const bundleArchive = path.join(extractedReleaseDir, `${bundle.name}.tar.gz`);
    if (!existsSync(bundleArchive)) {
      throw new Error(`Missing bundle archive for ${bundle.name}`);
    }

    const bundleExtractDir = path.join(params.stagingDir, `bundle-${bundle.name}`);
    await extractTarball(bundleArchive, bundleExtractDir);

    const bundleRoot = path.join(bundleExtractDir, normalizeBundleRoot(bundle.path));

    for (const host of bundle.hosts) {
      const deployHost = renderDeployHost(host, params.env);
      const templateSource = path.join(bundleRoot, `${deployHost}.template.json`);
      if (!existsSync(templateSource)) {
        throw new Error(`Missing CDK template for ${deployHost} in ${bundle.name}`);
      }

      const preparedDir = path.join(DEPLOY_CACHE_BASE, params.tag, deployHost, params.env);
      mkdirSync(preparedDir, { recursive: true });
      copyFileSync(templateSource, path.join(preparedDir, `${deployHost}.template.json`));

      planItems.push({
        makeTarget: `${bundle.target}_${params.env}`,
        deployTag: params.tag || 'latest',
        artifactUrl: params.artifactUrl,
        deployBundle: bundle.name,
        deployHosts: deployHost,
        deployEnv: params.env,
        displayName: `${bundle.name}:${deployHost}`,
      });
    }
  }

  return dedupeDeployPlan(planItems);
}

async function readReleaseManifest(
  assetPath: string,
  stagingDir: string,
): Promise<DeployManifest | null> {
  const extractedReleaseDir = path.join(stagingDir, 'release');
  const manifestPath = path.join(extractedReleaseDir, 'deploy.json');

  if (!existsSync(manifestPath)) {
    await extractTarball(assetPath, extractedReleaseDir);
  }

  if (!existsSync(manifestPath)) {
    return null;
  }

  return readDeployManifest(manifestPath);
}

function readDeployManifest(filePath: string): DeployManifest {
  const manifest = JSON.parse(readFileSync(filePath, 'utf8')) as DeployManifest;
  if (!Array.isArray(manifest.bundles)) {
    throw new Error(`Invalid deploy manifest at ${filePath}`);
  }

  return manifest;
}

async function extractTarball(archivePath: string, destination: string): Promise<void> {
  mkdirSync(destination, { recursive: true });
  await exec(
    `tar -xzf ${shellEscape(archivePath)} -C ${shellEscape(destination)}`,
    { timeout: DEPLOY_TIMEOUT },
  );
}

function normalizeBundleRoot(bundlePath: string): string {
  return path.basename(bundlePath.replace(/[\\/]+$/, ''));
}

function renderDeployHost(host: string, env: string): string {
  return host.replace(/\{env\}/g, env);
}

function requiresPreparedDeployTarget(bundle: DeployManifestBundle): boolean {
  return bundle.target === 'cdk';
}

function dedupeDeployPlan(items: DeployPlanItem[]): DeployPlanItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [
      item.makeTarget,
      item.deployTag,
      item.deployBundle,
      item.deployHosts,
      item.deployEnv,
    ].join('|');

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function extractRecap(stdout: string): string {
  const lines = stdout.split('\n');
  const idx = lines.findIndex((l) => l.includes('PLAY RECAP'));
  if (idx >= 0) return lines.slice(idx, idx + 10).join('\n');
  return lines.slice(-10).join('\n');
}

const STAGING_BASE = path.join(os.tmpdir(), 'hubot-deploy');
const DEPLOY_CACHE_BASE = path.join(os.tmpdir(), 'deploy');

function cleanup(file: string, dir: string): void {
  try { unlinkSync(file); } catch { /* already gone */ }
  try { rmdirSync(dir); } catch { /* not empty or already gone — leave it */ }
}
