"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = deploy;
const child_process_1 = require("child_process");
// Path to the sudoers-gated deploy script on the deploy server.
// Hubot executes this via sudo. It's the only root surface available to this process.
const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT ?? '/home/hubot/DeploymentScripts/hubot/deploy.sh';
// Only messages posted by the Agora deploy bot are accepted.
// Set AGORA_BOT_USER_ID in the deploy server's environment.
const AGORA_BOT_USER_ID = process.env.AGORA_BOT_USER_ID ?? '';
const ALLOWED_CHANNELS = new Set(['ops', 'deployments', 'ops-dev']);
const ALLOWED_ENVS = new Set(['dev', 'stg', 'prd']);
// Message format posted by cd.yml notify job:
//   @r2-d2 {app} {bundle} {env} {tag} {hosts_csv} {artifact_url}
const DEPLOY_PATTERN = /^@r2-d2\s+(\S+)\s+(\S+)\s+(dev|stg|prd)\s+(\S+)\s+(\S+)\s+(https:\/\/api\.github\.com\/repos\/\S+)$/im;
// Maps app name → Makefile target prefix
const APP_TARGET_MAP = {
    triggr_api: 'api',
    frontend: 'fe',
    'patient-mobile': 'eas',
    'infra-cdk': 'cdk',
};
function extractRecap(stdout) {
    const lines = stdout.split('\n');
    const idx = lines.findIndex((l) => l.includes('PLAY RECAP'));
    if (idx >= 0)
        return lines.slice(idx, idx + 10).join('\n');
    return '(no recap found)';
}
function deploy(robot) {
    robot.hear(DEPLOY_PATTERN, async (msg) => {
        const channel = msg.message.room;
        if (!ALLOWED_CHANNELS.has(channel))
            return;
        // Only the Agora bot may trigger deploys via chat message
        if (AGORA_BOT_USER_ID && msg.message.user.id !== AGORA_BOT_USER_ID)
            return;
        const [, app, bundle, env, tag, hostsCsv, artifactUrl] = msg.match;
        if (!ALLOWED_ENVS.has(env)) {
            msg.send(`:x: Unknown environment \`${env}\`. Allowed: dev, stg, prd`);
            return;
        }
        // Verify artifact URL is under the sonarmd GitHub org
        if (!artifactUrl.startsWith('https://api.github.com/repos/sonarmd/')) {
            msg.send(`:x: artifact_url must be under \`api.github.com/repos/sonarmd\`. Got: \`${artifactUrl}\``);
            return;
        }
        const targetPrefix = APP_TARGET_MAP[app];
        if (!targetPrefix) {
            msg.send(`:x: Unknown app \`${app}\`. Known apps: ${Object.keys(APP_TARGET_MAP).join(', ')}`);
            return;
        }
        const makeTarget = `${targetPrefix}_${env}`;
        msg.send(`:rocket: Deploying \`${app}/${bundle}\` (\`${tag}\`) → \`${env}\`\n` +
            `Target: \`${makeTarget}\` | Hosts: \`${hostsCsv}\``);
        // Route through the sudoers-gated deploy script.
        // Hubot has no other root surface — it cannot modify this script, cannot read
        // the credentials file, and cannot run any other privileged command.
        const cmd = [
            'sudo', '--non-interactive',
            DEPLOY_SCRIPT,
            'hubot', // caller — checked against /etc/sonarmd/authorized-deployers
            makeTarget,
            tag,
            artifactUrl,
            bundle,
            hostsCsv,
            env,
        ].join(' ');
        (0, child_process_1.exec)(cmd, { timeout: 1200000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                const tail = stdout.split('\n').slice(-30).join('\n');
                msg.send(`:x: Deploy FAILED: \`${app}/${bundle}\` (\`${tag}\`) → ${env}\n` +
                    `\`\`\`\n${tail}\n\`\`\``);
                return;
            }
            const recap = extractRecap(stdout);
            msg.send(`:white_check_mark: Deploy SUCCESS: \`${app}/${bundle}\` (\`${tag}\`) → ${env}\n` +
                `\`\`\`\n${recap}\n\`\`\``);
        });
    });
}
//# sourceMappingURL=deploy.js.map