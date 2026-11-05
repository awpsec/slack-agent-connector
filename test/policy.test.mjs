import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, matchesAgent, validateAgent, verifyAdapterReply, validateUrl } from '../src/policy.mjs';
import { verifySignature } from '../src/slack.mjs';
import { identity, agentInput, event, signed, secret } from './helpers.mjs';

test('Slack signatures authenticate the raw bytes and reject stale or malformed requests', () => {
  const raw = Buffer.from('{ "type": "url_verification" }'), headers = signed(raw);
  assert.equal(verifySignature(raw, headers, secret), true);
  assert.equal(verifySignature(Buffer.from('{"type":"url_verification"}'), headers, secret), false);
  assert.equal(verifySignature(raw, signed(raw,secret,String(Math.floor(Date.now()/1000)-301)), secret), false);
  assert.equal(verifySignature(raw, {...headers,'x-slack-signature':'v0=x'}, secret), false);
  assert.equal(verifySignature(raw, headers, ''), false);
});
test('events are restricted to the installation and ignore self, bots, changes and deletions', () => {
  assert.ok(normalizeEvent(event(), identity));
  for (const payload of [event({}, { team_id: 'T999' }),event({}, {authorizations:[{team_id:'T123',user_id:'U999'}]}),
    event({user:'U123'}),event({bot_id:'B123'}),event({subtype:'message_changed'}),event({subtype:'message_deleted'}),event({hidden:true}),event({ts:'bad'}),event({channel:'invalid'})]) assert.equal(normalizeEvent(payload, identity),null);
  assert.equal(normalizeEvent(event(),{...identity,app_id:'A999'}),null);
});
test('specific channel rules override workspace behavior and direct messages are separate', () => {
  const agent = validateAgent(agentInput({rules:[{scope:'all_channels',mode:'all'},{scope:'channel',channel_id:'C123',mode:'off'},{scope:'direct_messages',mode:'mentions'}]}));
  assert.equal(matchesAgent(agent,normalizeEvent(event(),identity)),false);
  assert.equal(matchesAgent(agent,normalizeEvent(event({channel:'C456',text:'hello'}),identity)),true);
  assert.equal(matchesAgent(agent,normalizeEvent(event({channel:'D123',channel_type:'im',text:'hello'}),identity)),false);
  assert.equal(matchesAgent(agent,normalizeEvent(event({channel:'D123',channel_type:'im'}),identity)),true);
});
test('mentions and thread replies wake only matching profiles', () => {
  const agent = validateAgent(agentInput());
  assert.equal(matchesAgent(agent,normalizeEvent(event(),identity)),true);
  assert.equal(matchesAgent(agent,normalizeEvent(event({text:'<@U1234> hello'}),identity)),false);
  const reply = normalizeEvent(event({text:'Here is more context.',thread_ts:'999999999.000001'}),identity);
  assert.equal(matchesAgent(agent,reply,false),false);
  assert.equal(matchesAgent(agent,reply,true),true);
});
test('validation rejects ambiguous rules, unsupported URLs and command/session injection', () => {
  assert.throws(() => validateAgent(agentInput({rules:[{scope:'channel',channel_id:'C123',mode:'all'},{scope:'channel',channel_id:'C123',mode:'off'}]})));
  assert.throws(() => validateAgent(agentInput({session_id:'--last'})));
  assert.throws(() => validateAgent(agentInput({adapter:{type:'command',cwd:'relative',command:'test',args:[]}})));
  assert.throws(() => validateUrl('http://untrusted.example'));
  assert.throws(() => validateUrl('https://example.org/prefix',{publicOnly:true}));
  assert.equal(validateUrl('http://127.0.0.1:1000'),'http://127.0.0.1:1000');
  assert.deepEqual(verifyAdapterReply({reply:'  ',session_id:'s123'}),{reply:null,session_id:'s123'});
  assert.throws(() => verifyAdapterReply({reply:'x'.repeat(12001)}));
});
