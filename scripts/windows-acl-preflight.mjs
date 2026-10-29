#!/usr/bin/env node
// At most four bounded PowerShell probes plus one direct-DACL verification.
// No account, provider, model, network, GUI or screen access. No raw child output.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {windowsAclCommand,preparePrivateCommand} from '../private-storage.mjs';

const encode=text=>Buffer.from(text,'utf16le').toString('base64');
const report={schemaVersion:1,pass:false,platform:process.platform,probes:[],modelRequests:0,accountReads:false};
let temporary;
async function probe(label,file,args,env,{eof=true,timeoutMs=8000,privateProfile=false}={}){
  const prepared=await preparePrivateCommand({env,isolatedProfile:privateProfile});
  try{return await new Promise(resolve=>{
    const started=Date.now();let timedOut=false,done=false,code=null,output='',error='';
    const child=spawn(file,args,{env:prepared.options.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    child.stdin.on('error',()=>{});
    const finish=category=>{if(done)return;done=true;clearTimeout(timer);resolve({label,pass:code===0&&!timedOut,timeout:timedOut,exitCode:code,elapsedMs:Date.now()-started,errorCategory:category||null,verified:output.trim()==='ACL_VERIFIED'});};
    child.stdout.on('data',bytes=>{if(output.length<4096)output+=bytes;});child.stderr.on('data',bytes=>{if(error.length<4096)error+=bytes;});
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');setTimeout(()=>finish('TIMEOUT'),500).unref();},timeoutMs);
    child.once('error',()=>finish('SPAWN_FAILED'));
    child.once('close',exitCode=>{code=exitCode;let category=null;if(timedOut)category='TIMEOUT';else if(code!==0){if(/access.*denied|UnauthorizedAccess|SecurityException/i.test(error))category='ACCESS_DENIED';else if(/not recognized|CommandNotFound|Method.*not|MissingMethod/i.test(error))category='API_OR_COMMAND_UNAVAILABLE';else category='POWERSHELL_FAILED';}finish(category);});
    if(eof)child.stdin.end();
  });}finally{await prepared.cleanup();}
}
try{
  if(process.platform!=='win32')throw Object.assign(new Error(),{code:'WINDOWS_REQUIRED'});
  temporary=await fs.mkdtemp(path.join(os.tmpdir(),'whale-acl-preflight-'));
  for(const label of ['legacy-inherited-open','legacy-narrow-eof','fixed-private-eof','fixed-private-open']){
    const folder=path.join(temporary,label);await fs.mkdir(folder);
    const command=windowsAclCommand(folder,true),script=Buffer.from(command.args.at(-1),'base64').toString('utf16le');
    const oldScript=script.replace('try{','').replace("if(([IO.File]::GetAttributes($p) -band",'$i=Get-Item -LiteralPath $p -Force;if(($i.Attributes -band').replace(/[;]\[IO[.]Directory\]::SetAccessControl\(\$p,\$a\);exit 0\}catch\{.*$/,';Set-Acl -LiteralPath $p -AclObject $a');
    const inherited={...process.env};for(const name of Object.keys(inherited))if(/(?:TOKEN|API_KEY|SECRET|PASSWORD|^CODEX_HOME$)/i.test(name))delete inherited[name];
    const narrow={};for(const name of ['SystemRoot','WINDIR','PATH','TEMP','TMP'])if(command.options.env[name])narrow[name]=command.options.env[name];
    const legacy=label.startsWith('legacy-'),env=label.includes('inherited')?inherited:legacy?narrow:command.options.env;
    const result=await probe(label,command.file,[...command.args.slice(0,-1),encode(legacy?oldScript:script)],env,{eof:label.endsWith('eof'),timeoutMs:legacy?2000:8000,privateProfile:!legacy});report.probes.push(result);
  }
  const fixed=path.join(temporary,'fixed-private-eof'),command=windowsAclCommand(fixed,true),encoded=Buffer.from(fixed).toString('base64');
  const verify=`$ErrorActionPreference='Stop';try{$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$a=[IO.Directory]::GetAccessControl($p);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$user=$false;$system=$false;if(!$a.AreAccessRulesProtected){throw 'unprotected'};foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){$s=$r.IdentityReference.Value;if(($s -ne $sid -and $s -ne 'S-1-5-18') -or [int]$r.AccessControlType -ne 0 -or ([int]$r.FileSystemRights -band 2032127) -ne 2032127){throw 'unexpected rule'};if($s -eq $sid){$user=$true};if($s -eq 'S-1-5-18'){$system=$true}};if(!$user -or !$system){throw 'missing rule'};[Console]::Out.Write('ACL_VERIFIED');exit 0}catch{[Console]::Error.Write('ACL_VERIFY_FAILED');exit 1}`;
  report.probes.push(await probe('fixed-dacl-verified',command.file,[...command.args.slice(0,-1),encode(verify)],command.options.env,{privateProfile:true}));
  const file=path.join(fixed,'synthetic-private.txt');await fs.writeFile(file,'SYNTHETIC-ACL-READWRITE',{flag:'wx'});
  const fileCommand=windowsAclCommand(file,false);
  report.probes.push(await probe('fixed-file-acl-eof',fileCommand.file,fileCommand.args,fileCommand.options.env,{privateProfile:true}));
  const fileVerify=verify.replace(encoded,Buffer.from(file).toString('base64')).replace('[IO.Directory]::GetAccessControl','[IO.File]::GetAccessControl');
  report.probes.push(await probe('fixed-file-dacl-verified',fileCommand.file,[...fileCommand.args.slice(0,-1),encode(fileVerify)],fileCommand.options.env,{privateProfile:true}));
  const fileReadWrite=await fs.readFile(file,'utf8')==='SYNTHETIC-ACL-READWRITE';await fs.appendFile(file,'\nSYNTHETIC-APPEND');
  report.fileReadWriteVerified=fileReadWrite&&(await fs.readFile(file,'utf8')).endsWith('SYNTHETIC-APPEND');
  const required=['fixed-private-eof','fixed-dacl-verified','fixed-file-acl-eof','fixed-file-dacl-verified'];
  report.pass=required.every(label=>report.probes.some(item=>item.label===label&&item.pass&&(!label.endsWith('dacl-verified')||item.verified)))&&report.fileReadWriteVerified;
}catch(error){report.error={code:/^[A-Z_]+$/.test(error?.code||'')?error.code:'ACL_PREFLIGHT_FAILED'};}
finally{
  if(temporary)await fs.rm(temporary,{recursive:true,force:true}).catch(()=>{});
  const output=path.resolve('build/windows-validation');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'acl-preflight.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));process.exitCode=report.pass?0:1;
}
