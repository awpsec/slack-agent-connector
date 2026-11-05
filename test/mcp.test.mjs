import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../src/server.mjs';
import { agentInput, FakeSlack } from './helpers.mjs';

test('an actual MCP client can discover, configure and pause the standalone connector',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'slack-agent-mcp-'));
  const app=await startServer({directory,port:0,slack:new FakeSlack()});
  const client=new Client({name:'test-harness',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../bin/slack-agent.mjs',import.meta.url)),'mcp','--data',directory,'--no-autostart'],stderr:'pipe'});
  t.after(async()=>{await client.close();await app.close();await rm(directory,{recursive:true,force:true});});
  await client.connect(transport);
  const listing=await client.listTools();assert.ok(listing.tools.some(t=>t.name==='slack_session_start'));
  const setup=await client.callTool({name:'slack_setup',arguments:{}});assert.match(JSON.parse(setup.content[0].text).webhook_url,/slack\/events/);
  const saved=await client.callTool({name:'slack_assignment_save',arguments:agentInput()});assert.equal(saved.isError,undefined);
  const state=JSON.parse(saved.content[0].text);assert.equal(state.agents[0].name,'Sandor');
  const paused=await client.callTool({name:'slack_pause',arguments:{paused:true}});assert.equal(JSON.parse(paused.content[0].text).paused,true);
  const unknown=await client.callTool({name:'unknown',arguments:{}});assert.equal(unknown.isError,true);
});
