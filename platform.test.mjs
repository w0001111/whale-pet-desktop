import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {appDataRoot,privateRead,privateWrite} from './provider-config.mjs';
import {findCodexBinary,createCodexEnvironment,sameCodexHome} from './codex-provider.mjs';
import {createStorageSecurity,windowsAclCommand,executePrivateCommand} from './private-storage.mjs';
import {attachParentIpc} from './service.mjs';
import {assertPrivateFile,directoryLink} from './test/platform.mjs';

async function temporary(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'whale-platform-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('data roots use the Windows local profile or an explicit override and preserve the Mac default',()=>{
  assert.equal(appDataRoot({platform:'win32',env:{LOCALAPPDATA:'C:\\Users\\Synthetic\\AppData\\Local'},home:'C:\\Users\\Synthetic'}),'C:\\Users\\Synthetic\\AppData\\Local\\WhalePet');
  assert.equal(appDataRoot({platform:'win32',env:{WHALE_PET_DATA_DIR:'D:\\Synthetic Data\\WhalePet'},home:'C:\\Users\\Synthetic'}),'D:\\Synthetic Data\\WhalePet');
  assert.equal(appDataRoot({platform:'win32',env:{},home:'C:\\Users\\Synthetic'}),'C:\\Users\\Synthetic\\AppData\\Local\\WhalePet');
  assert.equal(appDataRoot({platform:'darwin',env:{},home:'/synthetic/profile'}),'/synthetic/profile/Library/Application Support/WhalePet');
});
test('Windows finder accepts native Codex.exe only and does not fall back from a bad explicit choice',async()=>{
  const checked=[],io={constants:{F_OK:0,X_OK:1},access:async(file,mode)=>{checked.push([file,mode]);if(file!=='C:\\Tools\\codex.exe')throw new Error('missing');}};
  const options={platform:'win32',env:{PATH:'C:\\Missing;C:\\Tools',WHALE_PET_CODEX_BINARY:'C:\\Unsafe\\codex.cmd'},io};
  assert.equal(await findCodexBinary('',options),'C:\\Tools\\codex.exe');assert.ok(checked.every(([file,mode])=>file.endsWith('.exe')&&mode===0));
  assert.equal(await findCodexBinary('C:\\Unsafe\\codex.cmd',options),null);
  assert.equal(await findCodexBinary('C:\\Missing\\codex.exe',options),null);
});
test('Windows Codex gets isolated profile, roaming/local app data and temp without ambient credentials',()=>{
  const env=createCodexEnvironment({platform:'win32',root:'D:\\Synthetic Pet',binary:'C:\\Bundle\\codex.exe',env:{PATH:'C:\\System',SystemRoot:'C:\\Windows',HOME:'C:\\Private',USERPROFILE:'C:\\Private',APPDATA:'C:\\Private\\Roaming',LOCALAPPDATA:'C:\\Private\\Local',OPENAI_API_KEY:'SYNTHETIC-DO-NOT-INHERIT',CODEX_API_KEY:'SYNTHETIC-DO-NOT-INHERIT',CODEX_HOME:'C:\\Private\\Codex',AZURE_OPENAI_API_KEY:'SYNTHETIC-DO-NOT-INHERIT',WHALE_PET_PARENT_IPC:'1'}});
  assert.equal(env.USERPROFILE,'D:\\Synthetic Pet\\codex-system-home');assert.equal(env.HOME,env.USERPROFILE);
  assert.equal(env.APPDATA,env.USERPROFILE+'\\Roaming');assert.equal(env.LOCALAPPDATA,env.USERPROFILE+'\\Local');
  for(const key of ['TEMP','TMP','TMPDIR'])assert.equal(env[key],'D:\\Synthetic Pet\\codex-tmp');
  assert.equal(env.SystemRoot,'C:\\Windows');assert.equal(env.WINDIR,'C:\\Windows');assert.equal(env.CODEX_HOME,'D:\\Synthetic Pet\\codex-home');
  assert.ok(!JSON.stringify(env).includes('SYNTHETIC-DO-NOT-INHERIT'));assert.equal(env.WHALE_PET_PARENT_IPC,undefined);assert.equal(env.PATH.split(';')[0],'C:\\Bundle');
  assert.equal(sameCodexHome('\\\\?\\C:\\Synthetic\\Codex','c:/synthetic/codex',{platform:'win32'}),true);
  assert.equal(sameCodexHome('C:\\Other','C:\\Synthetic\\Codex',{platform:'win32'}),false);
});
test('private ACL invocation is literal, no-profile, bounded and grants only current SID plus SYSTEM',()=>{
  const target="C:\\Synthetic\\quote'$(not-code)\\data",command=windowsAclCommand(target,true,{env:{SystemRoot:'C:\\Windows',OPENAI_API_KEY:'SYNTHETIC-DO-NOT-INHERIT'}});
  const script=Buffer.from(command.args.at(-1),'base64').toString('utf16le');
  assert.match(script,/SetAccessRuleProtection\(\$true,\$false\)/);assert.match(script,/WindowsIdentity\]::GetCurrent\(\)\.User/);assert.match(script,/S-1-5-18/);assert.match(script,/ReparsePoint/);
  assert.equal(script.includes(target),false);assert.ok(script.includes(Buffer.from(target).toString('base64')));
  assert.ok(command.args.includes('-NoProfile'));assert.ok(!command.args.includes('-ExecutionPolicy'));assert.equal(command.options.windowsHide,true);assert.equal(command.options.timeout,15000);assert.equal(command.options.env.OPENAI_API_KEY,undefined);
  assert.match(script,/\[IO\.Directory\]::SetAccessControl/);assert.equal(script.includes('Get-Item'),false);assert.equal(script.includes('Set-Acl'),false);assert.match(script,/exit 0/);
  assert.equal(command.options.env.USERPROFILE,target);assert.ok(command.options.env.PSModulePath.endsWith('WindowsPowerShell\\v1.0\\Modules'));
});
test('private helper closes stdin rather than leaving a child waiting on the parent input pipe',async()=>{
  const {stdout}=await executePrivateCommand(process.execPath,['-e','process.stdin.resume();process.stdin.once("end",()=>process.stdout.write("SYNTHETIC-EOF"));'],{timeout:2000,windowsHide:true});
  assert.equal(stdout,'SYNTHETIC-EOF');
});
test('Windows private storage applies ACL only to app data, caches secured identities and never uses O_NOFOLLOW',async t=>{
  const root=await temporary(t),directory=path.join(root,'data'),calls=[],flags=[];
  const io={...fs,constants:{...fs.constants,O_NOFOLLOW:undefined},open:async(file,flag,...rest)=>{flags.push(flag);return fs.open(file,flag,...rest);}};
  const security=createStorageSecurity({platform:'win32',io,executeImpl:async(...args)=>{calls.push(args);}});
  await security.directory(directory);await security.directory(directory);assert.equal(calls.length,1);
  const file=path.join(directory,'state.json');await fs.writeFile(file,'{}',{flag:'wx'});await security.created(file);
  const handle=await security.openRead(file);assert.equal(await handle.readFile('utf8'),'{}');await handle.close();
  assert.equal(calls.length,1);assert.deepEqual(flags,[fs.constants.O_RDONLY]);
  const directoryScript=Buffer.from(calls[0][1].at(-1),'base64').toString('utf16le');assert.ok(directoryScript.includes(Buffer.from(directory).toString('base64')));assert.ok(!directoryScript.includes(Buffer.from(root).toString('base64')+"'"));
});
test('ACL failure is closed and junctions/hard links are rejected before a private read',async t=>{
  const root=await temporary(t),directory=path.join(root,'data');
  const denied=createStorageSecurity({platform:'win32',executeImpl:async()=>{throw new Error('synthetic policy denial');}});
  await assert.rejects(denied.directory(directory),{code:'PRIVATE_ACL_UNAVAILABLE'});
  const security=createStorageSecurity({platform:'win32',executeImpl:async()=>{}});await security.directory(directory);
  const outside=path.join(root,'outside.json');await fs.writeFile(outside,'DO_NOT_READ');const linked=path.join(directory,'linked.json');await fs.link(outside,linked);
  await assert.rejects(security.openRead(linked),{code:'UNSAFE_STORAGE'});assert.equal(await fs.readFile(outside,'utf8'),'DO_NOT_READ');
  await directoryLink(directory,path.join(root,'junction'));await assert.rejects(security.directory(path.join(root,'junction')),{code:'UNSAFE_STORAGE'});
});
test('no-follow fallback checks opened identity before any bytes can be read',async t=>{
  const root=await temporary(t),directory=path.join(root,'data');await fs.mkdir(directory);const file=path.join(directory,'state.json');await fs.writeFile(file,'ORIGINAL');
  let openedHandle;
  const io={...fs,open:async(...args)=>{const handle=await fs.open(...args);openedHandle=handle;await fs.rename(file,path.join(directory,'previous.json'));await fs.writeFile(file,'REPLACEMENT');return handle;}};
  const security=createStorageSecurity({platform:'win32',io,executeImpl:async()=>{}});
  await assert.rejects(security.openRead(file),{code:'UNSAFE_STORAGE'});await assert.rejects(openedHandle.readFile('utf8'));
  assert.equal(await fs.readFile(file,'utf8'),'REPLACEMENT');
});
test('private append retains task evidence and refuses an outside linked log target',async t=>{
  const root=await temporary(t),file=path.join(root,'data','tasks','task.jsonl');const security=createStorageSecurity({platform:'win32',executeImpl:async()=>{}});
  for(const value of ['first\n','second\n']){const handle=await security.openAppend(file);try{await handle.writeFile(value);}finally{await handle.close();}}
  assert.equal(await fs.readFile(file,'utf8'),'first\nsecond\n');
  const outside=path.join(root,'outside.jsonl');await fs.writeFile(outside,'DO_NOT_APPEND');const linked=path.join(path.dirname(file),'linked.jsonl');await fs.link(outside,linked);
  await assert.rejects(security.openAppend(linked),{code:'UNSAFE_STORAGE'});assert.equal(await fs.readFile(outside,'utf8'),'DO_NOT_APPEND');
});
test('private JSON remains bounded, durable and protected on the real host platform',async t=>{
  const root=await temporary(t),file=path.join(root,'data','record.json');
  await privateWrite(file,{synthetic:true});assert.deepEqual(await privateRead(file),{synthetic:true});await assertPrivateFile(file);
  await assert.rejects(privateRead(file,2),{code:'STATE_TOO_LARGE'});assert.deepEqual(await privateRead(file),{synthetic:true});
});
test('parent IPC is opt-in, exact, bounded, split-line safe and handles parent EOF once',async()=>{
  const ordinary=new PassThrough();let calls=0;const noop=attachParentIpc({enabled:false,input:ordinary,onShutdown:()=>calls++});assert.equal(ordinary.listenerCount('data'),0);noop();
  const input=new PassThrough(),dispose=attachParentIpc({enabled:true,input,onShutdown:()=>calls++});
  input.write('not json\n{"type":"shutdown","extra":true}\n{"type":"other"}\n');assert.equal(calls,0);
  input.write('x'.repeat(5000)+'\n');input.write('{"type":"shut');input.write('down"}\n');assert.equal(calls,1);input.end();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);dispose();
  const eof=new PassThrough();attachParentIpc({enabled:true,input:eof,onShutdown:()=>calls++});eof.end();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
});
test('a fresh isolated service exits through parent IPC and removes only its own service state',async t=>{
  const root=await temporary(t),data=path.join(root,'app'),home=path.join(root,'profile');await fs.mkdir(home);let state;
  const env={...process.env,WHALE_PET_DATA_DIR:data,WHALE_PET_PORT:'0',WHALE_PET_PARENT_IPC:'1',HOME:home,USERPROFILE:home,APPDATA:path.join(home,'Roaming'),LOCALAPPDATA:path.join(home,'Local')};
  for(const key of Object.keys(env))if(/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|^CODEX_HOME$)/i.test(key))delete env[key];
  const child=spawn(process.execPath,[path.join(import.meta.dirname,'service.mjs')],{env,cwd:root,stdio:['pipe','ignore','ignore'],windowsHide:true});
  let exited=false;const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});}));t.after(async()=>{if(!exited){child.kill('SIGKILL');await exit;}});
  const file=path.join(data,'data','service.json'),deadline=Date.now()+60000;
  while(Date.now()<deadline&&!exited){try{state=JSON.parse(await fs.readFile(file,'utf8'));break;}catch{}await new Promise(resolve=>setTimeout(resolve,30));}
  assert.ok(state,'isolated service reached ready state');assert.equal(state.pid,child.pid);assert.ok(state.port>0);assert.equal(new URL(state.baseURL).hostname,'127.0.0.1');
  const headers={Authorization:'Bearer '+state.token};const configuration=await(await fetch(state.baseURL+'/api/config',{headers})).json();assert.equal(configuration.mode,'none');assert.equal(configuration.api.hasKey,false);
  child.stdin.write('{"type":"shutdown"}\n');const result=await Promise.race([exit,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('parent IPC shutdown timed out')),10000);timer.unref();})]);
  assert.deepEqual(result,{code:0,signal:null});await assert.rejects(fs.stat(file),{code:'ENOENT'});assert.equal((await fs.readdir(home)).length,0);
});
