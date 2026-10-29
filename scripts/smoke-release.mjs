#!/usr/bin/env node
/**
 * Offline release smoke test. Never launches the GUI, logs in, sends a model
 * request, inherits provider keys, or reads the real user's application data.
 * Usage: node scripts/smoke-release.mjs --app "dist/arm64/Whale Pet.app"
 * Cross-architecture apps receive static checks only. --static-only forces it.
 */
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const fail=(code,stage)=>Object.assign(new Error(code),{code,stage});
const check=(value,code,stage)=>{if(!value)throw fail(code,stage);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={schemaVersion:1,pass:false,checks:[],execution:'not-started'};
let temporary,serviceChild,serviceExit,serviceExited=false,bundleBefore;
let checkedApp;

function argumentsFrom(values){
  const options={staticOnly:false};
  for(let index=0;index<values.length;index++){
    const value=values[index];
    if(value==='--help'||value==='-h')options.help=true;
    else if(value==='--app')options.app=values[++index];
    else if(value==='--report')options.report=values[++index];
    else if(value==='--static-only')options.staticOnly=true;
    else if(!value.startsWith('-')&&!options.app)options.app=value;
    else throw fail('SMOKE_BAD_ARGUMENTS','arguments');
  }
  return options;
}
function record(name,details={}){report.checks.push({name,passed:true,...details});}
function capture(command,args,{env,cwd,timeoutMs=15000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env,cwd,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',settled=false;
    const timer=setTimeout(()=>{if(settled)return;child.kill('SIGTERM');reject(fail('SMOKE_COMMAND_TIMEOUT',path.basename(command)));},timeoutMs);
    const collect=key=>chunk=>{if(key==='stdout')stdout+=chunk;else stderr+=chunk;if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>2*1024*1024){child.kill('SIGTERM');}};
    child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'));
    child.once('error',()=>{settled=true;clearTimeout(timer);reject(fail('SMOKE_COMMAND_FAILED',path.basename(command)));});
    child.once('exit',(code,signal)=>{settled=true;clearTimeout(timer);if(code!==0)return reject(fail(signal?'SMOKE_COMMAND_SIGNAL':'SMOKE_COMMAND_FAILED',path.basename(command)));resolve(stdout.trim());});
  });
}
async function fileHash(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function bundleSnapshot(root){
  const entries=[];
  async function visit(directory){
    for(const name of(await fs.readdir(directory)).sort()){
      const file=path.join(directory,name),relative=path.relative(root,file),info=await fs.lstat(file);
      if(info.isSymbolicLink()){
        const target=await fs.realpath(file);
        check(target===root||target.startsWith(root+path.sep),'BUNDLE_EXTERNAL_SYMLINK','bundle');
        entries.push([relative,'symlink',await fs.readlink(file)]);
      }else if(info.isDirectory())await visit(file);
      else if(info.isFile()){
        check(!/(^|\/)(?:auth\.json|provider-config\.json|service\.json|chat\.json|companion-(?:settings|recent)\.json|knowledge-graph\.jsonl|proactive\.json|usage-ledger\.json)$/.test(relative),'BUNDLE_CONTAINS_USER_STATE','bundle');
        entries.push([relative,info.mode&0o777,info.size,await fileHash(file)]);
      }else throw fail('BUNDLE_SPECIAL_FILE','bundle');
    }
  }
  await visit(root);return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
async function architecture(file){
  const output=await capture('/usr/bin/lipo',['-archs',file]);
  const result=output.split(/\s+/).filter(value=>['arm64','arm64e','x86_64'].includes(value));
  check(result.length>0,'SMOKE_NOT_MACHO',path.basename(file));return result;
}
async function stopService(){
  if(!serviceChild||serviceExited)return;
  serviceChild.kill('SIGTERM');
  const timer=AbortSignal.timeout(10000);
  await Promise.race([serviceExit,new Promise((_,reject)=>timer.addEventListener('abort',()=>reject(fail('SMOKE_SERVICE_STOP_TIMEOUT','cleanup')),{once:true}))]);
  check(serviceExited,'SMOKE_SERVICE_STILL_RUNNING','cleanup');
}
async function ensureNoFile(file,code){
  try{await fs.lstat(file);throw fail(code,'cleanup');}catch(error){if(error.code!=='ENOENT')throw error;}
}
async function saveReport(file){
  const target=path.resolve(file),parent=await fs.realpath(path.dirname(target));
  check(!checkedApp||!(parent===checkedApp||parent.startsWith(checkedApp+path.sep)),'SMOKE_REPORT_INSIDE_APP','report');
  try{const info=await fs.lstat(target);check(info.isFile()&&!info.isSymbolicLink(),'SMOKE_REPORT_UNSAFE','report');}catch(error){if(error.code!=='ENOENT')throw error;}
  const pending=path.join(parent,'.smoke-report-'+randomUUID()+'.tmp');
  try{await fs.writeFile(pending,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(pending,target);}catch(error){await fs.rm(pending,{force:true}).catch(()=>{});throw error;}
}

async function main(options){
  check(process.platform==='darwin','SMOKE_MACOS_REQUIRED','platform');
  check(typeof options.app==='string'&&options.app.endsWith('.app'),'SMOKE_APP_REQUIRED','arguments');
  const app=await fs.realpath(path.resolve(options.app));
  checkedApp=app;
  check((await fs.lstat(app)).isDirectory(),'SMOKE_APP_REQUIRED','bundle');
  const resources=path.join(app,'Contents','Resources'),service=path.join(resources,'service');
  const executable=await capture('/usr/bin/plutil',['-extract','CFBundleExecutable','raw','-o','-',path.join(app,'Contents','Info.plist')]);
  check(executable.length>0&&!executable.includes('/')&&!executable.includes('..'),'SMOKE_BAD_EXECUTABLE','bundle');
  const native=path.join(app,'Contents','MacOS',executable),node=path.join(resources,'runtime','bin','node'),codex=path.join(resources,'runtime','codex');
  for(const file of[native,node,codex,path.join(service,'service.mjs'),path.join(service,'codex-provider.mjs'),path.join(service,'assets','pet.png')])check((await fs.stat(file)).isFile(),'SMOKE_BUNDLE_FILE_MISSING','bundle');
  for(const file of[native,node,codex])await fs.access(file,fs.constants.X_OK);
  bundleBefore=await bundleSnapshot(app);report.bundleDigest=bundleBefore;
  const architectures={native:await architecture(native),node:await architecture(node),codex:await architecture(codex)};
  const common=architectures.native.filter(arch=>architectures.node.includes(arch)&&architectures.codex.includes(arch));
  check(common.length>0,'SMOKE_ARCHITECTURE_MISMATCH','architecture');
  const host=await capture('/usr/bin/uname',['-m']);report.hostArchitecture=host;report.architectures=architectures;record('bundle-layout-and-architecture');
  if(options.staticOnly||!common.includes(host)){
    report.execution='static-only';report.reason=options.staticOnly?'requested':'different-host-architecture';
    check(await bundleSnapshot(app)===bundleBefore,'SMOKE_BUNDLE_CHANGED','bundle');record('bundle-unchanged');report.pass=true;return;
  }
  report.execution='offline-runtime';
  temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'whale-release-smoke-')));
  const appData=path.join(temporary,'application-data'),home=path.join(temporary,'home'),tmp=path.join(temporary,'tmp'),working=path.join(temporary,'working');
  for(const folder of[appData,path.join(appData,'data'),home,tmp,working])await fs.mkdir(folder,{mode:0o700});
  const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:home,TMPDIR:tmp,LANG:'en_US.UTF-8',WHALE_PET_DATA_DIR:appData,WHALE_PET_RESOURCE_DIR:service,WHALE_PET_CODEX_BINARY:codex};
  const diagnosticText=await capture(native,['--diagnostics'],{env:{...env,WHALE_PET_PORT:'43928'},cwd:working});
  let diagnostics;try{diagnostics=JSON.parse(diagnosticText);}catch{throw fail('SMOKE_DIAGNOSTICS_INVALID','diagnostics');}
  // Foundation standardizes /private/var and /var differently from Node;
  // compare the actual filesystem destinations, never just spelling aliases.
  const sameLocation=async(actual,expected)=>typeof actual==='string'&&await fs.realpath(actual)===await fs.realpath(expected);
  check(await sameLocation(diagnostics.applicationDirectory,appData)&&await sameLocation(diagnostics.dataDirectory,path.join(appData,'data'))&&await sameLocation(diagnostics.resourceDirectory,service),'SMOKE_PATH_ISOLATION_FAILED','diagnostics');
  for(const key of['serviceEntryExists','assetsExist','nodeExecutableExists','codexExecutableExists','offlinePetAvailable'])check(diagnostics[key]===true,'SMOKE_DIAGNOSTICS_MISSING_RESOURCE','diagnostics');
  check(diagnostics.screenshotsDefaultEnabled===false&&diagnostics.appInfoDefaultEnabled===false,'SMOKE_CONTEXT_NOT_OPT_IN','diagnostics');
  record('native-diagnostics-no-gui',{screenshotsDefaultEnabled:false,appInfoDefaultEnabled:false});
  report.nodeVersion=await capture(node,['--version'],{env,cwd:working});
  check(/^v24\./.test(report.nodeVersion),'SMOKE_NODE_VERSION_UNEXPECTED','runtime');record('bundled-node-version');
  const codexVersionHome=path.join(temporary,'codex-version-home');await fs.mkdir(codexVersionHome,{mode:0o700});
  report.codexVersion=await capture(codex,['--version'],{env:{...env,CODEX_HOME:codexVersionHome},cwd:working});
  check(/\b0\.164\.0\b/.test(report.codexVersion),'SMOKE_CODEX_VERSION_UNEXPECTED','runtime');record('bundled-codex-version');
  const schemas=path.join(temporary,'codex-schema');
  await capture(codex,['app-server','generate-json-schema','--experimental','--out',schemas],{env:{...env,CODEX_HOME:codexVersionHome},cwd:working,timeoutMs:20000});
  const threadSchema=JSON.parse(await fs.readFile(path.join(schemas,'v2','ThreadStartParams.json'),'utf8'));
  const turnSchema=JSON.parse(await fs.readFile(path.join(schemas,'v2','TurnStartParams.json'),'utf8'));
  const readOnly=turnSchema.definitions.SandboxPolicy.oneOf.find(value=>value.properties?.type?.enum?.includes('readOnly'));
  check(['cwd','approvalPolicy','sandbox','ephemeral','baseInstructions','developerInstructions','config'].every(key=>threadSchema.properties[key])&&threadSchema.definitions.SandboxMode.enum.includes('read-only'),'SMOKE_CODEX_THREAD_SCHEMA_INCOMPATIBLE','codex-schema');
  check(['threadId','input','approvalPolicy','sandboxPolicy','effort'].every(key=>turnSchema.properties[key])&&readOnly?.properties?.networkAccess?.type==='boolean'&&turnSchema.definitions.UserInput.oneOf.some(value=>value.properties?.type?.enum?.includes('text')&&value.properties?.text?.type==='string'),'SMOKE_CODEX_TURN_SCHEMA_INCOMPATIBLE','codex-schema');
  const effort=turnSchema.definitions.ReasoningEffort;
  check((effort.type==='string'&&'low'.length>=(effort.minLength||0))||effort.enum?.includes('low'),'SMOKE_CODEX_EFFORT_SCHEMA_INCOMPATIBLE','codex-schema');
  record('bundled-codex-generated-schema',{threadReadOnly:true,turnReadOnlyNetworkAccessBoolean:true,textInput:true,lowEffortCompatible:true,modelRequests:0});

  serviceChild=spawn(node,[path.join(service,'service.mjs')],{cwd:working,env:{...env,WHALE_PET_PORT:'0'},stdio:['ignore','pipe','pipe']});
  serviceExit=new Promise((resolve,reject)=>{serviceChild.once('exit',(code)=>{serviceExited=true;if(code===0)resolve();else reject(fail('SMOKE_SERVICE_EXIT_FAILED','service'));});serviceChild.once('error',()=>{serviceExited=true;reject(fail('SMOKE_SERVICE_SPAWN_FAILED','service'));});});
  serviceExit.catch(()=>{});serviceChild.stdout.on('data',()=>{});serviceChild.stderr.on('data',()=>{});
  const stateFile=path.join(appData,'data','service.json');let state;
  for(let attempt=0;attempt<200;attempt++){
    if(serviceExited)throw fail('SMOKE_SERVICE_EXITED_EARLY','service');
    try{state=JSON.parse(await fs.readFile(stateFile,'utf8'));break;}catch{await sleep(50);}
  }
  check(state&&state.pid===serviceChild.pid&&Number.isInteger(state.port)&&state.port>0&&state.baseURL===`http://127.0.0.1:${state.port}`&&typeof state.token==='string'&&state.token.length>=32,'SMOKE_SERVICE_NOT_READY','service');
  check(((await fs.stat(stateFile)).mode&0o077)===0,'SMOKE_TOKEN_FILE_NOT_PRIVATE','service');
  // The token is kept only in this closure and is never printed or reported.
  async function request(route,{method='GET',body,auth=true,origin,status=200}={}){
    const headers={...(auth?{Authorization:`Bearer ${state.token}`}:{})};if(body!==undefined)headers['Content-Type']='application/json';if(origin)headers.Origin=origin;
    const response=await fetch(state.baseURL+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000),redirect:'error'});
    check(response.status===status,'SMOKE_HTTP_STATUS',route);return response.json();
  }
  const health=await request('/health',{auth:false});check(health.configured===false&&health.service==='desktop-whale-pet','SMOKE_OFFLINE_START_FAILED','service');
  await request('/api/config',{auth:false,status:401});await request('/api/config',{origin:'https://example.com',status:403});
  const config=await request('/api/config');check(config.mode==='none'&&config.configured===false&&config.api.hasKey===false&&config.capabilities.chat===false&&config.capabilities.vision===false,'SMOKE_PROVIDER_DEFAULTS_UNSAFE','service');
  const proactive=await request('/api/proactive-policy');check(proactive.policy.enabled===false,'SMOKE_PROACTIVE_DEFAULT_ENABLED','service');
  const companion=await request('/api/companion-settings');check(companion.settings.preferences.preferredName==='你','SMOKE_PERSONALIZED_DEFAULT','service');
  record('offline-first-start-and-local-auth',{configured:false,mode:'none',proactiveEnabled:false,hasKey:false});

  const todo=await request('/api/todos/create',{method:'POST',body:{text:'SMOKE_ONLY_TODO'}});check(typeof todo.id==='string','SMOKE_TODO_CREATE_FAILED','local-api');
  await request('/api/todos/action',{method:'POST',body:{id:todo.id,action:'complete'}});
  const memory=await request('/api/chat',{method:'POST',body:{message:'记住：SMOKE_ONLY_MEMORY',screen:{data:'SMOKE_ONLY_PIXELS_NOT_AN_IMAGE'}}});check(memory.source==='local'&&memory.modelCalls===0&&memory.screenUsed===false,'SMOKE_LOCAL_MEMORY_USED_MODEL','local-api');
  const graph=await request('/api/memory/list');check(graph.entities.some(entity=>entity.observations.includes('SMOKE_ONLY_MEMORY')),'SMOKE_MEMORY_NOT_PERSISTED','local-api');
  await request('/api/memory/forget',{method:'POST',body:{names:graph.entities.map(entity=>entity.name)}});
  const dueAt=new Date(Date.now()+1500).toISOString(),reminder=await request('/api/reminders/create',{method:'POST',body:{text:'SMOKE_ONLY_REMINDER',dueAt}});
  let event;for(let attempt=0;attempt<80;attempt++){const inbox=await request('/api/local-events/inbox');event=inbox.events.find(value=>value.reminderId===reminder.id);if(event)break;await sleep(100);}
  check(event&&Date.parse(event.at)>=Date.parse(dueAt),'SMOKE_REMINDER_EARLY_OR_MISSING','local-api');
  const repeated=await request('/api/local-events/inbox');check(repeated.events.some(value=>value.id===event.id),'SMOKE_REMINDER_EVENT_NOT_DURABLE','local-api');
  const ack=await request('/api/local-events/ack',{method:'POST',body:{ids:[event.id]}}),again=await request('/api/local-events/ack',{method:'POST',body:{ids:[event.id]}});check(ack.acknowledged===1&&again.acknowledged===0,'SMOKE_ACK_NOT_IDEMPOTENT','local-api');
  await request('/api/reminders/action',{method:'POST',body:{id:reminder.id,action:'complete'}});
  const local=await request('/api/reminders');check(local.todos.some(value=>value.id===todo.id&&value.status==='completed')&&local.reminders.some(value=>value.id===reminder.id&&value.status==='completed'),'SMOKE_LOCAL_RECORDS_LOST','local-api');
  const usage=await request('/api/usage');check(usage.today.usage.totalTokens===0&&usage.today.modelCalls===0,'SMOKE_OFFLINE_USED_MODEL','local-api');record('local-todo-reminder-memory-and-zero-model-usage');

  const probeRoot=path.join(temporary,'codex-probe');await fs.mkdir(probeRoot,{mode:0o700});
  const code="const {createCodexProvider}=await import(process.argv[1]);const provider=createCodexProvider({root:process.argv[2]});try{const result=await provider.status({codex:{cliPath:process.argv[3]}});console.log(JSON.stringify({available:result.available,authenticated:result.authenticated,restrictedModeVerified:result.restrictedModeVerified,loginPending:result.loginPending}));}finally{await provider.close();}";
  const status=JSON.parse(await capture(node,['--input-type=module','-e',code,pathToFileURL(path.join(service,'codex-provider.mjs')).href,probeRoot,codex],{env,cwd:working,timeoutMs:20000}));
  check(status.available===true&&status.authenticated===false&&status.restrictedModeVerified===true&&status.loginPending===false,'SMOKE_CODEX_ISOLATION_PROBE_FAILED','codex');
  record('codex-empty-home-protocol-metadata-only',{authenticated:false,restrictedModeVerified:true,modelRequests:0});

  await stopService();await ensureNoFile(stateFile,'SMOKE_SERVICE_STATE_NOT_REMOVED');record('owned-service-sigterm-and-state-cleanup');
  check(await bundleSnapshot(app)===bundleBefore,'SMOKE_BUNDLE_CHANGED','bundle');record('bundle-unchanged');report.pass=true;
}

let options;
try{
  options=argumentsFrom(process.argv.slice(2));
  if(options.help){console.log('Usage: node scripts/smoke-release.mjs --app "Whale Pet.app" [--static-only] [--report file.json]\nNo GUI, account login, model requests, or real user data are used. Cross-architecture bundles receive static checks only.');}
  else await main(options);
}catch(error){report.pass=false;report.error={code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'SMOKE_FAILED',stage:error.stage||'unknown'};}
finally{
  if(!options?.help){
    try{await stopService();}catch(error){report.pass=false;report.cleanupError={code:error.code||'SMOKE_CLEANUP_FAILED'};}
    if(temporary&&(!serviceChild||serviceExited))await fs.rm(temporary,{recursive:true,force:true});
    else if(temporary)report.temporaryDataPreserved=true;
    if(options?.app&&bundleBefore){try{check(await bundleSnapshot(await fs.realpath(path.resolve(options.app)))===bundleBefore,'SMOKE_BUNDLE_CHANGED','bundle');}catch(error){report.pass=false;report.bundleIntegrityError=error.code||'SMOKE_BUNDLE_RECHECK_FAILED';}}
    if(options?.report){try{await saveReport(options.report);}catch(error){report.pass=false;report.reportError=error.code||'SMOKE_REPORT_FAILED';}}
    console.log(JSON.stringify(report,null,2));process.exitCode=report.pass?0:1;
  }
}
