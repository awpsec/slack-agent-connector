import { dispatch } from './adapters.mjs';
import { requireValue, ruleFor, verifyAdapterReply } from './policy.mjs';

export class Engine {
  constructor(store, slack, { dispatchRun = dispatch, callbackBase = () => '', concurrency = 4 } = {}) {
    this.store = store; this.slack = slack; this.dispatchRun = dispatchRun;
    this.callbackBase = callbackBase; this.concurrency = concurrency;
    this.active = new Map(); this.closed = false;
  }
  start() { this.store.recover(); this.timer = setInterval(() => this.tick(), 500); this.tick(); }
  tick() {
    if (this.closed) return;
    for (const [id, active] of this.active) {
      if (!this.store.current(this.store.job(id))) active.controller.abort();
    }
    // Async harness sessions remain busy until their callback finishes or expires.
    const waitingKeys = new Set();
    for (const row of this.store.db.prepare("SELECT * FROM jobs WHERE status='waiting'").all()) {
      const agent = this.store.agent(row.agent_id);
      if (!this.store.current(row)) this.store.updateJob(row.id, { status: 'cancelled' });
      else if (row.updated + 30 * 60 * 1000 < Date.now()) this.store.updateJob(row.id, { status: 'failed', error: 'Harness callback timed out.' });
      else waitingKeys.add(this.store.sessionKey(agent));
    }
    for (const job of this.store.pending()) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(job.id) || job.status === 'waiting') continue;
      if (!this.store.current(job)) { this.store.updateJob(job.id, { status: 'cancelled' }); continue; }
      const agent = this.store.agent(job.agent_id), key = this.store.sessionKey(agent);
      if (waitingKeys.has(key) || [...this.active.values()].some(a => a.key === key)) continue;
      const controller = new AbortController();
      const active = { key, controller };
      this.active.set(job.id, active);
      active.promise = this.process(job, agent, controller.signal).catch(() => {
        if (this.store.current(job)) this.store.updateJob(job.id, { status: 'failed', error: 'Unexpected delivery failure.' });
      }).finally(() => { this.active.delete(job.id); if (!this.closed) this.tick(); });
    }
  }
  async process(job, agent, signal) {
    if (job.status === 'reply_ready') return this.send(job);
    this.store.updateJob(job.id, { status: 'running', attempts: job.attempts + 1 });
    const event = JSON.parse(job.event), connection = this.store.get('slack');
    try {
      const creating = event.type === 'session.create';
      const context = creating ? [] : await this.slack.context(connection.token, event);
      if (!this.store.current(job) || signal.aborted) return;
      const channelInstructions = creating ? '' : ruleFor(agent, event)?.instructions;
      const envelope = { version: '1', type: creating ? 'session.create' : 'slack.message', delivery_id: job.id, agent: { id: agent.id, name: agent.name, session_id: agent.session_id || null },
        identity: connection.identity, instructions: agent.instructions + (channelInstructions ? `\n\nChannel instructions:\n${channelInstructions}` : ''), slack: creating ? null : event, context,
        callback: { url: `${this.callbackBase()}/api/deliveries/${job.id}/complete`, token: job.callback_token, expires_in_seconds: 1800 } };
      const result = await this.dispatchRun(agent.adapter, envelope, { signal });
      if (!this.store.current(job) || signal.aborted) return;
      if (result.pending) {
        // A fast async callback can complete before the 202 response arrives.
        if (this.store.job(job.id).status === 'running') this.store.updateJob(job.id, { status: 'waiting' });
        return;
      }
      if (this.store.job(job.id).status !== 'running') return;
      this.acceptReply(job, result);
      if (this.store.job(job.id).status === 'reply_ready') await this.send(this.store.job(job.id));
    } catch (error) {
      const current = this.store.job(job.id);
      if (!this.store.current(job) || current.status !== 'running') return;
      // A local process may have used other harness tools before it failed.
      // HTTP bridges have an explicit idempotency contract; CLI processes do not.
      const retry = agent.adapter.type === 'webhook' && current.attempts < 3;
      this.store.updateJob(job.id, { status: retry ? 'queued' : 'failed', error: error.message,
        next_at: Date.now() + Math.min(60000, 2000 * 2 ** current.attempts) });
    }
  }
  acceptReply(job, raw) {
    const creating = JSON.parse(job.event).type === 'session.create';
    const result = verifyAdapterReply(creating ? { ...raw, reply: null } : raw);
    requireValue(!creating || result.session_id, 'The harness must return session_id when creating a session.');
    requireValue(this.store.current(job), 'This delivery was cancelled, changed, or already completed.');
    const current = this.store.job(job.id);
    requireValue(['running', 'waiting'].includes(current.status), 'This delivery has already received a reply.');
    this.store.transaction(() => {
      this.store.updateJob(job.id, { status: creating ? 'done' : result.reply ? 'reply_ready' : 'skipped', reply: result.reply, error: '', next_at: 0 });
      if (result.session_id) {
        const agent = this.store.agent(job.agent_id);
        agent.session_id = result.session_id;
        this.store.db.prepare('UPDATE agents SET body=? WHERE id=?').run(JSON.stringify(agent), agent.id);
        const active = this.active.get(job.id);
        if (active) active.key = this.store.sessionKey(agent);
      }
    });
  }
  async send(job) {
    if (!this.store.current(job) || this.store.job(job.id).status !== 'reply_ready') return;
    this.store.updateJob(job.id, { status: 'sending' });
    try {
      const event = JSON.parse(job.event);
      await this.slack.post(this.store.get('slack').token, event, job.reply, job.id);
      this.store.participate(event.channel_id, event.thread_ts);
      this.store.updateJob(job.id, { status: 'done', error: '' });
    } catch (error) {
      this.store.updateJob(job.id, { status: error.uncertain ? 'uncertain' : error.retryAfter ? 'reply_ready' : 'send_failed',
        error: error.message, next_at: Date.now() + (error.retryAfter || 30) * 1000 });
    }
  }
  async stop() {
    this.closed = true; clearInterval(this.timer);
    for (const a of this.active.values()) a.controller.abort();
    await Promise.allSettled([...this.active.values()].map(a => a.promise));
  }
}
