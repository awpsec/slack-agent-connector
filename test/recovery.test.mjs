import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { agentInput,event,identity,secret,FakeSlack,fixture,eventually } from './helpers.mjs';

test('v0.1 databases migrate credentials, session IDs and verified per-profile thread participation',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'slack-legacy-'));let store;
  t.after(async()=>{store?.close();await rm(directory,{recursive:true,force:true});});
  const db=new DatabaseSync(join(directory,'connector.sqlite'));
  db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE agents(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,revision TEXT NOT NULL,message_key TEXT NOT NULL,event TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,reply TEXT,error TEXT NOT NULL DEFAULT '',callback_token TEXT NOT NULL,UNIQUE(agent_id,message_key));
    CREATE TABLE threads(channel_id TEXT NOT NULL,thread_ts TEXT NOT NULL,PRIMARY KEY(channel_id,thread_ts));`);
  db.prepare('INSERT INTO settings VALUES(?,?)').run('slack',JSON.stringify({identity,token:'legacy-test-token',signing_secret:secret}));
  const agent={...agentInput({session_id:'legacy-session'}),id:'legacy-agent',revision:'old-revision'};
  db.prepare('INSERT INTO agents VALUES(?,?)').run(agent.id,JSON.stringify(agent));
  const e={channel_id:'C123',thread_ts:'100.000001'};
  db.prepare('INSERT INTO jobs(id,agent_id,revision,message_key,event,status,created,updated,reply,callback_token) VALUES(?,?,?,?,?,?,?,?,?,?)').run('old-job',agent.id,agent.revision,'old-message',JSON.stringify(e),'done',1,1,'Posted reply','test-callback');
  db.prepare('INSERT INTO threads VALUES(?,?)').run('C123','100.000001');db.close();
  store=new Store(directory);
  assert.equal(store.get('slack').token,'legacy-test-token');assert.equal(store.agent(agent.id).session_id,'legacy-session');
  assert.equal(store.db.prepare('SELECT agent_id FROM threads').get().agent_id,agent.id);
  assert.equal(store.job('old-job').session_key,'profile');assert.equal(store.job('old-job').status,'done');
});

test('separate account receivers keep credentials, session bindings and replies isolated',async t=>{
  const {store:a}=await fixture(t),{store:b}=await fixture(t);
  b.changeConnection({identity:{...identity,team_id:'T999',user_id:'U999'},token:'account-B-token',signing_secret:secret});
  a.saveAgent(agentInput({session_id:'session-A'}));b.saveAgent(agentInput({session_id:'session-B'}));
  const outA=new FakeSlack(),outB=new FakeSlack(),seen=[];
  const dispatchRun=async(_adapter,e)=>{seen.push({team:e.identity.team_id,session:e.agent.session_id});return{reply:e.agent.session_id};};
  const ea=new Engine(a,outA,{dispatchRun}),eb=new Engine(b,outB,{dispatchRun});t.after(async()=>{await ea.stop();await eb.stop();});
  a.ingest(event());b.ingest(event({text:'<@U999> Help?'}, {team_id:'T999',authorizations:[{team_id:'T999',user_id:'U999'}]}));ea.tick();eb.tick();
  await eventually(()=>outA.posts.length===1&&outB.posts.length===1);
  assert.equal(outA.posts[0].token,'xoxp-test-credential');assert.equal(outB.posts[0].token,'account-B-token');
  assert.equal(outA.posts[0].text,'session-A');assert.equal(outB.posts[0].text,'session-B');assert.deepEqual(seen.map(s=>s.team).sort(),['T123','T999']);
});

test('native session locks apply across working directories and selected configuration arguments',async t=>{
  const {store}=await fixture(t);
  const a=store.saveAgent(agentInput({session_id:'shared-global-id',adapter:{type:'codex',cwd:'/project-a',args:['--profile','one']}}));
  const b=store.saveAgent(agentInput({session_id:'shared-global-id',adapter:{type:'codex',cwd:'/project-b',args:['--profile','two']}}));
  assert.equal(store.sessionKey(store.agent(a)),store.sessionKey(store.agent(b)));
});

test('blocked deliveries remain actionable after more than sixty newer deliveries',async t=>{
  const {store}=await fixture(t);store.saveAgent(agentInput());const blocked=[];
  for(let i=0;i<78;i++){
    store.ingest(event({ts:`1000000000.${String(i+1).padStart(6,'0')}`}));
    const job=store.unfinished().at(-1),status=['failed','send_failed','uncertain'][i] || 'done';
    store.updateJob(job.id,{status});if(i<3)blocked.push(job.id);
  }
  const visible=store.history();
  for(const id of blocked)assert.ok(visible.some(job=>job.id===id),'An older blocked delivery must still be visible.');
  assert.ok(visible.length<=120);
  store.dismiss(blocked[0]);assert.equal(store.history().some(job=>job.id===blocked[0]),false);
});
