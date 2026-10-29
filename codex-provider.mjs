import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fail} from './provider-config.mjs';
import {emptyUsage} from './api-provider.mjs';
import {storageSecurity} from './private-storage.mjs';

// Verified against the official 0.164 app-server JSON schema. No ambient
// credentials, home config, tools, MCP servers or user workspaces are imported.
export const CODEX_CONFIG=Object.freeze({
  approval_policy:'never',sandbox_mode:'read-only',cli_auth_credentials_store:'file',
  project_doc_max_bytes:0,project_doc_fallback_filenames:[],web_search:'disabled',
  'features.shell_tool':false,'features.shell_snapshot':false,'features.apps':false,
  'features.browser_use':false,'features.computer_use':false,'features.multi_agent':false,
  'features.remote_plugin':false,'features.tool_suggest':false,'features.memories':false,
  'agents.enabled':false,
  'tools.view_image':false,'tools.web_search':false,'mcp_servers':{},
  'shell_environment_policy.inherit':'none','analytics.enabled':false,
});
export async function findCodexBinary(configured='',{platform=process.platform,env=process.env,io=fs}={}){
  const paths=platform==='win32'?path.win32:path;
  const candidates=configured?[configured]:[env.WHALE_PET_CODEX_BINARY,...(env.PATH||env.Path||'').split(paths.delimiter).filter(Boolean).map(folder=>paths.join(folder,platform==='win32'?'codex.exe':'codex'))].filter(Boolean);
  for(const candidate of candidates){
    // A .cmd/.bat shim requires a shell; only launch a native executable on Windows.
    if(platform==='win32'&&!/\.exe$/i.test(candidate))continue;
    try{await io.access(candidate,platform==='win32'?io.constants.F_OK:io.constants.X_OK);return paths.resolve(candidate);}catch{}
  }
  return null;
}
export function createCodexEnvironment({root,binary,platform=process.platform,env=process.env}={}){
  const paths=platform==='win32'?path.win32:path,profile=paths.join(root,'codex-system-home'),temporary=paths.join(root,'codex-tmp');
  const result={PATH:env.PATH||env.Path||(platform==='win32'?'':'/usr/bin:/bin'),HOME:profile,CODEX_HOME:paths.join(root,'codex-home'),TMPDIR:temporary,TEMP:temporary,TMP:temporary,LANG:env.LANG||'en_US.UTF-8'};
  if(platform==='win32'){
    const systemRoot=env.SystemRoot||env.SYSTEMROOT||env.WINDIR||'C:\\Windows';
    Object.assign(result,{USERPROFILE:profile,APPDATA:paths.join(profile,'Roaming'),LOCALAPPDATA:paths.join(profile,'Local'),SystemRoot:systemRoot,WINDIR:systemRoot});
    result.PATH=[binary?paths.dirname(binary):'',paths.join(systemRoot,'System32'),result.PATH].filter(Boolean).join(';');
  }
  for(const key of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY'])if(env[key])result[key]=env[key];
  return result;
}
export function sameCodexHome(left,right,{platform=process.platform}={}){
  if(typeof left!=='string'||typeof right!=='string')return false;
  if(platform==='win32')return path.win32.resolve(left.replace(/^\\\\\?\\/,'' )).toLowerCase()===path.win32.resolve(right.replace(/^\\\\\?\\/,'')).toLowerCase();
  return path.resolve(left)===path.resolve(right);
}
export function createCodexProvider({root,spawnImpl=spawn,findBinary=findCodexBinary}={}){
  const home=path.join(root,'codex-home'),workspace=path.join(root,'codex-workspace'),systemHome=path.join(root,'codex-system-home');
  let child=null,initializing=null,nextId=0,buffer='',active=null,ready=false,restrictedModeVerified=false;
  const pending=new Map();let loginState={loginPending:false};
  function send(value){if(!child?.stdin?.writable)throw fail('CODEX_NOT_RUNNING');child.stdin.write(JSON.stringify(value)+'\n');}
  function request(method,params={},timeoutMs=15000){
    const id=++nextId;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(fail('CODEX_RPC_TIMEOUT'));},timeoutMs);pending.set(id,{resolve,reject,timer});try{send({id,method,params});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}});
  }
  function rejectAll(){ready=false;restrictedModeVerified=false;for(const value of pending.values()){clearTimeout(value.timer);value.reject(fail('CODEX_DISCONNECTED'));}pending.clear();active?.reject(fail('CODEX_DISCONNECTED'));}
  function stopChild(){ready=false;restrictedModeVerified=false;if(child){const owned=child;child=null;owned.kill?.('SIGKILL');}rejectAll();}
  async function closeChild(){
    const owned=child;if(!owned){rejectAll();return;}
    child=null;rejectAll();
    // Closing the owned app-server's input is the portable graceful path.
    // Windows kill(SIGTERM) is forceful, so use a bounded hard-stop only after EOF.
    let timer;const ended=new Promise(resolve=>{const finish=()=>{clearTimeout(timer);resolve();};owned.once('exit',finish);owned.once('error',finish);timer=setTimeout(()=>{owned.kill?.('SIGKILL');finish();},2000);});
    try{owned.stdin.end();}catch{owned.kill?.('SIGKILL');}
    await ended;
  }
  function deny(message){
    let result;
    if(message.method.includes('requestApproval')&&(message.method.includes('commandExecution')||message.method.includes('fileChange')))result={decision:'decline'};
    else if(message.method.includes('permissions/requestApproval'))result={permissions:{},scope:'turn'};
    else if(message.method==='item/tool/call')result={contentItems:[{type:'inputText',text:'This desktop companion does not execute Codex tools.'}],success:false};
    else if(message.method==='tool/requestUserInput')result={answers:{}};
    try{send(result?{id:message.id,result}:{id:message.id,error:{code:-32601,message:'Disabled in Whale Pet Desktop.'}});}catch{}
    if(active){active.reject(fail('UNSAFE_TOOL_ATTEMPT'));stopChild();}
  }
  function receive(message){
    if(message.method&&message.id!==undefined){deny(message);return;}
    if(message.id!==undefined){const value=pending.get(message.id);if(!value)return;pending.delete(message.id);clearTimeout(value.timer);message.error?value.reject(fail('CODEX_RPC_REJECTED')):value.resolve(message.result);return;}
    if(message.method==='account/login/completed'){loginState={loginPending:false,message:message.params?.success?'登录已完成。':'登录未完成，请重试。'};return;}
    if(!active||message.params?.threadId!==active.threadId)return;
    const params=message.params||{};
    if(message.method==='item/started'&&!['userMessage','agentMessage','reasoning'].includes(params.item?.type)){active.reject(fail('UNSAFE_TOOL_ATTEMPT'));stopChild();return;}
    if(message.method==='item/agentMessage/delta'){active.text+=params.delta||'';if(active.text.length>16000){active.reject(fail('MODEL_OUTPUT_LIMIT'));stopChild();}}
    if(message.method==='item/completed'&&params.item?.type==='agentMessage'&&typeof params.item.text==='string')active.final=params.item.text;
    if(message.method==='thread/tokenUsage/updated')active.usage=params.tokenUsage?.total||params.tokenUsage?.last;
    if(message.method==='turn/completed'){
      if(params.turn?.status!=='completed')active.reject(fail('CODEX_TURN_FAILED'));
      else active.resolve({text:active.final||active.text,rawUsage:active.usage});
    }
    if(message.method==='error')active.reject(fail('CODEX_TURN_FAILED'));
  }
  async function ensure(config){
    if(ready)return;
    if(initializing)return initializing;
    initializing=(async()=>{
      const binary=await findBinary(config.codex.cliPath);if(!binary)throw fail('CODEX_CLI_MISSING');
      for(const folder of [home,workspace,systemHome,path.join(root,'codex-tmp'),path.join(systemHome,'Roaming'),path.join(systemHome,'Local')])await storageSecurity.directory(folder);
      for(const name of ['auth.json','config.toml','requirements.toml']){try{await storageSecurity.protectExisting(path.join(home,name));}catch(error){if(error.code!=='ENOENT')throw error;}}
      const args=['app-server','--listen','stdio://',...Object.entries(CODEX_CONFIG).flatMap(([key,value])=>['-c',`${key}=${JSON.stringify(value)}`])];
      const env=createCodexEnvironment({root,binary});
      child=spawnImpl(binary,args,{cwd:workspace,env,stdio:['pipe','pipe','pipe'],windowsHide:true});buffer='';
      const owned=child;
      const decoder=new TextDecoder();
      child.stdout.on('data',chunk=>{buffer+=decoder.decode(chunk,{stream:true});if(Buffer.byteLength(buffer)>2*1024*1024){stopChild();return;}while(buffer.includes('\n')){const index=buffer.indexOf('\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{receive(JSON.parse(line));}catch{stopChild();return;}}});
      child.stderr.on('data',()=>{}); // Provider/auth errors must never enter logs.
      child.on('error',()=>{if(child===owned)rejectAll();});child.on('exit',()=>{if(child===owned){child=null;rejectAll();}});
      const initialized=await request('initialize',{clientInfo:{name:'whale_pet_desktop',version:'0.2.0'}});
      send({method:'initialized'});
      const version=initialized?.userAgent?.match(/\/(\d+\.\d+\.\d+)/)?.[1];
      const effective=await request('config/read',{includeLayers:false});
      // ConfigReadResponse.ToolsV2 projects only web_search in 0.164, so it
      // cannot echo view_image. That documented option is always passed above;
      // verify every observable restriction, but never claim a no-tools table.
      restrictedModeVerified=/^0\.164\.\d+$/.test(version||'')&&sameCodexHome(initialized.codexHome,home)&&effective?.config?.features?.shell_tool===false&&['apps','multi_agent','browser_use','computer_use','remote_plugin','tool_suggest'].every(key=>effective.config.features[key]===false)&&effective.config.web_search==='disabled'&&effective.config.project_doc_max_bytes===0&&Object.keys(effective.config.mcp_servers||{}).length===0&&effective.config.sandbox_mode==='read-only'&&effective.config.approval_policy==='never';
      ready=true;
    })();
    try{await initializing;}catch(error){stopChild();throw error;}finally{initializing=null;}
  }
  return{
    async status(config){
      const available=!!await findBinary(config.codex.cliPath);if(!available)return{available:false,authenticated:false,loginPending:false,message:'尚未找到官方 Codex CLI；API 或离线模式仍可使用。'};
      try{await ensure(config);const result=await request('account/read',{refreshToken:false});return{available:true,authenticated:result.account?.type==='chatgpt',restrictedModeVerified,...loginState,...(!restrictedModeVerified?{message:'当前 CLI 版本或受限配置尚未通过核查；登录可用，AI 生成暂不开放。'}:{}),...(loginState.authUrl?{url:loginState.authUrl}:{})};}
      catch(error){return{available:true,authenticated:false,loginPending:false,restrictedModeVerified:false,errorCode:error?.code||'CODEX_UNAVAILABLE',message:'Codex 服务尚未就绪，请检查官方 CLI 版本与路径。'};}
    },
    async login(config){await ensure(config);const result=await request('account/login/start',{type:'chatgpt'});let url;try{url=new URL(result.authUrl);}catch{throw fail('CODEX_LOGIN_URL_INVALID');}if(url.protocol!=='https:'||!['auth.openai.com','chatgpt.com','auth0.openai.com'].includes(url.hostname))throw fail('CODEX_LOGIN_URL_INVALID');loginState={loginPending:true,loginId:result.loginId,authUrl:url.href};return{type:'chatgpt',...loginState,url:url.href};},
    async cancelLogin(config,{loginId}={}){await ensure(config);if(loginId)await request('account/login/cancel',{loginId});loginState={loginPending:false};return{success:true};},
    async logout(config){await ensure(config);await request('account/logout');loginState={loginPending:false};return{success:true};},
    reset(){stopChild();},
    async complete(config,{systemPrompt,messages,screen,signal,onScreenSend}={}){
      await ensure(config);if(!restrictedModeVerified)throw fail('CODEX_SECURITY_UNVERIFIED');if(active)throw fail('PROVIDER_BUSY');
      const started=await request('thread/start',{...(config.model?{model:config.model}:{}),cwd:workspace,approvalPolicy:'never',sandbox:'read-only',ephemeral:true,baseInstructions:'You are a text-only desktop companion. You have no permission to invoke tools.',developerInstructions:systemPrompt,config:CODEX_CONFIG});
      const threadId=started?.thread?.id;if(typeof threadId!=='string')throw fail('CODEX_THREAD_INVALID');
      const content=messages.map(message=>`[${message.role}]\n${message.content}`).join('\n\n');
      const input=[{type:'text',text:content}];if(screen)input.push({type:'image',url:`data:${screen.mimeType};base64,${screen.data}`});
      const deadline=AbortSignal.timeout(60000),combined=signal?AbortSignal.any([signal,deadline]):deadline;
      let cleanup;
      const done=new Promise((resolve,reject)=>{active={threadId,text:'',final:'',usage:undefined,resolve,reject};const abort=()=>{reject(fail('MODEL_ABORTED'));stopChild();};combined.addEventListener('abort',abort,{once:true});cleanup=()=>combined.removeEventListener('abort',abort);if(combined.aborted)abort();});
      done.catch(()=>{});
      try{
        if(screen)await onScreenSend?.();
        await request('turn/start',{threadId,input,approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false},effort:'low'});
        const result=await done;if(!result.text.trim())throw fail('MODEL_EMPTY_REPLY');
        const raw=result.rawUsage,usage=emptyUsage();
        if(raw){usage.cacheRead=Math.max(0,raw.cachedInputTokens||0);usage.cacheWrite=Math.max(0,raw.cacheWriteInputTokens||0);usage.input=Math.max(0,(raw.inputTokens||0)-usage.cacheRead-usage.cacheWrite);usage.output=Math.max(0,raw.outputTokens||0);usage.totalTokens=Math.max(0,raw.totalTokens||usage.input+usage.cacheRead+usage.cacheWrite+usage.output);}
        return{text:result.text.trim().slice(0,16000),model:config.model||'codex-default',source:'codex',usage,usageIncomplete:!raw,usageScope:'codex-thread-reported',modelCalls:1,modelCallsAreTurns:true,toolCalls:0};
      }finally{cleanup?.();active=null;}
    },
    async close(){await closeChild();},
  };
}
