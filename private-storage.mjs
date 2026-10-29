import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
export async function preparePrivateCommand(options={}){
  const{isolatedProfile,...actual}=options;
  if(!isolatedProfile)return{options:actual,cleanup:async()=>{}};
  // PowerShell can create AppData caches even with -NoProfile. Never use the
  // protected target/data directory as its profile, or the real user's profile.
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'whale-acl-profile-'));
  try{
    const roaming=path.join(profile,'AppData','Roaming'),local=path.join(profile,'AppData','Local'),temporary=path.join(profile,'tmp');
    for(const folder of[roaming,local,temporary])await fs.mkdir(folder,{recursive:true,mode:0o700});
    actual.env={...actual.env,HOME:profile,USERPROFILE:profile,APPDATA:roaming,LOCALAPPDATA:local,TEMP:temporary,TMP:temporary};
    return{options:actual,cleanup:()=>fs.rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:50})};
  }catch(error){await fs.rm(profile,{recursive:true,force:true}).catch(()=>{});throw error;}
}
export async function executePrivateCommand(file,args,options){
  const prepared=await preparePrivateCommand(options);
  try{return await new Promise((resolve,reject)=>{
    const child=execFile(file,args,prepared.options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));
    // PowerShell must never wait for an inherited/open parent input pipe.
    child.stdin?.on('error',()=>{});child.stdin?.end();
  });}finally{await prepared.cleanup();}
}
const execute=executePrivateCommand;
const fail=()=>Object.assign(new Error('UNSAFE_STORAGE'),{code:'UNSAFE_STORAGE'});
const identity=info=>`${info.dev}:${info.ino}`;
const regular=info=>info.isFile()&&!info.isSymbolicLink()&&info.nlink===1n;

// POSIX modes do not provide a private DACL on Windows. Restrict only our own
// storage directories/files to the current SID and SYSTEM; never change HOME,
// LOCALAPPDATA or the user's profile ACL. New files inherit the private DACL.
export function windowsAclCommand(target,isDirectory,{env=process.env}={}){
  const systemRoot=env.SystemRoot||env.SYSTEMROOT||env.WINDIR||'C:\\Windows';
  const encoded=Buffer.from(target,'utf8').toString('base64');
  // This executable is Windows PowerShell 5.1/.NET Framework: use its direct
  // filesystem ACL API, with no command-provider/module auto-loading required.
  const script=`$ErrorActionPreference='Stop';try{$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));if(([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse point'};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');$a=[Security.AccessControl.${isDirectory?'DirectorySecurity':'FileSecurity'}]::new();$a.SetAccessRuleProtection($true,$false);foreach($s in @($sid,$system)){$r=[Security.AccessControl.FileSystemAccessRule]::new($s,[Security.AccessControl.FileSystemRights]::FullControl,${isDirectory?'([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit)':'[Security.AccessControl.InheritanceFlags]::None'},[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);$a.AddAccessRule($r)};[IO.${isDirectory?'Directory':'File'}]::SetAccessControl($p,$a);exit 0}catch{[Console]::Error.WriteLine('PRIVATE_ACL_FAILED');exit 1}`;
  const options={isolatedProfile:true,windowsHide:true,timeout:15000,maxBuffer:4096,env:{SystemRoot:systemRoot,WINDIR:systemRoot,PATH:path.win32.join(systemRoot,'System32'),COMSPEC:path.win32.join(systemRoot,'System32','cmd.exe'),PATHEXT:'.COM;.EXE;.BAT;.CMD',PSModulePath:path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','Modules'),...(env.TEMP?{TEMP:env.TEMP}:{}),...(env.TMP?{TMP:env.TMP}:{})}};
  return{file:path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],options};
}

export function createStorageSecurity({platform=process.platform,io=fs,executeImpl=execute,env=process.env}={}){
  const directories=new Map(),files=new Map(),inFlight=new Map();
  async function acl(target,info,isDirectory){
    const cache=isDirectory?directories:files,key=identity(info);
    if(cache.get(target)===key)return;
    const taskKey=`${isDirectory?'d':'f'}:${target}:${key}`;
    let work=inFlight.get(taskKey);
    if(!work){work=(async()=>{
      const command=windowsAclCommand(target,isDirectory,{env});
      try{await executeImpl(command.file,command.args,command.options);}catch{throw Object.assign(new Error('PRIVATE_ACL_UNAVAILABLE'),{code:'PRIVATE_ACL_UNAVAILABLE'});}
      const after=await io.lstat(target,{bigint:true});
      if(after.isSymbolicLink()||identity(after)!==key||(isDirectory?!after.isDirectory():!regular(after)))throw fail();
      cache.set(target,key);
    })();inFlight.set(taskKey,work);work.finally(()=>inFlight.delete(taskKey)).catch(()=>{});}
    await work;
  }
  async function directory(target,{create=true}={}){
    if(create){
      // Check the nearest existing ancestor before recursive mkdir, so a missing
      // child below a junction cannot be created outside our storage first.
      let ancestor=target;
      while(true){try{const existing=await io.lstat(ancestor,{bigint:true});if(!existing.isDirectory()||existing.isSymbolicLink())throw fail();break;}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}}
      await io.mkdir(target,{recursive:true,mode:0o700});
    }
    const info=await io.lstat(target,{bigint:true});
    if(!info.isDirectory()||info.isSymbolicLink())throw fail();
    // Do not silently follow an app-root junction when creating data/children.
    const parent=await io.lstat(path.dirname(target),{bigint:true});
    if(!parent.isDirectory()||parent.isSymbolicLink())throw fail();
    if(platform==='win32')await acl(target,info,true);
    else await io.chmod(target,0o700);
    return info;
  }
  async function openRead(file){
    await directory(path.dirname(file),{create:false});
    const before=await io.lstat(file,{bigint:true});if(!regular(before))throw fail();
    if(platform==='win32')await acl(file,before,false);
    // Windows has no O_NOFOLLOW. Verify the opened handle identity before any
    // content read, and re-check the pathname, rather than OR-ing an absent flag.
    const flags=io.constants.O_RDONLY|(platform==='win32'?0:(io.constants.O_NOFOLLOW||0));
    const handle=await io.open(file,flags);
    try{
      const [opened,after]=await Promise.all([handle.stat({bigint:true}),io.lstat(file,{bigint:true})]);
      if(!regular(opened)||!regular(after)||identity(before)!==identity(opened)||identity(opened)!==identity(after))throw fail();
      if(platform!=='win32')await handle.chmod(0o600);
      return handle;
    }catch(error){await handle.close();throw error;}
  }
  async function created(file){
    const info=await io.lstat(file,{bigint:true});if(!regular(info))throw fail();
    if(platform==='win32'){
      // Only call after an exclusive creation inside an already secured parent.
      const parent=await io.lstat(path.dirname(file),{bigint:true});
      if(directories.get(path.dirname(file))!==identity(parent))throw fail();
      files.set(file,identity(info));
    }else await io.chmod(file,0o600);
  }
  async function protectExisting(file){
    const info=await io.lstat(file,{bigint:true});if(!regular(info))throw fail();
    if(platform==='win32')await acl(file,info,false);else await io.chmod(file,0o600);
  }
  async function openAppend(file){
    await directory(path.dirname(file));
    let before;try{before=await io.lstat(file,{bigint:true});if(!regular(before))throw fail();if(platform==='win32')await acl(file,before,false);}catch(error){if(error.code!=='ENOENT')throw error;}
    const flags=before?(io.constants.O_WRONLY|io.constants.O_APPEND|(platform==='win32'?0:(io.constants.O_NOFOLLOW||0))):'ax';
    const handle=await io.open(file,flags,0o600);
    try{
      const [opened,after]=await Promise.all([handle.stat({bigint:true}),io.lstat(file,{bigint:true})]);
      if(!regular(opened)||!regular(after)||identity(opened)!==identity(after)||(before&&identity(before)!==identity(opened)))throw fail();
      if(!before)await created(file);else if(platform!=='win32')await handle.chmod(0o600);
      return handle;
    }catch(error){await handle.close();throw error;}
  }
  function renamed(from,to){if(files.has(from)){files.set(to,files.get(from));files.delete(from);}}
  return{directory,openRead,openAppend,created,renamed,protectExisting};
}
export const storageSecurity=createStorageSecurity();
