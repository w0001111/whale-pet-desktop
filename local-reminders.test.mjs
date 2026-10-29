import {directoryLink,privateFileLink,isLinkedFixture} from './test/platform.mjs';
import {assertPrivateFile} from './test/platform.mjs';
import os from 'node:os';
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createLocalReminders,parseReminderCommand} from './local-reminders.mjs';

const MINUTE=60_000,DAY=86_400_000;
const START=Date.parse('2026-10-29T06:30:00.000Z'); // 14:30 in Shanghai.
class Clock{
  at=START;jobs=[];delays=[];
  now=()=>this.at;
  schedule=(callback,delay)=>{const job={callback,due:this.at+delay,active:true};this.jobs.push(job);this.delays.push(delay);return()=>{job.active=false;};};
  next(){return this.jobs.filter(job=>job.active).sort((a,b)=>a.due-b.due)[0];}
  async fire(job=this.next()){if(!job)return;job.active=false;await job.callback();}
  async advance(milliseconds){this.at+=milliseconds;for(let n=0;n<1000;n++){const job=this.next();if(!job||job.due>this.at)return;await this.fire(job);}throw new Error('Timer loop did not settle');}
}
async function fixture(t,{clock=new Clock()}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'whale-local-reminders-'));
  const store=createLocalReminders({root,now:clock.now,schedule:clock.schedule});
  t.after(async()=>{await store.close();await fs.rm(root,{recursive:true,force:true});});
  return{root,store,clock,file:path.join(root,'data','local-reminders.json')};
}
function failNextRename(file){
  const original=fs.rename;
  return mock.method(fs,'rename',async(source,destination)=>{if(destination===file)throw Object.assign(new Error('SYNTHETIC_ATOMIC_RENAME_FAILURE'),{code:'EIO'});return original(source,destination);});
}

test('anchored reminder commands resolve relative and calendar dates in Shanghai, including explicit tomorrow morning',()=>{
  const now=()=>START;
  const cases=[
    ['半小时后提醒我出门',{type:'reminder_create',text:'出门',dueAt:'2026-10-29T07:00:00.000Z'}],
    ['10分钟后提醒我喝水',{type:'reminder_create',text:'喝水',dueAt:'2026-10-29T06:40:00.000Z'}],
    ['明早提醒我带充电器',{type:'reminder_create',text:'带充电器',dueAt:'2026-10-30T01:00:00.000Z'}],
    ['明天08:30提醒我买早餐',{type:'reminder_create',text:'买早餐',dueAt:'2026-10-30T00:30:00.000Z'}],
    ['今天15:00提醒我打电话',{type:'reminder_create',text:'打电话',dueAt:'2026-10-29T07:00:00.000Z'}],
    ['添加待办买牛奶',{type:'todo_create',text:'买牛奶'}],['我的待办',{type:'status'}],['查看提醒',{type:'status'}],['提醒和待办',{type:'status'}],
  ];
  for(const [command,expected]of cases)assert.deepEqual(parseReminderCommand(command,{now}),expected,command);
  assert.equal(parseReminderCommand('明早提醒我带充电器',{now,defaultMorningTime:'07:15'}).dueAt,'2026-10-29T23:15:00.000Z');
  assert.equal(parseReminderCommand('明早提醒我带充电器',{now:Date.parse('2026-12-31T15:50:00.000Z')}).dueAt,'2027-01-01T01:00:00.000Z');
});

test('elapsed today times require a new explicit time and malformed or empty requests do not receive fake confirmations',()=>{
  for(const command of ['今天14:00提醒我喝水','今天14:30提醒我喝水','今天25:00提醒我喝水','今天15:60提醒我喝水','0分钟后提醒我喝水','525601分钟后提醒我喝水','半小时后提醒我','添加待办'])assert.equal(parseReminderCommand(command,{now:START}).type,'invalid',command);
  const past=parseReminderCommand('今天14:00提醒我喝水',{now:START});assert.match(past.message,/没有自动顺延/);
  assert.equal(parseReminderCommand('今天14:30提醒我喝水',{now:START-1000}).dueAt,'2026-10-29T06:30:00.000Z');
  assert.equal(parseReminderCommand('明早提醒我喝水',{now:START,defaultMorningTime:'25:00'}).type,'invalid');
});

test('quotes, narration, multiline or mixed operational requests cannot create reminders or todos',()=>{
  for(const command of ['“半小时后提醒我出门”','他说半小时后提醒我出门','请解释明早提醒我喝水是什么意思','半小时后提醒我出门这句话怎么翻译','10分钟后提醒我喝水\n然后查天气','半小时后提醒我出门，顺便帮我查天气','半小时后提醒我出门并告诉我天气','半小时后提醒我出门；查询天气','添加待办买牛奶，然后帮我搜索天气','我的待办，顺便打开网页'])assert.equal(parseReminderCommand(command,{now:START}),null,command);
});

test('state defaults are private, immutable to callers and independent of companion quiet or focus',async t=>{
  const {store,file,clock}=await fixture(t);
  assert.deepEqual(await store.start(),{reminders:[],todos:[],settings:{defaultMorningTime:'09:00',timezone:'Asia/Shanghai'}});
  await assertPrivateFile(file);
  assert.deepEqual(await store.configure({defaultMorningTime:'07:45'}),{defaultMorningTime:'07:45',timezone:'Asia/Shanghai'});
  const snapshot=await store.list();snapshot.settings.defaultMorningTime='00:00';assert.equal((await store.list()).settings.defaultMorningTime,'07:45');
  for(const patch of [{defaultMorningTime:'8:30'},{defaultMorningTime:'25:00'},{defaultMorningTime:'09:00',timezone:'UTC'},{quiet:{enabled:true}}])await assert.rejects(store.configure(patch),{code:'BAD_REMINDER_SETTINGS'});
  const night=Date.parse('2026-10-29T15:30:00.000Z');clock.at=night;
  await store.createReminder({text:'明确设置的夜间提醒',dueAt:new Date(night+MINUTE).toISOString()});await clock.advance(MINUTE);
  assert.equal((await store.inbox()).events[0].text,'明确设置的夜间提醒');
});

test('nearest timer is segmented at 24 hours and an early callback or backward clock cannot deliver early',async t=>{
  const {store,clock}=await fixture(t);await store.start();
  const reminder=await store.createReminder({text:'三天后的约定',dueAt:new Date(clock.at+3*DAY).toISOString()});
  assert.equal(clock.delays.at(-1),DAY);
  await clock.fire(); // Simulate an unexpectedly early timer callback.
  assert.deepEqual((await store.inbox()).events,[]);
  clock.at-=DAY;await clock.fire();assert.deepEqual((await store.inbox()).events,[]);
  await clock.advance(3*DAY);assert.deepEqual((await store.inbox()).events,[]);
  await clock.advance(DAY);
  assert.equal((await store.inbox()).events[0].reminderId,reminder.id);
  assert.ok(clock.delays.every(delay=>delay>=0&&delay<=DAY));
});

test('sleep and restart preserve exactly one durable event until ACK, and a double ACK cannot revive it',async t=>{
  const {root,store,clock,file}=await fixture(t);await store.start();
  const reminder=await store.createReminder({text:'带充电器',dueAt:new Date(clock.at+10*MINUTE).toISOString()});
  await store.close();clock.at+=2*DAY;
  const restarted=createLocalReminders({root,now:clock.now,schedule:clock.schedule});t.after(()=>restarted.close());
  await restarted.start();const first=(await restarted.inbox()).events;
  assert.equal(first.length,1);assert.equal(first[0].id,reminder.eventId);
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).reminders[0].status,'due');
  assert.deepEqual((await restarted.inbox()).events,first);
  await restarted.close();
  const again=createLocalReminders({root,now:clock.now,schedule:clock.schedule});t.after(()=>again.close());
  await again.start();assert.deepEqual((await again.inbox()).events,first);
  assert.deepEqual(await again.ack([first[0].id,first[0].id]),{success:true,acknowledged:1});
  assert.deepEqual(await again.ack([first[0].id]),{success:true,acknowledged:0});
  assert.deepEqual((await again.inbox()).events,[]);assert.equal((await again.list()).reminders[0].status,'due');
});

test('cancel and complete suppress unacknowledged events including a queued stale timer',async t=>{
  const {store,clock}=await fixture(t);await store.start();
  const cancelled=await store.createReminder({text:'将取消的提醒',dueAt:new Date(clock.at+MINUTE).toISOString()});
  const queued=clock.next();queued.active=false;clock.at+=MINUTE;
  await store.cancelReminder(cancelled.id);await queued.callback();assert.deepEqual((await store.inbox()).events,[]);
  const completed=await store.createReminder({text:'提前完成的提醒',dueAt:new Date(clock.at+MINUTE).toISOString()});
  await clock.advance(MINUTE);assert.equal((await store.inbox()).events.length,1);
  await store.completeReminder(completed.id);assert.deepEqual((await store.inbox()).events,[]);
  assert.deepEqual((await store.list()).reminders.map(item=>item.status),['cancelled','completed']);
});

test('snooze replaces event identity and stale ACK cannot suppress the next delivery',async t=>{
  const {store,clock}=await fixture(t);await store.start();
  const created=await store.createReminder({text:'喝水',dueAt:new Date(clock.at+MINUTE).toISOString()});await clock.advance(MINUTE);
  const old=(await store.inbox()).events[0];
  const snoozed=await store.snoozeReminder(created.id);
  assert.equal(snoozed.generation,1);assert.notEqual(snoozed.eventId,old.id);assert.equal(Date.parse(snoozed.dueAt),clock.at+10*MINUTE);
  assert.deepEqual((await store.inbox()).events,[]);assert.equal((await store.ack([old.id])).acknowledged,0);
  await clock.advance(10*MINUTE);const current=(await store.inbox()).events[0];assert.equal(current.id,snoozed.eventId);assert.notEqual(current.id,old.id);
  assert.equal((await store.ack([old.id])).acknowledged,0);assert.equal((await store.inbox()).events[0].id,current.id);
});

test('inbox pages at most ten unacknowledged events without dropping later reminders',async t=>{
  const {store,clock}=await fixture(t);await store.start();
  for(let n=0;n<12;n++)await store.createReminder({text:`第${n}条提醒`,dueAt:new Date(clock.at+MINUTE).toISOString()});
  await clock.advance(MINUTE);const first=(await store.inbox()).events;assert.equal(first.length,10);
  await store.ack(first.map(event=>event.id));const next=(await store.inbox()).events;assert.equal(next.length,2);
  assert.ok(next.every(event=>!first.some(old=>old.id===event.id)));
  await store.ack(next.map(event=>event.id));assert.deepEqual((await store.inbox()).events,[]);
  assert.equal((await store.list()).reminders.length,12);
});

test('todo completion, reopening and cancellation preserve all records across restart',async t=>{
  const {root,store,clock}=await fixture(t);const todo=await store.createTodo({text:'买牛奶'});
  await store.completeTodo(todo.id);await store.completeTodo(todo.id);assert.equal((await store.list()).todos[0].status,'completed');
  await store.close();const restarted=createLocalReminders({root,now:clock.now,schedule:clock.schedule});t.after(()=>restarted.close());
  assert.equal((await restarted.list()).todos[0].status,'completed');
  assert.equal((await restarted.reopenTodo(todo.id)).status,'pending');assert.equal((await restarted.cancelTodo(todo.id)).status,'cancelled');
  assert.equal((await restarted.list()).todos.length,1);
});

test('failed atomic mutations do not confirm or change state, and failed due commits retry using the reserved event ID',async t=>{
  const {store,clock,file}=await fixture(t);await store.start();
  const before=await fs.readFile(file,'utf8');let sabotage=failNextRename(file);
  try{await assert.rejects(store.createTodo({text:'必须保存后才确认'}),{code:'EIO'});}finally{sabotage.mock.restore();}
  assert.equal(await fs.readFile(file,'utf8'),before);assert.deepEqual((await store.list()).todos,[]);
  const created=await store.createReminder({text:'失败后重试',dueAt:new Date(clock.at+MINUTE).toISOString()});
  sabotage=failNextRename(file);
  try{await clock.advance(MINUTE);}finally{sabotage.mock.restore();}
  const disk=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(disk.reminders[0].status,'pending');assert.deepEqual(disk.events,[]);assert.equal(clock.delays.at(-1),30_000);
  await clock.advance(30_000);assert.equal((await store.inbox()).events[0].id,created.eventId);
  sabotage=failNextRename(file);
  try{await assert.rejects(store.ack([created.eventId]),{code:'EIO'});}finally{sabotage.mock.restore();}
  assert.equal((await store.inbox()).events[0].id,created.eventId);
  await store.ack([created.eventId]);assert.deepEqual((await store.inbox()).events,[]);
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name=>name.endsWith('.tmp')),[]);
});

test('invalid time, snooze, text and identifiers are rejected without changing valid records',async t=>{
  const {store,clock}=await fixture(t);await store.start();
  for(const dueAt of [new Date(clock.at).toISOString(),new Date(clock.at-1).toISOString(),new Date(clock.at+365*DAY+1).toISOString(),'tomorrow'])await assert.rejects(store.createReminder({text:'合法内容',dueAt}),{code:'BAD_REMINDER_TIME'});
  await assert.rejects(store.createTodo({text:'line\nbreak'}),{code:'BAD_REMINDER_TEXT'});
  await assert.rejects(store.createTodo({text:'x'.repeat(301)}),{code:'BAD_REMINDER_TEXT'});
  const item=await store.createReminder({text:'合法提醒',dueAt:new Date(clock.at+MINUTE).toISOString()});
  for(const minutes of [0,1441,1.5])await assert.rejects(store.snoozeReminder(item.id,minutes),{code:'BAD_REMINDER_INTERVAL'});
  await assert.rejects(store.cancelReminder('../private'),{code:'BAD_REMINDER_ID'});
  await assert.rejects(store.ack(['not-an-event-id']),{code:'BAD_REMINDER_ACK'});
  assert.equal((await store.list()).reminders[0].status,'pending');assert.equal((await store.list()).todos.length,0);
});

test('linked directories/files, malformed state and oversized state are preserved and rejected',async t=>{
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'whale-reminder-link-target-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  const target=path.join(outside,'private.json'),secret='DO_NOT_READ_OR_REPLACE';await fs.writeFile(target,secret);
  const linkedDirectory=await fixture(t);await directoryLink(outside,path.join(linkedDirectory.root,'data'));
  await assert.rejects(linkedDirectory.store.list(),{code:'REMINDER_STORAGE_UNSAFE'});assert.equal((await fs.lstat(path.join(linkedDirectory.root,'data'))).isSymbolicLink(),true);
  const fileLink=await fixture(t);await fs.mkdir(path.dirname(fileLink.file));await privateFileLink(target,fileLink.file);
  await assert.rejects(fileLink.store.list(),{code:'REMINDER_STORAGE_UNSAFE'});assert.equal(await isLinkedFixture(fileLink.file),true);assert.equal(await fs.readFile(target,'utf8'),secret);
  const invalid=await fixture(t);await fs.mkdir(path.dirname(invalid.file));await fs.writeFile(invalid.file,'null');
  await assert.rejects(invalid.store.list(),{code:'REMINDER_STATE_INVALID'});assert.equal(await fs.readFile(invalid.file,'utf8'),'null');
  const large=await fixture(t);await fs.mkdir(path.dirname(large.file));await fs.writeFile(large.file,' '.repeat(2*1024*1024+1));
  await assert.rejects(large.store.list(),{code:'REMINDER_FILE_TOO_LARGE'});assert.equal((await fs.stat(large.file)).size,2*1024*1024+1);
});
