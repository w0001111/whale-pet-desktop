import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {windowsAclCommand,executePrivateCommand} from '../private-storage.mjs';

// Windows junctions and hard links require no Developer Mode or administrator
// privilege. Both are rejected by production before reading private records.
export const directoryLink=(target,file)=>fs.symlink(target,file,process.platform==='win32'?'junction':'dir');
export const privateFileLink=(target,file)=>process.platform==='win32'?fs.link(target,file):fs.symlink(target,file,'file');
export async function isLinkedFixture(file){const info=await fs.lstat(file);return info.isSymbolicLink()||info.nlink>1;}
export async function assertPrivateFile(file){
  if(process.platform!=='win32'){assert.equal((await fs.stat(file)).mode&0o777,0o600);return;}
  const command=windowsAclCommand(file,false),encoded=Buffer.from(file,'utf8').toString('base64');
  const script=`$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$a=[IO.File]::GetAccessControl($p);[Console]::Out.WriteLine([Security.Principal.WindowsIdentity]::GetCurrent().User.Value);foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){[Console]::Out.WriteLine($r.IdentityReference.Value+'|'+[int]$r.AccessControlType+'|'+[int]$r.FileSystemRights)};exit 0`;
  const {stdout}=await executePrivateCommand(command.file,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],command.options);
  const lines=stdout.trim().split(/\r?\n/),value={sid:lines.shift(),rules:lines.map(line=>{const[sid,type,rights]=line.split('|');return{sid,allow:Number(type)===0,rights:Number(rights)};})};
  assert.ok(value.rules.some(rule=>rule.sid===value.sid&&rule.allow));
  assert.ok(value.rules.some(rule=>rule.sid==='S-1-5-18'&&rule.allow));
  for(const rule of value.rules){assert.ok([value.sid,'S-1-5-18'].includes(rule.sid));assert.equal(rule.allow,true);assert.equal(rule.rights&2032127,2032127);}
}
