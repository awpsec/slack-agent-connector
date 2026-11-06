import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, open } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION } from './version.mjs';

const entry = fileURLToPath(new URL('../bin/slack-agent.mjs', import.meta.url));
export async function access(directory) {
  const value = JSON.parse(await readFile(join(directory, 'access.json'), 'utf8'));
  const response = await fetch(`${value.url}/api/state`, { headers: { Authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error('Connector is unavailable.');
  const state = await response.json();
  return { ...value, version: state.version, deliveries: state.deliveries || [] };
}
export async function ensureDaemon(directory, { autoStart = true, upgrade = false } = {}) {
  let existing;
  try { existing = await access(directory); } catch { /* Start below if requested. */ }
  if (existing) {
    if (existing.version === VERSION) return existing;
    const instructions = `Receiver version ${existing.version || 'unknown'} differs from installed version ${VERSION}. Stop and restart this profile's receiver before using the update.`;
    if (!upgrade) throw new Error(instructions);
    if (existing.deliveries.some(j=>!['done','skipped','cancelled'].includes(j.status))) throw new Error(instructions + ' Resolve pending deliveries first; no active work was interrupted.');
    try { await requestApi(existing,'/api/shutdown','POST',{only_if_idle:true}); }
    catch { throw new Error(instructions + ' This older receiver must be stopped through its terminal or process manager.'); }
    let stopped = false;
    for (let i=0;i<50;i++) { await delay(100); try { await access(directory); } catch { stopped=true;break; } }
    if (!stopped) throw new Error(instructions + ' The receiver has not stopped yet.');
  }
  if (!autoStart) throw new Error('Start the connector with slack-agent serve first.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let port = '0';
  try { port = new URL(JSON.parse(await readFile(join(directory, 'access.json'), 'utf8')).url).port; } catch { /* Allocate a free port on first start. */ }
  let node = process.execPath;
  try { node = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')).node || node; } catch { /* Use the caller's Node runtime when not installed. */ }
  const log = await open(join(directory, 'daemon.log'), 'a', 0o600);
  const child = spawn(node, [entry, 'serve', '--data', directory, '--port', port], { detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
  child.on('error', () => {}); // Startup failures are reported by the readiness check below.
  child.unref(); await log.close();
  for (let i = 0; i < 50; i++) {
    await delay(100);
    try { const ready = await access(directory); if (ready.version === VERSION) return ready; } catch { /* Startup has not finished. */ }
  }
  throw new Error(`Connector did not start. Check ${join(directory, 'daemon.log')}. Another connector may use port 4037; start serve with --port and retry.`);
}
export async function requestApi(connection, path, method = 'GET', input) {
  const response = await fetch(`${connection.url}${path}`, { method,
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Connector request failed.');
  return result;
}
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const rule = object({ scope: { enum: ['all_channels','channel','direct_messages'] }, channel_id: string,
  mode: { enum: ['off','all','mentions','mentions_and_replies'] }, instructions: { type: 'string', maxLength: 4000 } }, ['scope','mode']);
export const toolDefinitions = [
  { name: 'slack_setup', description: 'Set up event-driven Slack monitoring for any harness. Returns a one-time settings link and Events API webhook URL. Enter Slack credentials only in the settings form. The connector runs in the background and dispatches matching events without polling Slack.', inputSchema: object(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'slack_status', description: 'List the connected Slack identity, assignments, channel rules, session targets, and delivery health. No credentials are returned.', inputSchema: object(), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'slack_channels', description: 'List Slack channels for the connected identity. Follow next_cursor until empty. Use returned IDs in channel rules. Workspace rules cover only conversations Slack makes available to this app and identity.', inputSchema: object({ cursor: string }), annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'slack_assignment_save', description: 'Create or replace an assignment using ALL its rules. Any harness can receive JSON by webhook or command stdin and return a JSON reply. Session IDs are passed through, not inferred. Claude/Codex/pi/omp adapters resume dedicated local sessions; active or cloud sessions need their harness bridge. Channel rules override workspace rules, including off. Editing cancels pending old events. Return null to stay silent. Never put tokens in chat; configure webhook authentication in settings.',
    inputSchema: object({ id: string, name: { type: 'string', maxLength: 80 }, enabled: { type: 'boolean' },
      instructions: { type: 'string', maxLength: 16000 }, session_id: { type:'string', description:'Omit to preserve an existing binding. Supply an existing session ID to bind it. Clearing a bound profile session also requires reset_session=true.' },
      session_scope: { enum: ['profile','channel','thread'], description: 'Share one session per profile, or create independent sessions for each channel or thread. Leave session_id empty for channel/thread scope.' },
      reset_session: { type:'boolean', description:'Explicitly clear a profile session binding when session_id is empty. Use only when the user requested a fresh session.' },
      adapter: { oneOf: [
        object({ type: { const: 'webhook' }, url: string }, ['type','url']),
        object({ type: { const: 'command' }, command: string, args: { type: 'array', items: string }, cwd: string }, ['type','command','args','cwd']),
        object({ type: { enum: ['claude','codex','pi','omp'] }, cwd: string, args: { type: 'array', items: string, description: 'Optional harness configuration arguments, such as a native profile or settings file. Session/output flags are managed by the connector.' } }, ['type','cwd']),
      ] }, rules: { type: 'array', minItems: 1, maxItems: 64, items: rule },
    }, ['name','enabled','instructions','adapter','rules']), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  { name: 'slack_assignment_remove', description: 'Remove an assignment and cancel its pending events. Already submitted Slack messages cannot be recalled.', inputSchema: object({ id: string }, ['id']), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'slack_session_start', description: 'Create a persistent teammate session for an enabled Slack profile that has no session ID. Queues session.create through the chosen harness bridge, then retains the returned session ID. The harness controls the session environment, tools, and connectors. Check slack_status for completion.', inputSchema: object({ id: string }, ['id']), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'slack_pause', description: 'Pause or resume event dispatch. Pause cancels pending events; resume receives new events without scanning history.', inputSchema: object({ paused: { type: 'boolean' } }, ['paused']), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
];
export async function callConnectorTool(connection, name, args = {}) {
  switch (name) {
    case 'slack_setup': return requestApi(connection, '/api/setup', 'POST', {});
    case 'slack_status': return requestApi(connection, '/api/state');
    case 'slack_channels': return requestApi(connection, `/api/channels?cursor=${encodeURIComponent(args.cursor || '')}`);
    case 'slack_assignment_save': return requestApi(connection, '/api/agents', 'PUT', args);
    case 'slack_assignment_remove': return requestApi(connection, `/api/agents/${encodeURIComponent(args.id)}`, 'DELETE');
    case 'slack_session_start': return requestApi(connection, `/api/agents/${encodeURIComponent(args.id)}/session`, 'POST', {});
    case 'slack_pause': return requestApi(connection, '/api/pause', 'POST', args);
    default: throw new Error('Unknown connector tool.');
  }
}
export async function startMcp(directory, options = {}) {
  const connection = await ensureDaemon(resolve(directory), options);
  const server = new Server({ name: 'slack-agent-connector', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = request.params.arguments || {};
    try {
      const data = await callConnectorTool(connection, request.params.name, args);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  await server.connect(new StdioServerTransport());
  return server;
}
