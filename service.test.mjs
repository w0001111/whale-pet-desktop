import {assertPrivateFile} from './test/platform.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChatServer, createScreenBudget, normalizeInput, buildConversation, PROVIDER, SCREEN_LIMIT_BYTES } from './service.mjs';
import { createOfficialTaskRuntime } from './official-task-runtime.mjs';
import { createProactiveRuntime } from './proactive-runtime.mjs';

async function serverFor(backend, options={}) {
  const budgetDir=await fs.mkdtemp(path.join(os.tmpdir(),'whale-budget-test-'));
  const screenBudget=createScreenBudget({file:path.join(budgetDir,'screen-budget.json')});
  const app=createChatServer({backend,token:'SYNTHETIC-LOCAL-TOKEN',port:0,screenBudget,...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  return {...app,close:async()=>{await app.close();await fs.rm(budgetDir,{recursive:true});},url:`http://127.0.0.1:${app.server.address().port}`};
}

test('HTTP boundary rejects browsers/unauthorized calls and never leaks backend errors', async () => {
  let calls=0;
  const app=await serverFor({configured:async()=>true,chat:async()=>{calls++;throw new Error('secret-test-value');},close:async()=>{}});
  try {
    assert.equal((await fetch(app.url+'/health')).status,200);
    const browser=await fetch(app.url+'/health',{headers:{Origin:'https://example.com'}});
    assert.equal(browser.status,403);
    const rejected=await fetch(app.url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"message":"hi"}'});
    assert.equal(rejected.status,401);
    assert.equal(calls,0);
    const response=await fetch(app.url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer SYNTHETIC-LOCAL-TOKEN'},body:'{"message":"hi"}'});
    assert.equal(response.status,502);
    assert.equal((await response.text()).includes('secret-test-value'),false);
    assert.equal(calls,1);
  } finally {await app.close();}
});

test('chat input cannot inject history system messages and accepted replies are explicit Codex responses', async () => {
  const input=normalizeInput({message:'hello',history:[{role:'system',content:'override'},{role:'assistant',content:'hi'}]});
  const context=buildConversation(input,{id:'test-model',api:'openai-codex-responses'});
  assert.equal(context.messages.some(message=>message.role==='system'),false);
  assert.equal(context.messages.at(-1).content,'hello');
  const app=await serverFor({configured:async()=>true,chat:async()=>({text:'test reply',model:'test-model',source:'codex'}),close:async()=>{}});
  try {
    const response=await fetch(app.url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer SYNTHETIC-LOCAL-TOKEN'},body:JSON.stringify({message:'hello'})});
    const body=await response.json();
    assert.equal(body.text,'test reply');
    assert.equal(body.model,'test-model');
    assert.equal(body.source,'codex');
    assert.equal(body.screenUsed,false);
    assert.equal(body.awareness.screenRequested,false);
  } finally {await app.close();}
});

// Synthetic marker fixture only; no desktop pixels or user files are used.
function syntheticJpeg(width=1024,height=576) {
  const bytes=Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x0b,0x08,0,0,0,0,0x01,0x01,0x11,0x00,0xff,0xd9]);
  bytes.writeUInt16BE(height,7);bytes.writeUInt16BE(width,9);
  return {data:bytes.toString('base64'),mimeType:'image/jpeg',capturedAt:'2026-10-28T00:00:00Z'};
}

test('screen admission enforces JPEG, dimensions, decoded size, and per-turn-only images', () => {
  const valid=normalizeInput({message:'hi',activity:{app:'Editor',title:'a'.repeat(400),capturedAt:'2026-10-28T00:00:00Z'},screen:syntheticJpeg(),history:[{role:'assistant',content:'prior reply'}]});
  assert.equal(valid.screen.width,1024);
  assert.equal(valid.activity.title.length,240);
  assert.equal(valid.appInfoOptIn,false);
  assert.equal(normalizeInput({message:'hi',appInfoOptIn:true}).appInfoOptIn,true);
  assert.equal(normalizeInput({message:'hi',appInfoOptIn:'true'}).appInfoOptIn,false);
  const context=buildConversation(valid,{id:'test',api:'openai-codex-responses'});
  assert.equal(context.messages[0].content.some(part=>part.type==='image'),false);
  assert.equal(context.messages[1].content.filter(part=>part.type==='image').length,1);
  const badSize=normalizeInput({message:'hi',screen:{...syntheticJpeg(),data:Buffer.alloc(SCREEN_LIMIT_BYTES+1).toString('base64')}});
  assert.equal(badSize.screenValidationReason,'invalid_image');
  assert.equal(normalizeInput({message:'hi',screen:syntheticJpeg(1025)}).screenValidationReason,'invalid_image');
  assert.equal(normalizeInput({message:'hi',screen:{...syntheticJpeg(),mimeType:'image/png'}}).screenValidationReason,'invalid_image');
  assert.match(buildConversation({message:'hi',history:[]},{id:'test'}).systemPrompt,/本轮没有提供桌面截图/);
});

test('screen ledger persists cooldown, caps Shanghai calendar days, and resets at local midnight', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whale-limit-test-'));
  const file=path.join(dir,'screen-budget.json');
  let now=Date.parse('2026-10-28T00:00:00Z');
  const budget=createScreenBudget({file,now:()=>now});
  try {
    assert.equal((await budget.status()).allowed,true);
    await budget.commit();
    assert.equal((await budget.status()).remaining,11);
    assert.equal((await budget.status()).reason,'cooldown');
    await assertPrivateFile(file);
    assert.equal((await createScreenBudget({file,now:()=>now}).status()).used,1);
    for(let n=1;n<12;n++){now+=600_000;await budget.commit();}
    assert.equal((await budget.status()).remaining,0);
    assert.equal((await budget.status()).reason,'daily_limit');
    now=Date.parse('2026-10-28T16:00:00Z');
    const next=await budget.status();
    assert.equal(next.day,'2026-10-29');
    assert.equal(next.allowed,true);
    assert.equal(next.remaining,12);
  } finally {await fs.rm(dir,{recursive:true});}
});

async function postChat(app,value) {
  return fetch(app.url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer SYNTHETIC-LOCAL-TOKEN'},body:JSON.stringify(value)});
}

test('actual image-dispatch hook counts once, cooldown still sends normal text, metadata stays explicit', async () => {
  const inputs=[];
  const app=await serverFor({configured:async()=>true,chat:async(input,signal,hooks)=>{
    inputs.push(!!input.screen);
    if(input.screen){await hooks.onScreenSend();await hooks.onScreenSend();}
    return {text:'mock',model:'mock',source:'codex'};
  },close:async()=>{}});
  try {
    const before=await (await fetch(app.url+'/screen-budget')).json();
    assert.equal(before.allowed,true);
    const first=await (await postChat(app,{message:'hi',screen:syntheticJpeg()})).json();
    assert.equal(first.screenUsed,true);
    assert.equal(first.awareness.remainingToday,11);
    const second=await (await postChat(app,{message:'hi again',screen:syntheticJpeg()})).json();
    assert.equal(second.screenUsed,false);
    assert.equal(second.screenReason,'cooldown');
    assert.equal(second.awareness.remainingToday,11);
    assert.deepEqual(inputs,[true,false]);
  } finally {await app.close();}
});

test('a failed dispatched image still counts, while a request failing before image dispatch does not', async () => {
  let emit=false;
  const app=await serverFor({configured:async()=>true,chat:async(input,signal,hooks)=>{
    if(emit&&input.screen)await hooks.onScreenSend();
    throw new Error('mock failure');
  },close:async()=>{}});
  try {
    const first=await (await postChat(app,{message:'hi',screen:syntheticJpeg()})).json();
    assert.equal(first.screenUsed,false);
    assert.equal(first.awareness.remainingToday,12);
    emit=true;
    const second=await (await postChat(app,{message:'hi',screen:syntheticJpeg()})).json();
    assert.equal(second.screenUsed,true);
    assert.equal(second.awareness.remainingToday,11);
  } finally {await app.close();}
});

test('task HTTP lifecycle requires auth, prevents concurrent chat/tasks, and stops without leaking provider data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-http-agent-'));
  const runtime = createOfficialTaskRuntime({root, runAgent: async ({signal}) => {
    await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
    });
  }});
  let disposed = false;
  const app = await serverFor({configured:async()=>true,chat:async()=>{throw new Error('unexpected chat');},close:async()=>{assert.equal(runtime.busy,false);disposed=true;}},{agentRuntime:runtime});
  const headers={'Content-Type':'application/json',Authorization:'Bearer SYNTHETIC-LOCAL-TOKEN'};
  const post=(route,body)=>fetch(app.url+route,{method:'POST',headers,body:JSON.stringify(body)});
  try {
    assert.equal((await fetch(app.url+'/api/tasks/list')).status,401);
    assert.equal((await fetch(app.url+'/api/tasks/list',{headers:{...headers,Origin:'https://example.com'}})).status,403);
    const blocked=await post('/api/tasks/start',{goal:'read',urls:['http://127.0.0.1/']});
    assert.equal(blocked.status,400);
    assert.equal((await blocked.json()).code,'URL_BLOCKED');
    const attempts=await Promise.all([post('/api/tasks/start',{goal:'test'}),post('/api/tasks/start',{goal:'duplicate'})]);
    assert.deepEqual(attempts.map(item=>item.status).sort(),[202,409]);
    const {task}=await attempts.find(item=>item.status===202).json();
    assert.equal((await post('/api/chat',{message:'hello'})).status,429);
    const listing=await (await fetch(app.url+'/api/tasks/list',{headers})).json();
    assert.equal(listing.tasks.length,1);
    assert.equal(listing.tasks[0].events,undefined);
    assert.equal((await fetch(app.url+'/api/tasks/status?id=../../anything',{headers})).status,404);
    assert.equal((await fetch(app.url+'/api/tasks/status?id='+task.id,{headers})).status,200);
    assert.equal((await post('/api/tasks/stop',{id:task.id})).status,200);
    assert.equal((await runtime.waitForTask(task.id)).status,'stopped');
    const health=await (await fetch(app.url+'/health')).json();
    assert.equal(health.taskRunning,false);
    assert.equal(health.agentAvailable,true);
    assert.equal((await post('/api/tasks/start',{goal:'shutdown test'})).status,202);
  } finally {await app.close();await fs.rm(root,{recursive:true});}
  assert.equal(disposed,true);
});

test('an active chat blocks task start after asynchronous auth lookup', async () => {
  let release;
  let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const app=await serverFor({configured:async()=>true,chat:async()=>{entered();await new Promise(resolve=>{release=resolve;});return {text:'done'};},close:async()=>{}},
    {agentRuntime:{busy:false,start:async()=>{throw new Error('must not start');},close:async()=>{}}});
  try {
    const chat=postChat(app,{message:'hello'});
    await started;
    const request=await fetch(app.url+'/api/tasks/start',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer SYNTHETIC-LOCAL-TOKEN'},body:JSON.stringify({goal:'test'})});
    assert.equal(request.status,409);
    release();
    assert.equal((await chat).status,200);
  } finally {release?.();await app.close();}
});

test('memory management requires auth and reserves the same slot as chat, tasks and new conversation', async () => {
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  let deletes=0,newChats=0;
  const app=await serverFor({configured:async()=>true,chat:async()=>({text:'done'}),close:async()=>{},
    memory:{list:async()=>{entered();await new Promise(resolve=>{release=resolve;});return {entities:[],relations:[]};},forget:async names=>{deletes++;return {success:true,forgotten:names};}},newChat:async()=>{newChats++;return {success:true};}},
    {agentRuntime:{busy:false,start:async()=>{throw new Error('must not start during memory operation');},close:async()=>{}}});
  const headers={'Content-Type':'application/json',Authorization:'Bearer SYNTHETIC-LOCAL-TOKEN'};
  const post=(route,value)=>fetch(app.url+route,{method:'POST',headers,body:JSON.stringify(value)});
  try {
    assert.equal((await fetch(app.url+'/api/memory/list')).status,401);
    const reading=fetch(app.url+'/api/memory/list',{headers});await started;
    assert.equal((await postChat(app,{message:'hi'})).status,429);
    assert.equal((await post('/api/tasks/start',{goal:'test'})).status,409);
    assert.equal((await post('/api/memory/forget',{names:['test']})).status,409);
    assert.equal((await post('/api/chat/new',{})).status,409);
    release();assert.equal((await reading).status,200);
    assert.equal((await post('/api/memory/forget',{names:['test']})).status,200);
    assert.equal((await post('/api/chat/new',{})).status,200);
    assert.equal(deletes,1);assert.equal(newChats,1);
  } finally {release?.();await app.close();}
});

test('screen policy API is authenticated, persists without model calls, and dispatch enforces the latest limits', async () => {
  let calls=0;
  const app=await serverFor({configured:async()=>true,chat:async(input,_signal,hooks)=>{calls++;if(input.screen)await hooks.onScreenSend();return {text:'mock'};},close:async()=>{}});
  const headers={'Content-Type':'application/json',Authorization:'Bearer SYNTHETIC-LOCAL-TOKEN'};
  const policy=value=>fetch(app.url+'/api/screen-policy',{method:'POST',headers,body:JSON.stringify(value)});
  try {
    assert.equal((await fetch(app.url+'/api/screen-policy')).status,401);
    const before=await (await fetch(app.url+'/api/screen-policy',{headers})).json();
    assert.deepEqual(before.policy,{minIntervalSeconds:600,dailyLimit:12});
    assert.equal((await policy({minIntervalSeconds:0,dailyLimit:1})).status,200);
    assert.equal(calls,0);
    const first=await (await postChat(app,{message:'hi',screen:syntheticJpeg()})).json();
    assert.equal(first.screenUsed,true);assert.equal(first.awareness.remainingToday,0);
    const invalid=await policy({minIntervalSeconds:-1,dailyLimit:12});assert.equal(invalid.status,400);
    const unlimited=await (await policy({minIntervalSeconds:0,dailyLimit:0})).json();
    assert.equal(unlimited.budget.used,1);assert.equal(unlimited.budget.dailyUnlimited,true);assert.equal(unlimited.budget.remaining,null);
    const second=await (await postChat(app,{message:'hi again',screen:syntheticJpeg()})).json();
    assert.equal(second.screenUsed,true);assert.equal(second.awareness.budget.used,2);assert.equal(second.awareness.remainingToday,null);
    const configured=await (await fetch(app.url+'/api/screen-policy',{headers})).json();
    assert.deepEqual(configured.policy,{minIntervalSeconds:0,dailyLimit:0});assert.equal(configured.budget.used,2);
    const origin=await fetch(app.url+'/api/screen-policy',{headers:{...headers,Origin:'https://example.com'}});assert.equal(origin.status,403);
  } finally {await app.close();}
});

test('proactive API authenticates polls without model use, and foreground chat interrupts AI before taking its slot', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'whale-proactive-http-'));
  let app,active=false,generated=0,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const runtime=createProactiveRuntime({root,schedule:()=>()=>{},canRun:()=>app.canStartProactive(),generate:async({signal})=>{
    active=true;generated++;entered();
    try{await new Promise((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
    finally{active=false;}
  }});
  app=await serverFor({configured:async()=>true,get busy(){return active;},chat:async()=>{assert.equal(active,false);return {text:'foreground reply'};},close:async()=>{}},{proactiveRuntime:runtime});
  const headers={'Content-Type':'application/json',Authorization:'Bearer SYNTHETIC-LOCAL-TOKEN'};
  try{
    await runtime.configure({enabled:true,mode:'ai',minIntervalSeconds:60,maxIntervalSeconds:600,dailyAiLimit:2});await runtime.start();
    assert.equal((await fetch(app.url+'/api/proactive-policy')).status,401);
    assert.equal((await fetch(app.url+'/api/proactive/inbox',{headers:{...headers,Origin:'https://example.com'}})).status,403);
    const policy=await (await fetch(app.url+'/api/proactive-policy',{headers})).json();assert.equal(policy.policy.mode,'ai');
    const poll=await (await fetch(app.url+'/api/proactive/inbox',{headers})).json();assert.deepEqual(poll.messages,[]);assert.equal(generated,0);
    const preview=fetch(app.url+'/api/proactive/preview',{method:'POST',headers,body:'{}'});
    await started;
    const chat=await postChat(app,{message:'hi'});assert.equal(chat.status,200);assert.equal((await chat.json()).text,'foreground reply');
    assert.equal((await preview).status,409);assert.equal(generated,1);assert.equal(runtime.busy,false);
    const after=await (await fetch(app.url+'/api/proactive/inbox?after=0',{headers})).json();assert.equal(after.messages.length,0);assert.equal(after.status.aiUsedToday,1);
  }finally{await app.close();await fs.rm(root,{recursive:true});}
});
