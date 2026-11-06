import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureDaemon} from '../src/mcp.mjs';

async function legacyReceiver(t,deliveries){
  const directory=await mkdtemp(join(tmpdir(),'slack-version-'));let shutdowns=0;
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/state')res.end(JSON.stringify({version:'0.1.0',deliveries}));
    else{shutdowns++;res.writeHead(404);res.end('{"error":"Not found"}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(join(directory,'access.json'),JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token:'fake-owner-token',pid:process.pid}));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  return{directory,shutdowns:()=>shutdowns};
}
test('a stale receiver cannot silently accept tools from a different source version',async t=>{
  const {directory,shutdowns}=await legacyReceiver(t,[]);
  await assert.rejects(ensureDaemon(directory),/differs from installed version/);assert.equal(shutdowns(),0);
});
test('installer upgrades do not interrupt queued or active work',async t=>{
  const {directory,shutdowns}=await legacyReceiver(t,[{status:'waiting'}]);
  await assert.rejects(ensureDaemon(directory,{upgrade:true}),/no active work was interrupted/);assert.equal(shutdowns(),0);
});
test('older receivers without a shutdown endpoint get actionable restart instructions',async t=>{
  const {directory,shutdowns}=await legacyReceiver(t,[]);
  await assert.rejects(ensureDaemon(directory,{upgrade:true}),/terminal or process manager/);assert.equal(shutdowns(),1);
});
