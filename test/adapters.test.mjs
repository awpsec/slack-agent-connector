import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, runProcess } from '../src/adapters.mjs';
import { tmpdir } from 'node:os';

const envelope = { version:'1',type:'slack.message',delivery_id:'d123',agent:{name:'Sandor',session_id:'session-123'},instructions:'Help the team.',slack:{text:'$(touch /tmp/should-not-exist)'},context:[] };
test('any executable can receive JSON on stdin without shell interpretation',async()=>{
  const script='let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{const e=JSON.parse(raw);process.stdout.write(JSON.stringify({reply:e.slack.text,session_id:e.agent.session_id}));});';
  const result=await dispatch({type:'command',command:process.execPath,args:['-e',script],cwd:tmpdir()},envelope);
  assert.deepEqual(result,{reply:'$(touch /tmp/should-not-exist)',session_id:'session-123'});
});
test('generic webhook dispatch carries authentication, idempotency and async completion',async()=>{
  let observed;
  const result=await dispatch({type:'webhook',url:'https://harness.example',token:'private-test-token'},envelope,{fetcher:async(url,options)=>{observed={url,options};return new Response('',{status:202});}});
  assert.deepEqual(result,{pending:true});assert.equal(observed.options.headers['Idempotency-Key'],'d123');
  assert.equal(observed.options.headers.Authorization,'Bearer private-test-token');
  assert.equal(JSON.parse(observed.options.body).agent.session_id,'session-123');
});
test('Claude and Codex resume explicit sessions and keep harness connector configuration',async()=>{
  const calls=[];
  const processRunner=async(command,args,input)=>{calls.push({command,args,input});return command==='claude'?JSON.stringify({session_id:'session-123',structured_output:{reply:'Claude reply'}}):[
    JSON.stringify({type:'thread.started',thread_id:'session-123'}),JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"reply":"Codex reply"}'}})].join('\n');};
  assert.equal((await dispatch({type:'claude',cwd:tmpdir()},envelope,{processRunner})).reply,'Claude reply');
  assert.equal((await dispatch({type:'codex',cwd:tmpdir()},envelope,{processRunner})).reply,'Codex reply');
  assert.ok(calls[0].args.includes('--resume'));assert.ok(calls[1].args.includes('resume'));
  for(const call of calls){assert.equal(call.args.includes('--strict-mcp-config'),false);assert.equal(call.args.some(a=>a.includes('dangerously')),false);assert.match(call.input,/tools and connectors already authorized/);}
});
test('harness output cannot accidentally become a Slack post without a valid reply contract',async()=>{
  await assert.rejects(dispatch({type:'webhook',url:'https://harness.example'},envelope,{fetcher:async()=>new Response('internal diagnostic log')}),/must return/);
  await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],'',tmpdir(),undefined,30),/timed out/);
});
test('streamed command output preserves UTF-8 characters split across chunks',async()=>{
  const script='const b=Buffer.from(JSON.stringify({reply:"Ready 🐺"}));const i=b.indexOf(0xf0)+1;process.stdout.write(b.subarray(0,i));setTimeout(()=>process.stdout.write(b.subarray(i)),20);';
  const result=await dispatch({type:'command',command:process.execPath,args:['-e',script],cwd:tmpdir()},envelope);
  assert.equal(result.reply,'Ready 🐺');
});
test('pi and omp resume dedicated sessions using their native JSON event stream',async()=>{
  for(const harness of ['pi','omp']){
    let observed;
    const result=await dispatch({type:harness,cwd:tmpdir()},envelope,{processRunner:async(command,args,input)=>{
      observed={command,args,input};return[
        JSON.stringify({type:'session',id:'native-session'}),
        JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'thinking',thinking:'private reasoning'},{type:'text',text:'{"reply":"Native harness reply"}'}],stopReason:'stop'}})
      ].join('\n');
    }});
    assert.equal(result.session_id,'native-session');assert.equal(result.reply,'Native harness reply');
    assert.equal(observed.command,harness);assert.deepEqual(observed.args,['--print','--mode','json','--session','session-123']);
    assert.equal(observed.args.includes('--no-extensions'),false);
  }
});
