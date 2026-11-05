import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { matchesAgent, normalizeEvent, requireValue, validateAgent } from './policy.mjs';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, 'connector.sqlite'));
    chmodSync(join(directory, 'connector.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, revision TEXT NOT NULL,
        message_key TEXT NOT NULL, event TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        created INTEGER NOT NULL, updated INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, reply TEXT, error TEXT NOT NULL DEFAULT '', callback_token TEXT NOT NULL,
        UNIQUE(agent_id,message_key));
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,next_at,created);
      CREATE TABLE IF NOT EXISTS threads(channel_id TEXT NOT NULL,thread_ts TEXT NOT NULL,
        PRIMARY KEY(channel_id,thread_ts));
      CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);`);
    if (!this.get('webhook_id')) this.set('webhook_id', randomBytes(20).toString('hex'));
    if (!this.get('paused')) this.set('paused', false);
  }
  get(key) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; }
  set(key, value) { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  agents() { return this.db.prepare('SELECT body FROM agents ORDER BY rowid').all().map(r => JSON.parse(r.body)); }
  agent(id) { return this.agents().find(a => a.id === id); }
  publicAgents() { return this.agents().map(a => ({ ...a, adapter: { ...a.adapter, token: undefined, has_token: Boolean(a.adapter.token) } })); }
  saveAgent(input) {
    const previous = input.id ? this.agent(input.id) : undefined;
    requireValue(!input.id || previous, 'Assignment not found.');
    const agent = validateAgent(input, previous);
    return this.transaction(() => {
      this.db.prepare('INSERT INTO agents VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(agent.id, JSON.stringify(agent));
      this.cancelPending(agent.id);
      return agent.id;
    });
  }
  cancelPending(id) {
    this.db.prepare(`UPDATE jobs SET status='cancelled',updated=? WHERE agent_id=? AND status IN ('queued','running','waiting','reply_ready','send_failed','failed')`).run(Date.now(), id);
  }
  removeAgent(id) { this.transaction(() => { this.cancelPending(id); this.db.prepare('DELETE FROM agents WHERE id=?').run(id); }); }
  pause(paused) {
    this.transaction(() => { this.set('paused', paused); if (paused) for (const a of this.agents()) this.cancelPending(a.id); });
  }
  changeConnection(connection) {
    this.transaction(() => {
      for (const a of this.agents()) this.cancelPending(a.id);
      this.db.exec('DELETE FROM threads');
      this.set('slack', connection);
    });
  }
  ingest(payload) {
    const event = normalizeEvent(payload, this.get('slack')?.identity);
    if (!event || this.get('paused')) return 0;
    return this.transaction(() => {
      const participated = Boolean(this.db.prepare('SELECT 1 FROM threads WHERE channel_id=? AND thread_ts=?').get(event.channel_id, event.thread_ts));
      let count = 0;
      for (const a of this.agents().filter(a => matchesAgent(a, event, participated))) {
        const now = Date.now();
        count += Number(this.db.prepare(`INSERT OR IGNORE INTO jobs(id,agent_id,revision,message_key,event,created,updated,callback_token)
          VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), a.id, a.revision, event.key, JSON.stringify(event), now, now, randomBytes(32).toString('hex')).changes);
      }
      this.set('last_event_at', Date.now());
      return count;
    });
  }
  startSession(id) {
    const agent = this.agent(id);
    requireValue(agent?.enabled && !this.get('paused'), 'Enable the profile before creating its session.');
    requireValue(!agent.session_id, 'This profile already targets a session. Clear its session ID to create a new one.');
    requireValue(this.get('slack')?.identity, 'Connect the Slack identity first.');
    requireValue(!this.db.prepare("SELECT 1 FROM jobs WHERE agent_id=? AND status IN ('queued','running','waiting','reply_ready','sending')").get(id), 'This profile already has pending work.');
    const delivery = randomUUID(), now = Date.now();
    this.db.prepare(`INSERT INTO jobs(id,agent_id,revision,message_key,event,created,updated,callback_token)
      VALUES(?,?,?,?,?,?,?,?)`).run(delivery, agent.id, agent.revision, `session:${delivery}`, JSON.stringify({ type: 'session.create' }), now, now, randomBytes(32).toString('hex'));
    return delivery;
  }
  job(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  history() {
    return this.db.prepare('SELECT id,agent_id,status,created,updated,attempts,error FROM jobs ORDER BY created DESC,rowid DESC LIMIT 60').all();
  }
  updateJob(id, values) {
    const allowed = new Set(['status','updated','attempts','next_at','reply','error']);
    const entries = Object.entries({ ...values, updated: Date.now() });
    if (entries.some(([k]) => !allowed.has(k))) throw new Error('Invalid job update.');
    this.db.prepare(`UPDATE jobs SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=?`).run(...entries.map(([,v]) => v), id);
  }
  recover() {
    // A process may have posted to Slack just before it stopped. Do not send twice.
    this.db.prepare(`UPDATE jobs SET status='uncertain',error='Delivery was interrupted while sending. Check Slack before retrying.',updated=? WHERE status='sending'`).run(Date.now());
    for (const job of this.db.prepare("SELECT * FROM jobs WHERE status='running'").all()) {
      const webhook = this.agent(job.agent_id)?.adapter.type === 'webhook';
      this.updateJob(job.id, { status: webhook ? 'queued' : 'failed',
        error: webhook ? '' : 'Local harness execution was interrupted. Check the session before retrying.' });
    }
  }
  current(job) { const a = this.agent(job.agent_id); return !this.get('paused') && a?.enabled && a.revision === job.revision && !['cancelled','done','skipped','uncertain'].includes(this.job(job.id)?.status); }
  sessionKey(agent) { return agent.session_id ? `${agent.adapter.type}:${agent.adapter.cwd || agent.adapter.url || agent.adapter.command}:${agent.session_id}` : agent.id; }
  pending() { return this.db.prepare(`SELECT * FROM jobs WHERE status IN ('queued','reply_ready','waiting') AND next_at<=? ORDER BY created,rowid`).all(Date.now()); }
  participate(channel, thread) { this.db.prepare('INSERT OR IGNORE INTO threads VALUES(?,?)').run(channel, thread); }
  ticket() {
    const id = randomBytes(24).toString('hex');
    this.db.prepare('DELETE FROM tickets WHERE expires<?').run(Date.now());
    this.db.prepare('INSERT INTO tickets VALUES(?,?)').run(id, Date.now() + 300000);
    return id;
  }
  useTicket(id) { return Boolean(this.db.prepare('DELETE FROM tickets WHERE id=? AND expires>=? RETURNING id').get(id, Date.now())); }
  close() { this.db.close(); }
}
