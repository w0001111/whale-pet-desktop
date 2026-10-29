#!/usr/bin/env python3
"""Audit real Windows payloads, pinned upstream bytes, and an installed copy.

Reports contain paths relative to the release/source, hashes and classifications;
never matching strings, accounts, SIDs, provider keys or temporary home paths.
No model, account login, normal GUI launch or screen capture is performed.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'Whale-Pet-0.2.0-windows.1-windows-x64'
APP_ID = '{4A2753DB-C924-4C64-9C53-721435CA2FBF}_is1'
PACKAGES = ('microsoft.netcore.app.runtime.win-x64',
            'microsoft.windowsdesktop.app.runtime.win-x64')
MAX_MEMBER = 1024 * 1024 * 1024


class AuditFailure(Exception):
    pass


def check(condition, code):
    if not condition:
        raise AuditFailure(code)


def sha(file, algorithm='sha256'):
    value = hashlib.new(algorithm)
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def load_scanner():
    spec = importlib.util.spec_from_file_location('release_audit', ROOT / 'scripts/audit-release.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.RULES = [*module.RULES, ('windows_personal_absolute_path', re.compile(
        r'\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s\x00\"\'<>]+', re.I))]
    return module


def safe_member(name):
    normalized = name.replace('\\', '/')
    parts = PurePosixPath(normalized).parts
    return bool(parts) and not normalized.startswith('/') and '..' not in parts and not re.match(r'^[A-Za-z]:', normalized)


def regular(file):
    check(file.is_file() and not file.is_symlink(), 'REGULAR_FILE_REQUIRED')
    check(not (file.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
          if hasattr(file.lstat(), 'st_file_attributes') else True, 'REPARSE_POINT_REJECTED')
    return file


def inventory(folder):
    check(folder.is_dir() and not folder.is_symlink(), 'PAYLOAD_DIRECTORY_REQUIRED')
    files = {}
    for file in sorted(folder.rglob('*')):
        check(not file.is_symlink(), 'PAYLOAD_LINK_REJECTED')
        if hasattr(file.lstat(), 'st_file_attributes'):
            check(not file.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT,
                  'PAYLOAD_REPARSE_POINT_REJECTED')
        if file.is_dir():
            continue
        regular(file)
        name = file.relative_to(folder).as_posix()
        check(safe_member(name), 'UNSAFE_PAYLOAD_PATH')
        files[name] = {'sha256': sha(file), 'size': file.stat().st_size}
    check(bool(files), 'EMPTY_PAYLOAD')
    return files


def isolated_environment(temporary, appdata):
    home, temp = temporary / 'home', temporary / 'tmp'
    for folder in (home, temp, home / 'Roaming', home / 'Local', appdata):
        folder.mkdir(parents=True, exist_ok=True)
    system = os.environ.get('SystemRoot', r'C:\Windows')
    # Explicit allowlist: no inherited provider/account/token environment.
    return {'SystemRoot': system, 'WINDIR': system,
            'PATH': os.environ.get('PATH', ''), 'HOME': str(home), 'USERPROFILE': str(home),
            'APPDATA': str(home / 'Roaming'), 'LOCALAPPDATA': str(home / 'Local'),
            'TEMP': str(temp), 'TMP': str(temp), 'TMPDIR': str(temp),
            'CODEX_HOME': str(temporary / 'empty-codex-home'),
            'WHALE_PET_DATA_DIR': str(appdata), 'DOTNET_CLI_TELEMETRY_OPTOUT': '1',
            'DOTNET_NOLOGO': '1', 'DOTNET_CLI_HOME': str(temporary / 'dotnet-home'),
            'NUGET_PACKAGES': str(ROOT / '.cache/nuget')}


def run(command, env, timeout=120, failure='COMMAND_FAILED'):
    # Child output can include local home paths; inspect it in memory only.
    try:
        result = subprocess.run([str(item) for item in command], cwd=ROOT, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding='utf-8', errors='replace', timeout=timeout,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.TimeoutExpired):
        raise AuditFailure(failure + '_UNAVAILABLE_OR_TIMEOUT') from None
    check(result.returncode == 0, failure)
    return result.stdout


def zip_bytes(archive, member):
    entries = archive.infolist()
    matches = [entry for entry in entries if entry.filename == member]
    check(len(matches) == 1 and matches[0].file_size <= MAX_MEMBER and safe_member(member), 'UPSTREAM_MEMBER_INVALID')
    check(not stat.S_ISLNK(matches[0].external_attr >> 16), 'UPSTREAM_LINK_REJECTED')
    return archive.read(matches[0])


def verify_originals(lock, temporary, scanner, env, report):
    """Re-hash archives and extract originals independently of runtime-manifest."""
    cache = ROOT / '.cache/windows-runtime'
    originals, origins, raw = temporary / 'originals', {}, scanner.Audit()
    original_hashes = {}
    originals.mkdir()

    def register(body, relative, source):
        check(len(body) <= MAX_MEMBER and safe_member(relative), 'UPSTREAM_MEMBER_TOO_LARGE')
        target = originals / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        digest = sha(target)
        original_hashes[relative] = digest
        record = {'path': relative, 'sha256': digest, 'size': len(body), **source}
        origins.setdefault(digest, []).append(record)
        raw.scan_bytes(body, relative)
        return digest

    node_archive = regular(cache / 'archives' / lock['nodeURL'].rsplit('/', 1)[-1])
    check(sha(node_archive) == lock['nodeSHA256'], 'NODE_ARCHIVE_SHA256')
    node_expected = {}
    with zipfile.ZipFile(node_archive) as archive:
        prefix = 'node-v' + lock['nodeVersion'] + '-win-x64/'
        for member, destination in [('node.exe', 'runtime/bin/node.exe'), ('LICENSE', 'runtime/licenses/Node-LICENSE.txt')]:
            digest = register(zip_bytes(archive, prefix + member), 'node/' + member,
                              {'kind': 'node', 'archiveSHA256': lock['nodeSHA256'], 'member': prefix + member})
            node_expected[destination] = digest

    codex_archive = regular(cache / 'archives' / lock['codexURL'].rsplit('/', 1)[-1])
    algorithm, expected = lock['codexIntegrity'].split('-', 1)
    check(algorithm == 'sha512' and base64.b64encode(bytes.fromhex(sha(codex_archive, algorithm))).decode() == expected,
          'CODEX_ARCHIVE_SHA512')
    codex_archive_sha = sha(codex_archive)
    with tarfile.open(codex_archive, 'r:gz') as archive:
        members = [member for member in archive.getmembers() if member.isfile() and member.name.endswith('/x86_64-pc-windows-msvc/bin/codex.exe')]
        check(len(members) == 1 and members[0].size <= MAX_MEMBER and safe_member(members[0].name), 'CODEX_ORIGINAL_MEMBER')
        with archive.extractfile(members[0]) as stream:
            node_expected['runtime/codex.exe'] = register(stream.read(), 'codex/codex.exe',
                {'kind': 'codex', 'archiveSHA256': codex_archive_sha, 'archiveSHA512': sha(codex_archive, 'sha512'), 'member': members[0].name})
    for kind, filename in [('License', 'Codex-LICENSE.txt'), ('Notice', 'Codex-NOTICE.txt')]:
        source = regular(cache / 'x64/licenses' / filename)
        check(sha(source) == lock['codex' + kind + 'SHA256'], 'CODEX_NOTICE_SHA256')
        node_expected['runtime/licenses/' + filename] = register(source.read_bytes(), 'codex/' + filename,
            {'kind': 'codex-notice', 'sourceSHA256': lock['codex' + kind + 'SHA256'], 'member': filename})
    report['pinnedRuntimeOriginals'] = {'nodeArchiveSHA256': sha(node_archive),
        'codexArchiveSHA256': codex_archive_sha, 'codexArchiveSHA512': sha(codex_archive, 'sha512'),
        'packageFiles': node_expected}

    nuget_records = []
    dotnet = shutil.which('dotnet', path=env['PATH'])
    for package in PACKAGES:
        folder = ROOT / '.cache/nuget' / package / lock['dotnetRuntimeVersion']
        archive_file = regular(folder / (package + '.' + lock['dotnetRuntimeVersion'] + '.nupkg'))
        checksum_file = regular(Path(str(archive_file) + '.sha512'))
        expected_checksum = checksum_file.read_text(encoding='utf-8-sig').strip()
        actual_checksum = base64.b64encode(bytes.fromhex(sha(archive_file, 'sha512'))).decode()
        check(actual_checksum == expected_checksum, 'NUGET_ARCHIVE_SHA512')
        archive_sha256, archive_sha512 = sha(archive_file), sha(archive_file, 'sha512')
        signature_verified = False
        if dotnet:
            run([dotnet, 'nuget', 'verify', archive_file, '--all', '--verbosity', 'quiet'], env, timeout=180,
                failure='NUGET_SIGNATURE_VERIFICATION_FAILED')
            signature_verified = True
        with zipfile.ZipFile(archive_file) as archive:
            entries = archive.infolist()
            check(len(entries) <= 30000 and sum(entry.file_size for entry in entries) <= 3 * MAX_MEMBER,
                  'NUGET_ARCHIVE_BOUNDS')
            check('.signature.p7s' in archive.namelist(), 'NUGET_SIGNATURE_MISSING')
            nuspecs = [name for name in archive.namelist() if '/' not in name and name.lower().endswith('.nuspec')]
            check(len(nuspecs) == 1, 'NUGET_PACKAGE_IDENTITY')
            metadata = ET.fromstring(zip_bytes(archive, nuspecs[0]))
            fields = {item.tag.rsplit('}', 1)[-1]: item.text for item in metadata.iter()}
            check(fields.get('id', '').lower() == package and fields.get('version') == lock['dotnetRuntimeVersion'],
                  'NUGET_PACKAGE_IDENTITY')
            seen = set()
            for entry in entries:
                check(safe_member(entry.filename) and entry.filename not in seen, 'NUGET_MEMBER_PATH')
                seen.add(entry.filename)
                if entry.is_dir():
                    continue
                check(not stat.S_ISLNK(entry.external_attr >> 16) and entry.file_size <= MAX_MEMBER, 'NUGET_MEMBER_UNSAFE')
                body = archive.read(entry)
                register(body, 'nuget/' + package + '/' + entry.filename,
                         {'kind': 'microsoft-runtime', 'package': package, 'version': lock['dotnetRuntimeVersion'],
                          'archiveSHA256': archive_sha256, 'archiveSHA512': archive_sha512,
                          'signatureVerified': signature_verified, 'member': entry.filename})
        nuget_records.append({'package': package, 'version': lock['dotnetRuntimeVersion'],
                              'archiveSHA256': archive_sha256, 'archiveSHA512': archive_sha512,
                              'sha512SidecarMatched': True, 'signatureVerifierAvailable': bool(dotnet),
                              'signatureVerified': signature_verified})
    report['microsoftRuntimeOriginals'] = nuget_records
    report['upstreamRawFindings'] = [{'path': name, 'line': line, 'category': category,
        'sha256': original_hashes[name]} for name, line, category in sorted(raw.findings)]
    report['upstreamOriginalFilesScanned'] = raw.files
    return origins, node_expected


def verify_payload(stage, manifest_file, portable, setup, lock, originals, expected, scanner, report):
    manifest = json.loads(regular(manifest_file).read_text(encoding='utf-8'))
    check(manifest.get('platform') == 'windows' and manifest.get('architecture') == 'x64', 'MANIFEST_PLATFORM')
    files = inventory(stage)
    check(files == manifest['files'], 'MANIFEST_PAYLOAD_MISMATCH')
    report['payloadFiles'] = files
    for relative, digest in expected.items():
        check(relative in files and files[relative]['sha256'] == digest, 'PINNED_RUNTIME_NOT_IDENTICAL')
    runtime = json.loads((stage / 'runtime/runtime-manifest.json').read_text(encoding='utf-8'))
    check(runtime.get('lockSHA256') == sha(ROOT / 'windows-runtime-lock.json'), 'RUNTIME_LOCK_MISMATCH')
    check(set(runtime['files']) == {name.removeprefix('runtime/') for name in expected}, 'RUNTIME_FILE_ALLOWLIST')
    check(all(runtime['files'][name.removeprefix('runtime/')] == digest for name, digest in expected.items()), 'RUNTIME_RECORDED_HASH_MISMATCH')
    artifacts = {}
    for file in (portable, setup):
        regular(file)
        artifacts[file.name] = {'sha256': sha(file), 'size': file.stat().st_size}
        check(manifest['artifacts'].get(file.name) == artifacts[file.name], 'ARTIFACT_MANIFEST_MISMATCH')
    report['artifacts'] = artifacts
    with zipfile.ZipFile(portable) as archive:
        entries = archive.infolist()
        check(len(entries) == len(files), 'ZIP_ENTRY_COUNT')
        check(archive.testzip() is None, 'ZIP_CRC')
        names = set()
        for entry in entries:
            check(safe_member(entry.filename) and entry.filename.startswith('Whale Pet/'), 'ZIP_PATH')
            relative = entry.filename.removeprefix('Whale Pet/')
            check(relative in files and relative not in names and not entry.is_dir(), 'ZIP_FILE_TABLE')
            check(not stat.S_ISLNK(entry.external_attr >> 16), 'ZIP_LINK')
            names.add(relative)
            body = archive.read(entry)
            check(len(body) == files[relative]['size'] and hashlib.sha256(body).hexdigest() == files[relative]['sha256'], 'ZIP_PAYLOAD_BYTES')
        check(names == set(files), 'ZIP_FILE_TABLE')
    raw = scanner.Audit()
    raw.scan_tree(stage, 'payload', packaged=True)
    raw.scan_bytes(manifest_file.read_bytes(), 'metadata/' + manifest_file.name)
    raw.scan_bytes(setup.read_bytes(), 'installer/' + setup.name)
    classified, unclassified = [], []

    def upstream_sources(relative, digest):
        sources = originals.get(digest, [])
        if relative in expected and expected[relative] == digest:
            return sources
        matched = []
        for source in sources:
            if source['kind'] != 'microsoft-runtime':
                continue
            member = source['member']
            # Provenance includes the distribution role/path, not merely a hash
            # found somewhere in an unrelated vendor archive.
            library = member.split('/lib/net10.0/', 1)[-1] if '/lib/net10.0/' in member else None
            native = member.split('/native/', 1)[-1] if '/native/' in member else None
            notice = 'licenses/' + source['package'] + '/' + member
            if relative in (library, native, notice):
                matched.append(source)
        return matched

    for name, line, category in sorted(raw.findings):
        relative = name.removeprefix('payload/') if name.startswith('payload/') else None
        record = {'path': name, 'line': line, 'category': category}
        sources = upstream_sources(relative, files[relative]['sha256']) if relative in files else []
        # Our own executable/assembly never receives a vendor exception.
        if sources and relative not in {'WhalePet.exe', 'WhalePet.dll'}:
            classified.append({**record, 'sha256': files[relative]['sha256'], 'origins': sources})
        else:
            unclassified.append(record)
    report.update(rawFindingsCount=len(raw.findings), classifiedUpstream=classified,
                  unclassifiedFindings=unclassified, payloadFilesScanned=raw.files,
                  zipFilesByteVerified=len(files), runtimeFilesByteVerified=len(expected))
    check(not unclassified, 'UNCLASSIFIED_PAYLOAD_FINDINGS')
    # Every distributed Microsoft framework binary needs original-package proof,
    # independently of whether the privacy scanner happened to find a string.
    matched = []
    for relative, record in files.items():
        if not relative.startswith('runtime/') and relative.lower().endswith(('.dll', '.exe')) and relative not in {'WhalePet.exe', 'WhalePet.dll'}:
            sources = [source for source in upstream_sources(relative, record['sha256']) if source['kind'] == 'microsoft-runtime']
            check(bool(sources), 'FRAMEWORK_BINARY_ORIGIN_UNVERIFIED')
            matched.append({'path': relative, 'sha256': record['sha256'], 'origins': sources})
    report['microsoftPayloadFilesByteVerified'] = matched
    return files


def existing_registration():
    import winreg
    key = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + APP_ID
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key):
            return True
    except FileNotFoundError:
        return False


def install_audit(setup, expected, temporary, env, report):
    check(not existing_registration(), 'PREEXISTING_INSTALLATION_NOT_TOUCHED')
    install, appdata = temporary / 'installed-payload', Path(env['WHALE_PET_DATA_DIR'])
    marker = appdata / 'data' / 'synthetic-uninstall-marker.txt'
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text('SYNTHETIC-UNINSTALL-DATA-PRESERVED\n', encoding='utf-8')
    marker_sha = sha(marker)
    installed = False
    try:
        run([setup, '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/DIR=' + str(install)], env, timeout=180,
            failure='SILENT_INSTALL_FAILED')
        installed = True
        actual = inventory(install)
        generated = {name: value for name, value in actual.items() if re.fullmatch(r'unins000\.(?:exe|dat|msg)', name, re.I)}
        payload = {name: value for name, value in actual.items() if name not in generated}
        check(payload == expected, 'INSTALLED_PAYLOAD_BYTES')
        check('unins000.exe' in generated and 'unins000.dat' in generated, 'UNINSTALLER_MISSING')
        text = run([install / 'WhalePet.exe', '--diagnostics'], env, failure='INSTALLED_DIAGNOSTICS_FAILED')
        try:
            diagnostics = json.loads(text)
        except (ValueError, TypeError):
            raise AuditFailure('NATIVE_DIAGNOSTICS_JSON') from None
        for name in ('serviceEntryExists', 'assetsExist', 'nodeExecutableExists', 'codexExecutableExists', 'offlinePetAvailable'):
            check(diagnostics.get(name) is True, 'INSTALLED_NATIVE_RESOURCES')
        for name in ('guiStarted', 'serviceStarted', 'userStateRead', 'screenshotsDefaultEnabled', 'appInfoDefaultEnabled', 'windowsScreenCaptureSupported', 'windowsForegroundInformationSupported'):
            check(diagnostics.get(name) is False, 'INSTALLED_NATIVE_SIDE_EFFECTS')
        check(Path(diagnostics.get('applicationDirectory', '')).resolve() == appdata.resolve(), 'INSTALLED_DIAGNOSTICS_DATA_ROOT')
        report['installedPayloadFilesByteVerified'] = len(payload)
        report['installerGeneratedFiles'] = generated
        report['installedDiagnostics'] = {name: diagnostics[name] for name in diagnostics if isinstance(diagnostics[name], bool)}
        run([install / 'unins000.exe', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], env, timeout=180,
            failure='SILENT_UNINSTALL_FAILED')
        installed = False
        check(not (install / 'WhalePet.exe').exists() and not (install / 'service/service.mjs').exists(), 'UNINSTALL_PAYLOAD_REMAINS')
        check(marker.is_file() and sha(marker) == marker_sha, 'UNINSTALL_REMOVED_USER_DATA')
        check(not existing_registration(), 'UNINSTALL_REGISTRATION_REMAINS')
        report.update(installerExecuted=True, uninstallExecuted=True, syntheticUserDataPreserved=True,
                      installerUninstallRegistrationCleaned=True)
    finally:
        if installed and (install / 'unins000.exe').is_file():
            try:
                run([install / 'unins000.exe', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], env, timeout=180)
            except AuditFailure:
                report['cleanupUninstallFailed'] = True


def main(args):
    report = {'schemaVersion': 1, 'pass': False, 'platform': 'windows', 'modelRequests': 0,
              'loginPerformed': False, 'desktopCaptured': False, 'normalGuiStarted': False}
    output = ROOT / args.report
    try:
        check(os.name == 'nt', 'WINDOWS_REQUIRED')
        check(sys.getwindowsversion().build >= 22000, 'WINDOWS_11_REQUIRED')
        scanner = load_scanner()
        lock = json.loads((ROOT / 'windows-runtime-lock.json').read_text(encoding='utf-8'))
        stage = ROOT / args.stage
        dist = ROOT / 'dist/windows'
        with tempfile.TemporaryDirectory(prefix='whale-windows-audit-') as temporary_name:
            temporary = Path(temporary_name)
            env = isolated_environment(temporary, temporary / 'home/Local/WhalePet')
            origins, expected = verify_originals(lock, temporary, scanner, env, report)
            payload = verify_payload(stage, dist / (PREFIX + '.manifest.json'),
                                     dist / (PREFIX + '-portable.zip'), dist / (PREFIX + '-setup.exe'),
                                     lock, origins, expected, scanner, report)
            install_audit(dist / (PREFIX + '-setup.exe'), payload, temporary, env, report)
        report['pass'] = True
    except AuditFailure as error:
        report['error'] = {'code': str(error)}
    except Exception:
        report['error'] = {'code': 'WINDOWS_AUDIT_FAILED'}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'pass': report['pass'], 'report': output.relative_to(ROOT).as_posix(),
                      'payloadFilesScanned': report.get('payloadFilesScanned', 0),
                      'classifiedUpstreamCount': len(report.get('classifiedUpstream', [])),
                      'unclassifiedCount': len(report.get('unclassifiedFindings', [])),
                      **({'error': report['error']} if 'error' in report else {})}))
    return 0 if report['pass'] else 1


def self_test():
    """Pure synthetic integrity/classification checks, never Windows execution."""
    scanner = load_scanner()
    with tempfile.TemporaryDirectory(prefix='whale-audit-selftest-') as name:
        root = Path(name)
        stage = root / 'payload'
        (stage / 'runtime/bin').mkdir(parents=True)
        (stage / 'service').mkdir()
        upstream = b'MZ\0 token = ' + bytes([39]) + b'UPSTREAM' + b'-FIXTURE' * 3 + bytes([39])
        (stage / 'runtime/bin/node.exe').write_bytes(upstream)
        (stage / 'WhalePet.exe').write_bytes(b'MZ\0SYNTHETIC-NATIVE')
        (stage / 'WhalePet.dll').write_bytes(b'MZ\0SYNTHETIC-ASSEMBLY')
        (stage / 'service/service.mjs').write_text('export const synthetic=true;\n')
        expected = {'runtime/bin/node.exe': hashlib.sha256(upstream).hexdigest()}
        runtime = {'lockSHA256': sha(ROOT / 'windows-runtime-lock.json'),
                   'files': {'bin/node.exe': expected['runtime/bin/node.exe']}}
        (stage / 'runtime/runtime-manifest.json').write_text(json.dumps(runtime))
        portable, setup, manifest_file = root / 'portable.zip', root / 'setup.exe', root / 'manifest.json'
        setup.write_bytes(b'MZ\0SYNTHETIC-INSTALLER')

        def bundle():
            files = inventory(stage)
            with zipfile.ZipFile(portable, 'w') as archive:
                for relative in files:
                    archive.write(stage / relative, 'Whale Pet/' + relative)
            manifest_file.write_text(json.dumps({'platform': 'windows', 'architecture': 'x64', 'files': files,
                'artifacts': {file.name: {'sha256': sha(file), 'size': file.stat().st_size} for file in (portable, setup)}}))

        origins = {expected['runtime/bin/node.exe']: [{'kind': 'node', 'member': 'synthetic/node.exe'}]}
        bundle()
        report = {}
        verify_payload(stage, manifest_file, portable, setup, {}, origins, expected, scanner, report)
        check(report['classifiedUpstream'] and not report['unclassifiedFindings'], 'SELF_TEST_UPSTREAM_CLASSIFICATION')
        (stage / 'service/service.mjs').write_bytes(upstream)
        (stage / 'WhalePet.dll').write_bytes(upstream)
        bundle()
        failed_report = {}
        try:
            verify_payload(stage, manifest_file, portable, setup, {}, origins, expected, scanner, failed_report)
            raise AuditFailure('SELF_TEST_OWN_ASSEMBLY_EXCEPTION')
        except AuditFailure as error:
            check(str(error) == 'UNCLASSIFIED_PAYLOAD_FINDINGS', 'SELF_TEST_OWN_ASSEMBLY_EXCEPTION')
            check(any(item['path'] == 'payload/service/service.mjs' for item in failed_report['unclassifiedFindings']), 'SELF_TEST_SERVICE_NO_VENDOR_EXCEPTION')
        (stage / 'WhalePet.dll').write_bytes(b'MZ\0SYNTHETIC-ASSEMBLY')
        (stage / 'service/service.mjs').write_text('export const synthetic=true;\n')
        bundle()
        (stage / 'service/service.mjs').write_text('changed after manifest\n')
        try:
            verify_payload(stage, manifest_file, portable, setup, {}, origins, expected, scanner, {})
            raise AuditFailure('SELF_TEST_MANIFEST_TAMPER')
        except AuditFailure as error:
            check(str(error) == 'MANIFEST_PAYLOAD_MISMATCH', 'SELF_TEST_MANIFEST_TAMPER')
    print('Windows audit synthetic integrity/classification self-test: PASS (no Windows execution)')
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', default='dist/windows-x64/Whale Pet')
    parser.add_argument('--report', default='build/windows-validation/audit-windows.json')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    raise SystemExit(self_test() if args.self_test else main(args))
