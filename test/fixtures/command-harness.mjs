// A deterministic process fixture, not a model or production harness.
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let raw='';for await(const chunk of process.stdin)raw+=chunk;
const event=JSON.parse(raw),id=event.agent.session_id || randomUUID();
const path=join(process.argv[2],encodeURIComponent(id)+'.json');
let memory={calls:0};try{memory=JSON.parse(await readFile(path,'utf8'));}catch{}
memory.calls++;
let reply;
if(event.slack.text.startsWith('remember:')){memory.marker=event.slack.text.slice(9);reply='Remembered.';}
else{
  const tool=await(await fetch(process.argv[3],{signal:AbortSignal.timeout(2000)})).json();
  reply=`${memory.marker}; connector=${tool.value}`;
}
await writeFile(path,JSON.stringify(memory));
process.stdout.write(JSON.stringify({reply,session_id:id}));
