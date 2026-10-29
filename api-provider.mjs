import {fail} from './provider-config.mjs';
export const emptyUsage=()=>({input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0});
function usage(value,format){
  const count=key=>Number.isFinite(value?.[key])&&value[key]>=0?value[key]:0;
  const result=emptyUsage();
  result.input=count(format==='responses'?'input_tokens':'prompt_tokens');result.output=count(format==='responses'?'output_tokens':'completion_tokens');result.totalTokens=count('total_tokens')||result.input+result.output;
  const cached=value?.[format==='responses'?'input_tokens_details':'prompt_tokens_details']?.cached_tokens;
  if(Number.isFinite(cached)&&cached>0){result.cacheRead=Math.min(result.input,cached);result.input-=result.cacheRead;}
  return result;
}
export function createApiProvider({fetchImpl=globalThis.fetch}={}){
  return{
    async complete(config,{systemPrompt,messages=[],screen,signal,maxTokens=800,onScreenSend}={}){
      if(!config.api.apiKey||!config.model)throw fail('PROVIDER_NOT_CONFIGURED');
      const isResponses=config.api.format==='responses';
      const mapped=messages.map(message=>({role:message.role,content:message.content}));
      if(screen){
        const last=mapped.at(-1);if(!last||last.role!=='user')throw fail('BAD_PROVIDER_INPUT');
        const imageURL=`data:${screen.mimeType};base64,${screen.data}`;
        last.content=isResponses?[{type:'input_text',text:last.content},{type:'input_image',image_url:imageURL,detail:'low'}]:[{type:'text',text:last.content},{type:'image_url',image_url:{url:imageURL,detail:'low'}}];
      }
      const payload=isResponses?{model:config.model,instructions:systemPrompt,input:mapped,store:false,max_output_tokens:Math.min(2000,maxTokens),tools:[],tool_choice:'none'}:
        {model:config.model,messages:[{role:'system',content:systemPrompt},...mapped],max_tokens:Math.min(2000,maxTokens),tools:[],tool_choice:'none'};
      const timeout=AbortSignal.timeout(45_000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
      combined.throwIfAborted();
      if(screen)await onScreenSend?.();
      let response;
      try{response=await fetchImpl(config.api.baseURL+(isResponses?'/responses':'/chat/completions'),{method:'POST',headers:{Authorization:`Bearer ${config.api.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:combined,redirect:'manual'});}catch(error){if(combined.aborted)throw fail('MODEL_ABORTED');throw fail('API_CONNECTION_FAILED');}
      if(!response.ok){await response.body?.cancel?.().catch(()=>{});throw fail(response.status===401||response.status===403?'API_AUTH_FAILED':'API_HTTP_ERROR');}
      let body='',bytes=0;const decoder=new TextDecoder();
      for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>2*1024*1024)throw fail('API_RESPONSE_TOO_LARGE');body+=decoder.decode(chunk,{stream:true});}body+=decoder.decode();
      let data;try{data=JSON.parse(body);}catch{throw fail('API_RESPONSE_INVALID');}
      if((data.output||[]).some(item=>['function_call','computer_call','local_shell_call'].includes(item.type))||data.choices?.some(choice=>choice.message?.tool_calls?.length))throw fail('UNEXPECTED_MODEL_TOOL');
      const text=isResponses?(data.output||[]).filter(item=>item.type==='message').flatMap(item=>item.content||[]).filter(item=>item.type==='output_text').map(item=>item.text).join(''):data.choices?.[0]?.message?.content;
      if(typeof text!=='string'||!text.trim())throw fail('MODEL_EMPTY_REPLY');
      const reportedInput=data.usage?.[isResponses?'input_tokens':'prompt_tokens'],reportedOutput=data.usage?.[isResponses?'output_tokens':'completion_tokens'];
      return{text:text.trim().slice(0,16000),model:config.model,source:'api',usage:usage(data.usage,config.api.format),modelCalls:1,toolCalls:0,usageIncomplete:!Number.isFinite(reportedInput)||!Number.isFinite(reportedOutput)||reportedInput<0||reportedOutput<0};
    },
  };
}
