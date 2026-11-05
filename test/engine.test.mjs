import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { fixture, agentInput, event, FakeSlack, eventually } from './helpers.mjs';

test('durable message identity deduplicates retries and overlapping mention events', async t => {
  const {store} = await fixture(t); store.saveAgent(agentInput());
  assert.equal(store.ingest(event()),1);
  assert.equal(store.ingest(event({}, {event_id:'Ev456'})),0);
  assert.equal(store.ingest(event({type:'app_mention',channel_type:undefined})),0);
  store.recover(); assert.equal(store.history().length,1);
});
test('queued work uses the persistent session, channel instructions and connected Slack identity', async t => {
  const {store} = await fixture(t), slack = new FakeSlack(), seen = [];
  const id = store.saveAgent(agentInput({rules:[{scope:'all_channels',mode:'all',instructions:'Only answer engineering questions.'}]}));
  const engine = new Engine(store,slack,{dispatchRun:async (_adapter,envelope) => { seen.push(envelope); return {reply:'On it.',session_id:'persistent-123'}; },callbackBase:()=> 'https://connector.example'});
  t.after(()=>engine.stop()); store.ingest(event()); engine.tick();
  await eventually(()=>store.history()[0].status==='done');
  assert.equal(slack.posts[0].token,'xoxp-test-credential');
  assert.equal(slack.posts[0].event.thread_ts,'1000000000.000001');
  assert.match(seen[0].instructions,/Only answer engineering questions/);
  assert.equal(store.agent(id).session_id,'persistent-123');
  store.ingest(event({ts:'1000000000.000002',thread_ts:'1000000000.000001',text:'More context'})); engine.tick();
  await eventually(()=>slack.posts.length===2);
  assert.equal(seen[1].agent.session_id,'persistent-123');
});
test('a harness can create a session and retain its ID before the first Slack message', async t => {
  const {store} = await fixture(t), slack = new FakeSlack(), seen = [];
  const id = store.saveAgent(agentInput());
  const engine = new Engine(store,slack,{dispatchRun:async (_a,e) => { seen.push(e); return {session_id:'cloud-session',reply:null}; }});
  t.after(()=>engine.stop()); const delivery = store.startSession(id); engine.tick();
  await eventually(()=>store.job(delivery).status==='done');
  assert.equal(seen[0].type,'session.create'); assert.equal(seen[0].slack,null);
  assert.equal(store.agent(id).session_id,'cloud-session'); assert.equal(slack.posts.length,0);
});
test('profiles targeting the same session are serialized while unrelated sessions can run', async t => {
  const {store} = await fixture(t), slack = new FakeSlack(), calls = [], finish = [];
  store.saveAgent(agentInput({session_id:'shared'}));
  store.saveAgent(agentInput({name:'Same session',session_id:'shared'}));
  store.saveAgent(agentInput({name:'Another session',session_id:'other'}));
  const engine = new Engine(store,slack,{dispatchRun:async (_a,e) => { calls.push(e.agent.name); return new Promise(resolve=>finish.push(()=>resolve({reply:null}))); }});
  t.after(async()=>{finish.forEach(f=>f());await engine.stop();}); store.ingest(event()); engine.tick();
  await eventually(()=>calls.length===2);
  assert.deepEqual(calls,['Sandor','Another session']);
  finish[0](); finish[1](); await eventually(()=>calls.length===3);
  assert.equal(calls[2],'Same session'); finish[2]();
});
test('pause and edits cancel in-flight events before they can produce a reply', async t => {
  const {store} = await fixture(t), slack = new FakeSlack();
  const id = store.saveAgent(agentInput()); let finish;
  const engine = new Engine(store,slack,{dispatchRun:async()=>new Promise(resolve=>{finish=resolve;})});
  t.after(()=>engine.stop()); store.ingest(event()); engine.tick(); await eventually(()=>finish);
  store.pause(true); finish({reply:'Must not send'}); await eventually(()=>engine.active.size===0);
  assert.equal(slack.posts.length,0); assert.equal(store.history()[0].status,'cancelled');
  store.pause(false); store.ingest(event({ts:'1000000000.000002'}));
  store.saveAgent({...agentInput(),id,instructions:'Updated behavior'});
  assert.equal(store.history().filter(j=>j.status==='cancelled').length,2);
});
test('a restart resumes a saved reply without another model run and flags interrupted sends', async t => {
  const {store} = await fixture(t), slack = new FakeSlack(); store.saveAgent(agentInput()); store.ingest(event());
  const id=store.history()[0].id; store.updateJob(id,{status:'reply_ready',reply:'Already generated.'});
  const engine=new Engine(store,slack,{dispatchRun:async()=>{throw new Error('Model must not run twice.');}});
  t.after(()=>engine.stop()); store.recover(); engine.tick(); await eventually(()=>store.job(id).status==='done');
  assert.equal(slack.posts[0].text,'Already generated.');
  store.ingest(event({ts:'1000000000.000002'})); const second=store.history()[0].id;
  store.updateJob(second,{status:'sending',reply:'Possibly sent'});store.recover();
  assert.equal(store.job(second).status,'uncertain'); engine.tick(); assert.equal(slack.posts.length,1);
});
test('rate limits retry only the saved Slack reply and network ambiguity never auto-resends',async t=>{
  const {store}=await fixture(t);store.saveAgent(agentInput());store.ingest(event());let posts=0,runs=0;
  const slack=new FakeSlack();slack.post=async()=>{posts++;if(posts===1)throw Object.assign(new Error('Rate limited'),{retryAfter:1});throw Object.assign(new Error('Connection interrupted'),{uncertain:true});};
  const engine=new Engine(store,slack,{dispatchRun:async()=>{runs++;return{reply:'Reply'};}});t.after(()=>engine.stop());engine.tick();
  const id=store.history()[0].id;await eventually(()=>store.job(id).status==='reply_ready');
  store.updateJob(id,{next_at:0});engine.tick();await eventually(()=>store.job(id).status==='uncertain');
  assert.equal(runs,1);assert.equal(posts,2);
});
test('interrupted local harness work requires an explicit retry instead of repeating tool actions',async t=>{
  const {store}=await fixture(t);
  store.saveAgent(agentInput({adapter:{type:'claude',cwd:'/tmp'}}));store.ingest(event());
  const id=store.history()[0].id;store.updateJob(id,{status:'running'});store.recover();
  assert.equal(store.job(id).status,'failed');assert.match(store.job(id).error,/Check the session/);
});
