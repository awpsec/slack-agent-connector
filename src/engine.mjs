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
    // Consider the head of every conversation, including delayed/failed work.
    // Otherwise a retry delay can let later messages start a different session.
    const heads = new Set(), busy = new Set([...this.active.values()].flatMap(a => a.keys));
    for (const job of this.store.unfinished()) {
      if (!this.store.policyCurrent(job)) {
        if (job.status !== 'sending') this.store.updateJob(job.id, { status: 'cancelled' });
        continue;
      }
      const agent = this.store.agent(job.agent_id), keys = this.store.jobKeys(job,agent);
      const behind = keys.some(key => heads.has(key));
      keys.forEach(key => heads.add(key));
      if (behind || this.active.has(job.id) || keys.some(key => busy.has(key))) continue;
      if (job.status === 'waiting' && job.callback_expires_at < Date.now()) {
        this.store.updateJob(job.id,{status:'failed',error:'Harness callback timed out. Retry or dismiss this delivery to continue the conversation.'});
        continue;
      }
      if (!['queued','reply_ready'].includes(job.status) || job.next_at > Date.now() || this.active.size >= this.concurrency) continue;
      const controller = new AbortController();
      const active = { keys, controller };
      this.active.set(job.id, active);
      keys.forEach(key => busy.add(key));
      active.promise = this.process(job, agent, controller.signal).catch(() => {
        if (this.store.current(job)) this.store.updateJob(job.id, { status: 'failed', error: 'Unexpected delivery failure.' });
      }).finally(() => { this.active.delete(job.id); if (!this.closed) this.tick(); });
    }
  }
  async process(job, agent, signal) {
    if (job.status === 'reply_ready') return this.send(job);
    const targetSession = this.store.targetSession(agent,job.session_key);
    this.store.updateJob(job.id, { status: 'running', attempts: job.attempts + 1, target_session: targetSession, callback_expires_at: Date.now()+1800000 });
    const event = JSON.parse(job.event), connection = this.store.get('slack');
    try {
      const creating = event.type === 'session.create';
      const context = creating ? [] : await this.slack.context(connection.token, event);
      if (!this.store.current(job) || signal.aborted) return;
      const channelInstructions = creating ? '' : ruleFor(agent, event)?.instructions;
      const envelope = { version: '1', type: creating ? 'session.create' : 'slack.message', delivery_id: job.id, agent: { id: agent.id, name: agent.name, session_id: targetSession, session_scope: agent.session_scope || 'profile', conversation_key: job.session_key },
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
      const retry = agent.adapter.type === 'webhook' && current.attempts < 3 && !error.status && error.retryable !== false;
      this.store.updateJob(job.id, { status: retry ? 'queued' : 'failed', error: error.message,
        next_at: Date.now() + Math.min(60000, 2000 * 2 ** current.attempts) });
    }
  }
  acceptReply(job, raw) {
    const creating = JSON.parse(job.event).type === 'session.create';
    const result = verifyAdapterReply(creating ? { ...raw, reply: null } : raw);
    requireValue(!creating || result.session_id, 'The harness must return session_id when creating a session.');
    const current = this.store.job(job.id);
    requireValue(current, 'Delivery not found.');
    if (['reply_ready','sending','done','skipped','send_failed','uncertain'].includes(current.status)) {
      requireValue(current.reply === result.reply && (!result.session_id || result.session_id === current.response_session), 'This delivery already received a different result.');
      return { duplicate: true };
    }
    requireValue(this.store.current(job), 'This delivery was cancelled or its settings changed.');
    requireValue(['running', 'waiting'].includes(current.status), 'This delivery has already received a reply.');
    requireValue(current.callback_expires_at >= Date.now(), 'The delivery callback expired.');
    requireValue(!current.target_session || !result.session_id || result.session_id === current.target_session, 'The harness returned a different session ID while resuming. The existing context binding was preserved.');
    requireValue(current.session_key === 'profile' || result.session_id || current.target_session, 'Return a session ID so this conversation can keep its context.');
    this.store.transaction(() => {
      if (result.session_id) {
        const agent = this.store.agent(job.agent_id);
        this.store.bindSession(agent,current.session_key,result.session_id);
        const active = this.active.get(job.id);
        if (active) active.keys = [...new Set([...active.keys,...this.store.jobKeys(current,agent)])];
      }
      this.store.updateJob(job.id, { status: creating ? 'done' : result.reply ? 'reply_ready' : 'skipped', reply: result.reply, response_session: result.session_id || current.target_session, error: '', next_at: 0 });
    });
    return { duplicate: false };
  }
  async send(job) {
    if (!this.store.current(job) || this.store.job(job.id).status !== 'reply_ready') return;
    this.store.updateJob(job.id, { status: 'sending' });
    try {
      const event = JSON.parse(job.event);
      await this.slack.post(this.store.get('slack').token, event, job.reply, job.id);
      if (this.store.policyCurrent(job)) this.store.participate(job.agent_id,event.channel_id,event.thread_ts);
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
