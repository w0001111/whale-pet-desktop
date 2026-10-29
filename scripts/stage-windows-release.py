#!/usr/bin/env python3
"""Stage exactly the artifacts of a successful trusted build, without re-running tests."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TAG = 'v0.2.0-windows.1'


def check(value, code):
    if not value:
        raise RuntimeError(code)


def gh(*args, optional=False):
    command = ['gh', *args]
    if optional:
        check(args and args[0] == 'api', 'OPTIONAL_ONLY_FOR_API')
        command = ['gh', 'api', '--include', *args[1:]]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if optional:
        status = re.search(r'^HTTP/[0-9.]+\s+([0-9]{3})\b', result.stdout, re.M)
        check(status is not None, 'GITHUB_HTTP_STATUS_UNAVAILABLE')
        if status[1] == '404':
            return None
        check(result.returncode == 0 and status[1] == '200', 'GITHUB_REQUEST_FAILED')
        header, separator, body = result.stdout.partition('\n\n')
        check(bool(separator), 'GITHUB_RESPONSE_BODY_UNAVAILABLE')
        return body
    check(result.returncode == 0, 'GITHUB_REQUEST_FAILED')
    return result.stdout


def sha(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def tag_commit(repo):
    ref = gh('api', f'repos/{repo}/git/ref/tags/{TAG}', optional=True)
    if ref is None:
        return None
    value = json.loads(ref)['object']
    for _ in range(8):
        check(re.fullmatch(r'[a-f0-9]{40}', value.get('sha', '')), 'INVALID_EXISTING_TAG')
        if value.get('type') == 'commit':
            return value['sha']
        check(value.get('type') == 'tag', 'EXISTING_TAG_NOT_COMMIT')
        value = json.loads(gh('api', f"repos/{repo}/git/tags/{value['sha']}"))['object']
    raise RuntimeError('EXISTING_TAG_CHAIN_TOO_DEEP')


def main():
    repo, run_id = os.environ.get('GH_REPO', ''), os.environ.get('VALIDATED_RUN_ID', '')
    check(os.environ.get('GITHUB_REF') == 'refs/heads/main', 'DEFAULT_BRANCH_DISPATCH_REQUIRED')
    check(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo), 'INVALID_REPOSITORY')
    check(re.fullmatch(r'[0-9]+', run_id), 'INVALID_RUN_ID')
    run = json.loads(gh('api', f'repos/{repo}/actions/runs/{run_id}'))
    check(run['status'] == 'completed' and run['conclusion'] == 'success', 'BUILD_NOT_SUCCESSFUL')
    check(run['head_repository']['full_name'] == repo and run['repository']['full_name'] == repo,
          'FOREIGN_BUILD_REJECTED')
    check(run.get('path') == '.github/workflows/windows-build.yml'
          and run.get('head_branch') in ['windows-port', 'main']
          and run.get('event') in ['push', 'workflow_dispatch'], 'UNTRUSTED_BUILD_WORKFLOW')
    commit = run['head_sha']
    check(re.fullmatch(r'[a-f0-9]{40}', commit), 'INVALID_BUILD_COMMIT')
    ancestor = subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'origin/main'], cwd=ROOT)
    check(ancestor.returncode == 0, 'BUILD_NOT_IN_DEFAULT_BRANCH_HISTORY')
    existing_tag = tag_commit(repo)
    check(existing_tag is None or existing_tag == commit, 'EXISTING_TAG_SOURCE_MISMATCH')
    with tempfile.TemporaryDirectory(prefix='whale-stage-') as temporary:
        folder = Path(temporary)
        gh('run', 'download', run_id, '--name', 'windows-release', '--dir', str(folder))
        files = {p.name: p for p in folder.iterdir()}
        check(files and all(p.is_file() and not p.is_symlink() for p in files.values()), 'ARTIFACT_FILE_TYPE')
        check(all(re.fullmatch(r'[A-Za-z0-9_.-]+', name) for name in files), 'ARTIFACT_NAME')
        prefix = 'Whale-Pet-0.2.0-windows.1-windows-x64'
        exact_files = {prefix + '-setup.exe', prefix + '-portable.zip', prefix + '.manifest.json',
                       'Whale-Pet-0.2.0-windows.1-source.zip', 'validation-source-windows.json',
                       'validation-smoke-windows.json', 'validation-audit-windows.json',
                       'validation-backend-tests-windows.json', 'validation-ui-windows.json',
                       'VALIDATION-windows.md', 'SHA256SUMS-windows.txt'}
        check(set(files) == exact_files, 'UNEXPECTED_RELEASE_FILE_SET')
        sums = files.get('SHA256SUMS-windows.txt')
        check(sums is not None, 'CHECKSUM_LIST_MISSING')
        expected = {}
        for line in sums.read_text(encoding='utf-8').splitlines():
            match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_.-]+)', line)
            check(match and match[2] not in expected, 'INVALID_CHECKSUM_LIST')
            expected[match[2]] = match[1]
        check(set(expected) == set(files) - {sums.name}, 'CHECKSUM_FILE_SET')
        check(all(sha(files[name]) == digest for name, digest in expected.items()), 'ARTIFACT_CHECKSUM_MISMATCH')
        reports = {name: json.loads(files[name].read_text(encoding='utf-8')) for name in
                   ['validation-smoke-windows.json', 'validation-audit-windows.json',
                    'validation-backend-tests-windows.json', 'validation-ui-windows.json']}
        spec = importlib.util.spec_from_file_location('release_gates', ROOT / 'scripts/finalize-windows-release.py')
        gates = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gates)
        gates.gates([reports[name] for name in ['validation-smoke-windows.json', 'validation-audit-windows.json',
                                               'validation-backend-tests-windows.json', 'validation-ui-windows.json']])
        manifest = json.loads(files[prefix + '.manifest.json'].read_text(encoding='utf-8'))
        check(manifest.get('version') == '0.2.0-windows.1' and manifest.get('platform') == 'windows'
              and manifest.get('architecture') == 'x64', 'MANIFEST_VERSION_PLATFORM')
        expected_artifacts = {prefix + '-setup.exe', prefix + '-portable.zip'}
        check(set(manifest.get('artifacts', {})) == expected_artifacts, 'MANIFEST_ARTIFACT_SET')
        for name, record in manifest['artifacts'].items():
            check(record.get('sha256') == expected[name] and record.get('size') == files[name].stat().st_size,
                  'MANIFEST_ARTIFACT_BYTES')
        audit = reports['validation-audit-windows.json']
        check(audit.get('payloadFiles') == manifest.get('files') and bool(manifest.get('files'))
              and audit.get('artifacts') == manifest['artifacts'], 'AUDIT_MANIFEST_BINDING')
        archive = files.get('Whale-Pet-0.2.0-windows.1-source.zip')
        check(archive is not None, 'CLEAN_SOURCE_MISSING')
        with zipfile.ZipFile(archive) as source:
            check(source.comment.decode('ascii').strip() == commit, 'SOURCE_COMMIT_MISMATCH')
        source_report = json.loads(files['validation-source-windows.json'].read_text(encoding='utf-8'))
        check(source_report.get('pass') is True and source_report.get('archiveFile') == archive.name
              and source_report.get('sha256') == expected[archive.name]
              and source_report.get('project', {}).get('findingsCount') == 0
              and source_report.get('archive', {}).get('findingsCount') == 0, 'SOURCE_REPORT_BINDING')
        releases = json.loads(gh('api', f'repos/{repo}/releases?per_page=100'))
        existing = next((r for r in releases if r.get('tag_name') == TAG), None)
        provenance = {'repository': repo, 'runId': int(run_id), 'attempt': run.get('run_attempt', 1),
                      'commit': commit, 'checksumsSHA256': sha(sums)}
        marker = '<!-- whale-windows-validated-build:' + json.dumps(provenance, sort_keys=True, separators=(',', ':')) + ' -->'
        notes = folder / 'staged-release-notes.md'
        notes.write_text((ROOT / 'docs/RELEASE.windows.md').read_text(encoding='utf-8') + '\n' + marker + '\n', encoding='utf-8')
        if existing:
            release = existing
            check(release.get('draft') is True and release.get('target_commitish') == commit,
                  'EXISTING_RELEASE_NOT_THIS_BUILD_DRAFT')
            check(marker in (release.get('body') or ''), 'EXISTING_DRAFT_BUILD_PROVENANCE_MISMATCH')
        else:
            gh('release', 'create', TAG, '--draft', '--prerelease', '--target', commit,
               '--title', 'Whale Pet 0.2.0 Windows 测试版', '--notes-file', str(notes))
        if existing:
            present = {asset['name']: asset for asset in existing.get('assets', [])}
        else:
            present = {}
        check(set(present).issubset(files), 'UNEXPECTED_EXISTING_DRAFT_ASSET')
        for name, asset in present.items():
            check(asset['state'] == 'uploaded' and asset['size'] == files[name].stat().st_size
                  and asset.get('digest') == 'sha256:' + sha(files[name]), 'EXISTING_DRAFT_ASSET_CONFLICT')
        missing = [str(files[name]) for name in sorted(set(files) - set(present))]
        if missing:
            gh('release', 'upload', TAG, *missing)
        existing_tag = tag_commit(repo)
        check(existing_tag is None or existing_tag == commit, 'UPLOADED_TAG_SOURCE_MISMATCH')
        # GET-by-tag may omit draft releases; authenticated list includes them.
        releases = json.loads(gh('api', f'repos/{repo}/releases?per_page=100'))
        release = next((r for r in releases if r.get('tag_name') == TAG and r.get('draft')), None)
        check(release is not None, 'DRAFT_RELEASE_MISSING')
        assets = release['assets']
        check(len(assets) == len(files) and {a['name'] for a in assets} == set(files), 'UPLOADED_ASSET_SET')
        for asset in assets:
            file = files[asset['name']]
            check(asset['state'] == 'uploaded' and asset['size'] == file.stat().st_size
                  and asset.get('digest') == 'sha256:' + sha(file), 'SERVER_ASSET_DIGEST_MISMATCH')
        print(json.dumps({'staged': True, 'draft': True, 'version': TAG, 'sourceCommit': commit,
                          'validatedBuildRunId': int(run_id), 'assetsVerified': len(assets)}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'staged': False, 'code': str(error) if isinstance(error, RuntimeError) else 'STAGE_FAILED'}))
        raise SystemExit(1)
