#!/usr/bin/env python3
"""Finalize only a fully validated Windows release; never mutate its payload."""
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist/windows'
VALIDATION = ROOT / 'build/windows-validation'
VERSION = '0.2.0-windows.1'
REPORTS = (
    ('smoke-windows.json', 'validation-smoke-windows.json'),
    ('audit-windows.json', 'validation-audit-windows.json'),
    ('backend-tests.json', 'validation-backend-tests-windows.json'),
    ('ui/self-test.json', 'validation-ui-windows.json'),
)


class FinalizationFailure(Exception):
    pass


def check(value, code):
    if not value:
        raise FinalizationFailure(code)


def sha(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def regular(file):
    check(file.is_file() and not file.is_symlink(), 'REQUIRED_REGULAR_FILE_MISSING')
    check(not any(parent.is_symlink() for parent in file.parents if parent != ROOT and ROOT in parent.parents), 'SYMLINK_PARENT_REJECTED')
    return file


def relative_name(name):
    check(isinstance(name, str) and bool(name) and '\\' not in name and ':' not in name
          and not any(ord(value) < 32 for value in name), 'UNSAFE_RELATIVE_NAME')
    value = PurePosixPath(name)
    check(not value.is_absolute() and '..' not in value.parts and str(value) == name, 'UNSAFE_RELATIVE_NAME')
    return name


def load_json(file):
    check(regular(file).stat().st_size <= 16 * 1024 * 1024, 'REPORT_TOO_LARGE')
    value = json.loads(file.read_text(encoding='utf-8-sig'))
    check(isinstance(value, dict), 'INVALID_REPORT_SCHEMA')
    return value


def auditor():
    spec = importlib.util.spec_from_file_location('whale_release_auditor', ROOT / 'scripts/audit-release.py')
    check(spec is not None and spec.loader is not None, 'SOURCE_AUDITOR_UNAVAILABLE')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def findings_summary(audit):
    return {'files': audit.files, 'archives': audit.archives,
            'findingsCount': len(audit.findings),
            'categories': dict(sorted(Counter(item[2] for item in audit.findings).items()))}


def verify_manifest(manifest_file, version):
    manifest = load_json(manifest_file)
    check(manifest.get('version') == version and manifest.get('platform') == 'windows'
          and manifest.get('architecture') == 'x64', 'MANIFEST_VERSION_PLATFORM_MISMATCH')
    check(manifest.get('authenticodeSigned') is False, 'UNEXPECTED_SIGNING_CLAIM')
    stage = ROOT / 'dist/windows-x64/Whale Pet'
    expected = manifest.get('files')
    check(isinstance(expected, dict) and bool(expected), 'MANIFEST_PAYLOAD_MISSING')
    actual = {file.relative_to(stage).as_posix(): file for file in stage.rglob('*') if file.is_file()}
    check(set(actual) == set(expected), 'PAYLOAD_FILE_TABLE_MISMATCH')
    check(not any(file.is_symlink() for file in stage.rglob('*')), 'PAYLOAD_LINK_REJECTED')
    def record_matches(file, record):
        regular(file)
        check(isinstance(record, dict) and re.fullmatch(r'[0-9a-f]{64}', record.get('sha256', ''))
              and type(record.get('size')) is int, 'INVALID_FILE_HASH_RECORD')
        check(file.stat().st_size == record['size'] and sha(file) == record['sha256'], 'MANIFEST_BYTES_MISMATCH')
    for name, record in expected.items():
        relative_name(name)
        record_matches(actual[name], record)
    artifacts = manifest.get('artifacts')
    check(isinstance(artifacts, dict) and bool(artifacts), 'MANIFEST_ARTIFACTS_MISSING')
    for name, record in artifacts.items():
        relative_name(name)
        check('/' not in name, 'ARTIFACT_MUST_BE_BASENAME')
        record_matches(DIST / name, record)
    return manifest


def category_counts(records):
    check(isinstance(records, list), 'AUDIT_CLASSIFICATION_SCHEMA')
    values = Counter()
    for record in records:
        check(isinstance(record, dict) and isinstance(record.get('category'), str), 'AUDIT_CLASSIFICATION_SCHEMA')
        category = record['category']
        check(re.fullmatch(r'[a-z0-9_-]{1,80}', category) is not None, 'AUDIT_CATEGORY_INVALID')
        values[category] += 1
    return values


def gates(reports):
    smoke, audit, backend, ui = reports
    check(smoke.get('pass') is True and smoke.get('native', {}).get('passed') is True, 'WINDOWS_SMOKE_NOT_PASSED')
    native_service = smoke.get('nativeService', {})
    check(native_service.get('passed') is True, 'NATIVE_PRODUCTION_SERVICE_NOT_PASSED')
    check(all(native_service.get(key) is False for key in ('guiStarted', 'loginPerformed', 'modelRequests',
              'desktopCaptured', 'providerCredentialsRead', 'defaultUserDataRead', 'normalDesktopValidated')), 'NATIVE_SERVICE_SIDE_EFFECT_BOUNDARY')
    check(native_service.get('checks', {}).get('production-client-not-synthetic') is True
          and native_service.get('checks', {}).get('state-owned-by-exact-child') is True
          and native_service.get('checks', {}).get('private-data-root-dacl') is True
          and native_service.get('checks', {}).get('owned-child-exited-cleanly') is True
          and native_service.get('checks', {}).get('owned-state-file-removed') is True
          and native_service.get('checks', {}).get('temporary-root-cleaned') is True, 'NATIVE_SERVICE_LIFECYCLE_INCOMPLETE')
    check(audit.get('pass') is True, 'WINDOWS_AUDIT_NOT_PASSED')
    check(backend.get('pass') is True and backend.get('summaryComplete') is True, 'BACKEND_TESTS_NOT_PASSED')
    totals = backend.get('totals', {})
    check(all(type(totals.get(name)) is int and totals[name] >= 0 for name in
              ('tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo')), 'BACKEND_COUNTS_MISSING')
    check(totals['tests'] > 0 and totals['tests'] == totals['pass'] + totals['skipped']
          and totals['fail'] == totals['cancelled'] == totals['todo'] == 0
          and backend.get('exitCode') == 0, 'BACKEND_COUNTS_NOT_PASSING')
    check(ui.get('passed') is True, 'SYNTHETIC_UI_NOT_PASSED')
    check(smoke.get('modelRequests') == 0 and smoke.get('loginPerformed') is False
          and smoke.get('desktopCaptured') is False, 'SMOKE_SIDE_EFFECT_BOUNDARY')
    check(audit.get('modelRequests') == 0 and audit.get('loginPerformed') is False
          and audit.get('desktopCaptured') is False, 'AUDIT_SIDE_EFFECT_BOUNDARY')
    check(ui.get('modelRequests') is False and ui.get('accountReads') is False
          and ui.get('screenshots') is False and ui.get('physicalDesktopValidated') is False, 'UI_SIDE_EFFECT_BOUNDARY')
    check(audit.get('unclassifiedFindings') == [], 'UNCLASSIFIED_FINDINGS_PRESENT')
    check(type(audit.get('rawFindingsCount')) is int and audit['rawFindingsCount'] >= 0,
          'AUDIT_RAW_COUNT_MISSING')
    category_counts(audit.get('classifiedUpstream'))
    category_counts(audit.get('upstreamRawFindings'))
    check(audit['rawFindingsCount'] == len(audit['classifiedUpstream']) + len(audit['unclassifiedFindings']),
          'AUDIT_CLASSIFICATION_COUNT_MISMATCH')
    check(audit.get('installerExecuted') is True and audit.get('uninstallExecuted') is True
          and audit.get('syntheticUserDataPreserved') is True, 'INSTALLER_AUDIT_INCOMPLETE')
    for value in (smoke, audit, backend, ui):
        text = json.dumps(value, ensure_ascii=False)
        check(re.search(r'/(?:Users|Volumes)/|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]', text) is None,
              'PERSONAL_PATH_IN_PUBLIC_REPORT')
    check(smoke.get('native') == ui, 'SMOKE_NATIVE_REPORT_MISMATCH')


def git_clean_archive(destination, version):
    def git(*args):
        return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True, text=True, encoding='utf-8')
    check(Path(git('rev-parse', '--show-toplevel').stdout.strip()).resolve() == ROOT, 'SOURCE_REPOSITORY_ROOT_MISMATCH')
    check(not git('status', '--porcelain', '--untracked-files=normal').stdout.strip(), 'SOURCE_WORKTREE_NOT_CLEAN')
    git('archive', '--format=zip', '--prefix=whale-pet-desktop-' + version + '/', '--output=' + str(destination), 'HEAD')


def validation_markdown(version, reports, source_summary):
    smoke, audit, backend, ui = reports
    totals = backend['totals']
    classified = category_counts(audit.get('classifiedUpstream', []))
    originals = category_counts(audit.get('upstreamRawFindings', []))
    rows = '\n'.join('| ' + name + ' | ' + str(classified[name]) + ' | ' + str(originals[name]) + ' |'
                     for name in sorted(set(classified) | set(originals))) or '| 无已记录分类 | 0 | 0 |'
    return f'''# Whale Pet {version} · Windows 验证说明

此版本在 **Windows Server 2025 GitHub CI** 中完成构建与验证，面向 Windows 11 x64 测试使用。

- 后端测试：共 {totals['tests']}，通过 {totals['pass']}，失败 {totals['fail']}，跳过 {totals['skipped']}。
- 离屏 WPF 合成检查：{len(ui.get('checks', {}))} 项；包括透明窗口属性、动作、二维规划、气泡、聊天与连接设置的合成控件渲染。
- 真实 C# 生产客户端生命周期：在全新临时根目录运行 ServiceClient 的 Node 启动、进程归属、私有数据权限、本机 HTTP 默认状态与正常退出/状态清理检查；没有启动普通桌面 GUI。
- 实际发行目录、便携 ZIP、安装器及安装后文件经过字节核对；安装、卸载及合成用户数据保留检查已通过。
- 已提交 HEAD 的干净源码归档实际经过隐私审计：{source_summary['files']} 个检查对象，{source_summary['findingsCount']} 项未通过发现。

**证据边界**：WPF PNG 是 RenderTargetBitmap 对固定合成内容的离屏渲染，不是桌面截图；这不是普通用户真实桌面交互或所有显示器/DPI 环境的实机验收。验证未登录真实账号、未调用模型、未采集屏幕。Windows 首版不提供截图或前台应用信息，相关功能默认关闭且不可启用。

本测试版没有 Authenticode 签名。Codex 为隔离只读受限模式（实验），模型权限与额度仍以使用者自己的账号或 API 服务为准。

## 上游发现的分类边界

原始发行载荷扫描记录 {audit.get('rawFindingsCount', 0)} 项发现；其中 {sum(classified.values())} 项依据锁定上游原件的字节一致性作分类，未分类发现为 {len(audit['unclassifiedFindings'])}。独立上游原件扫描另记录 {sum(originals.values())} 项，保留在公开审计报告中。

| 分类 | 发行载荷中已证明来自上游 | 独立上游原件原始发现 |
| --- | ---: | ---: |
{rows}

这不是“原始完整安装包零匹配”的声明。项目自有程序不使用供应商例外，未分类发现必须为空；上游分类依据、原件哈希及匹配计数见 `validation-audit-windows.json`。

公开报告：`validation-backend-tests-windows.json`、`validation-smoke-windows.json`、`validation-ui-windows.json`、`validation-audit-windows.json`、`validation-source-windows.json`。安装包与源码包的 SHA-256 见 `SHA256SUMS-windows.txt`；报告不包含账号、机器名、用户目录或临时 HOME 路径。
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', default=VERSION)
    args = parser.parse_args()
    try:
        check(os.name == 'nt', 'WINDOWS_REQUIRED')
        check(re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?', args.version), 'INVALID_VERSION')
        reports = [load_json(VALIDATION / source) for source, _ in REPORTS]
        gates(reports)
        manifest_file = DIST / f'Whale-Pet-{args.version}-windows-x64.manifest.json'
        manifest_hash = sha(regular(manifest_file))
        manifest = verify_manifest(manifest_file, args.version)
        scanner = auditor()
        source_audit = scanner.Audit()
        source_audit.scan_tree(ROOT, 'source', source=True)
        check(not source_audit.findings, 'PROJECT_SOURCE_AUDIT_FAILED')
        source_zip = DIST / f'Whale-Pet-{args.version}-source.zip'
        check(not source_zip.is_symlink(), 'SOURCE_ARCHIVE_SYMLINK')
        git_clean_archive(source_zip, args.version)
        archive_audit = scanner.Audit()
        archive_audit.scan_target(source_zip, 'source-archive')
        check(not archive_audit.findings, 'SOURCE_ARCHIVE_AUDIT_FAILED')
        source_summary = {'pass': True, 'project': findings_summary(source_audit),
                          'archive': findings_summary(archive_audit),
                          'archiveFile': source_zip.name, 'sha256': sha(source_zip)}
        for (source, destination), value in zip(REPORTS, reports):
            text = regular(VALIDATION / source).read_bytes()
            report_audit = scanner.Audit()
            report_audit.scan_bytes(text, destination)
            check(not report_audit.findings, 'PUBLIC_REPORT_AUDIT_FAILED')
            shutil.copyfile(VALIDATION / source, DIST / destination)
        (DIST / 'validation-source-windows.json').write_text(json.dumps(source_summary, indent=2) + '\n', encoding='utf-8')
        (DIST / 'VALIDATION-windows.md').write_text(validation_markdown(args.version, reports, source_summary['archive']), encoding='utf-8')
        check(sha(manifest_file) == manifest_hash, 'MANIFEST_CHANGED_DURING_FINALIZATION')
        verify_manifest(manifest_file, args.version)
        allowed = set(manifest['artifacts']) | {manifest_file.name, source_zip.name, 'validation-source-windows.json',
                  'VALIDATION-windows.md', 'SHA256SUMS-windows.txt'} | {destination for _, destination in REPORTS}
        check(all(file.name in allowed and file.is_file() and not file.is_symlink() for file in DIST.iterdir()), 'UNEXPECTED_RELEASE_FILE')
        sums = DIST / 'SHA256SUMS-windows.txt'
        files = sorted(file for file in DIST.iterdir() if file.name != sums.name)
        sums.write_text(''.join(sha(file) + '  ' + relative_name(file.name) + '\n' for file in files), encoding='utf-8')
        print(json.dumps({'pass': True, 'releaseFiles': len(files), 'reports': len(REPORTS) + 1,
                          'sourceArchive': source_zip.relative_to(ROOT).as_posix(),
                          'checksumFile': sums.relative_to(ROOT).as_posix(),
                          'sourceFindings': 0, 'unclassifiedPayloadFindings': 0}))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, FinalizationFailure) else 'WINDOWS_FINALIZATION_FAILED'
        print(json.dumps({'pass': False, 'error': {'code': code}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
