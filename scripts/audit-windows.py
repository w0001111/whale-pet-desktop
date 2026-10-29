#!/usr/bin/env python3
"""Audit real Windows payloads, pinned upstream bytes, and an installed copy.

Reports contain paths relative to the release/source, hashes and classifications;
never matching strings, accounts, SIDs, provider keys or temporary home paths.
No model, account login, normal GUI launch or screen capture is performed.
"""
import argparse
import base64
from contextlib import contextmanager
import hashlib
import importlib.util
import io
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
import time
import zipfile
import xml.etree.ElementTree as ET
import zlib

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


def load_scanner(cached=True):
    spec = importlib.util.spec_from_file_location('release_audit', ROOT / 'scripts/audit-release.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.RULES = [*module.RULES, ('windows_personal_absolute_path', re.compile(
        r'\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s\x00\"\'<>]+', re.I))]
    module.scan_cache_stats = {'uniqueLeafScans': 0, 'replayedLeafScans': 0}
    if cached:
        base_audit, cache = module.Audit, {}
        class CachedAudit(base_audit):
            def scan_bytes(self, content, name, depth=0):
                lower = str(name).lower()
                # Archive interpretation depends on the filename and recursion.
                # Only leaf bytes can reuse a prior scan; path checks still run
                # in scan_tree/ZIP traversal before this method is reached.
                if lower.endswith(('.zip', '.dmg', *module.ARCHIVE_OTHER)) or len(content) > module.MAX_FILE_BYTES:
                    return super().scan_bytes(content, name, depth)
                key = (hashlib.sha256(content).digest(), len(content), depth)
                if key not in cache:
                    isolated = base_audit()
                    isolated.scan_bytes(content, 'leaf', depth)
                    check(isolated.files == 1 and isolated.archives == 0, 'LEAF_SCAN_CACHE_BOUNDARY')
                    cache[key] = [(line, category) for _, line, category in isolated.findings]
                    module.scan_cache_stats['uniqueLeafScans'] += 1
                else:
                    module.scan_cache_stats['replayedLeafScans'] += 1
                self.files += 1
                for line, category in cache[key]:
                    self.add(name, line, category)
        module.Audit = CachedAudit
    return module


def safe_exception(error):
    record = {'type': type(error).__name__}
    for name in ('errno', 'winerror'):
        value = getattr(error, name, None)
        if type(value) is int:
            record[name] = value
    return record


def cleanup_owned_temporary(folder, report, label, timeout=20):
    """Retry only our freshly created temporary root; a durable failure fails."""
    check(folder.parent.resolve() == Path(tempfile.gettempdir()).resolve()
          and folder.name.startswith('whale-'), 'TEMPORARY_CLEANUP_TARGET_REJECTED')
    record = {'scope': label, 'cleaned': False, 'attempts': 0}
    report.setdefault('temporaryCleanup', []).append(record)
    deadline = time.monotonic() + timeout
    def readonly_retry(function, name, info):
        candidate = Path(name)
        check(candidate == folder or folder in candidate.parents, 'TEMPORARY_CLEANUP_TARGET_REJECTED')
        if not isinstance(info[1], PermissionError) or candidate.is_symlink():
            raise info[1]
        attributes = candidate.lstat()
        if getattr(attributes, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
            raise info[1]
        os.chmod(candidate, stat.S_IREAD | stat.S_IWRITE)
        function(name)
    while True:
        record['attempts'] += 1
        try:
            check(not folder.is_symlink(), 'TEMPORARY_ROOT_LINK_REJECTED')
            if folder.exists():
                attributes = folder.lstat()
                check(not getattr(attributes, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0), 'TEMPORARY_ROOT_LINK_REJECTED')
                shutil.rmtree(folder, onerror=readonly_retry)
            check(not folder.exists(), 'TEMPORARY_ROOT_REMAINS')
            record['cleaned'] = True
            report.setdefault('phases', {})[label + '-cleanup'] = True
            return
        except OSError as error:
            record['lastException'] = safe_exception(error)
            if time.monotonic() >= deadline:
                raise AuditFailure('TEMPORARY_CLEANUP_FAILED') from None
            time.sleep(.5)


@contextmanager
def audit_temporary(report, label):
    folder = Path(tempfile.mkdtemp(prefix='whale-windows-' + label + '-'))
    body_error = None
    try:
        yield folder
    except BaseException as error:
        body_error = error
        report.setdefault('failedPhase', report.get('phase', label))
        raise
    finally:
        if body_error is None:
            report['phase'] = label + '-cleanup'
        try:
            cleanup_owned_temporary(folder, report, label)
        except Exception as error:
            report['cleanupException'] = safe_exception(error)
            if body_error is None:
                raise


@contextmanager
def audit_phase(report, label):
    report['phase'] = label
    report.setdefault('phases', {})[label] = False
    started = time.monotonic()
    try:
        yield
        report['phases'][label] = True
    except BaseException:
        report.setdefault('failedPhase', label)
        raise
    finally:
        elapsed = round((time.monotonic() - started) * 1000)
        report.setdefault('phaseElapsedMs', {})[label] = elapsed
        print(json.dumps({'auditPhase': label, 'complete': report['phases'][label], 'elapsedMs': elapsed}), flush=True)


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


def nuget_output_categories(text):
    """Return fixed diagnostic labels; never publish captured command text."""
    patterns = {
        'package-integrity': r'\bNU3008\b',
        'invalid-signature-or-platform': r'\bNU3003\b',
        'unsigned-package': r'\bNU3004\b',
        'revocation-unavailable': r'CRYPT_E_REVOCATION_OFFLINE|0x80092013|OfflineRevocation|RevocationStatusUnknown|revocation.{0,160}(?:could not|unable|unavailable|offline|not be reached)',
        'certificate-revoked': r'CERT_E_REVOKED|0x800b010c|certificate.{0,80}(?:has been|was|is) revoked',
        'untrusted-root': r'UntrustedRoot|CERT_E_UNTRUSTEDROOT|0x800b0109|root certificate.{0,80}not trusted|terminated in a root certificate',
        'certificate-time': r'NotTimeValid|CERT_E_EXPIRED|0x800b0101|certificate.{0,80}expired',
        'certificate-chain': r'\bNU30(?:18|28|42)\b|chain building issue',
        'crypto-api': r'CryptographicException|AppleCrypto|Crypt32',
        'sdk-resolution': r'\bNETSDK\d{4}\b|compatible .NET SDK|SDK.{0,80}not found|could not execute because',
        'cli-arguments': r'unrecognized (?:command|option)|unexpected (?:argument|option)|unknown (?:option|command)|required argument|invalid (?:argument|option)',
        'configuration': r'NuGet.Config.{0,100}(?:not found|does not exist|invalid)|(?:error|failed|unable).{0,100}(?:config|XML)|configuration file.{0,80}(?:not found|invalid|does not exist)',
        'environment-path': r'ArgumentNullException|Value cannot be null.{0,80}path|NuGetEnvironment',
        'io-missing': r'FileNotFoundException|DirectoryNotFoundException|could not find (?:file|a part of the path)|no such file',
        'access-denied': r'UnauthorizedAccess|access.{0,30}denied|SecurityException',
        'network': r'HttpRequestException|NameResolution|SocketException|connection.{0,40}(?:failed|refused)|SSL connection.{0,40}(?:failed|could not)|timed? out',
    }
    return sorted(name for name, pattern in patterns.items() if re.search(pattern, text, re.I))


def decode_nuget_output(value):
    if value is None:
        return '', 'empty'
    if isinstance(value, str):
        return value, 'text'
    if value.startswith((b'\xff\xfe', b'\xfe\xff')):
        return value.decode('utf-16', errors='replace'), 'utf16-bom'
    sample = value[:512]
    if len(sample) >= 8 and sample[1::2].count(0) > len(sample[1::2]) // 2:
        return value.decode('utf-16le', errors='replace'), 'utf16le-detected'
    if len(sample) >= 8 and sample[0::2].count(0) > len(sample[0::2]) // 2:
        return value.decode('utf-16be', errors='replace'), 'utf16be-detected'
    return value.decode('utf-8-sig', errors='replace'), 'utf8'


def sanitized_nuget_excerpt(text, env):
    # Only trusted official-package tool output reaches this sanitizer. Scrub
    # complete known values before truncation, so a long proxy/path cannot be
    # partially exposed at the excerpt boundary.
    values = {str(ROOT)}
    for source in (env, os.environ):
        for name, value in source.items():
            if value and (name.upper() in {'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
                                           'DOTNET_ROOT', 'DOTNET_CLI_HOME', 'NUGET_PACKAGES', 'WHALE_PET_DATA_DIR'}
                          or 'PROXY' in name.upper()):
                values.add(value)
    for value in sorted(values, key=len, reverse=True):
        if len(value) >= 3:
            text = re.sub(re.escape(value), '[PATH_OR_PROXY]', text, flags=re.I)
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'(?i)\b(https?://)[^\s/@]+@', r'\1[URL_USERINFO]@', text)
    text = re.sub(r'(?i)(?:\\\\\?\\)?\b[A-Z]:[\\/][^\r\n\t\"\'<>]*', '[WINDOWS_PATH]', text)
    text = re.sub(r'/(?:Users|Volumes|private|tmp|home)/[^\s\"\'<>]+', '[ABSOLUTE_PATH]', text)
    text = re.sub(r'(?i)\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_.-]{12,})', '[CREDENTIAL_SHAPE]', text)
    text = re.sub(r'(?i)(?:Bearer\s+[^\s\"\']+|(?:access_token|refresh_token|api_key|password|client_secret)\s*[:=]\s*[^\r\n]+)', '[CREDENTIAL_VALUE]', text)
    text = ''.join(character if character.isprintable() or character in '\n\t' else '?' for character in text)
    return '\n'.join(text.splitlines()[:32])[:6000]


def emit_ci_nuget_diagnostic(record, text, env):
    if ci_signature_environment({}) is None or record['verified']:
        return
    # Diagnostic log only, deliberately absent from every public JSON report and
    # release asset. One JSON line also prevents Actions workflow-command syntax.
    print('NUGET_CI_DIAGNOSTIC ' + json.dumps({'package': record['package'], 'profile': record['profile'],
          'exitCode': record['exitCode'], 'excerpt': sanitized_nuget_excerpt(text, env)}, ensure_ascii=True), flush=True)


SIGNATURE_SYSTEM_VARIABLES = ('ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles',
    'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'SystemDrive')


def signature_system_environment(env):
    result = dict(env)
    if os.name == 'nt':
        # NuGet's IS_CORECLR Windows path resolver directly reads these names;
        # missing PROGRAMFILES(X86)/PROGRAMFILES can cause Path.Combine(null,
        # "NuGet") before package validation. These are machine paths only.
        original = {name.upper(): value for name, value in os.environ.items()}
        for name in SIGNATURE_SYSTEM_VARIABLES:
            if original.get(name.upper()):
                result[name] = original[name.upper()]
    return result


def probe_nuget_signature(dotnet, archive, package, version, env, profile='isolated'):
    """Run the real verifier, retaining only codes, timing and fixed categories."""
    started = time.monotonic()
    record = {'package': package, 'version': version, 'profile': profile,
              'verified': False, 'commandStarted': False, 'timedOut': False,
              'exitCode': None, 'nugetCodes': [], 'outputCategories': []}
    # Deterministic language improves category diagnostics without inheriting any
    # developer account environment. Online revocation remains the default.
    command_env = signature_system_environment({**env, 'DOTNET_CLI_UI_LANGUAGE': 'en-US',
                   'NUGET_CERT_REVOCATION_MODE': 'online', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE': '1'})
    record['revocationMode'] = 'online'
    record['systemEnvironmentKeys'] = [name for name in SIGNATURE_SYSTEM_VARIABLES if command_env.get(name)]
    text = ''
    stdout, stderr = b'', b''
    try:
        result = subprocess.run([str(dotnet), 'nuget', 'verify', str(archive), '--all', '--verbosity', 'detailed',
                                 '--configfile', str(ROOT / 'NuGet.Config')],
                                cwd=ROOT, env=command_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=180,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        record.update(commandStarted=True, exitCode=result.returncode, verified=result.returncode == 0)
        stdout, stderr = result.stdout, result.stderr
    except subprocess.TimeoutExpired as error:
        record.update(commandStarted=True, timedOut=True)
        stdout, stderr = error.stdout or b'', error.stderr or b''
    except OSError:
        record['outputCategories'] = ['verifier-start-failed']
    out_text, out_encoding = decode_nuget_output(stdout)
    err_text, err_encoding = decode_nuget_output(stderr)
    text = out_text + '\n' + err_text
    record.update(stdoutBytes=len(stdout), stderrBytes=len(stderr),
                  stdoutEncoding=out_encoding, stderrEncoding=err_encoding,
                  outputNulCount=text.count('\0'), outputReplacementCount=text.count('\ufffd'))
    record['elapsedMs'] = round((time.monotonic() - started) * 1000)
    record['nugetCodes'] = sorted(set(re.findall(r'\bNU\d{4}\b', text)))
    record['outputCategories'] = sorted(set(record['outputCategories']) | set(nuget_output_categories(text)))
    emit_ci_nuget_diagnostic(record, text, command_env)
    return record


def ci_signature_environment(isolated):
    # This exception is only for official-package certificate verification on
    # ephemeral GitHub-hosted Windows runners. App/service probes never use it.
    if os.name != 'nt' or os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        return None
    result = dict(isolated)
    for name in ('USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'SystemRoot', 'WINDIR', 'PATH',
                 'COMSPEC', 'PATHEXT', 'DOTNET_ROOT', 'DOTNET_CLI_HOME',
                 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'):
        value = os.environ.get(name)
        if value:
            result[name] = value
    return result


def nuget_archive(package, version):
    folder = ROOT / '.cache/nuget' / package / version
    archive = regular(folder / (package + '.' + version + '.nupkg'))
    expected = regular(Path(str(archive) + '.sha512')).read_text(encoding='utf-8-sig').strip()
    digest512 = sha(archive, 'sha512')
    check(base64.b64encode(bytes.fromhex(digest512)).decode() == expected, 'NUGET_ARCHIVE_SHA512')
    return archive, sha(archive), digest512


def verify_nuget_package(dotnet, archive, package, version, env, report, preferred='isolated'):
    profiles = {'isolated': env}
    ci_environment = ci_signature_environment(env)
    if ci_environment is not None:
        profiles['ci-build-profile'] = ci_environment
    if preferred not in profiles:
        preferred = 'isolated'
    check_record = probe_nuget_signature(dotnet, archive, package, version, profiles[preferred], preferred)
    check_record['archiveSHA256'] = sha(archive)
    report.setdefault('nugetSignatureChecks', []).append(check_record)
    if not check_record['verified'] and preferred == 'isolated' and ci_environment is not None:
        check_record = probe_nuget_signature(dotnet, archive, package, version, ci_environment, 'ci-build-profile')
        check_record['archiveSHA256'] = sha(archive)
        report['nugetSignatureChecks'].append(check_record)
    check(check_record['verified'], 'NUGET_SIGNATURE_VERIFICATION_FAILED')
    return check_record['profile']


def recorded_signature_profile(package, archive_hash):
    if ci_signature_environment({}) is None:
        return 'isolated'
    path = ROOT / 'build/windows-validation/nuget-preflight.json'
    try:
        check(regular(path).stat().st_size <= 1024 * 1024, 'NUGET_PREFLIGHT_REPORT_SIZE')
        report = json.loads(path.read_text(encoding='utf-8'))
        record = report.get('packages', {}).get(package, {})
        if report.get('pass') is True and record.get('archiveSHA256') == archive_hash and record.get('signatureVerified') is True:
            # This selects only an environment; actual bytes and signatures are
            # always reverified below. A report never substitutes for verification.
            return record.get('profile', 'isolated')
    except (OSError, ValueError, AuditFailure):
        pass
    return 'isolated'


def nuget_preflight(args):
    report = {'schemaVersion': 1, 'pass': False, 'platform': 'windows', 'packages': {},
              'modelRequests': 0, 'loginPerformed': False, 'desktopCaptured': False,
              'nugetSignatureChecks': []}
    output = ROOT / 'build/windows-validation/nuget-preflight.json'
    try:
        check(os.name == 'nt', 'WINDOWS_REQUIRED')
        lock = json.loads((ROOT / 'windows-runtime-lock.json').read_text(encoding='utf-8'))
        with tempfile.TemporaryDirectory(prefix='whale-nuget-preflight-') as raw:
            temporary = Path(raw)
            env = isolated_environment(temporary, temporary / 'application')
            dotnet = shutil.which('dotnet', path=env['PATH'])
            check(dotnet is not None, 'NUGET_SIGNATURE_VERIFIER_MISSING')
            preferred = 'isolated'
            for package in PACKAGES:
                archive, archive_hash, digest512 = nuget_archive(package, lock['dotnetRuntimeVersion'])
                preferred = verify_nuget_package(dotnet, archive, package, lock['dotnetRuntimeVersion'], env, report, preferred)
                report['packages'][package] = {'version': lock['dotnetRuntimeVersion'], 'archiveSHA256': archive_hash,
                    'archiveSHA512': digest512, 'sha512SidecarMatched': True, 'signatureVerified': True, 'profile': preferred}
        report['pass'] = True
    except AuditFailure as error:
        report['error'] = {'code': str(error)}
    except Exception:
        report['error'] = {'code': 'NUGET_PREFLIGHT_FAILED'}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))
    return 0 if report['pass'] else 1


def zip_bytes(archive, member):
    entries = archive.infolist()
    matches = [entry for entry in entries if entry.filename == member]
    check(len(matches) == 1 and matches[0].file_size <= MAX_MEMBER and safe_member(member), 'UPSTREAM_MEMBER_INVALID')
    check(not stat.S_ISLNK(matches[0].external_attr >> 16), 'UPSTREAM_LINK_REJECTED')
    return archive.read(matches[0])


def verify_originals(lock, temporary, scanner, env, report):
    """Re-hash archives and extract originals independently of runtime-manifest."""
    cache = ROOT / '.cache/windows-runtime'
    originals, origins = temporary / 'originals', {}
    pending_scans = []
    originals.mkdir()

    def register(body, relative, source):
        check(len(body) <= MAX_MEMBER and safe_member(relative), 'UPSTREAM_MEMBER_TOO_LARGE')
        target = originals / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        digest = sha(target)
        record = {'path': relative, 'sha256': digest, 'size': len(body), **source}
        origins.setdefault(digest, []).append(record)
        pending_scans.append((target, relative, digest))
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
    check(dotnet is not None, 'NUGET_SIGNATURE_VERIFIER_MISSING')
    report['nugetSignatureChecks'] = []
    for package in PACKAGES:
        archive_file, archive_sha256, archive_sha512 = nuget_archive(package, lock['dotnetRuntimeVersion'])
        signature_profile = verify_nuget_package(dotnet, archive_file, package, lock['dotnetRuntimeVersion'], env, report,
            recorded_signature_profile(package, archive_sha256))
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
                              'signatureVerified': signature_verified, 'signatureProfile': signature_profile,
                              'revocationMode': 'online'})
    report['microsoftRuntimeOriginals'] = nuget_records
    return origins, node_expected, pending_scans


def scan_originals(pending_scans, scanner, report):
    raw, original_hashes = scanner.Audit(), {}
    for target, relative, digest in pending_scans:
        body = regular(target).read_bytes()
        check(hashlib.sha256(body).hexdigest() == digest, 'UPSTREAM_EXTRACTED_BYTES_CHANGED')
        original_hashes[relative] = digest
        raw.scan_bytes(body, relative)
    report['upstreamRawFindings'] = [{'path': name, 'line': line, 'category': category,
        'sha256': original_hashes[name]} for name, line, category in sorted(raw.findings)]
    report['upstreamOriginalFilesScanned'] = raw.files


def verify_payload_bytes(stage, manifest_file, portable, setup, expected, report):
    manifest_body = regular(manifest_file).read_bytes()
    report['manifestSHA256'] = hashlib.sha256(manifest_body).hexdigest()
    manifest = json.loads(manifest_body.decode('utf-8'))
    check(manifest.get('platform') == 'windows' and manifest.get('architecture') == 'x64', 'MANIFEST_PLATFORM')
    files = inventory(stage)
    check(files == manifest['files'], 'MANIFEST_PAYLOAD_MISMATCH')
    report['payloadFiles'] = files
    for relative, digest in expected.items():
        check(relative in files and files[relative]['sha256'] == digest, 'PINNED_RUNTIME_NOT_IDENTICAL')
    runtime = json.loads((stage / 'runtime/runtime-manifest.json').read_text(encoding='utf-8'))
    check(runtime.get('lockSHA256') == sha(ROOT / 'windows-runtime-lock.json'), 'RUNTIME_LOCK_MISMATCH')
    check(set(runtime['files']) == {name.removeprefix('runtime/') for name in expected}, 'RUNTIME_FILE_ALLOWLIST')
    check({name.removeprefix('runtime/') for name in files if name.startswith('runtime/') and name != 'runtime/runtime-manifest.json'}
          == set(runtime['files']), 'RUNTIME_PAYLOAD_FILE_ALLOWLIST')
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
    return files


def verify_project_payload(files, report):
    spec = importlib.util.spec_from_file_location('package_inputs', ROOT / 'scripts/package-macos.py')
    inputs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inputs)
    inputs.validate_production_inputs()
    sources = [('service/' + name, ROOT / name) for name in inputs.SERVICE_FILES]
    sources += [('service/assets/' + name, ROOT / 'assets' / name) for name in inputs.ASSET_FILES]
    sources += [(name, ROOT / name) for name in inputs.PROJECT_NOTICES]
    sources += [('INSTALL.zh-CN.md', ROOT / 'docs/INSTALL.windows.zh-CN.md')]
    proof = {}
    for relative, source in sources:
        digest = sha(regular(source))
        check(relative in files and files[relative]['sha256'] == digest, 'PROJECT_SOURCE_PAYLOAD_MISMATCH')
        proof[relative] = digest
    compiler = {}
    for name in ('WhalePet.exe', 'WhalePet.dll'):
        digest = sha(regular(ROOT / 'build/windows/publish' / name))
        check(name in files and files[name]['sha256'] == digest, 'NATIVE_COMPILER_OUTPUT_MISMATCH')
        compiler[name] = digest
    report['projectSourcePayloadSHA256'] = proof
    report['nativeCompilerOutputSHA256'] = compiler


def payload_upstream_sources(relative, digest, originals, expected):
    sources = originals.get(digest, [])
    if relative in expected and expected[relative] == digest:
        return sources
    matched = []
    for source in sources:
        if source['kind'] != 'microsoft-runtime':
            continue
        member = source['member']
        library = member.split('/lib/net10.0/', 1)[-1] if '/lib/net10.0/' in member else None
        native = member.split('/native/', 1)[-1] if '/native/' in member else None
        notice = 'licenses/' + source['package'] + '/' + member
        if relative in (library, native, notice):
            matched.append(source)
    return matched


def verify_framework_origins(files, originals, expected, report):
    # Path/role and exact digest proof must finish before executing the installer,
    # independently of whether privacy regexes find anything in a framework file.
    matched = []
    for relative, record in files.items():
        if not relative.startswith('runtime/') and relative.lower().endswith(('.dll', '.exe')) and relative not in {'WhalePet.exe', 'WhalePet.dll'}:
            sources = [source for source in payload_upstream_sources(relative, record['sha256'], originals, expected)
                       if source['kind'] == 'microsoft-runtime']
            check(bool(sources), 'FRAMEWORK_BINARY_ORIGIN_UNVERIFIED')
            matched.append({'path': relative, 'sha256': record['sha256'], 'origins': sources})
    report['microsoftPayloadFilesByteVerified'] = matched


def scan_payload(stage, manifest_file, setup, originals, expected, scanner, report, files):
    raw = scanner.Audit()
    # Re-hash the exact buffers being scanned, after initial inventory/ZIP proof.
    # Cache reuse therefore cannot hide a file changed since byte verification.
    check(inventory(stage) == files, 'PAYLOAD_CHANGED_BEFORE_SCAN')
    def scan_folder(folder):
        for item in sorted(folder.iterdir()):
            relative = item.relative_to(stage).as_posix()
            name = 'payload/' + relative
            attributes = item.lstat()
            check(not item.is_symlink() and not getattr(attributes, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0),
                  'PAYLOAD_LINK_REJECTED')
            if raw.forbidden(name, directory=item.is_dir(), packaged=True):
                continue
            if item.is_dir():
                scan_folder(item)
                continue
            check(relative in files, 'PAYLOAD_CHANGED_BEFORE_SCAN')
            record = files[relative]
            body = regular(item).read_bytes()
            check(len(body) == record['size'] and hashlib.sha256(body).hexdigest() == record['sha256'], 'PAYLOAD_CHANGED_BEFORE_SCAN')
            raw.scan_bytes(body, name)
    scan_folder(stage)
    manifest_body = regular(manifest_file).read_bytes()
    check(hashlib.sha256(manifest_body).hexdigest() == report['manifestSHA256'], 'MANIFEST_CHANGED_BEFORE_SCAN')
    raw.scan_bytes(manifest_body, 'metadata/' + manifest_file.name)
    setup_body = regular(setup).read_bytes()
    check(hashlib.sha256(setup_body).hexdigest() == report['artifacts'][setup.name]['sha256'], 'INSTALLER_CHANGED_BEFORE_SCAN')
    raw.scan_bytes(setup_body, 'installer/' + setup.name)
    classified, unclassified = [], []

    for name, line, category in sorted(raw.findings):
        relative = name.removeprefix('payload/') if name.startswith('payload/') else None
        record = {'path': name, 'line': line, 'category': category}
        sources = payload_upstream_sources(relative, files[relative]['sha256'], originals, expected) if relative in files else []
        # Our own executable/assembly never receives a vendor exception.
        if sources and relative not in {'WhalePet.exe', 'WhalePet.dll'}:
            classified.append({**record, 'sha256': files[relative]['sha256'], 'origins': sources})
        else:
            unclassified.append(record)
    report.update(rawFindingsCount=len(raw.findings), classifiedUpstream=classified,
                  unclassifiedFindings=unclassified, payloadFilesScanned=raw.files,
                  zipFilesByteVerified=len(files), runtimeFilesByteVerified=len(expected))
    check(not unclassified, 'UNCLASSIFIED_PAYLOAD_FINDINGS')
    return files


def verify_payload(stage, manifest_file, portable, setup, lock, originals, expected, scanner, report):
    """Compatibility entry point used by deterministic integrity self-tests."""
    files = verify_payload_bytes(stage, manifest_file, portable, setup, expected, report)
    verify_framework_origins(files, originals, expected, report)
    return scan_payload(stage, manifest_file, setup, originals, expected, scanner, report, files)


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
              'loginPerformed': False, 'desktopCaptured': False, 'normalGuiStarted': False,
              'phase': 'initialize', 'phases': {}}
    output = ROOT / args.report
    try:
        check(os.name == 'nt', 'WINDOWS_REQUIRED')
        check(sys.getwindowsversion().build >= 22000, 'WINDOWS_11_REQUIRED')
        scanner = load_scanner()
        lock = json.loads((ROOT / 'windows-runtime-lock.json').read_text(encoding='utf-8'))
        stage = ROOT / args.stage
        dist = ROOT / 'dist/windows'
        with audit_temporary(report, 'originals') as temporary:
            env = isolated_environment(temporary, temporary / 'home/Local/WhalePet')
            with audit_phase(report, 'upstream-byte-origins'):
                origins, expected, pending_scans = verify_originals(lock, temporary, scanner, env, report)
            with audit_phase(report, 'payload-byte-proof'):
                payload = verify_payload_bytes(stage, dist / (PREFIX + '.manifest.json'),
                    dist / (PREFIX + '-portable.zip'), dist / (PREFIX + '-setup.exe'), expected, report)
                verify_project_payload(payload, report)
                verify_framework_origins(payload, origins, expected, report)
            # The same real installer/uninstaller checks now complete, including
            # their own cleanup, before any expensive regex pass begins.
            with audit_temporary(report, 'installation') as install_temporary:
                install_env = isolated_environment(install_temporary, install_temporary / 'home/Local/WhalePet')
                with audit_phase(report, 'installation-lifecycle'):
                    install_audit(dist / (PREFIX + '-setup.exe'), payload, install_temporary, install_env, report)
            with audit_phase(report, 'upstream-privacy-scan'):
                scan_originals(pending_scans, scanner, report)
            with audit_phase(report, 'payload-privacy-scan'):
                scan_payload(stage, dist / (PREFIX + '.manifest.json'), dist / (PREFIX + '-setup.exe'),
                    origins, expected, scanner, report, payload)
            report['scanCache'] = scanner.scan_cache_stats
        report['phase'] = 'complete'
        report['pass'] = True
    except Exception as error:
        report['error'] = {'code': str(error) if isinstance(error, AuditFailure) else 'WINDOWS_AUDIT_FAILED',
                          'phase': report.get('failedPhase', report['phase']), **safe_exception(error)}
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
    from unittest.mock import patch
    scanner = load_scanner()
    uncached = load_scanner(cached=False)
    cached_scan, original_scan = scanner.Audit(), uncached.Audit()
    duplicate = b'\0token = ' + bytes([39]) + b'UPSTREAM' + b'-FIXTURE' * 3 + bytes([39])
    def png_chunk(kind, body):
        return len(body).to_bytes(4, 'big') + kind + body + zlib.crc32(kind + body).to_bytes(4, 'big')
    metadata_png = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', bytes.fromhex('00000001000000010806000000'))
    metadata_png += png_chunk(b'zTXt', b'note\0\0' + zlib.compress(duplicate))
    metadata_png += png_chunk(b'IDAT', zlib.compress(b'\0\0\0\0\0')) + png_chunk(b'IEND', b'')
    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, 'w') as archive:
        archive.writestr('first.txt', duplicate)
        archive.writestr('second.txt', duplicate)
    cases = [(duplicate, 'first.dll'), (duplicate, 'second.dll'), (metadata_png, 'meta.png'),
             (metadata_png, 'meta-copy.png'), (archive_buffer.getvalue(), 'first.zip'),
             (archive_buffer.getvalue(), 'second.zip'), (duplicate, 'unsupported.tgz'), (duplicate, 'unsupported.dmg')]
    for body, relative in cases:
        cached_scan.scan_bytes(body, relative)
        original_scan.scan_bytes(body, relative)
    check(cached_scan.findings == original_scan.findings and cached_scan.files == original_scan.files
          and cached_scan.archives == original_scan.archives, 'SELF_TEST_CACHE_EQUIVALENCE')
    check(scanner.scan_cache_stats['replayedLeafScans'] >= 4 and cached_scan.archives == 2, 'SELF_TEST_CACHE_REUSE_ARCHIVE_BOUNDARY')
    framework_hash = hashlib.sha256(duplicate).hexdigest()
    framework_files = {'Framework.dll': {'sha256': framework_hash, 'size': len(duplicate)}}
    source = {'kind': 'microsoft-runtime', 'package': 'synthetic.runtime', 'member': 'runtimes/win-x64/native/Framework.dll'}
    verify_framework_origins(framework_files, {framework_hash: [source]}, {}, {})
    try:
        verify_framework_origins(framework_files, {framework_hash: [{**source, 'member': 'runtimes/win-x64/native/Other.dll'}]}, {}, {})
        raise AuditFailure('SELF_TEST_FRAMEWORK_ROLE_MUST_FAIL')
    except AuditFailure as error:
        check(str(error) == 'FRAMEWORK_BINARY_ORIGIN_UNVERIFIED', 'SELF_TEST_FRAMEWORK_ROLE_MUST_FAIL')
    real_remove = shutil.rmtree
    for durable in (False, True):
        folder = Path(tempfile.mkdtemp(prefix='whale-cleanup-selftest-'))
        (folder / 'owned.txt').write_text('SYNTHETIC-CLEANUP')
        denied = PermissionError(13, 'SYNTHETIC-LOCK')
        denied.winerror = 32
        calls, cleanup_report = [], {}
        def remove(target, **options):
            calls.append(target)
            if durable or len(calls) == 1:
                raise denied
            return real_remove(target, **options)
        try:
            with patch.object(shutil, 'rmtree', side_effect=remove), patch.object(time, 'sleep'):
                try:
                    cleanup_owned_temporary(folder, cleanup_report, 'synthetic', timeout=0 if durable else 2)
                    check(not durable, 'SELF_TEST_DURABLE_CLEANUP_MUST_FAIL')
                except AuditFailure as error:
                    check(durable and str(error) == 'TEMPORARY_CLEANUP_FAILED', 'SELF_TEST_DURABLE_CLEANUP_MUST_FAIL')
            record = cleanup_report['temporaryCleanup'][0]
            check(record['cleaned'] is (not durable) and record['attempts'] == (1 if durable else 2)
                  and record['lastException'] == {'type': 'PermissionError', 'errno': 13, 'winerror': 32}, 'SELF_TEST_CLEANUP_SAFE_DIAGNOSTICS')
        finally:
            if folder.exists():
                real_remove(folder)
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
        original_failed_report = {}
        try:
            verify_payload(stage, manifest_file, portable, setup, {}, origins, expected, uncached, original_failed_report)
            raise AuditFailure('SELF_TEST_UNCACHED_OWN_ASSEMBLY_EXCEPTION')
        except AuditFailure as error:
            check(str(error) == 'UNCLASSIFIED_PAYLOAD_FINDINGS'
                  and original_failed_report['unclassifiedFindings'] == failed_report['unclassifiedFindings']
                  and original_failed_report['rawFindingsCount'] == failed_report['rawFindingsCount']
                  and original_failed_report['payloadFilesScanned'] == failed_report['payloadFilesScanned'], 'SELF_TEST_UNCACHED_OWN_ASSEMBLY_EXCEPTION')
        (stage / 'WhalePet.dll').write_bytes(b'MZ\0SYNTHETIC-ASSEMBLY')
        (stage / 'service/service.mjs').write_text('export const synthetic=true;\n')
        bundle()
        (stage / 'service/service.mjs').write_text('changed after manifest\n')
        try:
            verify_payload(stage, manifest_file, portable, setup, {}, origins, expected, scanner, {})
            raise AuditFailure('SELF_TEST_MANIFEST_TAMPER')
        except AuditFailure as error:
            check(str(error) == 'MANIFEST_PAYLOAD_MISMATCH', 'SELF_TEST_MANIFEST_TAMPER')
        (stage / 'runtime/extra.dll').write_bytes(b'SYNTHETIC-UNLISTED-RUNTIME')
        bundle()
        try:
            verify_payload_bytes(stage, manifest_file, portable, setup, expected, {})
            raise AuditFailure('SELF_TEST_RUNTIME_ADDITION_MUST_FAIL')
        except AuditFailure as error:
            check(str(error) == 'RUNTIME_PAYLOAD_FILE_ALLOWLIST', 'SELF_TEST_RUNTIME_ADDITION_MUST_FAIL')
        (stage / 'runtime/extra.dll').unlink()
        # Additions and empty private directories remain visible after the
        # early inventory, even though regex findings can now be replayed.
        (stage / 'service/service.mjs').write_text('export const synthetic=true;\n')
        bundle()
        proof_report = {}
        files = verify_payload_bytes(stage, manifest_file, portable, setup, expected, proof_report)
        (stage / 'extra.txt').write_text('SYNTHETIC-ADDED')
        try:
            scan_payload(stage, manifest_file, setup, origins, expected, scanner, proof_report, files)
            raise AuditFailure('SELF_TEST_ADDED_FILE_MUST_FAIL')
        except AuditFailure as error:
            check(str(error) == 'PAYLOAD_CHANGED_BEFORE_SCAN', 'SELF_TEST_ADDED_FILE_MUST_FAIL')
        (stage / 'extra.txt').unlink()
        (stage / 'data').mkdir()
        try:
            scan_payload(stage, manifest_file, setup, origins, expected, scanner, proof_report, files)
            raise AuditFailure('SELF_TEST_EMPTY_PRIVATE_DIRECTORY_MUST_FAIL')
        except AuditFailure as error:
            check(str(error) == 'UNCLASSIFIED_PAYLOAD_FINDINGS', 'SELF_TEST_EMPTY_PRIVATE_DIRECTORY_MUST_FAIL')
    print('Windows audit synthetic integrity/classification/cache/cleanup self-test: PASS (no Windows execution)')
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', default='dist/windows-x64/Whale Pet')
    parser.add_argument('--report', default='build/windows-validation/audit-windows.json')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--nuget-preflight', action='store_true')
    args = parser.parse_args()
    raise SystemExit(self_test() if args.self_test else nuget_preflight(args) if args.nuget_preflight else main(args))
