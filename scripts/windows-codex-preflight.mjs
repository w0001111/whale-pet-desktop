#!/usr/bin/env node
// Official stdio initialize/config/account-read in a NEW empty application home.
// No login, model request, thread/turn, normal GUI, capture, or ambient auth read.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCodexProvider} from '../codex-provider.mjs';

const argumentsMap={};for(let index=2;index<process.argv.length;index+=2)argumentsMap[process.argv[index]]=process.argv[index+1];
const report={schemaVersion:1,platform:process.platform,pass:false,modelRequests:0,loginPerformed:false,desktopCaptured:false};
let temporary,provider,timer;
try{
  if(process.platform!=='win32')throw Object.assign(new Error(),{code:'WINDOWS_REQUIRED'});
  const binary=path.resolve(argumentsMap['--binary']||process.env.WHALE_PET_CODEX_BINARY||'.cache/windows-runtime/x64/codex.exe');
  temporary=await fs.mkdtemp(path.join(os.tmpdir(),'whale-codex-preflight-'));
  provider=createCodexProvider({root:temporary});
  const status=await Promise.race([provider.status({codex:{cliPath:binary}}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(),{code:'CODEX_PREFLIGHT_TIMEOUT'})),60000);})]);
  clearTimeout(timer);
  report.status={available:status.available===true,authenticated:status.authenticated===true,restrictedModeVerified:status.restrictedModeVerified===true,
    ...(typeof status.errorCode==='string'&&/^[A-Z0-9_]{2,80}$/.test(status.errorCode)?{errorCode:status.errorCode}:{}),
    restrictionChecks:Object.fromEntries(Object.entries(status.restrictionChecks||{}).filter(([,value])=>typeof value==='boolean')),
    diagnostics:status.diagnostics||{}};
  report.pass=report.status.available&&!report.status.authenticated&&report.status.restrictedModeVerified;
}catch(error){report.error={code:/^[A-Z0-9_]{2,80}$/.test(error?.code||'')?error.code:'CODEX_PREFLIGHT_FAILED'};}
finally{
  clearTimeout(timer);await provider?.close();
  if(temporary)await fs.rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
  const output=path.resolve('build/windows-validation');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'codex-preflight.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));process.exitCode=report.pass?0:1;
}
