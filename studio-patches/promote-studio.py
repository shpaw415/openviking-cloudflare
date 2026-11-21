#!/usr/bin/python3
"""Check a pinned local Studio promotion. Only --apply can swap the active tree."""
import argparse
from collections import Counter
from contextlib import contextmanager
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile

PATCHES = Path(__file__).resolve().parent
ROOT = PATCHES.parent
WORK = ROOT / '.work' / 'studio'
LOGS = WORK / 'logs'
REVISION = '000f0765d7ec183886fbabbc22e69bc289cc429d'
HEX = re.compile(r'[0-9a-f]{64}')
RESTORED_SUITES = frozenset(f'src/features/admin/gateway/lib/{name}.test.ts' for name in ('docs-anchors', 'upstream-schema'))


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def plain_dir(path):
    if not stat.S_ISDIR(path.lstat().st_mode):
        raise RuntimeError(f'Not a real directory: {path}')
    return path


def regular(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise RuntimeError(f'not a regular asset or receipt: {path}')
    return path


def relative_asset(name):
    path = PurePosixPath(name)
    if (not path.parts or path.is_absolute() or path.as_posix() != name
            or any(part.startswith('.') for part in path.parts)
            or '\\' in name or any(ord(char) < 32 for char in name)):
        raise RuntimeError(f'Invalid release path: {name!r}')
    return name


def manifest(path):
    entries = {}
    for line in regular(path).read_text().splitlines():
        value, separator, name = line.partition('  ')
        if not separator or not HEX.fullmatch(value) or name in entries:
            raise RuntimeError(f'Malformed or duplicate asset entry in {path.name}')
        entries[relative_asset(name)] = value
    if 'index.html' not in entries:
        raise RuntimeError(f'Manifest has no Studio index: {path.name}')
    return entries


def verify_tree(directory, expected):
    actual = {}
    for item in plain_dir(directory).rglob('*'):
        mode = item.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        regular(item)
        relative = relative_asset(item.relative_to(directory).as_posix())
        if item.stat().st_size > 25 * 1024 * 1024:
            raise RuntimeError(f'Asset exceeds the staging bound: {relative}')
        actual[relative] = sha(item)
    if actual != expected:
        raise RuntimeError(f'Asset manifest mismatch: {directory}')
    return len(actual)


@contextmanager
def writer_lock(path):
    fd = os.open(path, os.O_CREAT | os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError('Studio writer lock is not a regular file')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Refusing promotion: another Studio writer holds the lock') from error
        yield
    finally:
        os.close(fd)  # The lock file is never unlinked or replaced.


def exchange(left, right):
    call = ctypes.CDLL(None, use_errno=True).renameat2
    call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    call.restype = ctypes.c_int
    if call(-100, os.fsencode(left), -100, os.fsencode(right), 2):  # RENAME_EXCHANGE
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def checked_exchange(active, stage, transaction, old, new):
    verify_tree(active, old)
    verify_tree(stage, new)
    previous = plain_dir(transaction) / 'previous'
    if active.parent.stat().st_dev != transaction.stat().st_dev:
        raise RuntimeError('Atomic exchange requires a single filesystem; no fallback')
    shutil.copytree(stage, previous, symlinks=True)
    verify_tree(previous, new)
    verify_tree(active, old)
    exchange(active, previous)
    try:
        verify_tree(active, new)
        verify_tree(previous, old)
    except BaseException:
        exchange(active, previous)
        verify_tree(active, old)
        raise


def load_json(path):
    return json.loads(regular(path).read_text())


def require_green(totals, files, cases):
    if totals != dict(passed=cases, failed=0, skipped=0, todo=0, reported=files, success=True):
        raise RuntimeError(f'Campaign red or incomplete ({totals}); expected {files} files and {cases} green tests')


def require_sequential(summary):
    runner = summary.get('runner', {})
    if runner.get('strategy') != 'sequential' or type(runner.get('workers')) is not int or runner['workers'] != 1:
        raise RuntimeError('An unsharded sequential run with one worker is required')


def raw_reports(directory, groups, *, historical_empty=frozenset()):
    """Require disjoint reports with exactly the requested files and reconcile raw test states."""
    state = Counter()
    cases = Counter()
    seen = set()
    success = True
    empty = set()
    for cohort, files in groups.items():
        report = load_json(directory / f'{cohort}.json')
        paths = set()
        for suite in report['testResults']:
            _, separator, path = suite['name'].partition('/web-studio/')
            if not separator or path in paths or path in seen:
                raise RuntimeError(f'Unexpected or repeated report path: {path}')
            paths.add(path)
            if not suite['assertionResults']:
                empty.add(path)
            for case in suite['assertionResults']:
                cases[path, case['fullName']] += 1
                state[case['status']] += 1
        if paths != set(files):
            raise RuntimeError(f'Vitest file identity mismatch in {directory.name}/{cohort}')
        seen.update(paths)
        success = success and report.get('success') is True
    if state.keys() - {'passed', 'failed', 'pending', 'skipped', 'todo'}:
        raise RuntimeError('Unknown assertion status in Vitest reports')
    if empty != set(historical_empty):
        raise RuntimeError(f'Wrong empty-suite inventory in {directory.name}: {sorted(empty)}')
    return cases, dict(passed=state['passed'], failed=state['failed'], skipped=state['pending'] + state['skipped'],
                       todo=state['todo'], reported=len(seen), success=success)


def validate_campaign(stage, baseline, campaign, replay=None, baseline_support=None):
    source = regular(stage / 'source.sha256').read_bytes()
    if regular(campaign / 'source.sha256').read_bytes() != source or (baseline / 'source.sha256').read_bytes():
        raise RuntimeError('Source stamps differ or the baseline is not pristine')
    original = load_json(baseline / 'inventory.json')
    after = load_json(campaign / 'inventory.json')
    if original['sha'] != REVISION or (after['sha'], after['files']) != (original['sha'], original['files']):
        raise RuntimeError('Original test file hashes are not identical')
    pin = original['files']
    selected = [path for group in after['cohorts'].values() for path in group]
    if len(pin) != 221 or len(selected) != 221 or set(selected) != pin.keys():
        raise RuntimeError('Wrong upstream file inventory')
    support = after.get('support')
    if not isinstance(support, dict) or len(support) != 31 or any(not HEX.fullmatch(value) for value in support.values()):
        raise RuntimeError('The full pinned Studio support inputs were not restored')
    if original.get('support') == support:
        before_cases, _ = raw_reports(baseline, original['cohorts'])
    elif original.get('support') is None and baseline_support is not None:
        # The historical reference has two visible collection failures. Take
        # their assertion identities from a separate untouched upstream run.
        expanded = load_json(baseline_support / 'inventory.json')
        if (expanded != after or regular(baseline_support / 'source.sha256').read_bytes()):
            raise RuntimeError('The restored reference does not match those original imports')
        before_cases, _ = raw_reports(baseline, original['cohorts'], historical_empty=RESTORED_SUITES)
        extra, extra_total = raw_reports(baseline_support, {'features-admin': RESTORED_SUITES})
        require_green(extra_total, len(RESTORED_SUITES), extra.total())
        before_cases.update(extra)
    else:
        raise RuntimeError('An intact reference for the restored suites is required')
    after_cases, totals = raw_reports(campaign, after['cohorts'])
    if before_cases != after_cases or before_cases.total() <= 1701:
        raise RuntimeError('Some original assertions are missing, substituted, or duplicated')
    summary = load_json(campaign / 'summary.json')
    require_green(totals, 221, before_cases.total())
    expected_edge = sorted(f'script/studio-edge-tests/{path.name}' for path in PATCHES.glob('edge-*.test.ts*'))
    edge_cases, edge_total = raw_reports(campaign, {'edge-regressions': expected_edge})
    require_green(edge_total, len(expected_edge), edge_cases.total())
    if not edge_cases or not expected_edge or summary.get('upstream_only') is not False or summary.get('edge_originals') is not False:
        raise RuntimeError('Missing isolated Edge proofs or wrong campaign mode')
    selected_groups = set(after['cohorts']) | {'edge-regressions'}
    if set(summary['results']) != selected_groups or any(
        row.get('status') != 'passed' or row.get('exit') != 0 for row in summary['results'].values()
    ):
        raise RuntimeError('Campaign missing a clean runner exit')
    require_sequential(summary)
    if replay is None or replay == campaign:
        raise RuntimeError('An independent Edge regression replay is required')
    if regular(replay / 'source.sha256').read_bytes() != source:
        raise RuntimeError('The Edge replay is from a different patchset')
    repeat_summary = load_json(replay / 'summary.json')
    if load_json(replay / 'inventory.json') != after:
        raise RuntimeError('The Edge replay used a different test support inventory')
    require_sequential(repeat_summary)
    if (repeat_summary.get('upstream_only') is not False or repeat_summary.get('edge_originals') is not False
            or set(repeat_summary['results']) != {'edge-regressions'}
            or repeat_summary['results']['edge-regressions'].get('exit') != 0):
        raise RuntimeError('The Edge replay is not a completed Edge-only run')
    repeat_cases, repeat_total = raw_reports(replay, {'edge-regressions': expected_edge})
    if edge_cases != repeat_cases:
        raise RuntimeError('The Edge regression identities differ between runs')
    require_green(repeat_total, len(expected_edge), edge_cases.total())
    return totals, edge_total


def log_dir(name):
    if not re.fullmatch(r'[a-z0-9_-]{1,80}', name):
        raise ValueError('Use a direct name under .work/studio/logs')
    return plain_dir(LOGS / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True, help='build-* directory name under the Studio logs')
    parser.add_argument('--current-receipt', required=True)
    parser.add_argument('--baseline', default='test-gdwaeeoy')
    parser.add_argument('--baseline-support', help='Untouched upstream replay of the two once-uncollected suites')
    parser.add_argument('--campaign', required=True)
    parser.add_argument('--edge-replay', help='Independent successful Edge-only run for the same build')
    parser.add_argument('--expect-current', required=True)
    parser.add_argument('--expect-candidate', required=True)
    parser.add_argument('--browser-receipt', help='Independent exact-bundle QA JSON in .work/studio')
    parser.add_argument('--apply', action='store_true', help='Only on explicit local approval; default is check only')
    args = parser.parse_args()
    plain_dir(WORK.parent)
    plain_dir(WORK)
    plain_dir(LOGS)
    output = Path(tempfile.mkdtemp(prefix='promotion-', dir=WORK))
    active = plain_dir(ROOT / 'dist') / 'studio'
    state = {'action': 'apply' if args.apply else 'check', 'stage': args.stage, 'campaign': args.campaign,
             'current': args.expect_current, 'candidate': args.expect_candidate, 'status': 'blocked'}
    try:
        with writer_lock(WORK / 'studio-writer.lock'):
            stage = log_dir(args.stage)
            old = manifest(log_dir(args.current_receipt) / 'assets.sha256')
            manifest_path = stage / 'assets.sha256'
            new = manifest(manifest_path)
            if old['index.html'] != args.expect_current or new['index.html'] != args.expect_candidate or new == old:
                raise RuntimeError('Wrong current/candidate pin or candidate is not distinct')
            state['current_files'] = verify_tree(active, old)
            state['candidate_files'] = verify_tree(stage / 'dist', new)
            state['candidate_manifest_sha256'] = sha(manifest_path)
            build = re.sub(r'\x1b\[[0-9;]*m', '', regular(stage / 'build.log').read_text())
            if not all(p in build for p in ('npm run lint && npm run test:i18n', '48 passed (48)', '✓ built in')):
                raise RuntimeError('Candidate lacks the full successful build evidence')
            replay = log_dir(args.edge_replay) if args.edge_replay else None
            reference = log_dir(args.baseline_support) if args.baseline_support else None
            state['original'], state['edge'] = validate_campaign(stage, log_dir(args.baseline), log_dir(args.campaign), replay, reference)
            state['edge_replay'] = args.edge_replay
            if not args.browser_receipt:
                raise RuntimeError('Candidate browser receipt required for this exact manifest; active tree kept')
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}\.json', args.browser_receipt):
                raise RuntimeError('Browser receipt must be a direct JSON file under .work/studio')
            qa = load_json(WORK / args.browser_receipt)
            if not (qa.get('passed') is True and qa.get('index_sha256') == args.expect_candidate
                    and qa.get('manifest_sha256') == state['candidate_manifest_sha256']):
                raise RuntimeError('Browser receipt does not qualify these bytes')
            state['status'] = 'qualified'
            if args.apply:
                (output / 'before.json').write_text(json.dumps(state, indent=2) + '\n')
                checked_exchange(active, stage / 'dist', output, old, new)
                state['status'] = 'applied'
                state['previous'] = str((output / 'previous').relative_to(ROOT))
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        state['status'] = 'blocked'
        state['reason'] = str(error)
    (output / 'result.json').write_text(json.dumps(state, indent=2) + '\n')
    print(output.relative_to(ROOT), state['status'], state.get('reason', ''))
    return int(state['status'] == 'blocked')


if __name__ == '__main__':
    sys.exit(main())
