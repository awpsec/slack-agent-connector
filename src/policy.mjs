import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const MODES = ['off', 'all', 'mentions', 'mentions_and_replies'];
const channelId = /^[CGD][A-Z0-9]{1,63}$/;
const timestamp = /^\d{1,16}\.\d{1,10}$/;
export function requireValue(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { status: 400 });
}
export function validateUrl(value, { publicOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { requireValue(false, 'Enter a complete HTTP or HTTPS URL.'); }
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash,
    'Use an HTTP or HTTPS URL without credentials or a fragment.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireValue(url.protocol === 'https:' || (!publicOnly && local), 'Use HTTPS, or HTTP on localhost.');
  requireValue(!publicOnly || (url.pathname === '/' && !url.search), 'Use a public base URL with no path or query.');
  return url.href.replace(/\/$/, '');
}
export function validateAgent(input, previous) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Provide an assignment.');
  const allowed = ['id', 'name', 'enabled', 'instructions', 'session_id', 'session_scope', 'reset_session', 'adapter', 'rules'];
  requireValue(Object.keys(input).every(k => allowed.includes(k)), 'Unknown assignment field.');
  requireValue(typeof input.name === 'string' && input.name.trim() && input.name.length <= 80, 'Give the assignment a short name.');
  requireValue(typeof input.instructions === 'string' && input.instructions.length <= 16000, 'Instructions must be at most 16000 characters.');
  requireValue(typeof input.enabled === 'boolean', 'Set enabled to true or false.');
  requireValue(input.reset_session === undefined || typeof input.reset_session === 'boolean', 'Set reset_session to true only to clear an existing profile session.');
  requireValue(typeof input.session_id === 'string' && input.session_id.length <= 200 && !/[\r\n\0]/.test(input.session_id), 'Use a valid session ID.');
  requireValue(!input.session_id.startsWith('-'), 'Session IDs cannot begin with a dash.');
  const sessionScope = input.session_scope || 'profile';
  requireValue(['profile', 'channel', 'thread'].includes(sessionScope), 'Choose a session per profile, channel, or thread.');
  requireValue(sessionScope === 'profile' || !input.session_id, 'Leave the session ID empty for automatic channel or thread sessions.');
  requireValue(Array.isArray(input.rules) && input.rules.length > 0 && input.rules.length <= 64, 'Add between one and 64 channel rules.');
  const seen = new Set();
  const rules = input.rules.map(rule => {
    requireValue(rule && Object.keys(rule).every(k => ['scope', 'channel_id', 'mode', 'instructions'].includes(k)), 'Unknown rule field.');
    requireValue(['all_channels', 'channel', 'direct_messages'].includes(rule.scope) && MODES.includes(rule.mode), 'Choose a valid scope and behavior.');
    requireValue(rule.scope === 'channel' ? channelId.test(rule.channel_id ?? '') : !rule.channel_id, 'Use a Slack channel ID for a channel rule.');
    const key = rule.scope + ':' + (rule.channel_id ?? '');
    requireValue(!seen.has(key), 'Only one rule is allowed for each scope or channel.');
    seen.add(key);
    requireValue(rule.instructions === undefined || (typeof rule.instructions === 'string' && rule.instructions.length <= 4000), 'Channel instructions must be at most 4000 characters.');
    return { scope: rule.scope, channel_id: rule.channel_id ?? '', mode: rule.mode, instructions: rule.instructions || '' };
  });
  const a = input.adapter;
  requireValue(a && ['webhook', 'command', 'claude', 'codex', 'pi', 'omp'].includes(a.type), 'Choose a webhook, command, Claude Code, Codex, pi, or omp adapter.');
  requireValue(Object.keys(a).every(k => ['type', 'url', 'token', 'command', 'args', 'cwd'].includes(k)), 'Unknown adapter field.');
  let adapter = { type: a.type };
  if (a.type === 'webhook') {
    adapter.url = validateUrl(a.url);
    requireValue(!a.token || (typeof a.token === 'string' && a.token.length <= 4096 && !/[\r\n]/.test(a.token)), 'Invalid webhook token.');
    adapter.token = a.token || (previous?.adapter.type === 'webhook' ? previous.adapter.token : '') || '';
  } else {
    requireValue(typeof a.cwd === 'string' && isAbsolute(a.cwd) && !a.cwd.includes('\0'), 'Choose an absolute working directory.');
    adapter.cwd = a.cwd;
    if (a.type !== 'command' && a.args !== undefined) {
      requireValue(Array.isArray(a.args) && a.args.length <= 64 && a.args.every(v => typeof v === 'string' && v.length <= 4096 && !v.includes('\0')), 'Harness arguments must be an array of strings.');
      const reserved = new Set(['--', '--session', '--session-id', '--resume', '--continue', '--restore', '--fork', '--fork-session', '--mode', '--print', '--output-format', '--json-schema', '--json', '--output-schema', '--output-last-message', '--ephemeral']);
      if (a.type === 'claude') for (const flag of ['-p','-c']) reserved.add(flag);
      if (['pi','omp'].includes(a.type)) for (const flag of ['-p','-r','-c','--no-session']) reserved.add(flag);
      requireValue(!a.args.some(v => reserved.has(v.split('=')[0])), 'The connector manages session and output flags. Use additional arguments only for harness configuration.');
      adapter.args = a.args;
    }
    if (a.type === 'command') {
      requireValue(typeof a.command === 'string' && a.command.trim() && a.command.length <= 4096 && !a.command.includes('\0'), 'Choose an executable.');
      requireValue(Array.isArray(a.args) && a.args.length <= 64 && a.args.every(v => typeof v === 'string' && v.length <= 4096 && !v.includes('\0')), 'Command arguments must be an array of strings.');
      adapter.command = a.command;
      adapter.args = a.args;
    }
  }
  return { id: previous?.id ?? randomUUID(), name: input.name.trim(), enabled: input.enabled,
    instructions: input.instructions, session_id: input.session_id, session_scope: sessionScope, adapter, rules, revision: randomUUID() };
}
export function normalizeEvent(payload, identity) {
  if (!identity || payload.type !== 'event_callback' || payload.team_id !== identity.team_id) return null;
  if (identity.app_id && payload.api_app_id !== identity.app_id) return null;
  if (Array.isArray(payload.authorizations) && !payload.authorizations.some(a => a.team_id === identity.team_id && a.user_id === identity.user_id)) return null;
  const e = payload.event;
  if (!e || !['message', 'app_mention'].includes(e.type) || e.hidden ||
      (e.subtype && !['file_share', 'thread_broadcast'].includes(e.subtype)) ||
      e.user === identity.user_id || e.bot_id || !/^[UW][A-Z0-9]{1,63}$/.test(e.user ?? '') ||
      !channelId.test(e.channel ?? '') || !timestamp.test(e.ts ?? '') ||
      (e.thread_ts && !timestamp.test(e.thread_ts))) return null;
  const direct = ['im', 'mpim'].includes(e.channel_type) || e.channel.startsWith('D');
  return { team_id: payload.team_id, channel_id: e.channel, sender_id: e.user,
    message_ts: e.ts, thread_ts: e.thread_ts || e.ts, is_reply: Boolean(e.thread_ts && e.thread_ts !== e.ts),
    direct, mentioned: typeof e.text === 'string' && e.text.includes(`<@${identity.user_id}>`),
    text: typeof e.text === 'string' ? e.text.slice(0, 16000) : '',
    event_id: payload.event_id || '', key: `${payload.team_id}:${e.channel}:${e.ts}` };
}
export function matchesAgent(agent, event, participated = false) {
  if (!agent.enabled) return false;
  // A channel rule is an override, including an explicit "off" override.
  const rule = ruleFor(agent, event);
  if (!rule || rule.mode === 'off') return false;
  return rule.mode === 'all' || event.mentioned ||
    (rule.mode === 'mentions_and_replies' && event.is_reply && participated);
}
export function ruleFor(agent, event) {
  return agent.rules.find(r => r.scope === 'channel' && r.channel_id === event.channel_id) ??
    agent.rules.find(r => r.scope === (event.direct ? 'direct_messages' : 'all_channels'));
}
export function verifyAdapterReply(result) {
  requireValue(result && typeof result === 'object' && !Array.isArray(result), 'The harness must return a JSON object.');
  requireValue(result.reply === null || typeof result.reply === 'string', 'Return reply as a string or null.');
  requireValue(!result.reply || result.reply.length <= 12000, 'A reply must be at most 12000 characters.');
  requireValue(result.session_id === undefined || (typeof result.session_id === 'string' && result.session_id.length <= 200 && !/[\r\n\0]/.test(result.session_id) && !result.session_id.startsWith('-')), 'Invalid returned session ID.');
  return { reply: result.reply?.trim() || null, session_id: result.session_id };
}
