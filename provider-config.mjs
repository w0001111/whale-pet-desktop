import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';

export const appDataRoot=()=>path.resolve(process.env.WHALE_PET_DATA_DIR||path.join(os.homedir(),'Library','Application Support','WhalePet'));
export const fail=code=>Object.assign(new Error(code),{code});
export const DEFAULT_PROVIDER_CONFIG=Object.freeze({mode:'none',model:'',api:{format:'responses',baseURL:'https://api.openai.com/v1',apiKey:''},codex:{cliPath:''}});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key));

export function validateBaseURL(value){
  if(typeof value!=='string'||value.length>2048)throw fail('BAD_API_BASE_URL');
  let url;try{url=new URL(value);}catch{throw fail('BAD_API_BASE_URL');}
  if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||
    (url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw fail('BAD_API_BASE_URL');
  return url.href.replace(/\/+$/,'');
}
export async function privateRead(file,max=128*1024){
  let handle;
  try{
    const parent=await fs.lstat(path.dirname(file));if(!parent.isDirectory()||parent.isSymbolicLink())throw fail('UNSAFE_STORAGE');
    const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail('UNSAFE_STORAGE');
    handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);if((await handle.stat()).size>max)throw fail('STATE_TOO_LARGE');
    const data=Buffer.alloc(max+1);let count=0;while(count<data.length){const read=await handle.read(data,count,data.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
    if(count>max)throw fail('STATE_TOO_LARGE');
    let value;try{value=JSON.parse(data.subarray(0,count).toString('utf8'));}catch{throw fail('STATE_INVALID');}
    await handle.chmod(0o600);return value;
  }catch(error){if(error.code==='ENOENT')return undefined;throw error;}finally{await handle?.close();}
}
export async function privateWrite(file,value,max=128*1024){
  const body=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(body)>max)throw fail('STATE_TOO_LARGE');
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const parent=await fs.lstat(path.dirname(file));if(!parent.isDirectory()||parent.isSymbolicLink())throw fail('UNSAFE_STORAGE');
  try{const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail('UNSAFE_STORAGE');}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temporary,body,{mode:0o600,flag:'wx'});await fs.rename(temporary,file);}catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});throw error;}
}
function validate(value){
  if(!keys(value,['mode','model','api','codex'])||!['none','codex','api'].includes(value.mode)||typeof value.model!=='string'||value.model.length>120||/[\r\n\u0000]/.test(value.model)||
    !keys(value.api,['format','baseURL','apiKey'])||!['responses','chat-completions'].includes(value.api.format)||typeof value.api.apiKey!=='string'||value.api.apiKey.length>4096||/[\r\n\u0000]/.test(value.api.apiKey)||
    !keys(value.codex,['cliPath'])||typeof value.codex.cliPath!=='string'||value.codex.cliPath.length>2048||(value.codex.cliPath&&!path.isAbsolute(value.codex.cliPath)))throw fail('BAD_PROVIDER_CONFIG');
  value.api.baseURL=validateBaseURL(value.api.baseURL);return value;
}
export function createProviderConfig({root=appDataRoot()}={}){
  if(!path.isAbsolute(root))throw fail('BAD_DATA_ROOT');
  const file=path.join(root,'data','provider-config.json');let value,queue=Promise.resolve();
  async function load(){if(!value){const saved=await privateRead(file);value=saved===undefined?structuredClone(DEFAULT_PROVIDER_CONFIG):validate(saved);if(saved===undefined)await privateWrite(file,value);}return value;}
  function serial(operation){const next=queue.then(operation);queue=next.catch(()=>{});return next;}
  const publicView=config=>({mode:config.mode,model:config.model,api:{format:config.api.format,baseURL:config.api.baseURL,hasKey:!!config.api.apiKey},codex:{cliPath:config.codex.cliPath}});
  return{
    get:()=>serial(async()=>publicView(await load())),
    internal:()=>serial(async()=>structuredClone(await load())),
    configure:patch=>serial(async()=>{
      const old=await load();if(!keys(patch,['mode','model','api','codex']))throw fail('BAD_PROVIDER_CONFIG');
      const next=structuredClone(old);
      if(patch.mode!==undefined&&patch.mode!==old.mode&&patch.model===undefined)next.model='';
      if(patch.mode!==undefined)next.mode=patch.mode;if(patch.model!==undefined)next.model=patch.model;
      if(patch.api!==undefined){if(!keys(patch.api,['format','baseURL','apiKey','clearKey']))throw fail('BAD_PROVIDER_CONFIG');
        for(const key of ['format','baseURL'])if(patch.api[key]!==undefined)next.api[key]=patch.api[key];
        if(patch.api.clearKey!==undefined&&typeof patch.api.clearKey!=='boolean')throw fail('BAD_PROVIDER_CONFIG');
        if(patch.api.apiKey!==undefined&&typeof patch.api.apiKey!=='string')throw fail('BAD_PROVIDER_CONFIG');
        const changedOrigin=new URL(validateBaseURL(next.api.baseURL)).origin!==new URL(old.api.baseURL).origin;
        if(patch.api.clearKey)next.api.apiKey='';else if(patch.api.apiKey?.trim())next.api.apiKey=patch.api.apiKey.trim();else if(changedOrigin)next.api.apiKey='';
      }
      if(patch.codex!==undefined){if(!keys(patch.codex,['cliPath']))throw fail('BAD_PROVIDER_CONFIG');next.codex={...old.codex,...patch.codex};}
      validate(next);await privateWrite(file,next);value=next;return publicView(next);
    }),
  };
}
