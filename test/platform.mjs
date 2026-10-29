import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {windowsAclCommand} from '../private-storage.mjs';

// Windows junctions and hard links require no Developer Mode or administrator
// privilege. Both are rejected by production before reading private records.
export const directoryLink=(target,file)=>fs.symlink(target,file,process.platform==='win32'?'junction':'dir');
export const privateFileLink=(target,file)=>process.platform==='win32'?fs.link(target,file):fs.symlink(target,file,'file');
export async function isLinkedFixture(file){const info=await fs.lstat(file);return info.isSymbolicLink()||info.nlink>1;}
export async function assertPrivateFile(file){
  if(process.platform!=='win32'){assert.equal((await fs.stat(file)).mode&0o777,0o600);return;}
  const command=windowsAclCommand(file,false),encoded=Buffer.from(file,'utf8').toString('base64');
  const script=`$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$a=Get-Acl -LiteralPath $p;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');rights=[int]$_.FileSystemRights}});@{sid=$sid;rules=$rules}|ConvertTo-Json -Depth 4 -Compress`;
  const {stdout}=await promisify(execFile)(command.file,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],command.options);
  const value=JSON.parse(stdout.replace(/^\uFEFF/,''));
  assert.ok(value.rules.some(rule=>rule.sid===value.sid&&rule.allow));
  assert.ok(value.rules.some(rule=>rule.sid==='S-1-5-18'&&rule.allow));
  for(const rule of value.rules){assert.ok([value.sid,'S-1-5-18'].includes(rule.sid));assert.equal(rule.allow,true);assert.equal(rule.rights&2032127,2032127);}
}
