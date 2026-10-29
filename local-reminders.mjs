import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {storageSecurity} from './private-storage.mjs';

const DAY=86_400_000,MAX_FUTURE=365*DAY,MAX_BYTES=2*1024*1024,MAX_ITEMS=500;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const failure=code=>Object.assign(new Error(code),{code});
const clone=value=>structuredClone(value);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key));
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const textValid=value=>typeof value==='string'&&value===value.trim()&&value.length>=1&&value.length<=300&&!/[\u0000-\u001f\u007f]/.test(value);
function currentTime(now=Date.now){const value=Number(typeof now==='function'?now():now);if(!Number.isFinite(value))throw failure('BAD_REMINDER_CLOCK');return value;}
const timestamp=ms=>new Date(ms).toISOString();
function validText(value){if(typeof value!=='string'||!textValid(value.trim()))throw failure('BAD_REMINDER_TEXT');return value.trim();}
function calendarTime(now,offset,clock){
  const shifted=new Date(now+8*3_600_000);
  const [hour,minute]=clock.split(':').map(Number);
  return Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate()+offset,hour-8,minute);
}
function mixedText(value){return /["“”‘’「」『』\r\n]/.test(value)||/(?:这句话|这条命令|这个指令|这个命令|是什么意思|什么意思|如何翻译|怎么翻译)/.test(value)||/(?:然后|顺便|同时|另外|并且|并)(?:再)?(?:帮我|请你|替我|给我|打开|查询|查一下|搜索|安装|发送|告诉|解释|回答|执行|运行)/.test(value)||/[，,；;。！!？?、]\s*(?:帮我|请你|替我|给我|再|顺便|然后|查询|搜索|打开|安装|发送|执行|运行|查看|解释|告诉我)/.test(value);}

/** Deterministic, fully anchored local commands; a quoted or mixed request is never executed as a control command. */
export function parseReminderCommand(text,{now=Date.now,defaultMorningTime='09:00'}={}){
  if(typeof text!=='string'||text.length>400||/[\r\n]/.test(text))return null;
  const value=text.trim();
  if(['我的待办','查看提醒','提醒和待办'].includes(value))return{type:'status'};
  const todo=value.match(/^添加待办(.*)$/u);
  if(todo){
    if(mixedText(todo[1]))return null;
    const item=todo[1].trim();
    return textValid(item)?{type:'todo_create',text:item}:{type:'invalid',message:'请提供一条 1—300 字的单行待办内容。'};
  }
  const relative=value.match(/^(半小时|\d{1,7}分钟)后提醒我(.*)$/u);
  const morning=value.match(/^明早提醒我(.*)$/u);
  const calendar=value.match(/^(今天|明天)(\d{1,2}:\d{2})提醒我(.*)$/u);
  if(!relative&&!morning&&!calendar)return null;
  const item=(relative?.[2]??morning?.[1]??calendar?.[3]??'').trim();
  if(mixedText(item))return null;
  if(!textValid(item))return{type:'invalid',message:'请提供一条 1—300 字的单行提醒内容。'};
  let at;
  try{at=currentTime(now);}catch{return{type:'invalid',message:'当前时间不可用，暂时无法设置提醒。'};}
  let due;
  if(relative){
    const minutes=relative[1]==='半小时'?30:Number(relative[1].replace('分钟',''));
    if(!Number.isInteger(minutes)||minutes<=0||minutes>365*24*60)return{type:'invalid',message:'提醒间隔应大于 0 分钟且不超过一年。'};
    due=at+minutes*60_000;
  }else if(morning){
    if(!TIME.test(defaultMorningTime))return{type:'invalid',message:'默认早晨时间无效，请先设置 HH:mm 格式的时间。'};
    due=calendarTime(at,1,defaultMorningTime);
  }else{
    const [hour,minute]=calendar[2].split(':').map(Number);
    if(hour<0||hour>23||minute<0||minute>59)return{type:'invalid',message:'提醒时间应使用有效的 24 小时制 HH:mm 格式。'};
    due=calendarTime(at,calendar[1]==='明天'?1:0,`${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`);
    if(due<=at)return{type:'invalid',message:'今天这个时间已经过去，请明确选择一个将来的时间；我没有自动顺延到明天。'};
  }
  return{type:'reminder_create',text:item,dueAt:timestamp(due)};
}

function validate(state){
  const bad=()=>{throw failure('REMINDER_STATE_INVALID');};
  if(!keys(state,['version','settings','reminders','todos','events'])||state.version!==1||
    !keys(state.settings,['defaultMorningTime','timezone'])||!TIME.test(state.settings.defaultMorningTime)||state.settings.timezone!=='Asia/Shanghai'||
    !Array.isArray(state.reminders)||state.reminders.length>MAX_ITEMS||!Array.isArray(state.todos)||state.todos.length>MAX_ITEMS||!Array.isArray(state.events)||state.events.length>MAX_ITEMS)bad();
  const ids=new Set(),eventIds=new Set(),reminders=new Map();
  for(const item of state.reminders){
    if(!keys(item,['id','text','dueAt','status','createdAt','updatedAt','generation','eventId','firedAt','acknowledgedAt','completedAt','cancelledAt','snoozedAt'])||!UUID.test(item.id)||ids.has(item.id)||!textValid(item.text)||!iso(item.dueAt)||!iso(item.createdAt)||!iso(item.updatedAt)||!['pending','due','completed','cancelled'].includes(item.status)||!Number.isInteger(item.generation)||item.generation<0||item.generation>1_000_000||!UUID.test(item.eventId)||eventIds.has(item.eventId))bad();
    for(const field of ['firedAt','acknowledgedAt','completedAt','cancelledAt','snoozedAt'])if(item[field]!==undefined&&!iso(item[field]))bad();
    if(item.status==='due'&&!item.firedAt)bad();
    if(item.status==='pending'&&(item.firedAt||item.acknowledgedAt||item.completedAt||item.cancelledAt))bad();
    if(item.status==='completed'&&!item.completedAt)bad();
    if(item.status==='cancelled'&&!item.cancelledAt)bad();
    ids.add(item.id);eventIds.add(item.eventId);reminders.set(item.id,item);
  }
  for(const item of state.todos){
    if(!keys(item,['id','text','status','createdAt','updatedAt','completedAt','cancelledAt'])||!UUID.test(item.id)||ids.has(item.id)||!textValid(item.text)||!iso(item.createdAt)||!iso(item.updatedAt)||!['pending','completed','cancelled'].includes(item.status))bad();
    for(const field of ['completedAt','cancelledAt'])if(item[field]!==undefined&&!iso(item[field]))bad();
    ids.add(item.id);
  }
  const events=new Set();
  for(const event of state.events){
    const item=reminders.get(event.reminderId);
    if(!keys(event,['id','reminderId','at','generation'])||!UUID.test(event.id)||events.has(event.id)||!iso(event.at)||!item||item.status!=='due'||item.acknowledgedAt||item.eventId!==event.id||item.generation!==event.generation||item.firedAt!==event.at)bad();
    events.add(event.id);
  }
  // Every unacknowledged due reminder must have its durable delivery event.
  if(state.reminders.some(item=>item.status==='due'&&!item.acknowledgedAt&&!events.has(item.eventId)))bad();
  return state;
}

/** Local durable reminders only. Production injects the portable app host's scheduler. */
export function createLocalReminders({root,now=Date.now,schedule=(callback,delay)=>{const timer=setTimeout(callback,delay);timer.unref?.();return()=>clearTimeout(timer);}}={}){
  if(!path.isAbsolute(root||'')||typeof schedule!=='function')throw failure('BAD_REMINDER_CONFIG');
  const directory=path.join(root,'data'),file=path.join(directory,'local-reminders.json');
  let state,queue=Promise.resolve(),running=false,closed=false,cancelTimer=null,timerVersion=0,lastError=null;
  const clock=()=>currentTime(now);
  function serial(operation){const pending=queue.then(async()=>{if(closed)throw failure('REMINDERS_CLOSED');await initialize();return operation();});queue=pending.catch(()=>{});return pending;}
  async function safeDirectory(){try{const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw failure('REMINDER_STORAGE_UNSAFE');}catch(error){if(error.code!=='ENOENT')throw error;}}
  async function safeFile(){try{const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw failure('REMINDER_STORAGE_UNSAFE');}catch(error){if(error.code!=='ENOENT')throw error;}}
  async function load(){
    let handle;
    try{
      await safeDirectory();await safeFile();handle=await storageSecurity.openRead(file);
      const info=await handle.stat();if(!info.isFile())throw failure('REMINDER_STORAGE_UNSAFE');if(info.size>MAX_BYTES)throw failure('REMINDER_FILE_TOO_LARGE');
      const bytes=Buffer.alloc(MAX_BYTES+1);let count=0;
      while(count<bytes.length){const read=await handle.read(bytes,count,bytes.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
      if(count>MAX_BYTES)throw failure('REMINDER_FILE_TOO_LARGE');
      let value;try{value=JSON.parse(bytes.subarray(0,count).toString('utf8'));}catch{throw failure('REMINDER_STATE_INVALID');}
      validate(value);return value;
    }catch(error){if(error.code==='ENOENT')return undefined;throw error;}finally{await handle?.close();}
  }
  async function persist(value){
    validate(value);const body=JSON.stringify(value)+'\n';if(Buffer.byteLength(body)>MAX_BYTES)throw failure('REMINDER_FILE_TOO_LARGE');
    await storageSecurity.directory(directory);await safeDirectory();await safeFile();
    const temporary=file+'.'+randomUUID()+'.tmp';let handle;
    try{
      handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(body);await handle.sync();await handle.close();handle=null;
      await storageSecurity.created(temporary);await fs.rename(temporary,file);storageSecurity.renamed(temporary,file);
    }catch(error){await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true}).catch(()=>{});throw error;}
  }
  async function initialize(){
    if(state)return;
    const stored=await load();
    if(stored){state=stored;return;}
    const defaults={version:1,settings:{defaultMorningTime:'09:00',timezone:'Asia/Shanghai'},reminders:[],todos:[],events:[]};
    await persist(defaults);state=defaults;
  }
  const snapshot=()=>({reminders:clone(state.reminders),todos:clone(state.todos),settings:clone(state.settings),...(lastError?{diagnostic:clone(lastError)}:{})});
  function clearTimer(){timerVersion++;if(cancelTimer){try{cancelTimer();}catch{}cancelTimer=null;}}
  function setTimer(delay){
    const version=timerVersion;
    const scheduled=schedule(()=>{
      if(!running||closed||version!==timerVersion)return;
      cancelTimer=null;
      return serial(async()=>{if(!running||version!==timerVersion)return;try{await settleDue();lastError=null;arm();}catch{lastError={code:'REMINDER_COMMIT_FAILED',message:'提醒记录暂未保存，将重试。'};clearTimer();if(running)setTimer(30_000);}}).catch(()=>{});
    },Math.max(0,Math.min(DAY,delay)));
    cancelTimer=typeof scheduled==='function'?scheduled:()=>{if(typeof scheduled?.dispose==='function')scheduled.dispose();else if(typeof scheduled?.close==='function')scheduled.close();else if(scheduled!=null)clearTimeout(scheduled);};
  }
  function arm(){
    clearTimer();if(!running||closed)return;
    const deadlines=state.reminders.filter(item=>item.status==='pending').map(item=>Date.parse(item.dueAt));
    if(!deadlines.length)return;
    try{setTimer(Math.max(0,Math.min(...deadlines)-clock()));}
    catch{lastError={code:'REMINDER_SCHEDULER_FAILED',message:'提醒计时暂不可用；打开提醒列表仍会核对到期记录。'};}
  }
  async function commit(next){await persist(next);state=next;lastError=null;}
  async function settleDue(){
    const at=clock(),pending=state.reminders.filter(item=>item.status==='pending'&&Date.parse(item.dueAt)<=at);
    if(!pending.length)return;
    const next=clone(state),dueIds=new Set(pending.map(item=>item.id));
    for(const item of next.reminders){if(!dueIds.has(item.id))continue;item.status='due';item.firedAt=timestamp(at);item.updatedAt=timestamp(at);next.events.push({id:item.eventId,reminderId:item.id,at:item.firedAt,generation:item.generation});}
    await commit(next);
  }
  function mutate(operation){return serial(async()=>{const next=clone(state),result=operation(next);if(JSON.stringify(next)!==JSON.stringify(state))await commit(next);arm();return clone(result);});}
  function reminder(next,id){if(!UUID.test(id||''))throw failure('BAD_REMINDER_ID');const found=next.reminders.find(item=>item.id===id);if(!found)throw failure('REMINDER_NOT_FOUND');return found;}
  function todo(next,id){if(!UUID.test(id||''))throw failure('BAD_TODO_ID');const found=next.todos.find(item=>item.id===id);if(!found)throw failure('TODO_NOT_FOUND');return found;}
  function removeEvents(next,id){next.events=next.events.filter(event=>event.reminderId!==id);}
  return{
    start:()=>serial(async()=>{running=true;await settleDue();arm();return snapshot();}),
    async close(){if(closed)return;running=false;closed=true;clearTimer();await queue;},
    list:()=>serial(async()=>{await settleDue();arm();return snapshot();}),
    configure:patch=>mutate(next=>{if(!keys(patch,['defaultMorningTime'])||typeof patch.defaultMorningTime!=='string'||!TIME.test(patch.defaultMorningTime))throw failure('BAD_REMINDER_SETTINGS');next.settings.defaultMorningTime=patch.defaultMorningTime;return next.settings;}),
    createReminder:input=>mutate(next=>{
      if(!keys(input,['text','dueAt']))throw failure('BAD_REMINDER_INPUT');const text=validText(input.text),at=clock();
      if(!iso(input.dueAt)||Date.parse(input.dueAt)<=at||Date.parse(input.dueAt)>at+MAX_FUTURE)throw failure('BAD_REMINDER_TIME');
      if(next.reminders.length>=MAX_ITEMS)throw failure('REMINDER_CAPACITY_REACHED');
      const item={id:randomUUID(),text,dueAt:input.dueAt,status:'pending',createdAt:timestamp(at),updatedAt:timestamp(at),generation:0,eventId:randomUUID()};next.reminders.push(item);return item;
    }),
    completeReminder:id=>mutate(next=>{const item=reminder(next,id);if(['completed','cancelled'].includes(item.status))return item;item.status='completed';item.completedAt=timestamp(clock());item.updatedAt=item.completedAt;removeEvents(next,id);return item;}),
    cancelReminder:id=>mutate(next=>{const item=reminder(next,id);if(['completed','cancelled'].includes(item.status))return item;item.status='cancelled';item.cancelledAt=timestamp(clock());item.updatedAt=item.cancelledAt;removeEvents(next,id);return item;}),
    snoozeReminder:(id,minutes=10)=>mutate(next=>{
      const item=reminder(next,id);if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw failure('BAD_REMINDER_INTERVAL');if(!['pending','due'].includes(item.status)||item.generation>=1_000_000)throw failure('BAD_REMINDER_STATE');
      const at=clock();item.status='pending';item.dueAt=timestamp(at+minutes*60_000);item.updatedAt=timestamp(at);item.snoozedAt=item.updatedAt;item.generation++;item.eventId=randomUUID();delete item.firedAt;delete item.acknowledgedAt;removeEvents(next,id);return item;
    }),
    createTodo:input=>mutate(next=>{if(!keys(input,['text']))throw failure('BAD_TODO_INPUT');if(next.todos.length>=MAX_ITEMS)throw failure('TODO_CAPACITY_REACHED');const at=timestamp(clock()),item={id:randomUUID(),text:validText(input.text),status:'pending',createdAt:at,updatedAt:at};next.todos.push(item);return item;}),
    completeTodo:id=>mutate(next=>{const item=todo(next,id);if(item.status==='completed')return item;item.status='completed';item.completedAt=timestamp(clock());item.updatedAt=item.completedAt;delete item.cancelledAt;return item;}),
    reopenTodo:id=>mutate(next=>{const item=todo(next,id);if(item.status==='pending')return item;item.status='pending';item.updatedAt=timestamp(clock());delete item.completedAt;delete item.cancelledAt;return item;}),
    cancelTodo:id=>mutate(next=>{const item=todo(next,id);if(item.status==='cancelled')return item;item.status='cancelled';item.cancelledAt=timestamp(clock());item.updatedAt=item.cancelledAt;delete item.completedAt;return item;}),
    inbox:()=>serial(async()=>{
      await settleDue();arm();const records=new Map(state.reminders.map(item=>[item.id,item]));
      return{events:state.events.slice(0,10).map(event=>({id:event.id,text:records.get(event.reminderId).text,at:event.at,kind:'reminder',reminderId:event.reminderId}))};
    }),
    ack:ids=>mutate(next=>{
      if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||!UUID.test(id)))throw failure('BAD_REMINDER_ACK');
      const selected=new Set(ids),acked=next.events.filter(event=>selected.has(event.id));
      for(const event of acked){const item=reminder(next,event.reminderId);item.acknowledgedAt=timestamp(clock());item.updatedAt=item.acknowledgedAt;}
      next.events=next.events.filter(event=>!selected.has(event.id));return{success:true,acknowledged:acked.length};
    }),
  };
}
