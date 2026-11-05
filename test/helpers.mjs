import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';

export const identity = { team_id: 'T123', user_id: 'U123', bot_id: '', user: 'sandor', team: 'Test team' };
export const secret = 'test-signing-secret-not-a-real-credential';
export function agentInput(overrides = {}) {
  return { name: 'Sandor', enabled: true, instructions: 'Reply only when relevant.', session_id: '',
    adapter: { type: 'webhook', url: 'https://harness.example/events' },
    rules: [{ scope: 'all_channels', mode: 'mentions_and_replies' }], ...overrides };
}
export function event(overrides = {}, envelope = {}) {
  return { type: 'event_callback', team_id: 'T123', api_app_id: 'A123', event_id: 'Ev123',
    authorizations: [{ team_id: 'T123', user_id: 'U123', is_bot: false }],
    event: { type: 'message', channel: 'C123', user: 'U456', ts: '1000000000.000001', text: '<@U123> Help?', channel_type: 'channel', ...overrides }, ...envelope };
}
export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'slack-agent-test-'));
  const store = new Store(directory);
  store.set('slack', { identity, token: 'xoxp-test-credential', signing_secret: secret });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store };
}
export function signed(raw, signingSecret = secret, ts = String(Math.floor(Date.now() / 1000))) {
  return { 'Content-Type': 'application/json', 'x-slack-request-timestamp': ts,
    'x-slack-signature': 'v0=' + createHmac('sha256', signingSecret).update(`v0:${ts}:`).update(raw).digest('hex') };
}
export async function eventually(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await delay(10); }
  throw new Error('Condition did not become true.');
}
export class FakeSlack {
  posts = [];
  async identity() { return identity; }
  async context() { return []; }
  async channels(_token, cursor) { return { channels: [{ id: cursor ? 'C456' : 'C123', name: cursor ? 'general' : 'engineering', is_member: true }], next_cursor: cursor ? '' : 'page2' }; }
  async post(token, event, text, id) { this.posts.push({ token, event, text, id }); return { ok: true, ts: '1000000001.000001' }; }
}
