import path from 'node:path';
import {privateRead,privateWrite,fail} from './provider-config.mjs';
export function createLocalMemory({root}={}){
  const file=path.join(root,'data','memory.json');let value,queue=Promise.resolve();
  function serial(operation){const next=queue.then(operation);queue=next.catch(()=>{});return next;}
  async function load(){if(!value){const saved=await privateRead(file,256*1024);const loaded=saved===undefined?{version:1,entities:[],relations:[]}:saved;if(!loaded||loaded.version!==1||!Array.isArray(loaded.entities)||loaded.entities.length>100||!Array.isArray(loaded.relations)||loaded.entities.some(item=>typeof item.name!=='string'||!Array.isArray(item.observations)||item.observations.some(text=>typeof text!=='string'||text.length>1000)))throw fail('MEMORY_STATE_INVALID');value=loaded;}return value;}
  const graph=state=>({entities:structuredClone(state.entities),relations:[],backend:'local-json',persistent:true});
  return{
    list:()=>serial(async()=>graph(await load())),
    remember:text=>serial(async()=>{
      if(typeof text!=='string'||!text.trim()||text.length>1000)throw fail('BAD_MEMORY_TEXT');
      const next=structuredClone(await load());let owner=next.entities.find(item=>item.name==='用户明确保存的资料');
      if(!owner){owner={name:'用户明确保存的资料',entityType:'user_saved',observations:[]};next.entities.push(owner);}
      if(!owner.observations.includes(text.trim())){if(owner.observations.length>=100)throw fail('MEMORY_CAPACITY_REACHED');owner.observations.push(text.trim());}
      await privateWrite(file,next,256*1024);value=next;return graph(value);
    }),
    forget:names=>serial(async()=>{if(!Array.isArray(names)||!names.length||names.length>100||names.some(name=>typeof name!=='string'||name.length>200))throw fail('BAD_MEMORY_NAMES');const next=structuredClone(await load());next.entities=next.entities.filter(item=>!names.includes(item.name));await privateWrite(file,next,256*1024);value=next;return graph(next);}),
  };
}
