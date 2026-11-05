import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { callConnectorTool, ensureDaemon, toolDefinitions } from './mcp.mjs';

// Both hosts supply a schema builder. Keep their dependencies in the host runtime.
export function hostSchema(schema, Type) {
  if ('const' in schema) return Type.Literal(schema.const);
  if (schema.enum) return Type.Union(schema.enum.map(value => Type.Literal(value)));
  if (schema.oneOf) return Type.Union(schema.oneOf.map(value => hostSchema(value, Type)));
  if (schema.type === 'string') return Type.String({ ...(schema.maxLength ? { maxLength: schema.maxLength } : {}) });
  if (schema.type === 'boolean') return Type.Boolean();
  if (schema.type === 'array') return Type.Array(hostSchema(schema.items, Type), {
    ...(schema.minItems ? { minItems: schema.minItems } : {}), ...(schema.maxItems ? { maxItems: schema.maxItems } : {}) });
  if (schema.type === 'object') return Type.Object(Object.fromEntries(Object.entries(schema.properties || {}).map(([key,value]) => {
    const item = hostSchema(value, Type);
    return [key, schema.required?.includes(key) ? item : Type.Optional(item)];
  })), { additionalProperties: false });
  throw new Error('Unsupported connector schema.');
}

export function registerSlackExtension(api, Type, { directory = resolve(process.env.SLACK_AGENT_DATA || join(homedir(), '.local', 'share', 'slack-agent-connector')), connect = ensureDaemon, call = callConnectorTool } = {}) {
  const connection = async () => connect(directory);
  for (const spec of toolDefinitions) {
    api.registerTool({ name: spec.name, label: spec.name.replaceAll('_', ' '), description: spec.description,
      parameters: hostSchema(spec.inputSchema, Type),
      async execute(_id, args, signal) {
        if (signal?.aborted) throw new Error('Cancelled.');
        const details = await call(await connection(), spec.name, args);
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } });
  }
  api.registerTool({ name: 'slack_current_session', label: 'Slack current session',
    description: 'Read the current harness session ID, optional transcript file and working directory. Use these when binding this conversation to a Slack profile. Do not open another CLI process for a session that is currently running.',
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _onUpdate, ctx) {
      const details = { session_id: ctx.sessionManager.getSessionId(), session_file: ctx.sessionManager.getSessionFile?.() || null, cwd: ctx.cwd };
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    } });
  api.registerCommand('slack-setup', { description: 'Open private Slack connector setup',
    async handler(_args, ctx) {
      const setup = await call(await connection(), 'slack_setup', {});
      ctx.ui.notify(`Slack setup: ${setup.settings_url}`, 'info');
    } });
}
