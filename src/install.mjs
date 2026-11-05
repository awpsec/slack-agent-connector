import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDaemon, requestApi } from './mcp.mjs';

export const HARNESS_NAMES = ['claude', 'codex', 'pi', 'omp', 'mcp'];
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = fileURLToPath(new URL('../bin/slack-agent.mjs', import.meta.url));

export async function installedHarnesses(env = process.env) {
  const result = [];
  for (const name of HARNESS_NAMES.filter(h => h !== 'mcp')) {
    const extensions = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
    let found = false;
    for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
      for (const ext of extensions) {
        try { await access(join(dir, name + ext.toLowerCase()), process.platform === 'win32' ? constants.F_OK : constants.X_OK); found = true; break; } catch { /* Try next path. */ }
      }
      if (found) break;
    }
    if (found) result.push(name);
  }
  return result;
}
export function detectHarness({ requested = 'auto', env = process.env, available = [] } = {}) {
  if (requested !== 'auto') {
    if (!HARNESS_NAMES.includes(requested)) throw new Error(`Choose --harness ${HARNESS_NAMES.join(', ')}.`);
    return requested;
  }
  const hints = [
    [Boolean(env.OMP_PROFILE || env.OMP_SESSION_ID), 'omp'],
    [Boolean(env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID), 'claude'],
    [Boolean(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID), 'codex'],
    [Boolean(env.PI_CODING_AGENT_DIR || env.PI_SESSION_ID), 'pi'],
  ];
  for (const [active, name] of hints) if (active && available.includes(name)) return name;
  if (available.length === 1) return available[0];
  if (!available.length) throw new Error('No supported harness CLI found. Use --harness mcp for another client, or install your harness CLI first.');
  throw new Error(`Multiple harnesses found (${available.join(', ')}). Specify the current harness with --harness; existing clients will not be changed automatically.`);
}
export function runInstallerCommand(command, args) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 512000) { failure = new Error('Harness command output exceeded its limit.'); child.kill(); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', () => { failure = new Error(`Could not start ${command}. Check that its CLI is installed and on PATH.`); });
    const timer = setTimeout(() => { failure = new Error(`${command} installation timed out.`); child.kill(); }, 120000);
    child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else resolveCommand({ code, stdout, stderr }); });
  });
}

export function installPlan({ harness, directory, profile = 'default', node = process.execPath, packagePath = root }) {
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(profile)) throw new Error('Profile names use letters, numbers, and underscores.');
  const serverName = profile === 'default' ? 'slack-agent' : `slack-agent-${profile}`;
  const config = { mcpServers: { [serverName]: { command: node, args: [join(packagePath, 'bin', 'slack-agent.mjs'), 'mcp', '--data', directory] } } };
  const registration = harness === 'claude' ? { command: 'claude', args: ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', serverName, '--', node, ...config.mcpServers[serverName].args] } :
    harness === 'codex' ? { command: 'codex', args: ['mcp', 'add', serverName, '--', node, ...config.mcpServers[serverName].args] } :
    ['pi', 'omp'].includes(harness) ? { command: harness, args: ['install', join(directory, 'extension-package')] } : null;
  return { harness, server_name: serverName, directory, runtime: node, source: packagePath, registration, mcp_config: config };
}
async function writeExtensionPackage(directory, profile) {
  const path = join(directory, 'extension-package');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const shared = pathToFileURL(join(root, 'src', 'extension-tools.mjs')).href;
  const options = JSON.stringify({ directory });
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: `slack-agent-connector-${profile}`, version: '0.1.0', private: true, type: 'module',
    pi: { extensions: ['./pi.js'] }, omp: { extensions: ['./omp.js'] } }, null, 2), { mode: 0o600 });
  await writeFile(join(path, 'pi.js'), `import { Type } from '@sinclair/typebox';\nimport { registerSlackExtension } from ${JSON.stringify(shared)};\nexport default api => registerSlackExtension(api, Type, ${options});\n`, { mode: 0o600 });
  await writeFile(join(path, 'omp.js'), `import { registerSlackExtension } from ${JSON.stringify(shared)};\nexport default api => registerSlackExtension(api, api.typebox.Type, ${options});\n`, { mode: 0o600 });
}

export async function installConnector({ harness = 'auto', directory, profile = 'default', cwd = process.cwd(),
  dryRun = false, start = true, run = runInstallerCommand, connect = ensureDaemon, request = requestApi, env = process.env } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24 || process.versions.bun) throw new Error('Run the installer with Node.js 24 or newer. The receiver needs Node SQLite, including when omp runs on Bun.');
  harness = detectHarness({ requested: harness, env, available: harness === 'auto' ? await installedHarnesses(env) : [] });
  directory = resolve(directory); cwd = resolve(cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('The working directory must be a directory.');
  const plan = installPlan({ harness, directory, profile });
  if (dryRun) return { ...plan, dry_run: true, setup_started: false };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // The host may use Bun or an older Node. Always launch this verified Node runtime.
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ node: process.execPath, source: root }), { mode: 0o600 });
  if (['pi', 'omp'].includes(harness)) await writeExtensionPackage(directory, profile);
  if (['claude', 'codex'].includes(harness)) {
    const probe = await run(harness, ['mcp', 'get', plan.server_name, ...(harness === 'codex' ? ['--json'] : [])]);
    let sameRegistration = probe.stdout.includes(entry) && probe.stdout.includes(directory);
    if (harness === 'codex' && probe.code === 0) {
      try {
        const config = JSON.parse(probe.stdout);
        const transport = config.transport || config.mcpServers?.[plan.server_name];
        sameRegistration = transport?.args?.includes(entry) && transport.args.includes(directory);
      } catch { sameRegistration = false; }
    }
    if (probe.code === 0 && !sameRegistration) {
      throw new Error(`An unrelated MCP server named ${plan.server_name} already exists. Choose a different --profile; it has not been overwritten.`);
    }
    if (probe.code !== 0) {
      const result = await run(plan.registration.command, plan.registration.args);
      if (result.code !== 0) throw new Error(`${harness} could not register the MCP connector. Its existing configuration was not replaced. Check its CLI configuration and try again.`);
    }
  } else if (plan.registration) {
    const result = await run(plan.registration.command, plan.registration.args);
    if (result.code !== 0) throw new Error(`${harness} could not install the extension package. Check its package manager and try again.`);
  } else {
    await writeFile(join(directory, 'mcp-config.json'), JSON.stringify(plan.mcp_config, null, 2) + '\n', { mode: 0o600 });
  }
  const receipt = { ...plan, installed_at: new Date().toISOString(), setup_started: false };
  await writeFile(join(directory, 'installation.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  if (start) {
    const connection = await connect(directory);
    const state = await request(connection, '/api/state');
    if (!state.agents.length && harness !== 'mcp') {
      const saved = await request(connection, '/api/agents', 'PUT', { name: 'Slack teammate', enabled: false,
        instructions: 'Help the team using the tools and connectors already configured in this harness. Reply when addressed or when you can contribute; otherwise stay silent.',
        session_id: '', adapter: { type: harness, cwd }, rules: [{ scope: 'all_channels', mode: 'mentions_and_replies' }] });
      receipt.profile_id = saved.id;
    }
    const setup = await request(connection, '/api/setup', 'POST', {});
    Object.assign(receipt, { setup_started: true, setup, reload: ['pi', 'omp'].includes(harness) ? 'Use /reload, or restart the harness to load its extension.' : 'Reconnect MCP or restart the harness to load its tools. Setup can continue through this settings link now.' });
  }
  // One-time sign-in links are returned to the caller, never saved in an install receipt.
  return receipt;
}
