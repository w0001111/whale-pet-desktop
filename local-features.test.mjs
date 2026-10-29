import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createChatServer,measureModelUse} from './service.mjs';
import {createLocalReminders} from './local-reminders.mjs';
import {createUsageBudget} from './usage-budget.mjs';
import {createCompanionSettings} from './companion-settings.mjs';
import {createProactiveRuntime} from './proactive-runtime.mjs';

const usage=n=>({input:n-2,output:2,cacheRead:0,cacheWrite:0,totalTokens:n});
const answer=n=>({text:'合成测试回复',model:'fixture',source:'codex',modelCalls:1,usage:usage(n)});
const headers={'Content-Type':'application/json',Authorization:'Bearer SYNTHETIC-FEATURE-TOKEN'};
async function fixture(t,{chat,configured=true}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'whale-local-feature-'));
  let timestamp=Date.now(),sequence=0;
  const timers=new Map(),calls={model:0,configured:0,commit:0,interact:0,refresh:0};
  const meter=createUsageBudget({root,now:()=>timestamp});
  const reminders=createLocalReminders({root,now:()=>timestamp,schedule(callback,delay){const id=++sequence;timers.set(id,{at:timestamp+delay,callback});return()=>timers.delete(id);}});
  await reminders.start();
  const companion=createCompanionSettings({root});
  const proactive={async settings(){return{enabled:true,mode:'ai',minIntervalSeconds:60,maxIntervalSeconds:600,dailyAiLimit:0};},async status(){return{reason:'ready'};},async interact(){calls.interact++;},async refreshCompanionSettings(){calls.refresh++;},async close(){}};
  const backend={companion,async configured(){calls.configured++;return configured;},async chat(...args){calls.model++;return chat?chat(...args):answer(60);},async close(){}};
  const screenBudget={async status(){return{canSend:true,remaining:36,used:calls.commit,limit:36,minIntervalSeconds:300,nextAllowedAt:null};},async commit(){calls.commit++;}};
  const app=createChatServer({backend,token:'SYNTHETIC-FEATURE-TOKEN',port:0,usageBudget:meter,localReminders:reminders,proactiveRuntime:proactive,screenBudget});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  return{root,meter,reminders,calls,companion,timers,
    setTime(value){timestamp=Number(value);},now:()=>timestamp,
    request(route,body,extra={}){return fetch(url+route,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});},
    async json(route,body){const response=await this.request(route,body);assert.equal(response.status,200,await response.clone().text());return response.json();},
  };
}

test('new tools remain loopback-authenticated and reject browser origins',async t=>{
  const f=await fixture(t);
  for(const route of ['/api/reminders','/api/local-events/inbox','/api/usage']) {
    assert.equal((await f.request(route,undefined,{Authorization:''})).status,401);
    assert.equal((await f.request(route,undefined,{Origin:'https://example.com'})).status,403);
  }
  assert.equal((await f.request('/api/reminders/create',{text:'should-not-create',dueAt:new Date(f.now()+60_000).toISOString()},{Authorization:''})).status,401);
  assert.equal((await f.reminders.list()).reminders.length,0);
});

test('reminder/todo/usage short commands are local even with attached invalid pixels and no provider auth',async t=>{
  const f=await fixture(t,{configured:false});
  await f.json('/api/reminders/configure',{defaultMorningTime:'08:45'});
  for(const message of ['半小时后提醒我出门','明早提醒我带充电器','添加待办整理桌面','我的待办','查看提醒','今日用量','每日token预算10000','预算不限']) {
    const result=await f.json('/api/chat',{message,screen:{mimeType:'image/jpeg',data:'invalid'},activity:{app:'Private',title:'not-recent'}});
    assert.equal(result.source,'local');assert.equal(result.modelCalls,0);assert.equal(result.usage.totalTokens,0);
    assert.equal(result.screenUsed,false);assert.equal(result.awareness.activityUsed,false);assert.equal(result.screenReason,'local_command');
    if(message.startsWith('明早'))assert.match(result.text,/08:45/);
  }
  const data=await f.reminders.list();
  assert.equal(data.reminders.length,2);assert.equal(data.todos.length,1);
  assert.equal(f.calls.model,0);assert.equal(f.calls.configured,0);assert.equal(f.calls.commit,0);
  assert.deepEqual(await f.companion.recentContext(),[]);
  const summary=await f.meter.get();assert.equal(summary.today.requests,0);assert.equal(summary.policy.dailyTokenLimit,0);
});

test('invalid explicit reminder time is a local explanation; quoted requests cannot create reminders',async t=>{
  const f=await fixture(t);
  const invalid=await f.json('/api/chat',{message:'0分钟后提醒我出门'});
  assert.equal(invalid.source,'local');assert.match(invalid.text,/大于 0/);
  await f.json('/api/chat',{message:'朋友说“半小时后提醒我出门”，是什么意思？'});
  assert.equal(f.calls.model,1);assert.equal((await f.reminders.list()).reminders.length,0);
});

test('reminder REST lifecycle delivers durable IDs, acknowledges without engagement, and snoozes a fresh event',async t=>{
  const f=await fixture(t);
  const item=await f.json('/api/reminders/create',{text:'本地提醒合成测试',dueAt:new Date(f.now()+1000).toISOString()});
  assert.equal(item.status,'pending');
  f.setTime(f.now()+1100);
  const first=await f.json('/api/local-events/inbox');
  assert.equal(first.events.length,1);assert.equal(first.events[0].reminderId,item.id);
  assert.deepEqual(await f.json('/api/local-events/inbox'),first);
  const engaged=f.calls.interact;
  assert.equal((await f.json('/api/local-events/ack',{ids:[first.events[0].id]})).acknowledged,1);
  assert.equal(f.calls.interact,engaged,'background acknowledgement must not reset retreat');
  assert.deepEqual((await f.json('/api/local-events/inbox')).events,[]);
  const snoozed=await f.json('/api/reminders/action',{id:item.id,action:'snooze',minutes:10});
  assert.equal(snoozed.status,'pending');f.setTime(f.now()+600_001);
  const second=await f.json('/api/local-events/inbox');
  assert.equal(second.events.length,1);assert.notEqual(second.events[0].id,first.events[0].id);
  await f.json('/api/local-events/ack',{ids:[first.events[0].id]});
  assert.equal((await f.json('/api/local-events/inbox')).events.length,1,'old ack cannot remove snoozed event');
  await f.json('/api/reminders/action',{id:item.id,action:'complete',minutes:10});
  assert.deepEqual((await f.json('/api/local-events/inbox')).events,[]);
  assert.equal(f.calls.model,0);assert.equal(f.calls.commit,0);
});

test('todo and budget panels validate inputs and preserve policy after a rejected edit',async t=>{
  const f=await fixture(t);
  const todo=await f.json('/api/todos/create',{text:'带充电器'});
  assert.equal((await f.json('/api/todos/action',{id:todo.id,action:'complete'})).status,'completed');
  assert.equal((await f.json('/api/todos/action',{id:todo.id,action:'reopen'})).status,'pending');
  const configured=await f.json('/api/usage-policy',{dailyTokenLimit:100});
  assert.equal(configured.policy.dailyTokenLimit,100);assert.ok(configured.proactive.policy);assert.equal(configured.screenshot.limit,36);
  assert.equal((await f.request('/api/usage-policy',{dailyTokenLimit:-1})).status,400);
  assert.equal((await f.request('/api/reminders/create',{text:'bad ISO',dueAt:new Date(f.now()+60_000).toISOString().replace(/\.\d{3}Z$/,'Z')})).status,400);
  assert.equal((await f.meter.get()).policy.dailyTokenLimit,100);
});

test('ordinary chat records reported visual+text usage once; failure retains partial usage and unknown flag',async t=>{
  let attempt=0;
  const f=await fixture(t,{async chat(){attempt++;if(attempt===1)return{...answer(120),modelCalls:2};throw Object.assign(new Error('provider failed'),{partial:{usage:usage(30),modelCalls:2,usageIncomplete:true}});}});
  assert.equal((await f.request('/api/chat',{message:'synthetic success'})).status,200);
  assert.equal((await f.request('/api/chat',{message:'synthetic fail'})).status,502);
  const result=await f.json('/api/usage');
  assert.equal(result.today.usage.totalTokens,150);assert.equal(result.today.byKind.chat.requests,2);
  assert.equal(result.today.modelCalls,4);assert.equal(result.today.failed,1);assert.equal(result.today.unknownUsageAttempts,1);
  await f.json('/api/usage-policy',{dailyTokenLimit:1000});
  assert.equal((await f.meter.proactiveGate()).reason,'usage_unknown');
  assert.equal((await f.request('/api/chat',{message:'manual still goes to provider'})).status,502);
  assert.equal(f.calls.model,3);
});

test('meter write failure preserves a completed reply, queues it once, and fails closed until recovery',async t=>{
  const f=await fixture(t);
  await f.meter.get();
  const file=path.join(f.root,'data','usage-ledger.json');
  const saved=await fs.readFile(file);
  await fs.unlink(file);await fs.mkdir(file);
  const result=await f.json('/api/chat',{message:'reply survives ledger failure'});
  assert.equal(result.text,'合成测试回复');assert.equal(result.usageDiagnostic.code,'USAGE_STORAGE_UNAVAILABLE');
  assert.equal((await f.meter.proactiveGate()).reason,'usage_unavailable');
  await fs.rmdir(file);await fs.writeFile(file,saved,{mode:0o600});
  assert.equal((await f.meter.get()).today.usage.totalTokens,60);
  assert.equal((await f.meter.get()).today.requests,1);
});

test('a successful reply with partial unknown usage still marks the unified budget unknown',async t=>{
  const f=await fixture(t,{async chat(){return{...answer(80),modelCalls:2,usageIncomplete:true};}});
  await f.json('/api/usage-policy',{dailyTokenLimit:1000});
  assert.equal((await f.json('/api/chat',{message:'synthetic partial success'})).text,'合成测试回复');
  const value=await f.json('/api/usage');
  assert.equal(value.today.usage.totalTokens,80);assert.equal(value.today.unknownUsageAttempts,1);
  assert.equal(value.gate.reason,'usage_unknown');
});

test('last proactive answer crosses the budget and is delivered; later attempts pause and unlimited resumes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'whale-budget-runtime-'));
  let now=Date.parse('2026-10-29T00:00:00Z'),calls=0;
  const meter=createUsageBudget({root,now:()=>now});
  await meter.configure({dailyTokenLimit:50});
  const runtime=createProactiveRuntime({root,now:()=>now,random:()=>0,schedule:()=>()=>{},getProactiveBudget:()=>meter.proactiveGate(),generate:()=>measureModelUse(meter,'proactive',async()=>{calls++;return answer(60);},{id:`proactive-test-${calls+1}`,at:new Date(now).toISOString()})});
  t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await runtime.configure({enabled:true,mode:'ai',minIntervalSeconds:60,maxIntervalSeconds:600,dailyAiLimit:0});await runtime.start();
  await runtime.inbox();await runtime.inbox('0');
  await runtime.preview();
  const delivered=await runtime.inbox('0');
  assert.equal(delivered.messages.length,1);assert.equal(delivered.messages[0].text,'合成测试回复');
  assert.equal(delivered.status.tokenBudgetPaused,true);assert.equal(delivered.status.tokenBudgetReason,'token_budget');
  await assert.rejects(runtime.preview(),{code:'PROACTIVE_TOKEN_BUDGET'});
  assert.equal(calls,1);assert.equal((await runtime.status()).aiUsedToday,1);
  await meter.configure({dailyTokenLimit:0});await runtime.refreshCompanionSettings();await runtime.preview();
  assert.equal(calls,2);assert.equal((await meter.get()).today.byKind.proactive.requests,2);
});

test('budget midnight reset respects the following quiet window and does not replay missed messages',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'whale-budget-midnight-'));
  let now=Date.parse('2026-10-29T14:50:00Z');
  const meter=createUsageBudget({root,now:()=>now});await meter.configure({dailyTokenLimit:10});
  await meter.record({id:'before-midnight',kind:'chat',at:new Date(now).toISOString(),usage:usage(20),modelCalls:1,status:'completed'});
  const runtime=createProactiveRuntime({root,now:()=>now,random:()=>0,schedule:()=>()=>{},getProactiveBudget:()=>meter.proactiveGate(),generate:async()=>{throw new Error('must not generate');},getCompanionSettings:async()=>({preferences:{preferredName:'老板',tone:'natural'},quiet:{enabled:true,start:'23:00',end:'08:00'},focusUntil:null,backoff:{enabled:true,afterUnanswered:3,maxMultiplier:8,maxIntervalSeconds:3600}})});
  t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await runtime.configure({enabled:true,mode:'ai',minIntervalSeconds:60,maxIntervalSeconds:600,dailyAiLimit:0});await runtime.start();await runtime.inbox();
  assert.equal((await runtime.status()).nextAt,'2026-10-30T00:01:00.000Z');
  now=Date.parse('2026-10-29T16:01:00Z');
  const result=await runtime.inbox('0');assert.equal(result.status.tokenBudgetPaused,false);assert.equal(result.status.reason,'quiet_hours');assert.deepEqual(result.messages,[]);
  assert.equal(result.status.nextAt,'2026-10-30T00:01:00.000Z');
});

test('unavailable budget prevents proactive generation without disabling independent local reminders',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'whale-usage-failclosed-'));
  let now=Date.now(),calls=0;
  const reminders=createLocalReminders({root,now:()=>now,schedule:()=>()=>{}});await reminders.start();
  const item=await reminders.createReminder({text:'independent local event',dueAt:new Date(now+1000).toISOString()});
  const runtime=createProactiveRuntime({root,now:()=>now,schedule:()=>()=>{},getProactiveBudget:async()=>{throw new Error('broken store');},generate:async()=>{calls++;return answer(20);}});
  t.after(async()=>{await runtime.close();await reminders.close();await fs.rm(root,{recursive:true,force:true});});
  await runtime.configure({enabled:true,mode:'ai',minIntervalSeconds:60,maxIntervalSeconds:600,dailyAiLimit:0});await runtime.start();await runtime.inbox();
  await assert.rejects(runtime.preview(),{code:'PROACTIVE_USAGE_UNAVAILABLE'});assert.equal(calls,0);assert.equal((await runtime.status()).nextAt,null);
  now+=1100;assert.equal((await reminders.inbox()).events[0].reminderId,item.id);
});

test('legacy migration snapshots yesterday before runtime day rollover and seeds it only once',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'whale-usage-migration-'));
  let now=Date.parse('2026-10-28T00:00:00Z');
  const runtime=createProactiveRuntime({root,now:()=>now,schedule:()=>()=>{},generate:async()=>answer(70)});
  t.after(async()=>{await runtime.close();await fs.rm(root,{recursive:true,force:true});});
  await runtime.configure({enabled:true,mode:'ai',minIntervalSeconds:60,maxIntervalSeconds:600,dailyAiLimit:0});
  await runtime.start();await runtime.inbox();await runtime.preview();
  now=Date.parse('2026-10-29T00:00:00Z');
  const before=await runtime.usageMigrationSnapshot();assert.equal(before.day,'2026-10-28');assert.equal(before.usage.totalTokens,70);
  const meter=createUsageBudget({root,now:()=>now});await meter.seedProactive(before);
  assert.equal((await runtime.status()).usage.totalTokens,0);
  await meter.seedProactive(await runtime.usageMigrationSnapshot());
  const snapshot=await meter.get();assert.equal(snapshot.today.usage.totalTokens,0);
  assert.equal(snapshot.history.find(day=>day.day==='2026-10-28').usage.totalTokens,70);
});
