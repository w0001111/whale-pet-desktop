#!/usr/bin/env python3
"""Fetch pinned official runtimes and verify bytes before extracting allowlisted files."""
import argparse, base64, hashlib, json, os, subprocess, tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT/'runtime-lock.json').read_text())
CACHE = ROOT/'.cache/runtime'

def download(url, target, expected=None, algorithm='sha256'):
    target.parent.mkdir(parents=True, exist_ok=True)
    def valid():
        return target.is_file() and (expected is None or hashlib.new(algorithm, target.read_bytes()).digest() == expected)
    if valid(): return target
    partial = target.with_suffix(target.suffix+'.part')
    subprocess.run(['/usr/bin/curl','-q','--fail','--location','--silent','--show-error','--retry','2','--max-time','1200','--continue-at','-','--proto','=https',url,'-o',str(partial)],check=True)
    if expected is not None and hashlib.new(algorithm,partial.read_bytes()).digest() != expected:
        raise RuntimeError('Runtime checksum mismatch: '+target.name)
    partial.replace(target)
    return target

def extract_one(archive, suffix, output):
    with tarfile.open(archive,'r:gz') as tar:
        choices=[m for m in tar.getmembers() if m.isfile() and (m.name == suffix or m.name.endswith('/'+suffix))]
        if len(choices)!=1: raise RuntimeError('Expected one runtime file: '+suffix)
        output.parent.mkdir(parents=True,exist_ok=True)
        with tar.extractfile(choices[0]) as file: output.write_bytes(file.read())
    output.chmod(0o755 if output.name in ['node','codex','rg'] else 0o644)

def prepare(arch):
    spec=LOCK['architectures'][arch]
    archives=CACHE/'archives'
    node=download(spec['nodeURL'],archives/Path(spec['nodeURL']).name,bytes.fromhex(spec['nodeSHA256']))
    algorithm,value=spec['codexIntegrity'].split('-',1)
    codex=download(spec['codexURL'],archives/Path(spec['codexURL']).name,base64.b64decode(value),algorithm)
    output=CACHE/arch
    extract_one(node,'bin/node',output/'bin/node')
    node_platform = 'arm64' if arch == 'arm64' else 'x64'
    extract_one(node,'node-v'+LOCK['nodeVersion']+'-darwin-'+node_platform+'/LICENSE',output/'licenses/Node-LICENSE.txt')
    target = 'aarch64-apple-darwin' if arch == 'arm64' else 'x86_64-apple-darwin'
    extract_one(codex,'package/vendor/'+target+'/bin/codex',output/'codex')
    # Text companion only: omit voice, code-mode and search-tool runtimes.
    for key,name in [('codexLicenseURL','Codex-LICENSE.txt'),('codexNoticeURL','Codex-NOTICE.txt')]:
        download(LOCK[key],output/'licenses'/name,bytes.fromhex(LOCK[key.replace('URL','SHA256')]))
    record={'nodeVersion':LOCK['nodeVersion'],'codexVersion':LOCK['codexVersion'],'architecture':arch,
            'files':{str(p.relative_to(output)):hashlib.sha256(p.read_bytes()).hexdigest() for p in output.rglob('*') if p.is_file() and p.name!='runtime-manifest.json'}}
    (output/'runtime-manifest.json').write_text(json.dumps(record,indent=2)+'\n')
    print(str(output))
    return output

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--arch',choices=LOCK['architectures'],default='arm64')
    prepare(parser.parse_args().arch)
