import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createProviderConfig} from './provider-config.mjs';
import {createApiProvider} from './api-provider.mjs';
import {createCodexProvider,CODEX_CONFIG} from './codex-provider.mjs';
import {createDesktopBackend} from './desktop-backend.mjs';
import {createChatServer,createScreenBudget} from './service.mjs';

async function fixture(t){const root=await fs.mkdtemp('/private/tmp/whale-public-provider-');t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const fakeKey='TEST_ONLY_NOT_A_CREDENTIAL';
const apiConfig={mode:'api',model:'mock-model',api:{format:'responses',baseURL:'https://example.com/v1',apiKey:fakeKey},codex:{cliPath:''}};
const result={text:'测试回复',model:'mock-model',source:'api',usage:{input:10,output:2,cacheRead:0,cacheWrite:0,totalTokens:12},modelCalls:1,toolCalls:0};
function rpcFixture({version='0.164.0',unsafe=false}={}){
  const requests=[],children=[];let spawnOptions;
  function spawnImpl(binary,args,options){
    spawnOptions={binary,args,...options};const child=new EventEmitter();children.push(child);child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;setImmediate(()=>child.emit('exit',0));};
    const emit=message=>child.stdout.write(JSON.stringify(message)+'\n');let buffer='';
    child.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const index=buffer.indexOf('\n'),message=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);requests.push(message);if(!message.method)continue;
      let response={};
      if(message.method==='initialize')response={userAgent:`whale_pet_desktop/${version}`,codexHome:options.env.CODEX_HOME};
      if(message.method==='config/read')response={config:{features:{shell_tool:false,apps:false,multi_agent:false,browser_use:false,computer_use:false,remote_plugin:false,tool_suggest:false},tools:{web_search:null},web_search:'disabled',project_doc_max_bytes:0,mcp_servers:{},sandbox_mode:'read-only',approval_policy:'never'}};
      if(message.method==='account/read')response={account:{type:'chatgpt'},requiresOpenaiAuth:true};
      if(message.method==='account/login/start')response={type:'chatgpt',loginId:'mock-login',authUrl:'https://auth.openai.com/authorize?test_only=1'};
      if(message.method==='thread/start')response={thread:{id:'mock-thread'}};
      if(message.id!==undefined)emit({id:message.id,result:response});
      if(message.method==='turn/start')setImmediate(()=>{
        if(unsafe){emit({id:'server-approval',method:'item/commandExecution/requestApproval',params:{threadId:'mock-thread'}});return;}
        emit({method:'item/started',params:{threadId:'mock-thread',item:{type:'agentMessage',id:'msg'}}});
        emit({method:'item/agentMessage/delta',params:{threadId:'mock-thread',delta:'官方协议合成回复'}});
        emit({method:'thread/tokenUsage/updated',params:{threadId:'mock-thread',tokenUsage:{last:{inputTokens:100,cachedInputTokens:25,cacheWriteInputTokens:0,outputTokens:7,reasoningOutputTokens:2,totalTokens:107}}}});
        emit({method:'turn/completed',params:{threadId:'mock-thread',turn:{id:'mock-turn',status:'completed'}}});
      });
    }});return child;
  }
  return{spawnImpl,requests,children,get spawnOptions(){return spawnOptions;}};
}

test('provider configuration is private, write-only for keys and switches modes without retaining an unrelated model',async t=>{
  const root=await fixture(t),store=createProviderConfig({root});assert.equal((await store.get()).mode,'none');
  const saved=await store.configure(apiConfig);assert.equal(saved.api.hasKey,true);assert.equal(JSON.stringify(saved).includes(fakeKey),false);
  await store.configure({api:{apiKey:''}});assert.equal((await store.internal()).api.apiKey,fakeKey);
  assert.equal((await fs.stat(path.join(root,'data','provider-config.json'))).mode&0o777,0o600);
  await store.configure({mode:'codex'});assert.equal((await store.get()).model,'');
  await store.configure({api:{clearKey:true}});assert.equal((await store.get()).api.hasKey,false);
  for(const baseURL of ['https://user:password@example.com/v1','http://example.com/v1','file:///private','https://example.com/v1?key=value'])await assert.rejects(store.configure({api:{baseURL}}),{code:'BAD_API_BASE_URL'});
});

test('changing API origin never forwards an old key without an explicitly supplied replacement',async t=>{
  const root=await fixture(t),store=createProviderConfig({root});await store.configure(apiConfig);
  await store.configure({api:{baseURL:'https://example.com/another-prefix'}});assert.equal((await store.internal()).api.apiKey,fakeKey);
  await store.configure({api:{baseURL:'https://api.example.org/v1',apiKey:''}});assert.equal((await store.get()).api.hasKey,false);assert.equal((await store.internal()).api.apiKey,'');
  await store.configure({api:{baseURL:'https://different.example.net/v1',apiKey:fakeKey}});assert.equal((await store.get()).api.hasKey,true);
});

test('Responses API uses only supplied text/image and never exposes tools, stores history or follows key-bearing redirects',async()=>{
  let request,sent=0;
  const provider=createApiProvider({fetchImpl:async(url,options)=>{request={url,...options,payload:JSON.parse(options.body)};return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'合成视觉回复'}]}],usage:{input_tokens:100,output_tokens:5,total_tokens:105,input_tokens_details:{cached_tokens:40}}}),{headers:{'content-type':'application/json'}});}});
  const response=await provider.complete(apiConfig,{systemPrompt:'系统合成指令',messages:[{role:'user',content:'合成图片问题'}],screen:{data:'TEST_ONLY_IMAGE',mimeType:'image/jpeg'},onScreenSend:async()=>{sent++;}});
  assert.equal(sent,1);assert.equal(request.url,'https://example.com/v1/responses');assert.equal(request.redirect,'manual');assert.equal(request.payload.store,false);assert.deepEqual(request.payload.tools,[]);assert.equal(request.payload.tool_choice,'none');assert.equal(request.payload.input[0].content[1].type,'input_image');
  assert.deepEqual(response.usage,{input:60,output:5,cacheRead:40,cacheWrite:0,totalTokens:105});
});

test('compatible Chat Completions is configurable and upstream errors never echo a provider body',async()=>{
  let payload;
  const provider=createApiProvider({fetchImpl:async(_url,options)=>{payload=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'兼容服务回复'}}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}}));}});
  assert.equal((await provider.complete({...apiConfig,api:{...apiConfig.api,format:'chat-completions'}},{systemPrompt:'system',messages:[{role:'user',content:'hello'}]})).text,'兼容服务回复');assert.equal(payload.messages[0].role,'system');
  const bad=createApiProvider({fetchImpl:async()=>new Response(fakeKey,{status:401})});
  await assert.rejects(bad.complete(apiConfig,{messages:[]}),error=>error.code==='API_AUTH_FAILED'&&!JSON.stringify(error).includes(fakeKey));
  let requests=0;await assert.rejects(createApiProvider({fetchImpl:async()=>{requests++;return new Response('',{status:302,headers:{location:'https://elsewhere.example/'}});}}).complete(apiConfig,{messages:[]}),{code:'API_HTTP_ERROR'});assert.equal(requests,1);
});

test('split UTF-8 chunks preserve Chinese responses and partial usage stays explicitly incomplete',async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'鲸鱼晚安'}]}],usage:{input_tokens:3}}));
  const split=bytes.findIndex(value=>value>=128)+1;
  const provider=createApiProvider({fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,split));controller.enqueue(bytes.slice(split));controller.close();}}))});
  const response=await provider.complete(apiConfig,{messages:[{role:'user',content:'晚安'}]});assert.equal(response.text,'鲸鱼晚安');assert.equal(response.usageIncomplete,true);
});

test('Codex protocol uses isolated homes, verified read-only flags, one turn and reported usage without reading credentials',async t=>{
  const root=await fixture(t),mock=rpcFixture(),provider=createCodexProvider({root,spawnImpl:mock.spawnImpl,findBinary:async()=>'/test-only/codex'});t.after(()=>provider.close());
  const status=await provider.status(apiConfig);assert.equal(status.authenticated,true);assert.equal(status.restrictedModeVerified,true);
  const response=await provider.complete(apiConfig,{systemPrompt:'合成偏好',messages:[{role:'user',content:'你好'}]});assert.equal(response.text,'官方协议合成回复');assert.equal(response.usage.totalTokens,107);assert.equal(response.usage.output,7);assert.equal(response.usage.input,75);
  assert.equal(mock.spawnOptions.env.CODEX_HOME,path.join(root,'codex-home'));assert.equal(mock.spawnOptions.env.HOME,path.join(root,'codex-system-home'));assert.equal(mock.spawnOptions.env.OPENAI_API_KEY,undefined);assert.equal(mock.spawnOptions.env.CODEX_API_KEY,undefined);
  const thread=mock.requests.find(item=>item.method==='thread/start');assert.equal(thread.params.sandbox,'read-only');assert.equal(thread.params.approvalPolicy,'never');assert.equal(thread.params.ephemeral,true);assert.equal(CODEX_CONFIG['features.shell_tool'],false);
  assert.equal(mock.requests.filter(item=>item.method==='turn/start').length,1);assert.equal(JSON.stringify(mock.requests).includes(fakeKey),false);
  const login=await provider.login(apiConfig);assert.equal(login.authUrl.startsWith('https://auth.openai.com/'),true);assert.equal((await provider.status(apiConfig)).loginPending,true);
});

test('Codex declines a server approval and kills only its owned child; an unverified protocol version cannot generate',async t=>{
  const root=await fixture(t),mock=rpcFixture({unsafe:true}),provider=createCodexProvider({root,spawnImpl:mock.spawnImpl,findBinary:async()=>'/test-only/codex'});t.after(()=>provider.close());
  await assert.rejects(provider.complete(apiConfig,{systemPrompt:'test',messages:[{role:'user',content:'test'}]}),{code:'UNSAFE_TOOL_ATTEMPT'});
  assert.ok(mock.requests.some(item=>item.id==='server-approval'&&item.result?.decision==='decline'));assert.equal(mock.children[0].killed,true);
  const newerMock=rpcFixture({version:'0.165.0'}),newer=createCodexProvider({root,spawnImpl:newerMock.spawnImpl,findBinary:async()=>'/test-only/codex'});t.after(()=>newer.close());await assert.rejects(newer.complete(apiConfig,{messages:[]}),{code:'CODEX_SECURITY_UNVERIFIED'});assert.equal(newerMock.requests.some(item=>item.method==='turn/start'),false);
});

test('offline backend starts without inference; local memory and unified preferences remain local',async t=>{
  const root=await fixture(t);let calls=0;
  const backend=await createDesktopBackend({root,apiProvider:{complete:async()=>{calls++;return result;}},codexProvider:{status:async()=>({available:false,authenticated:false}),reset(){},close:async()=>{}}});t.after(()=>backend.close());
  assert.equal(await backend.configured(),false);assert.equal((await backend.config()).mode,'none');assert.equal(calls,0);
  await backend.localCommand('记住：我喜欢秋天散步。');assert.equal((await backend.memory.list()).entities[0].observations[0],'我喜欢秋天散步。');assert.equal(calls,0);
  await backend.configure(apiConfig);assert.equal((await backend.config()).connectionVerified,false);assert.equal(calls,0);
  await backend.testConnection();assert.equal(calls,1);assert.equal((await backend.config()).connectionVerified,true);
});

test('Codex unsupported screenshots never forward screenshot-only window titles, while independent metadata opt-in is honored',async t=>{
  const root=await fixture(t),configStore=createProviderConfig({root});await configStore.configure({mode:'codex'});const sent=[];
  const backend=await createDesktopBackend({root,configStore,codexProvider:{status:async()=>({available:true,authenticated:true,restrictedModeVerified:true}),complete:async(_config,input)=>{sent.push(input);return{...result,source:'codex'};},close:async()=>{}}});t.after(()=>backend.close());
  const first={message:'图里是什么',history:[],screen:{data:'SYNTHETIC-IMAGE',mimeType:'image/jpeg'},screenRequested:true,appInfoOptIn:false,activity:{app:'Synthetic',title:'SYNTHETIC-SCREEN-ONLY-TITLE'}};
  const reply=await backend.chat(first);assert.equal(reply.screenUnsupported,true);assert.equal(sent[0].screen,undefined);assert.equal(JSON.stringify(sent[0].messages).includes('SYNTHETIC-SCREEN-ONLY-TITLE'),false);assert.equal(first.activity,undefined);
  await backend.chat({...first,appInfoOptIn:true,activity:{app:'Synthetic',title:'SYNTHETIC-EXPLICIT-METADATA'}});assert.equal(JSON.stringify(sent[1].messages).includes('SYNTHETIC-EXPLICIT-METADATA'),true);
});

test('screenshot budget rejection or commit failure drops screenshot-only metadata before text retry and reports it accurately',async t=>{
  for(const commitFails of[false,true]){
    const root=await fixture(t),configStore=createProviderConfig({root});await configStore.configure(apiConfig);const sent=[];
    const backend=await createDesktopBackend({root,configStore,apiProvider:{complete:async(_config,input)=>{if(input.screen)await input.onScreenSend?.();sent.push(input);return result;}},codexProvider:{close:async()=>{}}});
    const screenBudget={status:async()=>({canSend:commitFails,reason:'cooldown',used:0,remaining:12,limit:12,nextAllowedAt:null}),commit:async()=>{throw Object.assign(new Error('SYNTHETIC'),{screenReason:'storage_error'});}};
    const app=createChatServer({backend,token:'SYNTHETIC-METADATA-TOKEN',port:0,screenBudget});await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});t.after(()=>app.close());
    const bytes=Buffer.from([0xff,0xd8,0xff,0xc0,0,0x0b,8,0,1,0,1,1,1,0x11,0,0xff,0xd9]);
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/chat`,{method:'POST',headers:{Authorization:'Bearer SYNTHETIC-METADATA-TOKEN','Content-Type':'application/json'},body:JSON.stringify({message:'看这张图',screen:{mimeType:'image/jpeg',data:bytes.toString('base64')},activity:{app:'Synthetic',title:'SYNTHETIC-DO-NOT-FORWARD'},appInfoOptIn:false})});
    const body=await response.json();assert.equal(response.status,200);assert.equal(body.awareness.activityUsed,false);assert.equal(body.screenUsed,false);assert.equal(sent.length,1);assert.equal(sent[0].screen,undefined);assert.equal(JSON.stringify(sent[0].messages).includes('SYNTHETIC-DO-NOT-FORWARD'),false);
  }
});

test('portable task path actually executes only supplied read tools before one synthesis call',async t=>{
  const root=await fixture(t),configStore=createProviderConfig({root});await configStore.configure(apiConfig);const calls=[],events=[];
  const backend=await createDesktopBackend({root,configStore,apiProvider:{complete:async(_config,input)=>{calls.push(input);return result;}},codexProvider:{close:async()=>{}}});t.after(()=>backend.close());
  const answer=await backend.run({input:'读取 https://example.com/post',tools:[{name:'read_web',execute:async args=>({sourceUrl:args.url,fetched:true,text:'实际合成正文'.repeat(20)})}],onEvent:event=>events.push(event)});
  assert.equal(answer.modelCalls,1);assert.equal(answer.toolCalls,1);assert.equal(calls.length,1);assert.ok(calls[0].messages[0].content.includes('实际合成正文'));assert.ok(events.some(event=>event.type==='tool_end'&&event.result.fetched));
});

test('config HTTP requires the local bearer and saves without any model call; connection test is explicit',async t=>{
  const root=await fixture(t);let calls=0;
  const backend=await createDesktopBackend({root,apiProvider:{complete:async()=>{calls++;return result;}},codexProvider:{reset(){},close:async()=>{}}});
  const app=createChatServer({backend,token:'SYNTHETIC-PROVIDER-TOKEN',port:0,screenBudget:createScreenBudget({file:path.join(root,'screen.json')})});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});t.after(()=>app.close());
  const url=`http://127.0.0.1:${app.server.address().port}`,headers={Authorization:'Bearer SYNTHETIC-PROVIDER-TOKEN','Content-Type':'application/json'};
  assert.equal((await fetch(url+'/api/config')).status,401);
  assert.equal((await fetch(url+'/api/config',{headers:{...headers,Origin:'https://example.com'}})).status,403);
  const memory=await(await fetch(url+'/api/chat',{method:'POST',headers,body:JSON.stringify({message:'记住：我喜欢秋天散步。',screen:{data:'TEST_ONLY_PIXELS_NOT_UPLOADABLE'}})})).json();assert.equal(memory.source,'local');assert.equal(memory.screenUsed,false);assert.equal(calls,0);
  const saved=await(await fetch(url+'/api/config',{method:'POST',headers,body:JSON.stringify(apiConfig)})).json();assert.equal(saved.api.hasKey,true);assert.equal(JSON.stringify(saved).includes(fakeKey),false);assert.equal(calls,0);
  assert.equal((await(await fetch(url+'/api/config/test',{method:'POST',headers,body:'{}'})).json()).ok,true);assert.equal(calls,1);
});

test('a configuration status read cannot release another in-flight configuration write slot',async t=>{
  const root=await fixture(t);let entered,release,writes=0;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const backend={configured:async()=>false,busy:false,config:async()=>({mode:'none'}),configure:async()=>{writes++;entered();await gate;return{mode:'none'};},close:async()=>{}};
  const app=createChatServer({backend,token:'SYNTHETIC-SLOT-TOKEN',port:0,screenBudget:createScreenBudget({file:path.join(root,'screen.json')})});await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});t.after(()=>app.close());
  const url=`http://127.0.0.1:${app.server.address().port}`,headers={Authorization:'Bearer SYNTHETIC-SLOT-TOKEN','Content-Type':'application/json'};
  const first=fetch(url+'/api/config',{method:'POST',headers,body:'{}'});await started;
  assert.equal((await fetch(url+'/api/config',{headers})).status,200);
  assert.equal((await fetch(url+'/api/config',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(url+'/api/config',{method:'POST',headers,body:'{}'})).status,409);
  release();assert.equal((await first).status,200);assert.equal(writes,1);
});
