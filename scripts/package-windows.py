#!/usr/bin/env python3
"""Build the native Windows companion and explicit allowlisted distribution."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.2.0-windows.1'


def run(command, env=None, capture=False):
    return subprocess.run([str(x) for x in command], cwd=ROOT, env=env,
                          check=True, text=True, capture_output=capture)


def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def plain(file):
    if not file.is_file() or file.is_symlink():
        raise RuntimeError('Required regular input missing: ' + file.name)
    return file


def copy(source, destination):
    plain(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def clean_managed(path):
    if path.is_symlink():
        raise RuntimeError('Managed build output must not be a symlink')
    if path.exists():
        shutil.rmtree(path) if path.is_dir() else path.unlink()


def main(skip_installer=False):
    if os.name != 'nt':
        raise RuntimeError('Run packaging on Windows; use GitHub Windows build workflow from a Mac.')
    lock = json.loads((ROOT / 'windows-runtime-lock.json').read_text(encoding='utf-8'))
    fetch = load('windows_runtime', ROOT / 'scripts/fetch-windows-runtime.py')
    cache = fetch.prepare(include_installer=not skip_installer)
    inputs = load('mac_inputs', ROOT / 'scripts/package-macos.py')
    inputs.validate_production_inputs()
    build = ROOT / 'build/windows'
    publish = build / 'publish'
    dist = ROOT / 'dist/windows'
    stage = ROOT / 'dist/windows-x64/Whale Pet'
    for p in [build, dist, stage.parent]:
        if p.is_symlink():
            raise RuntimeError('Managed directory must not be a symlink')
        p.mkdir(parents=True, exist_ok=True)
    clean_managed(publish)
    clean_managed(stage)
    stage.mkdir()
    environment = os.environ.copy()
    environment.update(DOTNET_CLI_TELEMETRY_OPTOUT='1', DOTNET_NOLOGO='1',
                       DOTNET_CLI_HOME=str(ROOT / '.cache/dotnet-home'),
                       NUGET_PACKAGES=str(ROOT / '.cache/nuget'))
    run(['dotnet', 'publish', 'windows/WhalePet.Windows.csproj', '-c', 'Release',
         '-r', 'win-x64', '--self-contained', 'true', '-o', publish,
         '-p:DebugType=None', '-p:DebugSymbols=false', '-p:ContinuousIntegrationBuild=true',
         '-p:IncludeSourceRevisionInInformationalVersion=false',
         '-p:PathMap=' + str(ROOT) + '=/_/whale-pet'], env=environment)
    # dotnet publish is a compiler output, never a source/user-data directory.
    allowed_suffixes = {'.exe', '.dll', '.json', '.config', '.dat', '.manifest', '.txt'}
    for p in sorted(publish.rglob('*')):
        if p.is_symlink():
            raise RuntimeError('Unexpected symlink in publish output')
        if not p.is_file():
            continue
        rel = p.relative_to(publish)
        if p.suffix.lower() == '.pdb':
            raise RuntimeError('Debug symbols must not be distributed')
        if p.suffix.lower() not in allowed_suffixes:
            raise RuntimeError('Unexpected publish output type: ' + p.name)
        copy(p, stage / rel)
    plain(stage / 'WhalePet.exe')
    plain(stage / 'WhalePet.dll')
    for name in inputs.SERVICE_FILES:
        copy(ROOT / name, stage / 'service' / name)
    for name in inputs.ASSET_FILES:
        copy(ROOT / 'assets' / name, stage / 'service/assets' / name)
    runtime_record = json.loads((cache / 'runtime-manifest.json').read_text(encoding='utf-8'))
    for name, expected in runtime_record['files'].items():
        if digest(plain(cache / name)) != expected:
            raise RuntimeError('Official runtime extraction changed after verification')
        copy(cache / name, stage / 'runtime' / name)
    copy(cache / 'runtime-manifest.json', stage / 'runtime/runtime-manifest.json')
    for name in inputs.PROJECT_NOTICES:
        copy(ROOT / name, stage / name)
    copy(ROOT / 'docs/INSTALL.windows.zh-CN.md', stage / 'INSTALL.zh-CN.md')
    # Preserve complete notices from the exact restored Microsoft runtime packs.
    microsoft_packs = []
    packages = ROOT / '.cache/nuget'
    for package in ['microsoft.netcore.app.runtime.win-x64', 'microsoft.windowsdesktop.app.runtime.win-x64']:
        folder = packages / package / lock['dotnetRuntimeVersion']
        if not folder.is_dir():
            raise RuntimeError('Expected pinned .NET runtime pack missing: ' + package)
        notices = [p for p in folder.rglob('*') if p.is_file() and
                   (p.name.lower().startswith('license') or 'third-party-notices' in p.name.lower())]
        if not notices:
            raise RuntimeError('Microsoft runtime license files missing')
        for p in notices:
            copy(p, stage / 'licenses' / package / p.relative_to(folder))
        microsoft_packs.append({'package': package, 'version': lock['dotnetRuntimeVersion'],
                                'notices': [p.relative_to(folder).as_posix() for p in notices]})
    installer = None
    if not skip_installer:
        compiler_dir = ROOT / '.cache/windows-runtime/compiler'
        compiler = compiler_dir / 'ISCC.exe'
        installer_tool = ROOT / '.cache/windows-runtime/tools/innosetup-6.7.4.exe'
        if not compiler.is_file():
            run([installer_tool, '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/DIR=' + str(compiler_dir)])
        plain(compiler)
        for p in compiler_dir.iterdir():
            if p.is_file() and p.name.lower().startswith('license'):
                copy(p, stage / 'licenses/inno-setup' / p.name)
        run([compiler, '/DAppVersion=0.2.0', '/DReleaseVersion=' + VERSION,
             '/DStageDir=' + str(stage), '/DOutputDir=' + str(dist),
             '/DLanguageFile=' + str(ROOT / 'windows/ChineseSimplified.isl'),
             '/DIconFile=' + str(ROOT / 'windows/WhalePet.ico'), ROOT / 'windows/installer.iss'])
        installer = dist / ('Whale-Pet-' + VERSION + '-windows-x64-setup.exe')
        plain(installer)
    zip_file = dist / ('Whale-Pet-' + VERSION + '-windows-x64-portable.zip')
    payload_files = sorted(p for p in stage.rglob('*') if p.is_file())
    with zipfile.ZipFile(zip_file, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for p in payload_files:
            archive.write(p, 'Whale Pet/' + p.relative_to(stage).as_posix())
    with zipfile.ZipFile(zip_file) as archive:
        if archive.testzip():
            raise RuntimeError('Portable ZIP CRC failed')
    manifest = {'schemaVersion': 1, 'version': VERSION, 'platform': 'windows', 'architecture': 'x64',
                'targetOS': 'Windows 11', 'authenticodeSigned': False, 'screenshotAvailable': False,
                'foregroundMetadataAvailable': False, 'runtime': runtime_record,
                'dotnetSDK': lock['dotnetSDKVersion'], 'dotnetRuntime': lock['dotnetRuntimeVersion'],
                'microsoftRuntimePacks': microsoft_packs,
                'files': {p.relative_to(stage).as_posix(): {'sha256': digest(p), 'size': p.stat().st_size} for p in payload_files},
                'artifacts': {p.name: {'sha256': digest(p), 'size': p.stat().st_size} for p in [zip_file, installer] if p}}
    manifest_file = dist / ('Whale-Pet-' + VERSION + '-windows-x64.manifest.json')
    manifest_file.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'stage': stage.relative_to(ROOT).as_posix(), 'artifactCount': len(manifest['artifacts']),
                      'manifest': manifest_file.relative_to(ROOT).as_posix(), 'signed': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-installer', action='store_true')
    try:
        main(parser.parse_args().skip_installer)
    except Exception as error:
        print('WINDOWS_PACKAGE_FAILED: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
