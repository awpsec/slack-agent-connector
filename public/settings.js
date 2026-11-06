const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('slack-agent-access'), state, selected = null, dirty = false, sessionEdited = false, noticeTimer, connectionLost = false, loadedRevision, seenIdentity;
const modeLabels = { off: 'Off', all: 'Every message', mentions: 'Mentions only', mentions_and_replies: 'Mentions and replies' };
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function notify(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 10000 : 5000); }
async function api(path, method = 'GET', data) {
  let response;
  try { response = await fetch(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error('Cannot reach the receiver. Start it again, then reopen or refresh settings.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
async function action(button, fn) { button.disabled = true; try { await fn(); } catch (e) { notify(e.message, true); } finally { button.disabled = false; } }
function tab(name) { document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== name; }); document.querySelectorAll('[data-tab]').forEach(el => { if (el.dataset.tab === name) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current'); }); }
function renderState() {
  const identity = state.identity ? `${state.identity.team_id}:${state.identity.user_id}` : '';
  const accountChanged = Boolean(identity && seenIdentity && identity !== seenIdentity);
  if(identity)seenIdentity=identity;
  if(accountChanged && selected){editProfile(state.agents.find(a=>a.id===selected)||null);notify(state.connection_notice || 'Slack identity changed. Profile settings were reloaded.');return;}
  $('app').hidden = false; $('signin').hidden = true;
  $('connection-badge').textContent = state.paused ? 'Monitoring paused' : state.identity ? state.webhook_public ? 'Slack connected' : 'Slack linked · webhook setup needed' : 'Connect Slack';
  $('identity-summary').textContent = state.identity ? `Connected as ${state.identity.user || state.identity.user_id} in ${state.identity.team || state.identity.team_id}. Your harness decides where the teammate runs.` : 'Connect Slack, choose a session, and decide when it joins the conversation.';
  $('pause').textContent = state.paused ? 'Resume monitoring' : 'Pause monitoring';
  $('event-url').value = state.webhook_url; $('public-warning').hidden = state.webhook_public;
  $('scope-note').textContent = state.scope_note;
  if (document.activeElement !== $('public-url')) $('public-url').value = state.public_url;
  $('disconnect').hidden = !state.identity;
  $('slack-token').placeholder = state.has_credentials ? 'Saved · leave blank to keep' : 'xoxb… or xoxp…';
  $('signing-secret').placeholder = state.has_signing_secret ? 'Saved · leave blank to keep' : 'Slack app → Basic Information';
  $('profile-list').replaceChildren();
  if (!state.agents.length) $('profile-list').append(node('p','No profiles yet. Give your first teammate a session and a channel rule.','empty'));
  for (const agent of state.agents) {
    const card = node('button', agent.name, `profile-card${agent.id === selected ? ' active' : ''}`); card.type = 'button';
    card.append(node('span',`${agent.enabled ? 'Enabled' : 'Paused'} · ${agent.adapter.type === 'webhook' || agent.adapter.type === 'command' ? 'Any harness' : agent.adapter.type}`));
    card.append(node('span',agent.session_scope && agent.session_scope !== 'profile' ? `${agent.session_count || 0} sessions · per ${agent.session_scope}` : agent.session_id ? `Session ${agent.session_id}` : 'Ready for a new session'));
    card.onclick = () => editProfile(agent); $('profile-list').append(card);
  }
  renderDeliveries();
  if (selected && !dirty) {
    const agent = state.agents.find(a => a.id === selected);
    if (agent && agent.revision !== loadedRevision){editProfile(agent);return;}
    if (agent) { $('session-id').value = agent.session_id; $('enabled').checked=agent.enabled; sessionFields(); $('session-summary').textContent = `${agent.session_count || 0} conversation sessions saved. New conversations get their own context.`; renderBindings(agent); }
  }
}
function adapterFields() {
  const type = $('adapter-type').value;
  $('webhook-fields').hidden = type !== 'webhook'; $('local-fields').hidden = type === 'webhook'; $('command-fields').hidden = type !== 'command';
}
function sessionFields() {
  const scoped = $('session-scope').value !== 'profile';
  $('session-id').disabled = scoped;
  $('start-session').hidden = !selected || scoped || Boolean($('session-id').value);
  $('session-summary').hidden = !scoped;
  $('session-bindings').hidden = !scoped;
  $('session-help').textContent = scoped ? 'Separate sessions are created on the first matching message and reused for that channel or thread.' : 'Set an existing session ID, or let the harness return a new one. The harness owns its environment, credentials, and tools.';
}
function renderBindings(agent) {
  const list=$('session-list');list.replaceChildren();
  if(!agent.sessions?.length){list.append(node('p','No conversation sessions yet.','hint'));return;}
  const table=node('table',undefined,'binding-table'),head=node('tr');head.append(node('th','Conversation'),node('th','Session'));table.append(head);
  for(const binding of agent.sessions){const row=node('tr');row.append(node('td',binding.conversation_key),node('td',binding.session_id));table.append(row);}
  list.append(table);
  if(agent.session_count>agent.sessions.length)list.append(node('p',`Showing the newest ${agent.sessions.length} of ${agent.session_count} saved sessions.`,'hint'));
}
function addRule(value = { scope: 'channel', channel_id: '', mode: 'mentions_and_replies', instructions: '' }) {
  const wrap = node('div',undefined,'rule'), fields = node('div',undefined,'rule-fields');
  const scopeLabel = node('label','Where'), scope = node('select'); scope.className = 'rule-scope';
  for (const [v,t] of [['channel','Specific channel'],['all_channels','All available channels'],['direct_messages','Direct messages']]) { const o = node('option',t); o.value = v; scope.append(o); }
  scope.value = value.scope; scopeLabel.append(scope);
  const modeLabel = node('label','Wake on'), mode = node('select'); mode.className = 'rule-mode';
  for (const [v,t] of Object.entries(modeLabels)) { const o = node('option',t); o.value = v; mode.append(o); } mode.value = value.mode; modeLabel.append(mode);
  const channelLabel = node('label','Channel','channel-field'), channel = node('input'); channel.className = 'rule-channel'; channel.setAttribute('list','channels'); channel.placeholder = 'Choose a channel or paste its Slack ID'; channel.value = value.channel_id || ''; channelLabel.append(channel);
  channelLabel.hidden = scope.value !== 'channel'; scope.onchange = () => { channelLabel.hidden = scope.value !== 'channel'; };
  const instructionsLabel = node('label','Instructions for this channel','rule-instructions'), instructions = node('textarea'); instructions.className = 'channel-instructions'; instructions.rows = 2; instructions.maxLength = 4000; instructions.placeholder = 'For example: Only reply if this concerns you or someone asks you directly.'; instructions.value = value.instructions || ''; instructionsLabel.append(instructions);
  fields.append(scopeLabel,modeLabel,channelLabel);
  const footer = node('div',undefined,'rule-footer'), remove = node('button','Remove rule','text-button'); remove.type = 'button'; remove.onclick = () => { wrap.remove(); dirty = true; }; footer.append(remove);
  wrap.append(fields,instructionsLabel,footer); $('rules').append(wrap);
}
function editProfile(agent = null) {
  selected = agent?.id || null; loadedRevision=agent?.revision; dirty = false; sessionEdited=false; $('profile-heading').textContent = agent ? agent.name : 'Create a teammate';
  $('profile-name').value = agent?.name || ''; $('enabled').checked = agent?.enabled ?? true; $('instructions').value = agent?.instructions || '';
  $('adapter-type').value = agent?.adapter.type || 'webhook'; $('harness-url').value = agent?.adapter.url || '';
  $('harness-token').value = ''; $('harness-token').placeholder = agent?.adapter.has_token ? 'Saved · leave blank to keep' : 'Optional bearer token';
  $('harness-cwd').value = agent?.adapter.cwd || ''; $('harness-command').value = agent?.adapter.command || ''; $('harness-args').value = JSON.stringify(agent?.adapter.args || []);
  $('session-id').value = agent?.session_id || ''; $('delete-profile').hidden = !agent; $('start-session').hidden = !agent || Boolean(agent.session_id);
  $('session-scope').value = agent?.session_scope || 'profile'; sessionFields();
  $('rules').replaceChildren(); if (agent) agent.rules.forEach(addRule); else addRule({ scope: 'all_channels', mode: 'mentions_and_replies' });
  adapterFields(); if (state) renderState();
}
function readProfile() {
  const type = $('adapter-type').value, adapter = { type };
  if (type === 'webhook') { adapter.url = $('harness-url').value.trim(); if ($('harness-token').value) adapter.token = $('harness-token').value; }
  else { adapter.cwd = $('harness-cwd').value.trim(); if (type === 'command') adapter.command = $('harness-command').value.trim(); try { adapter.args = JSON.parse($('harness-args').value); } catch { throw new Error('Arguments must be a JSON array of strings.'); } }
  const rules = [...$('rules').children].map(el => ({ scope: el.querySelector('.rule-scope').value,
    channel_id: el.querySelector('.rule-scope').value === 'channel' ? el.querySelector('.rule-channel').value.trim() : '',
    mode: el.querySelector('.rule-mode').value, instructions: el.querySelector('.channel-instructions').value }));
  const binding = !selected || sessionEdited ? {session_id:$('session-scope').value === 'profile' ? $('session-id').value.trim() : '',reset_session:sessionEdited && !$('session-id').value.trim()} : {};
  return { ...(selected ? { id: selected } : {}), name: $('profile-name').value, enabled: $('enabled').checked, instructions: $('instructions').value, ...binding, session_scope: $('session-scope').value, adapter, rules };
}
function renderDeliveries() {
  const target = $('deliveries'); target.replaceChildren();
  if (!state.deliveries.length) { target.append(node('p','No deliveries yet. New matching Slack messages will appear here once your webhook is connected.','empty')); return; }
  const scroll = node('div',undefined,'table-scroll'), table = node('table'), head = node('thead'), headings = node('tr');
  for (const label of ['Profile','Status','Received','']) headings.append(node('th',label)); head.append(headings); table.append(head);
  const tbody = node('tbody');
  for (const job of state.deliveries) {
    const row = node('tr'); row.append(node('td',state.agents.find(a => a.id === job.agent_id)?.name || 'Removed profile'));
    const status = node('td',job.status.replaceAll('_',' ')); if (job.session_key && job.session_key !== 'profile') status.append(node('small',job.session_key)); if (job.error) status.append(node('small',job.error)); row.append(status);
    row.append(node('td',new Date(job.created).toLocaleString())); const controls = node('td');
    if (['failed','send_failed','uncertain'].includes(job.status)) {
      const retry = node('button',job.status === 'uncertain' ? 'Checked Slack · retry' : 'Retry','small'); retry.type = 'button';
      retry.onclick = () => action(retry, async () => { await api(`/api/deliveries/${job.id}/retry`,'POST',{ checked_slack: job.status === 'uncertain' }); await refresh(); }); controls.append(retry);
      const dismiss = node('button','Dismiss','text-button'); dismiss.type = 'button';
      dismiss.onclick = () => action(dismiss,async () => { await api(`/api/deliveries/${job.id}/dismiss`,'POST',{}); await refresh(); notify('Delivery dismissed. The conversation can continue.'); }); controls.append(dismiss);
    }
    row.append(controls); tbody.append(row);
  }
  table.append(tbody); scroll.append(table); target.append(scroll);
}
async function refresh() { state = await api('/api/state'); connectionLost=false; renderState(); }
document.querySelectorAll('[data-tab]').forEach(button => { button.onclick = () => tab(button.dataset.tab); });
$('adapter-type').onchange = adapterFields;
$('session-scope').onchange = () => { sessionEdited=true; if ($('session-scope').value !== 'profile') $('session-id').value = ''; sessionFields(); };
$('session-id').addEventListener('input',()=>{sessionEdited=true;});
$('profile-form').addEventListener('input',() => { dirty = true; });
$('profile-form').addEventListener('change',() => { dirty = true; });
$('new-profile').onclick = () => editProfile();
$('add-rule').onclick = () => { addRule(); dirty = true; };
$('profile-form').onsubmit = event => { event.preventDefault(); action($('save-profile'),async () => { const result = await api('/api/agents','PUT',readProfile()); state = result; editProfile(state.agents.find(a => a.id === result.id)); notify('Profile saved. New rules apply to future events.'); }); };
$('delete-profile').onclick = () => action($('delete-profile'),async () => { state = await api(`/api/agents/${selected}`,'DELETE'); editProfile(); notify('Profile removed.'); });
$('start-session').onclick = () => action($('start-session'),async () => { if (dirty) throw new Error('Save the profile before creating its session.'); await api(`/api/agents/${selected}/session`,'POST',{}); await refresh(); notify('Session creation queued. Your harness will return its session ID.'); });
$('pause').onclick = () => action($('pause'),async () => { state = await api('/api/pause','POST',{ paused: !state.paused }); renderState(); notify(state.paused ? 'Monitoring paused. Pending events were cancelled.' : 'Monitoring resumed for new events.'); });
$('connection-form').onsubmit = event => { event.preventDefault(); const button = event.submitter; action(button,async () => { state = await api('/api/connection','PUT',{ token: $('slack-token').value.trim(), signing_secret: $('signing-secret').value.trim(), app_id: $('app-id').value.trim() }); $('slack-token').value = ''; $('signing-secret').value = ''; $('manifest-identity').value=state.identity.bot_id?'bot':'user'; if (state.connection_notice) editProfile(state.agents.find(a=>a.id===selected)||null); else renderState(); notify(state.connection_notice || 'Slack identity connected.'); }); };
$('disconnect').onclick = () => action($('disconnect'),async () => { state = await api('/api/connection','DELETE'); renderState(); notify('Slack disconnected. Pending events were cancelled.'); });
$('public-url-form').onsubmit = event => { event.preventDefault(); action(event.submitter,async () => { state = await api('/api/public-url','PUT',{ url: $('public-url').value.trim() }); renderState(); notify('Public webhook URL saved.'); }); };
$('copy-webhook').onclick = () => action($('copy-webhook'),async () => { await navigator.clipboard.writeText(state.webhook_url); notify('Webhook copied.'); });
$('load-channels').onclick = () => action($('load-channels'),async () => { const channels = []; let cursor = ''; do { const result = await api(`/api/channels?cursor=${encodeURIComponent(cursor)}`); channels.push(...result.channels); cursor = result.next_cursor; } while (cursor); $('channels').replaceChildren(...channels.map(c => { const el = node('option'); el.value = c.id; el.label = c.name === c.id ? c.id : `#${c.name}`; return el; })); notify(`${channels.length} channels loaded.`); });
$('manifest').onclick = () => action($('manifest'),async () => { const manifest = await api(`/api/manifest?identity=${$('manifest-identity').value}`); const blob = new Blob([JSON.stringify(manifest,null,2)],{ type:'application/json' }); const url = URL.createObjectURL(blob), anchor = node('a'); anchor.href = url; anchor.download = 'slack-app-manifest.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url),1000); });
$('refresh').onclick = () => action($('refresh'),refresh);
async function init() {
  try {
    const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
    if (ticket) { history.replaceState(null,'',location.pathname); const result = await api('/api/login','POST',{ticket}); token = result.token; sessionStorage.setItem('slack-agent-access',token); }
    if (!token) throw new Error('Use a fresh settings link to sign in.');
    await refresh(); editProfile(state.agents[0] || null); if(state.identity)$('manifest-identity').value=state.identity.bot_id?'bot':'user';
    setInterval(() => { if (!document.hidden) refresh().catch(error => { $('connection-badge').textContent='Receiver unavailable'; if(!connectionLost)notify(error.message,true); connectionLost=true; }); },5000);
  } catch (e) { $('signin').hidden = false; $('signin-error').textContent = e.message; }
}
init();
