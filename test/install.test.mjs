import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectHarness, installConnector, installPlan } from '../src/install.mjs';
import { startServer } from '../src/server.mjs';
import { FakeSlack } from './helpers.mjs';

async function directoryFixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'slack-install-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, directory: join(base, 'profile with spaces') };
}
test('installer selects the current harness without configuring unrelated clients', () => {
  assert.equal(detectHarness({ available: ['pi'], env: {} }), 'pi');
  assert.equal(detectHarness({ available: ['claude','codex'], env: { CLAUDECODE: '1' } }), 'claude');
  assert.equal(detectHarness({ requested: 'omp', available: ['pi','omp'] }), 'omp');
  assert.throws(() => detectHarness({ available: ['pi','omp'], env: {} }), /Multiple harnesses/);
  assert.throws(() => detectHarness({ available: [], env: {} }), /No supported harness/);
});
test('install plans preserve executable argument boundaries and declare all client routes', () => {
  const base = { directory: '/some path/data', node: '/node path/node', packagePath: '/checkout path/source' };
  for (const harness of ['claude','codex']) {
    const plan = installPlan({ harness, ...base });
    assert.ok(plan.registration.args.includes('/node path/node'));
    assert.ok(plan.registration.args.includes('/checkout path/source/bin/slack-agent.mjs'));
    assert.equal(plan.registration.args.at(-1), '/some path/data');
  }
  for (const harness of ['pi','omp']) assert.deepEqual(installPlan({harness,...base}).registration, { command:harness,args:['install','/some path/data/extension-package'] });
  assert.equal(installPlan({harness:'mcp',...base}).registration,null);
});
test('dry-run does not write settings, start daemons, or invoke client commands', async t => {
  const {directory}=await directoryFixture(t);let invoked=false;
  const result=await installConnector({harness:'codex',directory,dryRun:true,run:async()=>{invoked=true;}});
  assert.equal(result.dry_run,true);assert.equal(invoked,false);await assert.rejects(stat(directory),{code:'ENOENT'});
});
test('Codex registration is idempotent and an unrelated MCP server is preserved',async t=>{
  const {directory}=await directoryFixture(t),calls=[];let installed=false;
  const run=async(command,args)=>{
    calls.push({command,args});
    if(args[1]==='get')return{code:installed?0:1,stdout:installed?JSON.stringify(installPlan({harness:'codex',directory}).mcp_config):''};
    installed=true;return{code:0,stdout:''};
  };
  await installConnector({harness:'codex',directory,start:false,run});
  await installConnector({harness:'codex',directory,start:false,run});
  assert.equal(calls.filter(c=>c.args[1]==='add').length,1);
  const runtime=JSON.parse(await readFile(join(directory,'runtime.json'),'utf8'));assert.equal(runtime.node,process.execPath);
  await assert.rejects(installConnector({harness:'codex',directory,start:false,run:async()=>({code:0,stdout:'some other Slack server'})}),/not been overwritten/);
});
test('Claude registers at user scope and does not edit the project MCP configuration',async t=>{
  const {directory}=await directoryFixture(t),calls=[];
  await installConnector({harness:'claude',directory,start:false,run:async(command,args)=>{calls.push({command,args});return{code:args[1]==='get'?1:0,stdout:''};}});
  assert.deepEqual(calls[1].args.slice(0,6),['mcp','add','--scope','user','--transport','stdio']);
});
test('pi and omp receive a per-profile extension package with a verified Node runtime',async t=>{
  const {base}=await directoryFixture(t);
  for(const harness of ['pi','omp']){
    const directory=join(base,harness),calls=[];
    await installConnector({harness,directory,profile:'sandor',start:false,run:async(command,args)=>{calls.push({command,args});return{code:0,stdout:''};}});
    const manifest=JSON.parse(await readFile(join(directory,'extension-package','package.json'),'utf8'));
    assert.deepEqual(manifest.pi.extensions,['./pi.js']);assert.deepEqual(manifest.omp.extensions,['./omp.js']);
    const wrapper=await readFile(join(directory,'extension-package',`${harness}.js`),'utf8');
    assert.ok(wrapper.includes(JSON.stringify(directory)));assert.equal(calls[0].command,harness);
  }
});
test('one installer invocation starts real private setup and creates a disabled starter profile',async t=>{
  const {directory}=await directoryFixture(t);
  const app=await startServer({directory,port:0,slack:new FakeSlack()});
  t.after(()=>app.close());
  const result=await installConnector({harness:'codex',directory,run:async(_command,args)=>({code:args[1]==='get'?1:0,stdout:''})});
  assert.equal(result.setup_started,true);assert.match(result.setup.settings_url,/#ticket=/);
  assert.equal(app.state().agents.length,1);assert.equal(app.state().agents[0].enabled,false);assert.equal(app.state().agents[0].adapter.type,'codex');
  const receipt=await readFile(join(directory,'installation.json'),'utf8');assert.equal(receipt.includes('#ticket='),false);assert.equal(receipt.includes(app.token),false);
});
