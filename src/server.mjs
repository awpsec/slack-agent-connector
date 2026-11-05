import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { Slack, verifySignature } from './slack.mjs';
import { Engine } from './engine.mjs';
import { requireValue, validateUrl } from './policy.mjs';

export function equalSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw Object.assign(new Error('Request body exceeds 512 KiB.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function jsonBody(raw) {
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}
function send(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}
function acquireLock(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'daemon.lock');
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); return path; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = JSON.parse(readFileSync(path, 'utf8')).pid; } catch { /* Incomplete startup: do not steal an unowned lock. */ }
      if (!pid) throw new Error('Connector startup is already in progress.');
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { unlinkSync(path); continue; } }
      throw new Error('A connector already runs for this data directory.');
    }
  }
  throw new Error('Could not acquire connector lock.');
}
export async function startServer({ directory, host = '127.0.0.1', port = 4037, slack = new Slack(), dispatchRun, startWorker = true } = {}) {
  const lockPath = acquireLock(directory);
  await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  let store, server, engine;
  try {
    store = new Store(directory);
    const accessPath = join(directory, 'access.json');
    let token;
    try { token = JSON.parse(await readFile(accessPath, 'utf8')).token; } catch { /* New connector. */ }
    token ||= randomBytes(32).toString('hex');
    let localBase;
    const base = () => store.get('public_url') || localBase;
    const eventUrl = () => `${base()}/slack/events/${store.get('webhook_id')}`;
    const settingsUrl = () => `${localBase}/settings#ticket=${store.ticket()}`;
    const state = () => ({ version: '0.1.0', paused: store.get('paused'), public_url: store.get('public_url') || '',
      webhook_url: eventUrl(), webhook_public: Boolean(store.get('public_url')), settings_url: `${localBase}/settings`,
      identity: store.get('slack')?.identity || null, has_credentials: Boolean(store.get('slack')?.token),
      has_signing_secret: Boolean(store.get('slack')?.signing_secret),
      last_event_at: store.get('last_event_at') || null, agents: store.publicAgents(), deliveries: store.history(),
      scope_note: 'Workspace rules cover only conversations the connected identity and Slack app can receive. Private channels require membership and scopes.' });
    engine = new Engine(store, slack, { dispatchRun, callbackBase: base });
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const allowedHosts = new Set([new URL(localBase).host, `localhost:${server.address().port}`,
          ...(store.get('public_url') ? [new URL(store.get('public_url')).host] : [])]);
        if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'Unrecognized host.' });
        if (req.headers.origin && ![localBase, `http://localhost:${server.address().port}`, ...(store.get('public_url') ? [new URL(store.get('public_url')).origin] : [])].includes(req.headers.origin)) return send(res, 403, { error: 'Unrecognized origin.' });
        if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, { ok: true, version: '0.1.0' });
        const staticFile = { '/': 'settings.html', '/settings': 'settings.html', '/settings.js': 'settings.js', '/settings.css': 'settings.css', '/geist.woff2': 'geist.woff2', '/favicon.svg': 'favicon.svg' }[url.pathname];
        if (staticFile && req.method === 'GET') {
          const data = await readFile(new URL(`../public/${staticFile}`, import.meta.url));
          const type = staticFile.endsWith('.js') ? 'text/javascript' : staticFile.endsWith('.css') ? 'text/css' : staticFile.endsWith('.woff2') ? 'font/woff2' : staticFile.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
          return send(res, 200, data, type);
        }
        if (url.pathname === `/slack/events/${store.get('webhook_id')}` && req.method === 'POST') {
          const raw = await body(req);
          if (!verifySignature(raw, req.headers, store.get('slack')?.signing_secret)) return send(res, 401, { error: 'Invalid Slack signature.' });
          const payload = jsonBody(raw);
          if (payload.type === 'url_verification') {
            requireValue(typeof payload.challenge === 'string' && payload.challenge.length <= 4096, 'Invalid Slack challenge.');
            return send(res, 200, { challenge: payload.challenge });
          }
          // Ingestion commits before Slack receives its acknowledgement.
          const queued = store.ingest(payload);
          send(res, 200, { ok: true, queued });
          setImmediate(() => engine.tick());
          return;
        }
        if (url.pathname === '/api/login' && req.method === 'POST') {
          const input = jsonBody(await body(req));
          if (typeof input.ticket !== 'string' || !store.useTicket(input.ticket)) return send(res, 401, { error: 'This settings link expired or was already used. Open a new link from the connector.' });
          return send(res, 200, { token });
        }
        const callback = url.pathname.match(/^\/api\/deliveries\/([a-f0-9-]{36})\/complete$/);
        if (callback && req.method === 'POST') {
          const job = store.job(callback[1]);
          if (!job || !equalSecret(req.headers.authorization, `Bearer ${job.callback_token}`)) return send(res, 401, { error: 'Invalid delivery token.' });
          requireValue(job.updated + 30 * 60 * 1000 >= Date.now(), 'The delivery callback expired.');
          engine.acceptReply(job, jsonBody(await body(req)));
          send(res, 200, { ok: true });
          setImmediate(() => engine.tick()); return;
        }
        if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
        if (!equalSecret(req.headers.authorization, `Bearer ${token}`)) return send(res, 401, { error: 'Open settings from the connector to sign in.' });
        if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, state());
        if (url.pathname === '/api/setup' && req.method === 'POST') return send(res, 200, {
          settings_url: settingsUrl(), webhook_url: eventUrl(), webhook_public: Boolean(store.get('public_url')),
          connected: Boolean(store.get('slack')), transport: 'Slack Events API over signed HTTP',
          instructions: 'Open settings to connect Slack and choose the public HTTPS base URL. Enter OAuth credentials only in settings. Assign any harness using a webhook or a JSON stdin/stdout command. Use the same tools to edit assignments later.' });
        if (url.pathname === '/api/public-url' && req.method === 'PUT') {
          const input = jsonBody(await body(req));
          store.set('public_url', input.url ? validateUrl(input.url, { publicOnly: true }) : '');
          return send(res, 200, state());
        }
        if (url.pathname === '/api/connection' && req.method === 'PUT') {
          const input = jsonBody(await body(req)), previous = store.get('slack');
          const oauth = input.token || previous?.token, secret = input.signing_secret || previous?.signing_secret;
          requireValue(typeof oauth === 'string' && /^xox[bp]-[\x21-\x7e]{5,500}$/.test(oauth), 'Enter a Slack bot or user OAuth token.');
          requireValue(typeof secret === 'string' && /^[\x21-\x7e]{16,200}$/.test(secret), 'Enter the Slack app signing secret.');
          requireValue(!input.app_id || /^A[A-Z0-9]{1,63}$/.test(input.app_id), 'Enter a valid Slack app ID.');
          const identity = await slack.identity(oauth);
          if (input.app_id) identity.app_id = input.app_id;
          store.changeConnection({ token: oauth, signing_secret: secret, identity });
          return send(res, 200, state());
        }
        if (url.pathname === '/api/connection' && req.method === 'DELETE') {
          store.changeConnection(null); return send(res, 200, state());
        }
        if (url.pathname === '/api/channels' && req.method === 'GET') {
          requireValue(store.get('slack')?.token, 'Connect Slack first.');
          return send(res, 200, await slack.channels(store.get('slack').token, url.searchParams.get('cursor') || ''));
        }
        if (url.pathname === '/api/agents' && req.method === 'PUT') {
          const id = store.saveAgent(jsonBody(await body(req))); engine.tick(); return send(res, 200, { id, ...state() });
        }
        const agentMatch = url.pathname.match(/^\/api\/agents\/([a-f0-9-]{36})$/);
        if (agentMatch && req.method === 'DELETE') {
          store.removeAgent(agentMatch[1]); engine.tick(); return send(res, 200, state());
        }
        const sessionMatch = url.pathname.match(/^\/api\/agents\/([a-f0-9-]{36})\/session$/);
        if (sessionMatch && req.method === 'POST') {
          const delivery_id = store.startSession(sessionMatch[1]); engine.tick();
          return send(res, 202, { delivery_id, ...state() });
        }
        if (url.pathname === '/api/pause' && req.method === 'POST') {
          const input = jsonBody(await body(req)); requireValue(typeof input.paused === 'boolean', 'Set paused to true or false.');
          store.pause(input.paused); engine.tick(); return send(res, 200, state());
        }
        const retry = url.pathname.match(/^\/api\/deliveries\/([a-f0-9-]{36})\/retry$/);
        if (retry && req.method === 'POST') {
          const job = store.job(retry[1]); requireValue(job && ['failed','send_failed','uncertain'].includes(job.status), 'This delivery cannot be retried.');
          requireValue(store.current({ ...job, status: 'failed' }) || (job.status === 'uncertain' && store.agent(job.agent_id)?.revision === job.revision && store.agent(job.agent_id)?.enabled && !store.get('paused')), 'Assignment changed or paused.');
          const input = jsonBody(await body(req));
          requireValue(job.status !== 'uncertain' || input.checked_slack === true, 'Check Slack before retrying an uncertain delivery.');
          store.updateJob(job.id, { status: job.reply ? 'reply_ready' : 'queued', error: '', next_at: 0, attempts: 0 });
          engine.tick(); return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/manifest' && req.method === 'GET') {
          const user = !store.get('slack')?.identity.bot_id;
          const scopes = ['channels:read','groups:read','im:read','mpim:read','channels:history','groups:history','im:history','mpim:history','chat:write'];
          return send(res, 200, { display_information: { name: 'Slack Agent Connector' },
            ...(!user ? { features: { bot_user: { display_name: 'Slack teammate', always_online: false } } } : {}),
            oauth_config: { scopes: { [user ? 'user' : 'bot']: [...scopes, ...(!user ? ['app_mentions:read'] : [])] } },
            settings: { socket_mode_enabled: false, event_subscriptions: { request_url: eventUrl(),
              [user ? 'user_events' : 'bot_events']: ['message.channels','message.groups','message.im','message.mpim', ...(!user ? ['app_mention'] : [])] } } });
        }
        return send(res, 404, { error: 'Not found.' });
      } catch (error) {
        // Avoid returning upstream bodies, tokens, command arguments, or stack traces.
        if (!res.headersSent) send(res, error.status || 400, { error: error.status ? error.message : (error.name === 'SlackError' ? error.message : 'The request could not be completed. Check the connection and inputs.') });
        else res.end();
      }
    });
    server.requestTimeout = 20000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    localBase = `http://${host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
    await writeFile(accessPath, JSON.stringify({ url: localBase, token, pid: process.pid }), { mode: 0o600 });
    if (startWorker) engine.start();
    return { store, engine, server, url: localBase, token, settingsUrl, state,
      async close() {
        await engine.stop();
        await new Promise(resolve => server.close(resolve));
        store.close();
        try { unlinkSync(lockPath); } catch { /* Already removed. */ }
      } };
  } catch (error) {
    await engine?.stop(); server?.close(); store?.close();
    try { unlinkSync(lockPath); } catch { /* Already removed. */ }
    throw error;
  }
}
