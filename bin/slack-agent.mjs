#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), command = args[0] || 'help';
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Provide a value for ${name}.`);
  return args[index + 1];
};
let directory = resolve(option('--data', process.env.SLACK_AGENT_DATA || join(homedir(), '.local', 'share', 'slack-agent-connector')));
const profile = option('--profile', '');
if (profile) {
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(profile)) throw new Error('Profile names use letters, numbers, and underscores.');
  directory = join(directory, 'profiles', profile);
}
try {
  if (command === 'serve') {
    const { startServer } = await import('../src/server.mjs');
    const port = Number(option('--port', '4037'));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Choose a valid TCP port.');
    const app = await startServer({ directory, port, host: option('--host', '127.0.0.1') });
    console.log(`Slack Agent Connector is running at ${app.url}\nSettings: ${app.settingsUrl()}\nData: ${directory}`);
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
    process.on('SIGINT', close); process.on('SIGTERM', close);
  } else if (command === 'mcp') {
    const { startMcp } = await import('../src/mcp.mjs');
    await startMcp(directory, { autoStart: !args.includes('--no-autostart') });
  } else if (command === 'install') {
    const { installConnector } = await import('../src/install.mjs');
    const result = await installConnector({ harness: option('--harness', 'auto'), directory, profile: profile || 'default',
      cwd: option('--cwd', process.cwd()), dryRun: args.includes('--dry-run'), start: !args.includes('--no-start') });
    if (args.includes('--json') || result.dry_run) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Slack Agent Connector installed for ${result.harness}.\nProfile data: ${result.directory}`);
      if (result.setup) console.log(`Setup: ${result.setup.settings_url}\nSlack webhook: ${result.setup.webhook_url}\n${result.reload}`);
      if (result.harness === 'mcp') console.log(`Client configuration: ${join(directory, 'mcp-config.json')}`);
    }
  } else if (command === 'settings') {
    const { ensureDaemon, requestApi } = await import('../src/mcp.mjs');
    const setup = await requestApi(await ensureDaemon(directory), '/api/setup', 'POST', {});
    console.log(setup.settings_url);
  } else if (command === 'config') {
    const entry = fileURLToPath(import.meta.url);
    console.log(JSON.stringify({ mcpServers: { slack: { command: process.execPath, args: [entry, 'mcp', '--data', directory] } } }, null, 2));
    console.log(`\nCodex config.toml:\n[mcp_servers.slack]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([entry,'mcp','--data',directory])}`);
  } else {
    console.log(`Slack Agent Connector\n\nCommands:\n  install   Register with this harness and begin private Slack setup\n  serve     Run the background event receiver and settings\n  mcp       Connect any stdio MCP harness; starts the receiver if needed\n  settings  Print a fresh settings sign-in link\n  config    Print Claude Code / MCP JSON and Codex TOML configuration\n\nOptions:\n  --harness <name>    For install: auto, claude, codex, pi, omp, or mcp\n  --profile <name>    Isolate a Slack identity and its receiver\n  --data <directory>  Connector data directory\n  --cwd <directory>   Teammate working directory for install\n  --dry-run          Show an install plan without changing settings\n  --no-start         Install without starting setup\n  --json             Return installer output as JSON\n  --port <port>       Receiver port for serve (default 4037)\n  --host <address>    Bind address for serve (default 127.0.0.1)\n  --no-autostart      For mcp, require an existing receiver\n`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
