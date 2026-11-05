import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startServer } from '../src/server.mjs';
import { FakeSlack, agentInput, event, secret, signed, eventually } from './helpers.mjs';

async function appFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(),'slack-agent-http-')), slack = new FakeSlack();
  const app = await startServer({directory,port:0,slack,...options});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  async function api(path,method='GET',input) {
    const response=await fetch(`${app.url}${path}`,{method,headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {response,data:await response.json()};
  }
  await api('/api/connection','PUT',{token:'xoxp-test-credential',signing_secret:secret});
  return {app,slack,api,directory};
}
test('settings use one-time sign-in links, reject unauthorized writes and never disclose saved credentials',async t=>{
  const {app,api}=await appFixture(t);
  const unauthorized=await fetch(`${app.url}/api/state`);assert.equal(unauthorized.status,401);
  const setup=await api('/api/setup','POST',{}), ticket=new URLSearchParams(new URL(setup.data.settings_url).hash.slice(1)).get('ticket');
  const login=()=>fetch(`${app.url}/api/login`,{method:'POST',body:JSON.stringify({ticket})});
  assert.equal((await login()).status,200);assert.equal((await login()).status,401);
  const rejected=await fetch(`${app.url}/api/pause`,{method:'POST',headers:{Origin:'https://untrusted.example',Authorization:`Bearer ${app.token}`},body:'{"paused":true}'});
  assert.equal(rejected.status,403);
  const result=await api('/api/agents','PUT',agentInput({adapter:{type:'webhook',url:'https://harness.example',token:'private-harness-token'}}));
  assert.equal(result.response.status,200);const raw=JSON.stringify(result.data);
  assert.equal(raw.includes('xoxp-test-credential'),false);assert.equal(raw.includes(secret),false);assert.equal(raw.includes('private-harness-token'),false);
  assert.equal(result.data.agents[0].adapter.has_token,true);
});
test('signed Slack challenges and messages work end to end, including retry deduplication',async t=>{
  const {app,api,slack}=await appFixture(t,{dispatchRun:async()=>({reply:'I can help.',session_id:'persistent-session'})});
  await api('/api/agents','PUT',agentInput());
  const hook=app.state().webhook_url;
  const challenge=Buffer.from('{"type":"url_verification","challenge":"verified"}');
  const verification=await fetch(hook,{method:'POST',headers:signed(challenge),body:challenge});
  assert.deepEqual(await verification.json(),{challenge:'verified'});
  const raw=Buffer.from(JSON.stringify(event()));
  assert.equal((await fetch(hook,{method:'POST',body:raw})).status,401);
  for(let i=0;i<2;i++){const response=await fetch(hook,{method:'POST',headers:signed(raw),body:raw});assert.equal(response.status,200);}
  await eventually(()=>app.state().deliveries[0].status==='done');assert.equal(slack.posts.length,1);
  const state=(await api('/api/state')).data;assert.equal(state.agents[0].session_id,'persistent-session');
});
test('any remote harness can accept a wake-up and complete it asynchronously',async t=>{
  let received,auth;
  const harness=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;received=JSON.parse(raw);auth=req.headers.authorization;res.writeHead(202);res.end();});
  await new Promise(resolve=>harness.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>harness.close(resolve)));
  const {app,api,slack}=await appFixture(t);
  await api('/api/agents','PUT',agentInput({session_id:'existing-cloud-thread',adapter:{type:'webhook',url:`http://127.0.0.1:${harness.address().port}`,token:'harness-token'}}));
  const raw=Buffer.from(JSON.stringify(event()));await fetch(app.state().webhook_url,{method:'POST',headers:signed(raw),body:raw});
  await eventually(()=>app.state().deliveries[0]?.status==='waiting');
  assert.equal(auth,'Bearer harness-token');assert.equal(received.agent.session_id,'existing-cloud-thread');assert.equal(received.type,'slack.message');
  const complete=(token=received.callback.token)=>fetch(received.callback.url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{"reply":"Sent by my existing harness session."}'});
  assert.equal((await complete('wrong-token')).status,401);
  assert.equal((await complete()).status,200);await eventually(()=>slack.posts.length===1);
  assert.equal((await complete()).status,400);assert.equal(slack.posts[0].text,'Sent by my existing harness session.');
});
test('async session creation can return only a session ID and future wakes target it',async t=>{
  let envelope;
  const {app,api}=await appFixture(t,{dispatchRun:async(_a,e)=>{envelope=e;return{pending:true};}});
  const saved=await api('/api/agents','PUT',agentInput());
  const start=await api(`/api/agents/${saved.data.id}/session`,'POST',{});assert.equal(start.response.status,202);
  await eventually(()=>app.state().deliveries[0]?.status==='waiting');
  const result=await fetch(envelope.callback.url,{method:'POST',headers:{Authorization:`Bearer ${envelope.callback.token}`},body:'{"session_id":"new-cloud-thread"}'});
  assert.equal(result.status,200);assert.equal(app.state().agents[0].session_id,'new-cloud-thread');
});
test('edits invalidate old callbacks and a second receiver cannot consume the same profile',async t=>{
  let envelope;
  const {app,api,directory}=await appFixture(t,{dispatchRun:async(_a,e)=>{envelope=e;return{pending:true};}});
  const saved=await api('/api/agents','PUT',agentInput());const raw=Buffer.from(JSON.stringify(event()));
  await fetch(app.state().webhook_url,{method:'POST',headers:signed(raw),body:raw});await eventually(()=>app.state().deliveries[0]?.status==='waiting');
  await api('/api/agents','PUT',agentInput({id:saved.data.id,instructions:'Changed'}));
  const result=await fetch(envelope.callback.url,{method:'POST',headers:{Authorization:`Bearer ${envelope.callback.token}`},body:'{"reply":"Stale reply"}'});assert.equal(result.status,400);
  await assert.rejects(startServer({directory,port:0}),/already runs/);
});
test('connection, profile, deduplication and waiting callbacks survive a real receiver restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'slack-agent-restart-'));let app;
  t.after(async()=>{await app?.close();await rm(directory,{recursive:true,force:true});});
  app=await startServer({directory,port:0,slack:new FakeSlack(),dispatchRun:async()=>({pending:true})});
  app.store.set('slack',{token:'xoxp-test-credential',signing_secret:secret,identity:{team_id:'T123',user_id:'U123'}});
  app.store.saveAgent(agentInput({session_id:'kept-thread'}));app.store.ingest(event());app.engine.tick();
  await eventually(()=>app.state().deliveries[0]?.status==='waiting');const before=app.state(),token=app.token;
  await app.close();app=null;
  app=await startServer({directory,port:0,slack:new FakeSlack(),dispatchRun:async()=>{throw new Error('A waiting event must not be dispatched again.');}});
  assert.equal(app.token,token);assert.equal(app.state().agents[0].session_id,'kept-thread');
  assert.equal(app.state().deliveries[0].id,before.deliveries[0].id);assert.equal(app.state().deliveries[0].status,'waiting');
  assert.equal(app.store.ingest(event()),0);
});
