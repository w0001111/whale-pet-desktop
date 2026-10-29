import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const COMPANION_TIMEZONE='Asia/Shanghai';
export const DEFAULT_COMPANION_SETTINGS=Object.freeze({
  preferences:Object.freeze({preferredName:'你',tone:'natural'}),
  quiet:Object.freeze({enabled:true,start:'23:00',end:'08:00'}),focusUntil:null,
  backoff:Object.freeze({enabled:true,afterUnanswered:3,maxMultiplier:8,maxIntervalSeconds:3600}),
  recentTopics:Object.freeze({enabled:true,maxAgeMinutes:120}),
});
const SETTINGS_BYTES=8192,RECENT_BYTES=16384,RECENT_CHARS=1800,RECENT_TURNS=6;
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const failure=code=>Object.assign(new Error(code),{code});
const clone=value=>structuredClone(value);
const time=value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const nickname=value=>typeof value==='string'&&value===value.trim()&&value.length>=1&&value.length<=20&&/^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} ·・_-]*$/u.test(value);
function validKeys(value,keys){return plain(value)&&Object.keys(value).every(key=>keys.includes(key));}
function integer(value,min,max){return Number.isInteger(value)&&value>=min&&value<=max;}
function validate(settings,code='BAD_COMPANION_SETTINGS'){
  const {preferences:p,quiet:q,backoff:b,recentTopics:r,focusUntil:f}=settings;
  if(!validKeys(settings,['preferences','quiet','focusUntil','backoff','recentTopics'])||
    !validKeys(p,['preferredName','tone'])||!nickname(p.preferredName)||!['natural','gentle','lively'].includes(p.tone)||
    !validKeys(q,['enabled','start','end'])||typeof q.enabled!=='boolean'||!time(q.start)||!time(q.end)||q.start===q.end||
    !(f===null||(typeof f==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(f)&&Number.isFinite(Date.parse(f))&&new Date(f).toISOString()===f))||
    !validKeys(b,['enabled','afterUnanswered','maxMultiplier','maxIntervalSeconds'])||typeof b.enabled!=='boolean'||!integer(b.afterUnanswered,1,10)||!integer(b.maxMultiplier,1,8)||!integer(b.maxIntervalSeconds,60,3600)||
    !validKeys(r,['enabled','maxAgeMinutes'])||typeof r.enabled!=='boolean'||!integer(r.maxAgeMinutes,1,120))throw failure(code);
  return settings;
}
function merge(base,patch,code='BAD_COMPANION_SETTINGS'){
  if(!validKeys(patch,['preferences','quiet','focusUntil','backoff','recentTopics']))throw failure(code);
  const next=clone(base);
  for(const [key,value]of Object.entries(patch)){
    if(key==='focusUntil'){next[key]=value;continue;}
    if(!validKeys(value,Object.keys(base[key])))throw failure(code);
    next[key]={...base[key],...value};
  }
  return validate(next,code);
}

/** Exact local control commands only; quoted, multi-line or combined tasks fall through to ordinary chat. */
export function parseCompanionCommand(text){
  if(typeof text!=='string'||/[\r\n]/.test(text)||text.length>80)return null;
  const value=text.trim();
  if(['陪伴设置','查看陪伴设置'].includes(value))return{type:'status'};
  const named=value.match(/^(?:以后)?叫我(.+)$/u);
  if(named){
    const name=named[1].trim();
    if(nickname(name)&&!/(?:然后|顺便|同时|另外|并|帮|请|再|告诉|解释|回答|介绍|记住|语气|专注|勿扰|陪伴|退让|近期话题|恢复主动|忽略|指令|打开|运行|查询|搜索|安装|删除|清理|发送|截图|\b(?:and|then|please|ignore|run|delete|search|tell|explain)\b)/i.test(name))return{type:'configure',patch:{preferences:{preferredName:name}}};
    return null;
  }
  const tones={'语气温柔一点':'gentle','语气活泼一点':'lively','语气自然一点':'natural'};
  if(own(tones,value))return{type:'configure',patch:{preferences:{tone:tones[value]}}};
  if(['取消专注','结束专注'].includes(value))return{type:'focus',minutes:0};
  if(value==='恢复主动聊天')return{type:'resume'};
  if(/^(?:专注|勿扰)(?:一小时|1小时)$/.test(value))return{type:'focus',minutes:60};
  if(/^(?:专注|勿扰)半小时$/.test(value))return{type:'focus',minutes:30};
  const focused=value.match(/^(?:专注|勿扰)([1-9]\d{0,3})分钟$/);
  if(focused&&integer(Number(focused[1]),1,1440))return{type:'focus',minutes:Number(focused[1])};
  const quiet=value.match(/^夜间勿扰((?:[01]\d|2[0-3]):[0-5]\d)到((?:[01]\d|2[0-3]):[0-5]\d)$/);
  if(quiet&&quiet[1]!==quiet[2])return{type:'configure',patch:{quiet:{enabled:true,start:quiet[1],end:quiet[2]}}};
  if(value==='关闭夜间勿扰'||value==='开启夜间勿扰')return{type:'configure',patch:{quiet:{enabled:value==='开启夜间勿扰'}}};
  if(value==='关闭互动退让'||value==='开启互动退让')return{type:'configure',patch:{backoff:{enabled:value==='开启互动退让'}}};
  if(['关闭近期话题','开启近期话题','关闭话题衔接','开启话题衔接'].includes(value))return{type:'configure',patch:{recentTopics:{enabled:value.startsWith('开启')}}};
  if(value==='清空近期话题')return{type:'clear_recent'};
  return null;
}

function isNaturalTopic(message){
  if(!message||parseCompanionCommand(message))return false;
  if(/(?:截图|屏幕|窗口内容|视觉观察|测试(?:码|页面|窗口|文档|画面)|识别测试|screencheck|SYNTHETIC|https?:\/\/|localhost|OAuth|\bAPI\b|\/Volumes\/|\/Users\/|```)/i.test(message))return false;
  if(/^(?:请(?:你)?|帮我|给我|替我|麻烦你|先|再)?\s*(?:打开|关闭|读取|查找|搜索|查询|安装|卸载|重启|运行|执行|编译|调试|修复|部署|备份|删除|清理|下载|上传|发送|发帖|提交|接上|连接|查看|记住|忘记|忘掉|更正记忆)/.test(message))return false;
  if(/(?:帮我|请你|给我|替我|麻烦你).{0,16}(?:打开|读取|搜索|查询|安装|运行|执行|修复|发送|发帖|提交)/.test(message))return false;
  return true;
}
const excerpt=(value,max)=>Array.from(value.trim()).slice(0,max).join('');
function turnChars(turn){return turn.message.length+(turn.reply?.length||0);}

/** Local-only preferences and ephemeral conversation snippets; never reads credentials, activity or image observations. */
export function createCompanionSettings({root,now=Date.now}={}){
  if(!path.isAbsolute(root||''))throw failure('BAD_COMPANION_ROOT');
  const directory=path.join(root,'data');
  const settingsFile=path.join(directory,'companion-settings.json'),recentFile=path.join(directory,'companion-recent.json');
  let settings,turns,loaded=false,queue=Promise.resolve();
  const clock=()=>{const value=Number(typeof now==='function'?now():now);if(!Number.isFinite(value))throw failure('BAD_COMPANION_CLOCK');return value;};
  function serial(operation){const pending=queue.then(operation);queue=pending.catch(()=>{});return pending;}
  async function safeDirectory(){
    try{const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw failure('COMPANION_STORAGE_UNSAFE');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  async function safeFile(file){
    try{const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink())throw failure('COMPANION_STORAGE_UNSAFE');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  async function read(file,max){
    let handle;
    try{
      await safeDirectory();await safeFile(file);
      handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const stat=await handle.stat();
      if(!stat.isFile()||stat.size>max)throw failure('COMPANION_FILE_TOO_LARGE');
      const data=Buffer.alloc(max+1);let bytes=0;
      while(bytes<data.length){const result=await handle.read(data,bytes,data.length-bytes,bytes);if(!result.bytesRead)break;bytes+=result.bytesRead;}
      if(bytes>max)throw failure('COMPANION_FILE_TOO_LARGE');
      try{return JSON.parse(data.subarray(0,bytes).toString('utf8'));}catch{throw failure('COMPANION_FILE_INVALID');}
    }catch(error){if(error.code==='ENOENT')return undefined;throw error;}finally{await handle?.close();}
  }
  async function write(file,value,max){
    const body=JSON.stringify(value,null,2)+'\n';
    if(Buffer.byteLength(body)>max)throw failure('COMPANION_FILE_TOO_LARGE');
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    await safeDirectory();await safeFile(file);
    const temporary=file+'.'+randomUUID()+'.tmp';
    try{await fs.writeFile(temporary,body,{flag:'wx',mode:0o600});await fs.rename(temporary,file);}
    catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});throw error;}
  }
  const saveSettings=value=>write(settingsFile,{version:1,settings:value},SETTINGS_BYTES);
  const saveRecent=value=>write(recentFile,{version:1,turns:value},RECENT_BYTES);
  function pruned(value){
    const current=clock(),cutoff=current-settings.recentTopics.maxAgeMinutes*60_000;
    const kept=value.filter(turn=>Date.parse(turn.at)>cutoff&&Date.parse(turn.at)<=current&&isNaturalTopic(turn.message)).slice(-RECENT_TURNS);
    while(kept.reduce((sum,turn)=>sum+turnChars(turn),0)>RECENT_CHARS)kept.shift();
    return kept;
  }
  async function initialize(){
    if(loaded)return;
    const [stored,recent]=await Promise.all([read(settingsFile,SETTINGS_BYTES),read(recentFile,RECENT_BYTES)]);
    if(stored===undefined)settings=clone(DEFAULT_COMPANION_SETTINGS);
    else{
      if(!plain(stored))throw failure('COMPANION_SETTINGS_INVALID');
      const patch=stored.version===1&&validKeys(stored,['version','settings'])?stored.settings:stored;
      settings=merge(DEFAULT_COMPANION_SETTINGS,patch,'COMPANION_SETTINGS_INVALID');
    }
    if(recent===undefined)turns=[];
    else{
      if(!validKeys(recent,['version','turns'])||recent.version!==1||!Array.isArray(recent.turns))throw failure('COMPANION_RECENT_INVALID');
      for(const turn of recent.turns)if(!validKeys(turn,['at','message','reply'])||typeof turn.message!=='string'||!turn.message.trim()||turn.message.length>6000||typeof turn.at!=='string'||!Number.isFinite(Date.parse(turn.at))||(own(turn,'reply')&&typeof turn.reply!=='string')||(turn.reply?.length||0)>16000)throw failure('COMPANION_RECENT_INVALID');
      turns=recent.turns.map(turn=>({at:new Date(turn.at).toISOString(),message:excerpt(turn.message,360),...(turn.reply?{reply:excerpt(turn.reply,240)}:{})}));
    }
    turns=pruned(turns);
    if(settings.focusUntil&&Date.parse(settings.focusUntil)<=clock())settings.focusUntil=null;
    await saveSettings(settings);await saveRecent(turns);loaded=true;
  }
  async function refresh(){
    await initialize();
    if(settings.focusUntil&&Date.parse(settings.focusUntil)<=clock()){
      const updated={...settings,focusUntil:null};await saveSettings(updated);settings=updated;
    }
    const recent=pruned(turns);
    if(JSON.stringify(recent)!==JSON.stringify(turns)){await saveRecent(recent);turns=recent;}
  }
  return{
    get:()=>serial(async()=>{await refresh();return clone(settings);}),
    configure:patch=>serial(async()=>{
      await refresh();const updated=merge(settings,patch);
      if(own(patch,'focusUntil')&&updated.focusUntil&&Date.parse(updated.focusUntil)>clock()+1440*60_000)throw failure('BAD_COMPANION_SETTINGS');
      if(updated.focusUntil&&Date.parse(updated.focusUntil)<=clock())updated.focusUntil=null;
      await saveSettings(updated);settings=updated;
      const recent=pruned(turns);if(JSON.stringify(recent)!==JSON.stringify(turns)){await saveRecent(recent);turns=recent;}
      return clone(settings);
    }),
    recordTurn:({message,reply,hasImage=false}={})=>serial(async()=>{
      await refresh();
      if(!settings.recentTopics.enabled||typeof message!=='string'||message.length>6000||!isNaturalTopic(message.trim()))return;
      const turn={at:new Date(clock()).toISOString(),message:excerpt(message,360)};
      if(!hasImage&&typeof reply==='string'&&reply.trim()&&!/(?:截图|视觉观察|测试码|屏幕内容|窗口内容)/.test(reply))turn.reply=excerpt(reply,240);
      const recent=pruned([...turns,turn]);await saveRecent(recent);turns=recent;
    }),
    recentContext:()=>serial(async()=>{
      await refresh();if(!settings.recentTopics.enabled)return[];
      return turns.flatMap(turn=>[{role:'user',content:turn.message,at:turn.at},...(turn.reply?[{role:'assistant',content:turn.reply,at:turn.at}]:[])]);
    }),
    clearRecent:()=>serial(async()=>{await initialize();await saveRecent([]);turns=[];}),
  };
}
