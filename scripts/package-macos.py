#!/usr/bin/env python3
"""Build allowlisted macOS releases using only pinned, verified runtime caches.

No account login, user-state discovery, model calls or app launch.
Runtimes are re-extracted from checksum-verified, pinned archives before each
build. Cached inputs stay unchanged during packaging. Ad hoc signed runtime
bytes have separate hashes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUNDLE_ID = 'org.whalepet.desktop'
APP_NAME = 'Whale Pet.app'
SERVICE_FILES = (
    'service.mjs', 'desktop-backend.mjs', 'provider-config.mjs',
    'api-provider.mjs', 'codex-provider.mjs', 'companion-settings.mjs',
    'local-memory.mjs', 'local-reminders.mjs', 'screen-policy.mjs',
    'usage-budget.mjs', 'proactive-runtime.mjs', 'web-tools.mjs',
    'official-task-runtime.mjs',
)
ASSET_FILES = (
    'pet.png', 'pet-sprites.png', 'wandering-policy.json',
    'actions-v2/manifest.json', 'actions-v2/movement-v2.png',
    'actions-v2/eating-v2.png', 'actions-v2/cheer.png',
    'actions-v2/gaming.png', 'actions-v2/music.png',
)
RUNTIME_REQUIRED = (
    'bin/node', 'codex', 'licenses/Node-LICENSE.txt',
    'licenses/Codex-LICENSE.txt', 'licenses/Codex-NOTICE.txt',
)
RUNTIME_OPTIONAL = ('rg',)
PROJECT_NOTICES = ('LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'SECURITY.md')
MACHO_MAGICS = {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf',
                b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca',
                b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'}


def run(command, *, env=None, capture=False):
    return subprocess.run([str(value) for value in command], cwd=ROOT, env=env,
                          check=True, text=True, capture_output=capture)


def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def plain_file(file):
    if not file.is_file() or file.is_symlink():
        raise RuntimeError('Required regular input is missing or is a symlink: ' + file.name)
    # Parent symlinks could silently select files outside the intended allowlist.
    parent = file.parent
    while parent != ROOT and ROOT in parent.parents:
        if parent.is_symlink():
            raise RuntimeError('Input parent must not be a symlink')
        parent = parent.parent
    return file


def copy_file(source, destination, executable=False):
    plain_file(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    run(['/usr/bin/ditto', '--norsrc', '--noextattr', '--noacl', source, destination])
    destination.chmod(0o755 if executable else 0o644)


def write_json(file, value):
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    file.chmod(0o644)


def validate_production_inputs():
    for name in SERVICE_FILES:
        text = plain_file(ROOT / name).read_text(encoding='utf-8')
        for imported in re.findall(r"(?:from\s*|import\s*\()\s*['\"](\.[^'\"]+)['\"]", text):
            if imported not in {'./' + item for item in SERVICE_FILES}:
                raise RuntimeError('Production import is outside the explicit module allowlist: ' + name)
    for name in ASSET_FILES:
        plain_file(ROOT / 'assets' / name)
    manifest = json.loads((ROOT / 'assets/actions-v2/manifest.json').read_text(encoding='utf-8'))
    for sheet in manifest.get('sheets', []):
        if 'actions-v2/' + sheet.get('file', '') not in ASSET_FILES:
            raise RuntimeError('Animation atlas is outside the explicit asset allowlist')
    for name in PROJECT_NOTICES:
        plain_file(ROOT / name)


def verified_runtime(arch, lock):
    cache = ROOT / '.cache/runtime' / arch
    manifest_file = cache / 'runtime-manifest.json'
    if not manifest_file.is_file():
        raise RuntimeError('Verified runtime cache is missing. Run: python3 scripts/fetch-runtime.py --arch ' + arch)
    record = json.loads(plain_file(manifest_file).read_text(encoding='utf-8'))
    if (record.get('architecture') != arch or record.get('nodeVersion') != lock['nodeVersion']
            or record.get('codexVersion') != lock['codexVersion']):
        raise RuntimeError('Runtime manifest architecture or pinned version does not match')
    files = record.get('files')
    allowed = set(RUNTIME_REQUIRED + RUNTIME_OPTIONAL)
    if not isinstance(files, dict) or not set(RUNTIME_REQUIRED).issubset(files) or not set(files).issubset(allowed):
        raise RuntimeError('Runtime manifest must contain only the explicit runtime allowlist')
    for name, expected in files.items():
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise RuntimeError('Invalid runtime checksum')
        if digest(plain_file(cache / name)) != expected:
            raise RuntimeError('Cached runtime bytes do not match their extraction manifest: ' + name)
    return cache, record


def architecture(file, expected):
    words = run(['/usr/bin/xcrun', 'lipo', '-archs', file], capture=True).stdout.split()
    if expected not in words:
        raise RuntimeError('Executable architecture mismatch: ' + file.name)


def macho(file):
    with file.open('rb') as stream:
        return stream.read(4) in MACHO_MAGICS


def clean_managed(path):
    if path.is_symlink():
        raise RuntimeError('Managed output must not be a symlink')
    if path.exists():
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()


def make_icon(pet, resources, temporary):
    iconset = temporary / 'WhalePet.iconset'
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            suffix = '@2x' if scale == 2 else ''
            target = iconset / ('icon_' + str(size) + 'x' + str(size) + suffix + '.png')
            run(['/usr/bin/sips', '--resampleHeightWidth', str(size * scale), str(size * scale),
                 pet, '--out', target], capture=True)
    run(['/usr/bin/iconutil', '--convert', 'icns', '--output', resources / 'WhalePet.icns', iconset])
    (resources / 'WhalePet.icns').chmod(0o644)


def install_text(version, arch):
    return f'''Whale Pet {version} · 大肥鱼桌宠
架构：{arch}；需要 macOS 15 或更新版本。

1. 将 Whale Pet.app 拖入 Applications（应用程序），再从应用程序打开。
2. 当前包使用 ad hoc 内容签名，没有 Developer ID 签名和 Apple 公证。
   确认来自本项目发行页并核对校验值后，如被系统阻止，请先尝试打开，
   再前往“系统设置 → 隐私与安全性 → 仍要打开”，按系统提示确认。
   无需全局关闭 Gatekeeper，也不要删除隔离属性来绕过正常流程。
   Apple 说明：https://support.apple.com/en-gb/102445
3. 首次向导可先选离线。Codex 使用本应用独立登录，是实验性的受限文字模式；
   API 模式需要自己的服务地址、模型和 Key。测试连接会使用一次小模型请求。
4. 应用信息、截图和主动 AI 均默认关闭。截图识别需要 API 视觉模型与系统录屏授权。
5. 更新前完整退出旧实例，再替换应用。用户数据默认保存在
   ~/Library/Application Support/WhalePet，与应用包分开。

本包内置固定版本运行时，不需要另装 Node、npm 或 DeepSeek Harness。
使用前请阅读应用 Resources 内的 PRIVACY.md、SECURITY.md 与许可证说明。
'''


def verify_zip(file, expected_paths):
    with zipfile.ZipFile(file) as archive:
        files = {item.filename for item in archive.infolist() if not item.is_dir()}
        if files != expected_paths or any(name.startswith('/') or '..' in Path(name).parts for name in files):
            raise RuntimeError('ZIP contents differ from the signed app allowlist')
        if any('__MACOSX' in name or '/._' in name or name.endswith('/.DS_Store') for name in files):
            raise RuntimeError('ZIP contains unintended metadata')
        if archive.testzip() is not None:
            raise RuntimeError('ZIP failed its CRC check')


def package(arch, version, skip_dmg):
    if sys.platform != 'darwin':
        raise RuntimeError('macOS packaging requires macOS and Xcode Command Line Tools')
    validate_production_inputs()
    lock = json.loads(plain_file(ROOT / 'runtime-lock.json').read_text(encoding='utf-8'))
    run([sys.executable, ROOT / 'scripts/fetch-runtime.py', '--arch', arch])
    cache, upstream = verified_runtime(arch, lock)
    dist = ROOT / 'dist'
    build = ROOT / 'build' / arch
    for directory in (ROOT / 'build', build, dist, dist / arch):
        if directory.is_symlink():
            raise RuntimeError('Build and release directories must not be symlinks')
        directory.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    environment.update(WHALE_BUILD_ARCH=arch, WHALE_BUILD_DIR=str(build))
    run(['/bin/bash', ROOT / 'build-native.sh'], env=environment)
    native = plain_file(build / 'DesktopWhalePet')
    architecture(native, arch)
    app = dist / arch / APP_NAME
    clean_managed(app)
    contents = app / 'Contents'
    resources = contents / 'Resources'
    service = resources / 'service'
    runtime = resources / 'runtime'
    (contents / 'MacOS').mkdir(parents=True)
    resources.mkdir()
    copy_file(native, contents / 'MacOS/WhalePet', executable=True)
    for name in SERVICE_FILES:
        copy_file(ROOT / name, service / name)
    for name in ASSET_FILES:
        copy_file(ROOT / 'assets' / name, service / 'assets' / name)
    for name in ('pet.png', 'pet-sprites.png'):
        copy_file(ROOT / 'assets' / name, resources / name)
    for name in PROJECT_NOTICES:
        copy_file(ROOT / name, resources / name)
    for name in sorted(upstream['files']):
        copy_file(cache / name, runtime / name, executable=name in ('bin/node', 'codex', 'rg'))
    with tempfile.TemporaryDirectory(prefix='package-assets-', dir=build) as raw:
        make_icon(ROOT / 'assets/pet.png', resources, Path(raw))
    info = {
        'CFBundleIdentifier': BUNDLE_ID, 'CFBundleExecutable': 'WhalePet',
        'CFBundleName': 'Whale Pet', 'CFBundleDisplayName': 'Whale Pet',
        'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version,
        'CFBundleVersion': version.split('-')[0], 'CFBundleIconFile': 'WhalePet.icns',
        'CFBundleDevelopmentRegion': 'zh_CN', 'CFBundleSupportedPlatforms': ['MacOSX'],
        'LSMinimumSystemVersion': '15.0', 'LSUIElement': True,
        'NSPrincipalClass': 'NSApplication', 'NSHighResolutionCapable': True,
        'LSApplicationCategoryType': 'public.app-category.lifestyle',
        'NSScreenCaptureUsageDescription': '仅在你开启截图并发送聊天时读取窗口图像，供你连接的 API 视觉模型识别。',
    }
    with (contents / 'Info.plist').open('wb') as stream:
        plistlib.dump(info, stream, sort_keys=True)
    (contents / 'PkgInfo').write_bytes(b'APPL????')
    executable_files = sorted(file for file in app.rglob('*') if file.is_file() and macho(file))
    expected_executables = {contents / 'MacOS/WhalePet', runtime / 'bin/node', runtime / 'codex'}
    if (runtime / 'rg').exists():
        expected_executables.add(runtime / 'rg')
    if set(executable_files) != expected_executables:
        raise RuntimeError('Unexpected or missing Mach-O executable in bundle')
    for file in executable_files:
        architecture(file, arch)
        identifier = BUNDLE_ID if file == contents / 'MacOS/WhalePet' else BUNDLE_ID + '.runtime.' + file.name
        run(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', '--identifier', identifier, file])
    runtime_record = {
        'schemaVersion': 1, 'architecture': arch, 'nodeVersion': lock['nodeVersion'],
        'codexVersion': lock['codexVersion'], 'signing': 'ad-hoc', 'notarized': False,
        'upstreamFiles': upstream['files'],
        'packagedFiles': {name: digest(runtime / name) for name in sorted(upstream['files'])},
        'upstream': lock['architectures'][arch],
    }
    write_json(runtime / 'runtime-manifest.json', runtime_record)
    run(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', '--identifier', BUNDLE_ID, app])
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', app])
    # Everything below is read-only with respect to the signed app.
    prefix = f'Whale-Pet-{version}-macos-{arch}'
    zip_file = dist / (prefix + '.zip')
    clean_managed(zip_file)
    run(['/usr/bin/ditto', '--norsrc', '--noextattr', '--noacl', '-c', '-k', '--keepParent', app, zip_file])
    app_files = sorted(file for file in app.rglob('*') if file.is_file())
    if any(file.is_symlink() for file in app.rglob('*')):
        raise RuntimeError('Unexpected symlink in signed app')
    verify_zip(zip_file, {APP_NAME + '/' + file.relative_to(app).as_posix() for file in app_files})
    artifacts = [zip_file]
    if not skip_dmg:
        dmg_file = dist / (prefix + '.dmg')
        clean_managed(dmg_file)
        with tempfile.TemporaryDirectory(prefix='dmg-stage-', dir=build) as raw:
            stage = Path(raw)
            run(['/usr/bin/ditto', '--norsrc', '--noextattr', '--noacl', app, stage / APP_NAME])
            (stage / 'Applications').symlink_to('/Applications', target_is_directory=True)
            (stage / 'INSTALL.txt').write_text(install_text(version, arch), encoding='utf-8')
            run(['/usr/bin/hdiutil', 'create', '-ov', '-format', 'UDZO', '-fs', 'HFS+',
                 '-volname', 'Whale Pet ' + version, '-srcfolder', stage, dmg_file])
        artifacts.append(dmg_file)
    files = {file.relative_to(dist).as_posix(): {'sha256': digest(file), 'size': file.stat().st_size} for file in app_files}
    tree = hashlib.sha256()
    for name, record in sorted(files.items()):
        tree.update((name + '\0' + record['sha256'] + '\n').encode('utf-8'))
    release = {
        'schemaVersion': 1, 'version': version, 'architecture': arch,
        'bundleIdentifier': BUNDLE_ID, 'minimumMacOS': '15.0',
        'signing': 'ad-hoc', 'notarized': False,
        'app': {'path': app.relative_to(dist).as_posix(), 'treeSHA256': tree.hexdigest(), 'files': files},
        'runtime': runtime_record,
        'artifacts': {file.name: {'sha256': digest(file), 'size': file.stat().st_size} for file in artifacts},
    }
    manifest = dist / (prefix + '.manifest.json')
    write_json(manifest, release)
    checksums = dist / (prefix + '-SHA256SUMS.txt')
    checksums.write_text(''.join(digest(file) + '  ' + file.name + '\n' for file in artifacts + [manifest]), encoding='utf-8')
    # No absolute build or user paths enter either manifest or checksum list.
    for file in [manifest, checksums]:
        text = file.read_text(encoding='utf-8')
        if str(ROOT) in text or re.search(r'/(?:Users|Volumes)/', text):
            raise RuntimeError('Release metadata contains a local absolute path')
    print(json.dumps({'app': app.relative_to(ROOT).as_posix(),
                      'artifacts': [file.relative_to(ROOT).as_posix() for file in artifacts],
                      'manifest': manifest.relative_to(ROOT).as_posix(),
                      'checksums': checksums.relative_to(ROOT).as_posix(),
                      'signing': 'ad-hoc', 'notarized': False}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--arch', required=True, choices=('arm64', 'x86_64'))
    parser.add_argument('--version', default='0.1.0')
    parser.add_argument('--skip-dmg', action='store_true', help='Produce the app and ZIP without a DMG (macOS CI).')
    options = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?', options.version):
        parser.error('--version must be a dotted numeric version with an optional prerelease suffix')
    try:
        package(options.arch, options.version, options.skip_dmg)
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        # A failure is not a successful release; no app or provider is launched.
        print('Packaging failed: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
