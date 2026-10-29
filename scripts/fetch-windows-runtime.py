#!/usr/bin/env python3
"""Extract only checksum-verified official Windows text runtimes and licenses."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'windows-runtime-lock.json').read_text(encoding='utf-8'))
CACHE = ROOT / '.cache/windows-runtime'


def sha(file, algorithm='sha256'):
    value = hashlib.new(algorithm)
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.digest()


def parents_safe(file):
    current = file
    while current != ROOT and ROOT in current.parents:
        if current.is_symlink():
            raise RuntimeError('Runtime cache must not contain symbolic links')
        current = current.parent


def download(url, target, expected, algorithm='sha256'):
    parents_safe(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and sha(target, algorithm) == expected:
        return target
    partial = target.with_name(target.name + '.part')
    parents_safe(partial)
    curl = shutil.which('curl.exe' if os.name == 'nt' else 'curl')
    if not curl:
        raise RuntimeError('curl is required to fetch pinned runtime archives')
    subprocess.run([curl, '-q', '--fail', '--location', '--silent', '--show-error',
                    '--retry', '2', '--max-time', '1200', '--continue-at', '-',
                    '--proto', '=https', '--output', str(partial), url], check=True)
    if sha(partial, algorithm) != expected:
        raise RuntimeError('Runtime checksum mismatch: ' + target.name)
    partial.replace(target)
    return target


def write(file, content):
    parents_safe(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_name(file.name + '.extracting')
    parents_safe(temp)
    temp.write_bytes(content)
    temp.replace(file)


def extract_tar(archive, suffix, output):
    with tarfile.open(archive, 'r:gz') as data:
        matches = [m for m in data.getmembers() if m.isfile() and m.name.endswith('/' + suffix)]
        if len(matches) != 1:
            raise RuntimeError('Expected one official runtime member: ' + suffix)
        with data.extractfile(matches[0]) as file:
            write(output, file.read())


def prepare(include_installer=False):
    archives = CACHE / 'archives'
    node = download(LOCK['nodeURL'], archives / Path(LOCK['nodeURL']).name, bytes.fromhex(LOCK['nodeSHA256']))
    algorithm, digest = LOCK['codexIntegrity'].split('-', 1)
    codex = download(LOCK['codexURL'], archives / Path(LOCK['codexURL']).name, base64.b64decode(digest), algorithm)
    output = CACHE / 'x64'
    with zipfile.ZipFile(node) as archive:
        prefix = 'node-v' + LOCK['nodeVersion'] + '-win-x64/'
        for source, destination in [('node.exe', 'bin/node.exe'), ('LICENSE', 'licenses/Node-LICENSE.txt')]:
            write(output / destination, archive.read(prefix + source))
    extract_tar(codex, 'x86_64-pc-windows-msvc/bin/codex.exe', output / 'codex.exe')
    # Voice, code-host and search helpers are deliberately absent from this text companion.
    for kind, name in [('License', 'Codex-LICENSE.txt'), ('Notice', 'Codex-NOTICE.txt')]:
        download(LOCK['codex' + kind + 'URL'], output / 'licenses' / name,
                 bytes.fromhex(LOCK['codex' + kind + 'SHA256']))
    record = {'architecture': 'x64', 'nodeVersion': LOCK['nodeVersion'], 'codexVersion': LOCK['codexVersion'],
              'lockSHA256': hashlib.sha256((ROOT / 'windows-runtime-lock.json').read_bytes()).hexdigest(),
              'files': {p.relative_to(output).as_posix(): sha(p).hex() for p in output.rglob('*')
                        if p.is_file() and p.name != 'runtime-manifest.json'}}
    write(output / 'runtime-manifest.json', (json.dumps(record, indent=2) + '\n').encode())
    if include_installer:
        download(LOCK['innoSetupURL'], CACHE / 'tools/innosetup-6.7.4.exe', bytes.fromhex(LOCK['innoSetupSHA256']))
    print('Windows x64 runtime archives and extracted files verified.')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--include-installer', action='store_true')
    prepare(parser.parse_args().include_installer)
