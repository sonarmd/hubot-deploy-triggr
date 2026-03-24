// Description:
//   Universal deploy — handles frontend and API deploys via Slack.
//
// Commands:
//   hubot deploy <app> <env> <tag> <artifact_url>
//
// Examples:
//   hubot deploy frontend stg stg-fe-0.0.1-b8 https://api.github.com/repos/sonarmd/frontend/releases/tags/stg-fe-0.0.1-b8
//   hubot deploy api prd prd-api-2.5.1-b45 https://api.github.com/repos/sonarmd/triggr_api/releases/tags/prd-api-2.5.1-b45

const util = require('util');
const exec = util.promisify(require('child_process').exec);

const deployScriptPath = '/home/hubot/DeploymentScripts/hubot';

const authorizedSlackUsers = [
  'devops',      // deploy bot
  'Agora',       // CI bot
  'avespoli',
  'jlyons',
  'tnguyen',
  'cforrester',
  'vsiqueira',
];

const validApps = ['frontend', 'api'];
const validEnvs = ['dev', 'stg', 'prd'];

const os = require('os');
const hostname = os.hostname();
const hostEnv = hostname.split(/[-.]/)[1];

module.exports = function(robot) {
  robot.hear(/^@r2-d2 deploy (\w+) (\w+) ([\w-\.]+) (.+)$/i, async (msg) => {
    const app = msg.match[1].toLowerCase();
    const environment = msg.match[2].toLowerCase();
    const deployTag = msg.match[3];
    const artifactUrl = msg.match[4];
    const caller = msg.message.user.name;

    if (!validApps.includes(app)) {
      msg.reply(`Unknown app: ${app}. Expected: ${validApps.join(', ')}`);
      return;
    }

    if (!validEnvs.includes(environment)) {
      msg.reply(`Unknown env: ${environment}. Expected: ${validEnvs.join(', ')}`);
      return;
    }

    // Check environment matches this host.
    if (environment !== hostEnv) {
      if (environment === 'prd' && hostEnv === 'sonarmd') {
        robot.logger.info('prod host (sonarmd) — proceeding');
      } else {
        msg.reply(`Wrong host. This bot handles ${hostEnv}, not ${environment}.`);
        return;
      }
    }

    if (!caller || !authorizedSlackUsers.includes(caller)) {
      robot.logger.error(`Unauthorized deploy attempt by ${caller}`);
      msg.reply(`I'm tired. Maybe later.`);
      return;
    }

    robot.logger.info(`Deploy: ${caller} → ${app} ${environment} ${deployTag}`);
    msg.reply(`Deploying ${app} to ${environment}: ${deployTag}`);

    try {
      const cmd = `sudo ${deployScriptPath}/deploy.sh ${caller} ${app} ${environment} ${deployTag} ${artifactUrl}`;
      const {stdout, stderr} = await exec(cmd, {timeout: 600000});
      if (stdout) robot.logger.info(`stdout: ${stdout}`);
      if (stderr) robot.logger.info(`stderr: ${stderr}`);
      msg.reply(`Deploy complete: ${app} ${deployTag} → ${environment}`);
    } catch (e) {
      robot.logger.error(e);
      msg.reply(`Deploy failed: ${app} ${deployTag} → ${environment}\n${e.message || e}`);
    }
  });
};
