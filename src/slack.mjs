import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(raw, headers, secret, now = Date.now()) {
  const ts = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];
  if (!secret || typeof ts !== 'string' || !/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > 300 ||
      typeof signature !== 'string' || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:`).update(raw).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
export class SlackError extends Error {
  constructor(message, retryAfter = 0, uncertain = false) { super(message); this.name = 'SlackError'; this.retryAfter = retryAfter; this.uncertain = uncertain; }
}
export class Slack {
  constructor(fetcher = fetch) { this.fetch = fetcher; }
  async api(token, method, body = {}) {
    let response;
    try {
      response = await this.fetch(`https://slack.com/api/${method}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams(Object.entries(body).map(([key,value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)])),
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    } catch { throw new SlackError('Slack connection interrupted.', 0, method === 'chat.postMessage'); }
    if (response.status === 429) throw new SlackError('Slack rate limit reached.', Math.max(1, Number(response.headers.get('retry-after')) || 30));
    if (!response.ok) throw new SlackError(`Slack returned HTTP ${response.status}.`, 0, method === 'chat.postMessage');
    let data;
    try { data = await response.json(); } catch { throw new SlackError('Slack returned invalid JSON.', 0, method === 'chat.postMessage'); }
    if (!data.ok) throw new SlackError(`Slack: ${String(data.error || 'request_failed').replace(/[^a-z_]/g, '').slice(0, 80)}.`);
    return data;
  }
  async identity(token) {
    const data = await this.api(token, 'auth.test');
    if (!data.team_id || !data.user_id) throw new SlackError('Slack did not identify the connected account.');
    return { team_id: data.team_id, user_id: data.user_id, bot_id: data.bot_id || '', team: data.team || '', user: data.user || '' };
  }
  async channels(token, cursor = '') {
    const result = await this.api(token, 'conversations.list', { types: 'public_channel,private_channel,im,mpim', exclude_archived: true, limit: 200, cursor });
    return { channels: result.channels.map(c => ({ id: c.id, name: c.name || c.user || c.id, is_member: c.is_member ?? c.is_im ?? c.is_mpim ?? false, is_private: Boolean(c.is_private) })), next_cursor: result.response_metadata?.next_cursor || '' };
  }
  async context(token, event) {
    // No history scan: fetch just this thread when available. Scope failures do not block a reply.
    if (!event.is_reply) return [];
    try {
      const result = await this.api(token, 'conversations.replies', { channel: event.channel_id, ts: event.thread_ts, limit: 20 });
      return (result.messages || []).map(m => ({ user: m.user || m.bot_id || '', text: String(m.text || '').slice(0, 3000), ts: m.ts }));
    } catch { return []; }
  }
  async post(token, event, text, deliveryId) {
    return this.api(token, 'chat.postMessage', { channel: event.channel_id, thread_ts: event.thread_ts,
      text, client_msg_id: deliveryId, unfurl_links: false, unfurl_media: false });
  }
}
