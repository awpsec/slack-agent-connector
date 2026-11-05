import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import piExtension from '../extensions/pi.js';
import ompExtension from '../extensions/omp.js';
import { registerSlackExtension } from '../src/extension-tools.mjs';

function host(){
  const tools=[],commands=[];
  return {tools,commands,typebox:{Type},registerTool:tool=>tools.push(tool),registerCommand:(name,command)=>commands.push({name,...command})};
}
test('pi and omp package entrypoints register valid native tool schemas and setup commands',()=>{
  for(const extension of [piExtension,ompExtension]){
    const api=host();extension(api);
    assert.ok(api.tools.some(t=>t.name==='slack_setup'));assert.ok(api.tools.some(t=>t.name==='slack_current_session'));assert.equal(api.commands[0].name,'slack-setup');
    for(const tool of api.tools)TypeCompiler.Compile(tool.parameters);
  }
});
test('native extension tools use the same API as MCP and expose the current session without secrets',async()=>{
  const api=host(),calls=[];
  registerSlackExtension(api,Type,{directory:'/test-profile',connect:async directory=>({directory}),call:async(connection,name,args)=>{calls.push({connection,name,args});return{name};}});
  const result=await api.tools.find(t=>t.name==='slack_status').execute('tool',{});
  assert.deepEqual(result.details,{name:'slack_status'});assert.equal(calls[0].connection.directory,'/test-profile');
  const current=await api.tools.find(t=>t.name==='slack_current_session').execute('tool',{},undefined,undefined,{cwd:'/project',sessionManager:{getSessionId:()=> 'session-123',getSessionFile:()=> '/project/session.jsonl'}});
  assert.equal(current.details.session_id,'session-123');assert.equal(current.details.cwd,'/project');
});
