import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
      CREATE TABLE IF NOT EXISTS threads(agent_id TEXT NOT NULL,channel_id TEXT NOT NULL,thread_ts TEXT NOT NULL,
        PRIMARY KEY(agent_id,channel_id,thread_ts));
      CREATE TABLE IF NOT EXISTS sessions(agent_id TEXT NOT NULL,conversation_key TEXT NOT NULL,session_id TEXT NOT NULL,
        PRIMARY KEY(agent_id,conversation_key),UNIQUE(agent_id,session_id));
      CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);`);
    // Migrate the first release without discarding credentials, messages or session IDs.
    if (!this.db.prepare('PRAGMA table_info(threads)').all().some(c => c.name === 'agent_id')) this.transaction(() => {
      // Legacy thread participation cannot be safely attributed to a particular profile.
      this.db.exec('DROP TABLE threads; CREATE TABLE threads(agent_id TEXT NOT NULL,channel_id TEXT NOT NULL,thread_ts TEXT NOT NULL,PRIMARY KEY(agent_id,channel_id,thread_ts))');
      for (const row of this.db.prepare("SELECT agent_id,event FROM jobs WHERE status='done' AND reply IS NOT NULL").all()) {
        try { const event = JSON.parse(row.event); if (event.channel_id && event.thread_ts) this.participate(row.agent_id,event.channel_id,event.thread_ts); } catch { /* Ignore incomplete legacy records. */ }
      }
    });
    const columns = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name));
    for (const [name,definition] of Object.entries({ session_key: "TEXT NOT NULL DEFAULT 'profile'", target_session: 'TEXT', response_session: 'TEXT', callback_expires_at: 'INTEGER NOT NULL DEFAULT 0' })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
    this.db.prepare("UPDATE jobs SET callback_expires_at=updated+1800000 WHERE status='waiting' AND callback_expires_at=0").run();
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
  publicAgents() { return this.agents().map(a => ({ ...a, session_scope: a.session_scope || 'profile', sessions: this.sessions(a.id), session_count: this.db.prepare('SELECT count(*) AS n FROM sessions WHERE agent_id=?').get(a.id).n, adapter: { ...a.adapter, token: undefined, has_token: Boolean(a.adapter.token) } })); }
  saveAgent(input) {
    const previous = input.id ? this.agent(input.id) : undefined;
    requireValue(!input.id || previous, 'Assignment not found.');
    const scope = input.session_scope || previous?.session_scope || 'profile';
    const sessionId = input.session_id === undefined ? previous?.session_id || '' :
      !input.session_id && previous?.session_id && scope === 'profile' && !input.reset_session ? previous.session_id : input.session_id;
    const agent = validateAgent({ ...input, session_scope: scope, session_id: scope !== 'profile' && input.session_id === undefined ? '' : sessionId }, previous);
    const adapterKey = a => JSON.stringify([a.type,a.cwd || '',a.url || '',a.token || '',a.command || '',a.args || []]);
    const comparable = a => JSON.stringify([a.name,a.enabled,a.instructions,a.session_id,a.session_scope || 'profile',adapterKey(a.adapter),a.rules.map(r=>[r.scope,r.channel_id || '',r.mode,r.instructions || ''])]);
    if (previous && comparable(previous) === comparable(agent)) return previous.id;
    return this.transaction(() => {
      this.db.prepare('INSERT INTO agents VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(agent.id, JSON.stringify(agent));
      this.cancelPending(agent.id);
      if (previous && (adapterKey(previous.adapter) !== adapterKey(agent.adapter) || (previous.session_scope || 'profile') !== agent.session_scope)) {
        this.db.prepare('DELETE FROM sessions WHERE agent_id=?').run(agent.id);
        this.db.prepare('DELETE FROM threads WHERE agent_id=?').run(agent.id);
      }
      return agent.id;
    });
  }
  cancelPending(id) {
    this.db.prepare(`UPDATE jobs SET status='cancelled',updated=? WHERE agent_id=? AND status IN ('queued','running','waiting','reply_ready','send_failed','failed','uncertain')`).run(Date.now(), id);
  }
  removeAgent(id) { this.transaction(() => { this.cancelPending(id); this.db.prepare('DELETE FROM sessions WHERE agent_id=?').run(id); this.db.prepare('DELETE FROM threads WHERE agent_id=?').run(id); this.db.prepare('DELETE FROM agents WHERE id=?').run(id); }); }
  pause(paused) {
    this.transaction(() => { this.set('paused', paused); if (paused) for (const a of this.agents()) this.cancelPending(a.id); });
  }
  changeConnection(connection) {
    return this.transaction(() => {
      const key = identity => identity ? `${identity.team_id}:${identity.user_id}` : '';
      const previousKey = key(this.get('slack')?.identity) || this.get('last_identity_key') || '';
      const nextKey = key(connection?.identity);
      const changed = Boolean(previousKey && nextKey && previousKey !== nextKey);
      if (!connection || changed) for (const a of this.agents()) this.cancelPending(a.id);
      if (changed) {
        for (const agent of this.agents()) {
          agent.enabled = false; agent.session_id = ''; agent.revision = randomUUID();
          this.db.prepare('UPDATE agents SET body=? WHERE id=?').run(JSON.stringify(agent), agent.id);
        }
        this.db.exec('DELETE FROM threads; DELETE FROM sessions');
      }
      this.set('slack', connection);
      if (nextKey) this.set('last_identity_key', nextKey);
      this.set('connection_notice', changed ? 'Slack identity changed. Profiles were paused and session bindings cleared to keep account contexts separate.' : '');
      return changed;
    });
  }
  ingest(payload) {
    const event = normalizeEvent(payload, this.get('slack')?.identity);
    if (!event || this.get('paused')) return 0;
    return this.transaction(() => {
      let count = 0;
      for (const a of this.agents()) {
        const participated = Boolean(this.db.prepare('SELECT 1 FROM threads WHERE agent_id=? AND channel_id=? AND thread_ts=?').get(a.id,event.channel_id,event.thread_ts));
        if (!matchesAgent(a, event, participated)) continue;
        const now = Date.now();
        count += Number(this.db.prepare(`INSERT OR IGNORE INTO jobs(id,agent_id,revision,message_key,event,created,updated,callback_token,session_key)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), a.id, a.revision, event.key, JSON.stringify(event), now, now, randomBytes(32).toString('hex'), this.conversationKey(a,event)).changes);
      }
      this.set('last_event_at', Date.now());
      return count;
    });
  }
  startSession(id) {
    const agent = this.agent(id);
    requireValue(agent?.enabled && !this.get('paused'), 'Enable the profile before creating its session.');
    requireValue((agent.session_scope || 'profile') === 'profile', 'Channel and thread sessions are created by their first matching message.');
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
    return this.db.prepare('SELECT id,agent_id,status,created,updated,attempts,error,session_key FROM jobs ORDER BY created DESC,rowid DESC LIMIT 60').all();
  }
  updateJob(id, values) {
    const allowed = new Set(['status','updated','attempts','next_at','reply','error','target_session','response_session','callback_expires_at']);
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
  policyCurrent(job) { const a = job && this.agent(job.agent_id); return Boolean(a && !this.get('paused') && a.enabled && a.revision === job.revision); }
  current(job) { return this.policyCurrent(job) && !['cancelled','done','skipped','uncertain'].includes(this.job(job.id)?.status); }
  conversationKey(agent, event) { return agent.session_scope === 'thread' ? `thread:${event.channel_id}:${event.thread_ts}` : agent.session_scope === 'channel' ? `channel:${event.channel_id}` : 'profile'; }
  targetSession(agent, key = 'profile') { return key === 'profile' ? agent.session_id || null : this.db.prepare('SELECT session_id FROM sessions WHERE agent_id=? AND conversation_key=?').get(agent.id,key)?.session_id || null; }
  sessions(id) { return this.db.prepare('SELECT conversation_key,session_id FROM sessions WHERE agent_id=? ORDER BY rowid DESC LIMIT 100').all(id); }
  bindSession(agent, key, sessionId) {
    if (key === 'profile') {
      agent.session_id = sessionId;
      this.db.prepare('UPDATE agents SET body=? WHERE id=?').run(JSON.stringify(agent),agent.id);
    } else {
      const other = this.db.prepare('SELECT conversation_key FROM sessions WHERE agent_id=? AND session_id=?').get(agent.id,sessionId);
      requireValue(!other || other.conversation_key === key, 'The harness reused a session across separate conversations. Return a distinct session ID for each conversation.');
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(agent_id,conversation_key) DO UPDATE SET session_id=excluded.session_id').run(agent.id,key,sessionId);
    }
  }
  sessionKey(agent, event) {
    const key = event ? this.conversationKey(agent,event) : 'profile', id = this.targetSession(agent,key);
    if (!id) return `conversation:${agent.id}:${key}`;
    const a = agent.adapter;
    const namespace = a.type === 'webhook' ? [a.type,a.url,a.token || ''] : a.type === 'command' ? [a.type,a.command,a.args,a.cwd] : [a.type];
    return `session:${createHash('sha256').update(JSON.stringify(namespace)).digest('hex')}:${id}`;
  }
  jobKeys(job, agent) { return [`conversation:${agent.id}:${job.session_key}`, this.sessionKey(agent,JSON.parse(job.event))]; }
  unfinished() { return this.db.prepare(`SELECT * FROM jobs WHERE status NOT IN ('done','skipped','cancelled') ORDER BY created,rowid`).all(); }
  dismiss(id) { const job = this.job(id); requireValue(job && ['failed','send_failed','uncertain'].includes(job.status), 'Only a failed or uncertain delivery can be dismissed.'); this.updateJob(id,{status:'cancelled'}); }
  participate(agentId, channel, thread) { this.db.prepare('INSERT OR IGNORE INTO threads VALUES(?,?,?)').run(agentId,channel,thread); }
  ticket() {
    const id = randomBytes(24).toString('hex');
    this.db.prepare('DELETE FROM tickets WHERE expires<?').run(Date.now());
    this.db.prepare('INSERT INTO tickets VALUES(?,?)').run(id, Date.now() + 300000);
    return id;
  }
  useTicket(id) { return Boolean(this.db.prepare('DELETE FROM tickets WHERE id=? AND expires>=? RETURNING id').get(id, Date.now())); }
  close() { this.db.close(); }
}
