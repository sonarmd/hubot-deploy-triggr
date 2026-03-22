// Description:
//   Universal deploy — handles frontend and API deploys via Slack.
//   Two auth paths: bot (CI automated) and human (manual Slack command).
//
// Commands:
//   hubot deploy <app> <env> <tag> <artifact_url>

import {promisify} from 'util';
import {exec as execCb} from 'child_process';
import * as https from 'https';
import * as os from 'os';

const exec = promisify(execCb);

const DEPLOY_SCRIPT = '/home/hubot/DeploymentScripts/hubot/deploy.sh';
const DEPLOY_TIMEOUT = 600_000; // 10 minutes

// Deploy bot Slack bot_id — verified by Slack, not spoofable.
const DEPLOY_BOT_ID = 'B0AMQKWT77W';

// Artifact URLs must originate from sonarmd GitHub org.
const ARTIFACT_URL_PREFIX = 'https://api.github.com/repos/sonarmd/';

const GITHUB_ORG = 'sonarmd';
const DEPLOYERS_TEAM = 'deployers';

// Slack username → GitHub username mapping for human deploys.
const SLACK_TO_GITHUB: Record<string, string> = {
  avespoli: 'avespoli-sonarmd',
  tnguyen: 'tn70626',
  cforrester: 'cforrester-sonarmd',
  vsiqueira: 'vsiqueirasonarmd',
};

const VALID_APPS = ['frontend', 'api'] as const;
const VALID_ENVS = ['dev', 'stg', 'prd'] as const;

const hostname = os.hostname();
const hostEnv = hostname.split(/[-.]/)[1];

interface GitHubApiOptions {
  path: string;
  token: string;
}

function githubApi(opts: GitHubApiOptions): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: opts.path,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'hubot-deploy-triggr',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 204) {
            resolve({_status: 204});
            return;
          }
          try {
            const parsed = JSON.parse(body);
            parsed._status = res.statusCode;
            resolve(parsed);
          } catch {
            reject(new Error(`GitHub API: ${res.statusCode} — ${body}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function isTeamMember(
  githubUser: string,
  token: string
): Promise<boolean> {
  const res = await githubApi({
    path: `/orgs/${GITHUB_ORG}/teams/${DEPLOYERS_TEAM}/members/${githubUser}`,
    token,
  });
  return res._status === 204;
}

async function verifyBotDeploy(
  msg: any,
  robot: any,
  token: string
): Promise<boolean> {
  // Extract "View Run" URL from attachment to get repo + run ID.
  const attachments =
    msg.message.rawMessage?.attachments ||
    msg.message.rawMessage?.message?.attachments;

  if (!attachments?.length) {
    robot.logger.error('Bot deploy: no attachments found');
    msg.reply('Deploy blocked: bot message has no attachments.');
    return false;
  }

  let runUrl: string | undefined;
  for (const att of attachments) {
    const actions = att.actions || [];
    for (const action of actions) {
      if (action.type === 'button' && action.url?.includes('/actions/runs/')) {
        runUrl = action.url;
      }
    }
    if (!runUrl && att.title_link?.includes('/actions/runs/')) {
      runUrl = att.title_link;
    }
  }

  if (!runUrl) {
    robot.logger.info('Bot deploy: no run URL in attachments — skipping CI verification');
    return true;
  }

  // Parse: https://github.com/sonarmd/<repo>/actions/runs/<id>
  const runMatch = runUrl.match(
    /github\.com\/sonarmd\/([^/]+)\/actions\/runs\/(\d+)/
  );
  if (!runMatch) {
    robot.logger.error(`Bot deploy: could not parse run URL: ${runUrl}`);
    msg.reply(`Deploy blocked: could not parse run URL from attachment.`);
    return false;
  }

  const [, repo, runId] = runMatch;

  // Verify the workflow run exists and completed successfully.
  const run = await githubApi({
    path: `/repos/${GITHUB_ORG}/${repo}/actions/runs/${runId}`,
    token,
  });

  if (run._status !== 200) {
    robot.logger.error(`Bot deploy: run ${runId} not found (${run._status})`);
    msg.reply(`Deploy blocked: GitHub run ${runId} not found (HTTP ${run._status}).`);
    return false;
  }

  if (run.status !== 'completed' || run.conclusion !== 'success') {
    robot.logger.error(
      `Bot deploy: run ${runId} not successful — ${run.status}/${run.conclusion}`
    );
    msg.reply(
      `Deploy blocked: CI run ${runId} is ${run.status}/${run.conclusion}.`
    );
    return false;
  }

  // Find the PR for the head commit and verify an approved review
  // from a deployers team member on the final commit.
  const headSha = run.head_sha;
  const pulls = await githubApi({
    path: `/repos/${GITHUB_ORG}/${repo}/commits/${headSha}/pulls`,
    token,
  });

  if (pulls._status !== 200 || !Array.isArray(pulls) || !pulls.length) {
    robot.logger.info(
      `Bot deploy: no PR found for commit ${headSha} — skipping approval check`
    );
    return true;
  }

  const pr = pulls[0];
  const reviews = await githubApi({
    path: `/repos/${GITHUB_ORG}/${repo}/pulls/${pr.number}/reviews`,
    token,
  });

  if (reviews._status !== 200 || !Array.isArray(reviews)) {
    robot.logger.error('Bot deploy: could not fetch PR reviews');
    msg.reply(
      `Deploy blocked: could not fetch reviews for PR #${pr.number}.`
    );
    return false;
  }

  // Get deployers team members.
  const teamMembers = await githubApi({
    path: `/orgs/${GITHUB_ORG}/teams/${DEPLOYERS_TEAM}/members`,
    token,
  });

  if (teamMembers._status !== 200 || !Array.isArray(teamMembers)) {
    robot.logger.error('Bot deploy: could not fetch deployers team');
    msg.reply(
      'Deploy blocked: could not fetch deployers team from GitHub ' +
        `(HTTP ${teamMembers._status}). Check GITHUB_TOKEN scopes.`
    );
    return false;
  }

  const deployerLogins = new Set(
    teamMembers.map((m: any) => m.login.toLowerCase())
  );

  // Check for an approved review on the final commit from a deployer.
  const validApproval = reviews.some(
    (r: any) =>
      r.state === 'APPROVED' &&
      r.commit_id === headSha &&
      deployerLogins.has(r.user.login.toLowerCase())
  );

  if (!validApproval) {
    robot.logger.error(
      `Bot deploy: no approved review from deployers team on commit ${headSha}`
    );
    msg.reply(
      'Deploy blocked: no approved review from a deployers team member ' +
        'on the final commit.'
    );
    return false;
  }

  robot.logger.info(
    `Bot deploy: verified run ${runId}, PR #${pr.number}, approval on ${headSha}`
  );
  return true;
}

module.exports = (robot: any) => {
  robot.respond(
    /deploy (\w+) (\w+) ([\w\-.]+) (.+)$/i,
    async (msg: any) => {
      const app = msg.match[1].toLowerCase();
      const environment = msg.match[2].toLowerCase();
      const deployTag = msg.match[3];
      const artifactUrl = msg.match[4].replace(/[<>]/g, '').trim();
      const caller = msg.message.user.name;
      const botId =
        msg.message.rawMessage?.bot_id;

      try {
        if (!VALID_APPS.includes(app as any)) {
          msg.reply(`Unknown app: ${app}. Expected: ${VALID_APPS.join(', ')}`);
          return;
        }

        if (!VALID_ENVS.includes(environment as any)) {
          msg.reply(
            `Unknown env: ${environment}. Expected: ${VALID_ENVS.join(', ')}`
          );
          return;
        }

        if (!artifactUrl.startsWith(ARTIFACT_URL_PREFIX)) {
          robot.logger.error(
            `Blocked deploy — bad artifact URL: ${artifactUrl}`
          );
          msg.reply(
            `Deploy blocked: artifact URL must start with ` +
              `${ARTIFACT_URL_PREFIX}`
          );
          return;
        }

        // Check environment matches this host.
        if (environment !== hostEnv) {
          if (environment === 'prd' && hostEnv === 'sonarmd') {
            robot.logger.info('prod host (sonarmd) — proceeding');
          } else {
            return;
          }
        }

        const token = process.env.GITHUB_TOKEN;
        if (!token) {
          robot.logger.error(
            'GITHUB_TOKEN not set — cannot authorize deploys'
          );
          msg.reply('Deploy blocked: GITHUB_TOKEN not configured.');
          return;
        }

        // --- Authorization: two paths ---

        if (botId === DEPLOY_BOT_ID) {
          // Automated CI deploy — bot ID verified by Slack.
          robot.logger.info(
            `CI deploy from bot ${botId}: ` +
              `${app} ${environment} ${deployTag}`
          );

          const verified = await verifyBotDeploy(msg, robot, token);
          if (!verified) {
            return;
          }
        } else {
          // Human deploy — map Slack user to GitHub, check team membership.
          const githubUser = SLACK_TO_GITHUB[caller];
          if (!githubUser) {
            robot.logger.error(
              `Unknown Slack user: ${caller} — no GitHub mapping`
            );
            msg.reply(
              `Unauthorized. ${caller} has no deployer mapping. ` +
                'Contact an admin to be added.'
            );
            return;
          }

          const isMember = await isTeamMember(githubUser, token);
          if (!isMember) {
            robot.logger.error(
              `${caller} (${githubUser}) not in ${DEPLOYERS_TEAM}`
            );
            msg.reply(
              `Unauthorized. ${githubUser} is not a member of the ` +
                `${DEPLOYERS_TEAM} team.`
            );
            return;
          }

          robot.logger.info(
            `Human deploy: ${caller} (${githubUser}) → ` +
              `${app} ${environment} ${deployTag}`
          );
        }

        // --- Execute deploy ---

        msg.reply(`Deploying ${app} to ${environment}: ${deployTag}`);

        try {
          const cmd =
            `sudo ${DEPLOY_SCRIPT} ${app} ${environment}` +
            ` ${deployTag} ${artifactUrl}`;
          const {stdout, stderr} = await exec(cmd, {
            timeout: DEPLOY_TIMEOUT,
          });
          if (stdout) {
            robot.logger.info(`stdout: ${stdout}`);
          }
          if (stderr) {
            robot.logger.info(`stderr: ${stderr}`);
          }
          msg.reply(
            `Deploy complete: ${app} ${deployTag} → ${environment}`
          );
        } catch (e: any) {
          robot.logger.error(e);
          msg.reply(
            `Deploy failed: ${app} ${deployTag} → ${environment}\n` +
              `${e.stderr || e.message || e}`
          );
        }
      } catch (err: any) {
        const context = `${app} ${environment} ${deployTag}`;
        const detail = err.message || String(err);
        robot.logger.error(`Deploy error [${context}]: ${detail}`);
        robot.logger.error(err.stack || err);
        msg.reply(
          `Deploy error [${context}]: ${detail}\n` +
            'Check hubot logs for full stack trace.'
        );
      }
    }
  );
};
