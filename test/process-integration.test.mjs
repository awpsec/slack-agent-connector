import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir,readFile } from 'node:fs/promises';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { fixture,agentInput,event,FakeSlack,eventually } from './helpers.mjs';

test('real process bridge preserves two conversation contexts across worker and receiver restarts and calls an existing service',async t=>{
  const {store,directory}=await fixture(t),slack=new FakeSlack(),memory=join(directory,'worker-memory');await mkdir(memory);
  let serviceCalls=0;
  const service=createServer((_req,res)=>{serviceCalls++;res.setHeader('Content-Type','application/json');res.end('{"value":"existing-tool-result"}');});
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>service.close(resolve)));
  const id=store.saveAgent(agentInput({session_scope:'thread',adapter:{type:'command',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/command-harness.mjs',import.meta.url)),memory,`http://127.0.0.1:${service.address().port}`],cwd:directory},rules:[{scope:'all_channels',mode:'all'}]}));
  let engine=new Engine(store,slack);t.after(()=>engine.stop());
  for(const [i,marker] of ['ALPHA','BETA'].entries()){
    store.ingest(event({ts:`1000000000.00000${i+1}`,text:'remember:'+marker}));engine.tick();await eventually(()=>slack.posts.length===i+1);
  }
  await engine.stop();const reopened=new Store(directory);t.after(()=>reopened.close());engine=new Engine(reopened,slack);engine.start();
  for(let i=0;i<2;i++){
    reopened.ingest(event({ts:`1000000000.00000${i+3}`,thread_ts:`1000000000.00000${i+1}`,text:'recall'}));engine.tick();await eventually(()=>slack.posts.length===i+3);
  }
  assert.equal(slack.posts[2].text,'ALPHA; connector=existing-tool-result');assert.equal(slack.posts[3].text,'BETA; connector=existing-tool-result');assert.equal(serviceCalls,2);
  const bindings=reopened.sessions(id);assert.equal(bindings.length,2);assert.notEqual(bindings[0].session_id,bindings[1].session_id);
  for(const binding of bindings){const state=JSON.parse(await readFile(join(memory,encodeURIComponent(binding.session_id)+'.json'),'utf8'));assert.equal(state.calls,2);}
  assert.equal(reopened.ingest(event({ts:'1000000000.000003',thread_ts:'1000000000.000001',text:'recall'})),0);
});
