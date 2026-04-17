"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = breakGlass;
const child_process_1 = require("child_process");
const ANSIBLE_DIR = (_a = process.env.ANSIBLE_DIR) !== null && _a !== void 0 ? _a : '/root/triggr_misc/Ansible';
const ANSIBLE_BIN = (_b = process.env.ANSIBLE_PLAYBOOK) !== null && _b !== void 0 ? _b : '/opt/ansible-env/bin/ansible-playbook';
const VAULT_PASS = '.get-vault-password';
const SSH_KEY = '~/.ssh/AnsibleRoot.pem';
const BREAK_GLASS_CHANNEL = 'ops';
const ENV_DOMAIN_MAP = {
    dev: 'dev.sonarmd.com',
    stg: 'stg.sonarmd.com',
    prd: 'sonarmd.com',
};
const APP_TO_REPO = {
    triggr_api: 'triggr_api',
    frontend: 'frontend',
    'patient-mobile': 'frontend-patient-app',
};
const activeDeploys = new Map();
const deployHistory = [];
function extractRecap(stdout) {
    const lines = stdout.split('\n');
    const idx = lines.findIndex((l) => l.includes('PLAY RECAP'));
    if (idx >= 0)
        return lines.slice(idx, idx + 10).join('\n');
    return '(no recap found)';
}
function interpolateHosts(hosts, env) {
    var _a;
    return hosts
        .join(',')
        .replace(/\$\{env\}/g, env)
        .replace(/\$\{env_domain\}/g, (_a = ENV_DOMAIN_MAP[env]) !== null && _a !== void 0 ? _a : `${env}.sonarmd.com`);
}
function runBundleDeploy(bundle, deploy, apiUrl, repo, msg) {
    return new Promise((resolve) => {
        var _a;
        const hostsList = (_a = bundle.hosts) !== null && _a !== void 0 ? _a : (bundle.host ? [bundle.host] : []);
        const hostsCsv = interpolateHosts(hostsList, deploy.env);
        const extraVars = [
            `deploy_app=${deploy.app}`,
            `deploy_bundle=${bundle.name}`,
            `deploy_tag=${deploy.tag}`,
            `deploy_target=${bundle.target}`,
            `deploy_env=${deploy.env}`,
            `deploy_hosts=${hostsCsv}`,
            `artifact_url=${apiUrl}`,
            `release_url=https://github.com/sonarmd/${repo}/releases/tag/${deploy.tag}`,
        ];
        const cmdParts = [
            ANSIBLE_BIN,
            `-i inventories/aws_ec2.yml`,
            `--vault-password-file ${VAULT_PASS}`,
            `--private-key ${SSH_KEY}`,
            `-e ansible_user=ubuntu`,
            ...extraVars.map((v) => `-e ${v}`),
            'deploy-generic.yml',
        ];
        (0, child_process_1.exec)(cmdParts.join(' '), { cwd: ANSIBLE_DIR, timeout: 600000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err) {
                const tail = stdout.split('\n').slice(-20).join('\n');
                msg.send(`:x: Bundle \`${bundle.name}\` FAILED for break-glass\n\`\`\`\n${tail}\n\`\`\``);
                resolve(false);
            }
            else {
                const recap = extractRecap(stdout);
                msg.send(`:white_check_mark: Bundle \`${bundle.name}\` deployed\n\`\`\`\n${recap}\n\`\`\``);
                resolve(true);
            }
        });
    });
}
function fetchDeployConfig(tag, repo) {
    const ghToken = process.env.GITHUB_TOKEN;
    const apiUrl = `https://api.github.com/repos/sonarmd/${repo}/releases/tags/${tag}`;
    return new Promise((resolve, reject) => {
        // Get the release, find deploy.json asset, download it
        const getAssetUrl = [
            `curl -sf`,
            `-H "Accept: application/vnd.github+json"`,
            `-H "Authorization: Bearer ${ghToken}"`,
            `"${apiUrl}"`,
            `| python3 -c "import json,sys; r=json.load(sys.stdin); a=[x for x in r['assets'] if x['name']=='deploy.json']; print(a[0]['url'] if a else '')"`,
        ].join(' ');
        (0, child_process_1.exec)(getAssetUrl, (err, assetUrl) => {
            const url = assetUrl === null || assetUrl === void 0 ? void 0 : assetUrl.trim();
            if (err || !url) {
                reject(new Error(`Could not find deploy.json in release ${tag}`));
                return;
            }
            const downloadCmd = [
                `curl -sfL`,
                `-H "Accept: application/octet-stream"`,
                `-H "Authorization: Bearer ${ghToken}"`,
                `"${url}"`,
            ].join(' ');
            (0, child_process_1.exec)(downloadCmd, (err2, configJson) => {
                if (err2) {
                    reject(new Error(`Could not download deploy.json from release ${tag}`));
                    return;
                }
                try {
                    resolve(JSON.parse(configJson));
                }
                catch (e) {
                    reject(new Error(`deploy.json is not valid JSON: ${e.message}`));
                }
            });
        });
    });
}
function breakGlass(robot) {
    // /deploy <app> <env> <tag>
    robot.respond(/deploy\s+(\S+)\s+(dev|stg|prd)\s+(\S+)$/i, async (msg) => {
        if (msg.message.room !== BREAK_GLASS_CHANNEL) {
            msg.send(`:x: \`/deploy\` only works in #${BREAK_GLASS_CHANNEL}.`);
            return;
        }
        const [, app, env, tag] = msg.match;
        const actor = msg.message.user.name;
        const timestamp = new Date().toISOString();
        if (!tag.startsWith(`${env}-`)) {
            msg.send(`:x: Tag \`${tag}\` doesn't match environment \`${env}\`. Tag must start with \`${env}-\`.`);
            return;
        }
        const auditId = `bg-${Date.now()}`;
        msg.send(`:warning: *BREAK-GLASS DEPLOY* :warning:\n\n` +
            `> *App:* ${app}\n` +
            `> *Environment:* ${env}\n` +
            `> *Tag:* \`${tag}\`\n` +
            `> *Actor:* @${actor}\n` +
            `> *Time:* ${timestamp}\n` +
            `> *Audit ID:* \`${auditId}\`\n\n` +
            `cc @platform-eng\n\n` +
            `Reason required. Reply with: \`reason ${auditId} <your reason>\``);
        activeDeploys.set(auditId, {
            app,
            env,
            tag,
            actor,
            timestamp,
            status: 'pending_reason',
        });
        // Auto-expire after 5 minutes
        setTimeout(() => {
            const d = activeDeploys.get(auditId);
            if ((d === null || d === void 0 ? void 0 : d.status) === 'pending_reason') {
                msg.send(`:x: Break-glass \`${auditId}\` expired. No reason provided within 5 minutes.`);
                activeDeploys.delete(auditId);
            }
        }, 300000);
    });
    // reason <audit_id> <reason text>
    robot.hear(/reason\s+(\S+)\s+(.+)$/i, async (msg) => {
        var _a, _b;
        const auditId = msg.match[1];
        const reason = msg.match[2].trim();
        const deploy = activeDeploys.get(auditId);
        if (!deploy) {
            msg.send(`:x: No pending deploy found for \`${auditId}\`. It may have expired.`);
            return;
        }
        if (msg.message.user.name !== deploy.actor) {
            msg.send(`:x: Only @${deploy.actor} can provide the reason for \`${auditId}\`.`);
            return;
        }
        deploy.reason = reason;
        deploy.status = 'executing';
        msg.send(`:rocket: Break-glass \`${auditId}\` executing.\n` +
            `*Reason:* ${reason}\n` +
            `Deploying \`${deploy.app}\` \`${deploy.tag}\` to \`${deploy.env}\`...`);
        const repo = (_a = APP_TO_REPO[deploy.app]) !== null && _a !== void 0 ? _a : deploy.app;
        const apiUrl = `https://api.github.com/repos/sonarmd/${repo}/releases/tags/${deploy.tag}`;
        let config;
        try {
            config = await fetchDeployConfig(deploy.tag, repo);
        }
        catch (e) {
            msg.send(`:x: ${e.message}`);
            deploy.status = 'failed';
            activeDeploys.delete(auditId);
            return;
        }
        if (!((_b = config.bundles) === null || _b === void 0 ? void 0 : _b.length)) {
            msg.send(`:x: No bundles found in deploy.json for \`${deploy.app}\`.`);
            deploy.status = 'failed';
            activeDeploys.delete(auditId);
            return;
        }
        const results = await Promise.all(config.bundles.map((bundle) => runBundleDeploy(bundle, deploy, apiUrl, repo, msg)));
        const failures = results.filter((ok) => !ok).length;
        if (failures > 0) {
            deploy.status = 'partial_failure';
            msg.send(`:warning: Break-glass \`${auditId}\` completed with ${failures}/${config.bundles.length} failures.`);
        }
        else {
            deploy.status = 'success';
            msg.send(`:white_check_mark: Break-glass \`${auditId}\` completed. All ${config.bundles.length} bundles deployed.`);
        }
        deployHistory.unshift(deploy);
        if (deployHistory.length > 50)
            deployHistory.length = 50;
        activeDeploys.delete(auditId);
    });
    // /deploy status
    robot.respond(/deploy\s+status$/i, async (msg) => {
        if (activeDeploys.size === 0) {
            msg.send('No active deploys.');
            return;
        }
        const lines = [...activeDeploys.entries()].map(([id, d]) => `${id}: \`${d.app}\` \`${d.tag}\` to ${d.env} by @${d.actor} [${d.status}]`);
        msg.send(`Active deploys:\n${lines.join('\n')}`);
    });
    // /deploy history [app]
    robot.respond(/deploy\s+history\s*(\S*)$/i, async (msg) => {
        const appFilter = msg.match[1];
        let history = deployHistory;
        if (appFilter) {
            history = history.filter((d) => d.app === appFilter);
        }
        if (history.length === 0) {
            msg.send(`No deploy history${appFilter ? ` for ${appFilter}` : ''}.`);
            return;
        }
        const lines = history.slice(0, 10).map((d) => {
            const icon = d.status === 'success' ? ':white_check_mark:' : ':x:';
            return `${icon} \`${d.app}\` \`${d.tag}\` to ${d.env} by @${d.actor} at ${d.timestamp}`;
        });
        msg.send(`Recent deploys:\n${lines.join('\n')}`);
    });
}
