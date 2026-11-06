import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { fixture, agentInput, event, FakeSlack, eventually, identity, secret } from './helpers.mjs';

test('thread replies wake only the profile that participated in that thread',async t=>{
  const {store}=await fixture(t);
  const a=store.saveAgent(agentInput({name:'A'})),b=store.saveAgent(agentInput({name:'B'}));
  store.participate(a,'C123','1000000000.000001');
  assert.equal(store.ingest(event({ts:'1000000000.000002',thread_ts:'1000000000.000001',text:'A reply without a mention'})),1);
  assert.equal(store.history()[0].agent_id,a);
  assert.equal(store.history().some(j=>j.agent_id===b),false);
});

test('thread scope keeps context within a thread and isolates other threads',async t=>{
  const {store}=await fixture(t),slack=new FakeSlack(),seen=[];
  const id=store.saveAgent(agentInput({session_scope:'thread',rules:[{scope:'all_channels',mode:'all'}]}));
  let sequence=0;
  const engine=new Engine(store,slack,{dispatchRun:async(_a,e)=>{seen.push(e);return{reply:'Reply',session_id:e.agent.session_id || `session-${++sequence}`};}});
  t.after(()=>engine.stop());
  store.ingest(event());engine.tick();await eventually(()=>slack.posts.length===1);
  store.ingest(event({ts:'1000000000.000002',thread_ts:'1000000000.000001',text:'Follow up'}));engine.tick();await eventually(()=>slack.posts.length===2);
  store.ingest(event({ts:'1000000000.000003',text:'A separate root'}));engine.tick();await eventually(()=>slack.posts.length===3);
  assert.equal(seen[0].agent.session_id,null);assert.equal(seen[1].agent.session_id,'session-1');assert.equal(seen[2].agent.session_id,null);
  assert.deepEqual(store.sessions(id).map(s=>s.session_id).sort(),['session-1','session-2']);assert.equal(store.agent(id).session_id,'');
});

test('channel scope shares a session across threads in one channel but not another channel',async t=>{
  const {store}=await fixture(t),slack=new FakeSlack(),seen=[];
  store.saveAgent(agentInput({session_scope:'channel',rules:[{scope:'all_channels',mode:'all'}]}));
  let count=0;
  const engine=new Engine(store,slack,{dispatchRun:async(_a,e)=>{seen.push(e);return{reply:'Reply',session_id:e.agent.session_id || `channel-${++count}`};}});t.after(()=>engine.stop());
  for(const [index,channel] of ['C123','C123','C456'].entries()){
    store.ingest(event({channel,ts:`1000000000.00000${index+1}`}));engine.tick();await eventually(()=>slack.posts.length===index+1);
  }
  assert.deepEqual(seen.map(e=>e.agent.session_id),[null,'channel-1',null]);
});

test('a delayed retry cannot be overtaken by a later message in the same session',async t=>{
  const {store}=await fixture(t),slack=new FakeSlack(),calls=[];
  store.saveAgent(agentInput({session_id:'persistent'}));
  const engine=new Engine(store,slack,{dispatchRun:async(_a,e)=>{calls.push(e.slack.message_ts);if(calls.length===1)throw new Error('Temporary network failure');return{reply:'Reply'};}});t.after(()=>engine.stop());
  store.ingest(event());engine.tick();await eventually(()=>store.history()[0].status==='queued'&&store.history()[0].attempts===1&&engine.active.size===0);
  store.ingest(event({ts:'1000000000.000002'}));engine.tick();
  assert.equal(calls.length,1);
  const first=store.unfinished()[0];store.updateJob(first.id,{next_at:0});engine.tick();await eventually(()=>slack.posts.length===2);
  assert.deepEqual(calls,['1000000000.000001','1000000000.000001','1000000000.000002']);
});

test('failed work blocks its conversation until retry or dismissal, without blocking other sessions',async t=>{
  const {store}=await fixture(t),slack=new FakeSlack();
  const a=store.saveAgent(agentInput({session_id:'failed-session',rules:[{scope:'channel',channel_id:'C123',mode:'all'}]}));
  store.saveAgent(agentInput({session_id:'other-session',rules:[{scope:'channel',channel_id:'C456',mode:'all'}]}));
  const engine=new Engine(store,slack,{dispatchRun:async()=>({reply:'Reply'})});t.after(()=>engine.stop());
  store.ingest(event());const failed=store.unfinished()[0];store.updateJob(failed.id,{status:'failed',error:'Manual check needed'});
  store.ingest(event({ts:'1000000000.000002'}));store.ingest(event({channel:'C456',ts:'1000000000.000003'}));engine.tick();
  await eventually(()=>slack.posts.length===1);assert.equal(slack.posts[0].event.channel_id,'C456');
  store.dismiss(failed.id);engine.tick();await eventually(()=>slack.posts.length===2);assert.equal(store.agent(a).session_id,'failed-session');
});

test('resuming a session cannot silently replace its context with a different session ID',async t=>{
  const {store}=await fixture(t),slack=new FakeSlack();const id=store.saveAgent(agentInput({session_id:'original'}));
  const engine=new Engine(store,slack,{dispatchRun:async()=>({reply:'Wrong session reply',session_id:'accidental-fork'})});t.after(()=>engine.stop());
  store.ingest(event());engine.tick();await eventually(()=>store.history()[0].status==='failed');
  assert.equal(store.agent(id).session_id,'original');assert.equal(slack.posts.length,0);assert.match(store.history()[0].error,/different session ID/);
});

test('a harness cannot bind two isolated threads to the same returned session',async t=>{
  const {store}=await fixture(t),slack=new FakeSlack();store.saveAgent(agentInput({session_scope:'thread'}));
  const engine=new Engine(store,slack,{dispatchRun:async()=>({reply:'Reply',session_id:'reused-session'})});t.after(()=>engine.stop());
  store.ingest(event());engine.tick();await eventually(()=>slack.posts.length===1);
  store.ingest(event({ts:'1000000000.000002'}));engine.tick();await eventually(()=>store.history()[0].status==='failed');
  assert.equal(slack.posts.length,1);assert.match(store.history()[0].error,/reused a session/);
});

test('switching Slack identities clears context bindings and pauses profiles; refreshing credentials does not',async t=>{
  const {store}=await fixture(t);const id=store.saveAgent(agentInput({session_id:'old-account-session'}));
  store.participate(id,'C123','1000000000.000001');
  store.changeConnection({identity,token:'new-token',signing_secret:secret});
  assert.equal(store.agent(id).session_id,'old-account-session');assert.equal(store.agent(id).enabled,true);
  store.changeConnection(null);
  store.changeConnection({identity:{...identity,user_id:'U999'},token:'another-account',signing_secret:secret});
  assert.equal(store.agent(id).session_id,'');assert.equal(store.agent(id).enabled,false);assert.match(store.get('connection_notice'),/identity changed/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM threads').get().n,0);
});

test('scoped mappings and successful thread participation survive a database reopen',async t=>{
  const {store,directory}=await fixture(t);const id=store.saveAgent(agentInput({session_scope:'thread'}));
  store.bindSession(store.agent(id),'thread:C123:100.000001','stored-session');store.participate(id,'C123','100.000001');
  const reopened=new Store(directory);t.after(()=>reopened.close());
  assert.equal(reopened.targetSession(reopened.agent(id),'thread:C123:100.000001'),'stored-session');
  assert.equal(reopened.db.prepare('SELECT agent_id FROM threads').get().agent_id,id);
});

test('editing channel instructions preserves scoped sessions when harness settings are unchanged',async t=>{
  const {store}=await fixture(t);const input=agentInput({session_scope:'thread',adapter:{type:'codex',cwd:'/tmp'}}),id=store.saveAgent(input);
  store.bindSession(store.agent(id),'thread:C123:100.000001','kept-session');
  store.saveAgent({...input,id,instructions:'New instructions',adapter:{type:'codex',cwd:'/tmp',args:[]}});
  assert.equal(store.sessions(id)[0].session_id,'kept-session');
});
test('saving unchanged settings or refreshing same-identity credentials does not drop pending messages',async t=>{
  const {store}=await fixture(t),input=agentInput(),id=store.saveAgent(input),revision=store.agent(id).revision;
  store.ingest(event());const job=store.unfinished()[0];store.saveAgent({...input,id});
  assert.equal(store.job(job.id).status,'queued');assert.equal(store.agent(id).revision,revision);
  store.changeConnection({identity,token:'refreshed-token',signing_secret:secret});assert.equal(store.job(job.id).status,'queued');
});
test('an older settings snapshot cannot accidentally erase a newly created profile session',async t=>{
  const {store}=await fixture(t),input=agentInput(),id=store.saveAgent(input);
  store.bindSession(store.agent(id),'profile','newly-created-session');
  store.saveAgent({...input,id,instructions:'Updated instructions from an older form'});
  assert.equal(store.agent(id).session_id,'newly-created-session');
  store.saveAgent({...input,id,reset_session:true});assert.equal(store.agent(id).session_id,'');
});
