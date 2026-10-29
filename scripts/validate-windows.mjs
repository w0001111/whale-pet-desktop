#!/usr/bin/env node
// Isolated release validation: no account login, model calls, or desktop capture.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
const options={};for(let i=2;i<process.argv.length;i+=2)options[process.argv[i]]=process.argv[i+1];
const app=path.resolve(options['--app']||'dist/windows-x64/Whale Pet');
const output=path.resolve(options['--output']||'build/windows-validation');
const report={schemaVersion:1,platform:process.platform,pass:false,checks:[],modelRequests:0,loginPerformed:false,desktopCaptured:false};
const check=(value,code)=>{if(!value)throw Object.assign(new Error(code),{code});};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let temporary,child,childDone,exited=false;
function command(exe,args,env,timeout=120000){return new Promise((resolve,reject)=>{
  const proc=spawn(exe,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='',error='';
  const timer=setTimeout(()=>{proc.kill();reject(Object.assign(new Error('COMMAND_TIMEOUT'),{code:'COMMAND_TIMEOUT'}));},timeout);
  proc.stdout.on('data',c=>text+=c);proc.stderr.on('data',c=>error+=c);
  proc.on('error',()=>{clearTimeout(timer);reject(Object.assign(new Error('COMMAND_START_FAILED'),{code:'COMMAND_START_FAILED'}));});
  proc.on('exit',code=>{clearTimeout(timer);code===0?resolve(text.trim()):reject(Object.assign(new Error('COMMAND_FAILED'),{code:'COMMAND_FAILED'}));});
});}
try{
  check(process.platform==='win32','WINDOWS_REQUIRED');
  await fs.mkdir(output,{recursive:true});temporary=await fs.mkdtemp(path.join(os.tmpdir(),'whale-release-validation-'));
  const home=path.join(temporary,'home'),root=path.join(temporary,'application'),tmp=path.join(temporary,'tmp');
  for(const folder of[home,root,tmp,path.join(home,'Roaming'),path.join(home,'Local')])await fs.mkdir(folder,{recursive:true});
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR||process.env.SystemRoot,
    HOME:home,USERPROFILE:home,APPDATA:path.join(home,'Roaming'),LOCALAPPDATA:path.join(home,'Local'),TEMP:tmp,TMP:tmp,TMPDIR:tmp,
    WHALE_PET_DATA_DIR:root,WHALE_PET_RESOURCE_DIR:path.join(app,'service'),WHALE_PET_CODEX_BINARY:path.join(app,'runtime','codex.exe'),
    CODEX_HOME:path.join(temporary,'version-home')};
  const native=path.join(app,'WhalePet.exe'),node=path.join(app,'runtime','bin','node.exe'),codex=path.join(app,'runtime','codex.exe');
  report.nodeVersion=await command(node,['--version'],env);check(report.nodeVersion==='v24.22.2','NODE_VERSION');
  report.codexVersion=await command(codex,['--version'],env);check(report.codexVersion.includes('0.164.0'),'CODEX_VERSION');
  const diagnostics=JSON.parse(await command(native,['--diagnostics'],env));
  for(const key of['serviceEntryExists','assetsExist','nodeExecutableExists','codexExecutableExists','offlinePetAvailable'])check(diagnostics[key]===true,'NATIVE_RESOURCES');
  check(diagnostics.guiStarted===false&&diagnostics.serviceStarted===false&&diagnostics.userStateRead===false,'DIAGNOSTICS_SIDE_EFFECTS');
  check(diagnostics.screenshotsDefaultEnabled===false&&diagnostics.appInfoDefaultEnabled===false,'CONTEXT_DEFAULTS');
  report.checks.push('bundled-runtimes-and-native-diagnostics');
  const ui=path.join(output,'ui');await fs.mkdir(ui,{recursive:true});
  await command(native,['--self-test','--self-test-output',ui],env,180000);
  report.native=JSON.parse(await fs.readFile(path.join(ui,'self-test.json'),'utf8'));
  check(report.native.passed===true,'WPF_SELF_TEST');report.checks.push('synthetic-wpf-controls-animation-and-rendering');
  child=spawn(node,[path.join(app,'service','service.mjs')],{env:{...env,WHALE_PET_PORT:'0',WHALE_PET_PARENT_IPC:'1'},cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
  childDone=new Promise((resolve,reject)=>{child.on('error',()=>reject(new Error('SERVICE_START_FAILED')));child.on('exit',code=>{exited=true;resolve(code);});});
  const stateFile=path.join(root,'data','service.json');let state;
  for(let i=0;i<900;i++){check(!exited,'SERVICE_EARLY_EXIT');try{state=JSON.parse(await fs.readFile(stateFile,'utf8'));break;}catch{await delay(100);}}
  check(state&&state.pid===child.pid&&state.port>0&&state.baseURL===`http://127.0.0.1:${state.port}`&&state.token?.length>=32,'PRIVATE_SERVICE_READY');
  async function request(route,body,expected=200,auth=true){
    const r=await fetch(state.baseURL+route,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:`Bearer ${state.token}`}:{}) ,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000),redirect:'error'});
    check(r.status===expected,'LOCAL_API_STATUS');return r.json();
  }
  await request('/api/config',undefined,401,false);const config=await request('/api/config');
  check(config.mode==='none'&&!config.configured&&!config.api.hasKey,'OFFLINE_DEFAULT');
  check((await request('/api/proactive-policy')).policy.enabled===false,'PROACTIVE_DEFAULT');
  report.checks.push('private-loopback-auth-and-offline-defaults');
  const todo=await request('/api/todos/create',{text:'SYNTHETIC-WINDOWS-TODO'});check(!!todo.id,'TODO_CREATE');
  await request('/api/todos/action',{id:todo.id,action:'complete'});
  const remembered=await request('/api/chat',{message:'记住：SYNTHETIC-WINDOWS-MEMORY'});check(remembered.source==='local'&&remembered.modelCalls===0,'LOCAL_MEMORY');
  const dueAt=new Date(Date.now()+3000).toISOString();const reminder=await request('/api/reminders/create',{text:'SYNTHETIC-WINDOWS-REMINDER',dueAt});let event;
  for(let i=0;i<180;i++){const inbox=await request('/api/local-events/inbox');event=inbox.events.find(x=>x.reminderId===reminder.id);if(event)break;await delay(100);}
  check(event&&Date.parse(event.at)>=Date.parse(dueAt),'REMINDER_DELIVERY');
  check((await request('/api/local-events/ack',{ids:[event.id]})).acknowledged===1,'REMINDER_ACK');
  check((await request('/api/local-events/ack',{ids:[event.id]})).acknowledged===0,'REMINDER_ACK_IDEMPOTENT');
  const usage=await request('/api/usage');check(usage.today.modelCalls===0&&usage.today.usage.totalTokens===0,'ZERO_MODEL_USAGE');
  report.checks.push('local-todos-memory-real-timer-and-usage');
  const status=await request('/api/codex/status');
  check(status.available===true&&status.authenticated===false&&status.restrictedModeVerified===true,'CODEX_EMPTY_HOME_RESTRICTIONS');
  report.checks.push('bundled-codex-empty-home-protocol-no-login');
  child.stdin.end(JSON.stringify({type:'shutdown'})+'\n');
  const exit=await Promise.race([childDone,delay(30000).then(()=>-999)]);check(exit===0,'GRACEFUL_IPC_SHUTDOWN');
  let removed=false;try{await fs.stat(stateFile);}catch(e){removed=e.code==='ENOENT';}check(removed,'SERVICE_STATE_REMOVED');
  report.checks.push('parent-ipc-clean-shutdown');report.pass=true;
}catch(error){report.error={code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'WINDOWS_VALIDATION_FAILED'};}
finally{
  if(child&&!exited){try{child.stdin.end('{"type":"shutdown"}\n');await Promise.race([childDone,delay(10000)]);}catch{}if(!exited)child.kill();}
  if(temporary&&(!child||exited))await fs.rm(temporary,{recursive:true,force:true}).catch(()=>{});
  await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'smoke-windows.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));process.exitCode=report.pass?0:1;
}
