import test from 'node:test';
import assert from 'node:assert/strict';
import { Slack } from '../src/slack.mjs';

test('Slack read APIs receive pagination and thread parameters using supported form encoding',async()=>{
  const requests=[];
  const slack=new Slack(async(url,options)=>{
    requests.push({url,options,fields:new URLSearchParams(options.body)});
    return Response.json({ok:true,channels:[{id:'C123',name:'engineering',is_member:true}],response_metadata:{next_cursor:'next-page'},messages:[{user:'U456',text:'Thread parent',ts:'100.000001'}]});
  });
  const channels=await slack.channels('test-token','cursor+with/special=characters');
  assert.equal(requests[0].fields.get('cursor'),'cursor+with/special=characters');
  assert.match(requests[0].options.headers['Content-Type'],/^application\/x-www-form-urlencoded/);
  assert.equal(channels.next_cursor,'next-page');
  await slack.context('test-token',{is_reply:true,channel_id:'C123',thread_ts:'100.000001'});
  assert.equal(requests[1].fields.get('channel'),'C123');assert.equal(requests[1].fields.get('ts'),'100.000001');
  await slack.post('test-token',{channel_id:'C123',thread_ts:'100.000001'},'Ready 🐺 & waiting.','delivery-id');
  assert.equal(requests[2].fields.get('text'),'Ready 🐺 & waiting.');assert.equal(requests[2].fields.get('client_msg_id'),'delivery-id');
});
