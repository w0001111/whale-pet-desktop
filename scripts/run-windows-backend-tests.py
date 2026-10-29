#!/usr/bin/env python3
"""Run the pinned Windows Node backend tests and publish count-only TAP results."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / 'build/windows-validation/backend-tests.json'
SUMMARY = re.compile(r'^#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$')


def parse_summary_line(line, counts):
    match = SUMMARY.fullmatch(line.strip())
    if match:
        counts[match.group(1)] = int(match.group(2))


def summary_passed(counts, exit_code):
    required = {'tests', 'pass', 'fail', 'skipped'}
    return (exit_code == 0 and required.issubset(counts) and counts['tests'] > 0
            and counts['fail'] == 0 and counts.get('cancelled', 0) == 0
            and counts.get('todo', 0) == 0
            and counts['tests'] == counts['pass'] + counts['skipped'])


def test_environment(temporary):
    env = {key: value for key in ('PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG')
           if (value := os.environ.get(key)) is not None}
    home, tmp = temporary / 'home', temporary / 'tmp'
    for folder in (home, tmp, home / 'Roaming', home / 'Local', temporary / 'codex-home'):
        folder.mkdir(parents=True, exist_ok=True)
    env.update(HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / 'Roaming'),
               LOCALAPPDATA=str(home / 'Local'), TEMP=str(tmp), TMP=str(tmp), TMPDIR=str(tmp),
               CODEX_HOME=str(temporary / 'codex-home'), WHALE_PET_DATA_DIR=str(temporary / 'application'),
               NO_COLOR='1', NODE_DISABLE_COLORS='1')
    return env


def main():
    report = {'schemaVersion': 1, 'platform': 'windows', 'pass': False,
              'modelRequests': 0, 'loginPerformed': False, 'desktopCaptured': False}
    counts, code, child = {}, -1, None
    try:
        if os.name != 'nt':
            raise RuntimeError('WINDOWS_REQUIRED')
        node = ROOT / '.cache/windows-runtime/x64/bin/node.exe'
        if not node.is_file() or node.is_symlink():
            raise RuntimeError('PINNED_NODE_MISSING')
        tests = sorted(file for file in ROOT.glob('*.test.mjs') if file.is_file() and not file.is_symlink())
        if not tests:
            raise RuntimeError('NO_BACKEND_TESTS')
        report['testFiles'] = len(tests)
        with tempfile.TemporaryDirectory(prefix='whale-backend-ci-') as raw:
            env = test_environment(Path(raw))
            child = subprocess.Popen([str(node), '--test', '--test-timeout=120000', '--test-reporter=tap',
                                      *(file.name for file in tests)], cwd=ROOT, env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, encoding='utf-8', errors='replace', bufsize=1)
            assert child.stdout is not None
            for line in child.stdout:
                sys.stdout.write(line)
                sys.stdout.flush()
                parse_summary_line(line, counts)
            code = child.wait()
        report.update(exitCode=code, totals={key: counts.get(key, 0) for key in
                      ('tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo')},
                      summaryComplete={'tests', 'pass', 'fail', 'skipped'}.issubset(counts),
                      **{'pass': summary_passed(counts, code)})
        if not report['pass']:
            report['error'] = {'code': 'BACKEND_TESTS_FAILED_OR_INCOMPLETE'}
    except KeyboardInterrupt:
        if child is not None and child.poll() is None:
            child.terminate()
        report['error'] = {'code': 'BACKEND_TESTS_INTERRUPTED'}
    except Exception as error:
        report['error'] = {'code': str(error) if isinstance(error, RuntimeError) else 'BACKEND_TEST_RUNNER_FAILED'}
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait()
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'pass': report['pass'], 'totals': report.get('totals', {}),
                      'report': REPORT.relative_to(ROOT).as_posix()}))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
