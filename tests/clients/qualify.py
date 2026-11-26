# SPDX-License-Identifier: AGPL-3.0-only
"""Run the admitted client cohorts against one newly bundled loopback Workerd."""
import argparse
from collections import Counter
from hashlib import sha1, sha256
import importlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from types import SimpleNamespace

PROJECT = Path(__file__).resolve().parents[2]
HERE = PROJECT / 'tests/clients'
WORKSPACE = Path('/home/agent/workspace')
HISTORY = WORKSPACE / 'openviking-cloudflare/.work/cli'
PY_DEPS = HISTORY.parent / 'original/venv/lib/python3.11/site-packages'
NODE = WORKSPACE / 'ov-parite-compile-gateway/candidat-b3/.work/studio/toolchain/bin/node'
PY = '/usr/bin/python3'
PORT = 8824
ORIGIN = f'http://127.0.0.1:{PORT}'
PIN = '000f0765d7ec183886fbabbc22e69bc289cc429d'
NODE_SHA = '1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31'
OV_SHA = '8bd2229f3fc0b41326ad853bfad0e233e9c7b78be84c52d0d0f8f7e15b0b28dd'
REFERENCE = 'nodes-full-ab69453299e1.json'
HELPERS = {
    'guard.py': 'dc30fe0d24251a067532998049c64c9f16d37850599b8f3dd6c346ee52d88027',
    'fixture_guard.py': '75405053e668c46a0cc5ce6e96a2fd3f3657fa925a86aa487b3e3e8678888c46',
    'run.py': '5c08f0cb4637f88c61ecc3a8ed2d1e9d5f8e6024a850cef1be0620b50b7eef2d',
    'py_entry.py': 'a3c0a40ece2cce8833edc0cb23be3718b78710e236619385b34ea6d5541e1d78',
}
LOCKS = {
    'source-lock.json': '04b674be8c4c2eaffd928268e68444123d37c0025c1097ba7ac90bbbd6dd227d',
    'source-python-lock.json': '0c4ef5c21f3bd8b46b6c147b6d0708d41df8b1a90fb0e3f9554be73b2a35e826',
    'source-imports-lock.json': 'c283ff803ef7091f1bb5dfee71c11f2ec19954993c2971c68fe6a04da24c6562',
    'source-gateway-lock.json': 'cda0906590479202e1b007013d38d26bb9b37733782ab78bf915953380a0dad6',
}
TS_FILES = {
    'package.json': 'f6507d837b1caf689f77bfe3ed28fef45f07a32db47f09cc47fc8500b99e913c',
    'dist/index.js': '042a4ce7e9be14a54d272bca97eaa9497841818dd9df93029a014242af7a7e7a',
    'node_modules/fflate/package.json': '5922d8150b307bc0e4e441491c779c45379e9913d348848fca8d5cf02db4d134',
    'node_modules/fflate/esm/index.mjs': '8d75534a30a0580608e1271c13d70943ed4cd3589fddff7b1197748036a5116e',
}
ENV = dict(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/nonexistent', LANG='C.UTF-8',
           GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_NO_LAZY_FETCH='1',
           GIT_OPTIONAL_LOCKS='0', GIT_NO_REPLACE_OBJECTS='1')


def require(cond, message):
    if not cond:
        raise RuntimeError(message)


def digest(data):
    return sha256(data).hexdigest()


def verified(path, expected):
    require(path.resolve() == path and path.is_file(), f'not a regular attested file: {path}')
    data = path.read_bytes()
    require(digest(data) == expected, f'input drift: {path}')
    return data


def save(path, data, mode=0o400):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as out:
        out.write(data)
    path.chmod(mode)


def record(path, data):
    save(path, (json.dumps(data, indent=2, sort_keys=True) + '\n').encode())


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '-c', 'protocol.allow=never', '--git-dir=upstream', *args],
                                   cwd=PROJECT, env=ENV, timeout=20)


def bound_sockets(*, listeners_only=False):
    rows = []
    for name in ('tcp', 'tcp6', 'udp', 'udp6'):
        for line in Path(f'/proc/net/{name}').read_text().splitlines()[1:]:
            _, local, _, state, *_ = line.split()
            if int(local.rsplit(':', 1)[1], 16) != PORT:
                continue
            if listeners_only and state != '0A':
                continue
            if state != '06':  # TIME_WAIT cannot be a competing listener.
                rows.append((name, local, state))
    return rows


def stage(base, with_sdk):
    require(git('rev-parse', 'HEAD').decode().strip() == PIN, 'upstream pin drift')
    tree = {}
    for entry in git('ls-tree', '-rz', PIN).split(b'\0')[:-1]:
        meta, name = entry.decode().split('\t', 1)
        tree[name] = meta.split()
    inputs = {}
    review = []
    for lock, checksum in LOCKS.items():
        items = json.loads(verified(HISTORY / lock, checksum))
        require(items['pin'] == PIN, f'invalid pin in {lock}')
        for rel, row in items['files'].items():
            require(re.fullmatch(r'[\w.@+/-]+', rel, re.ASCII) and
                    all(p not in ('', '.', '..', '.git', '.env') for p in rel.split('/')), 'invalid export path')
            mode, kind, oid = tree[rel]
            require(kind == 'blob' and mode in ('100644', '100755') and oid == row['git_blob'] and rel not in inputs,
                    f'invalid export: {rel}')
            data = verified(HISTORY / 'source' / rel, row['sha256'])
            # A copy of the already reviewed export, independently tied to the pin's Git blob.
            require(sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() == oid, f'Git blob drift: {rel}')
            save(base / 'source' / rel, data, 0o500 if mode == '100755' else 0o400)
            inputs[rel] = row['sha256']
    if with_sdk:
        for rel in sorted(tree):
            if not re.fullmatch(r'sdk/python/openviking_sdk/[a-z_]+\.py|sdk/python/pyproject\.toml', rel):
                continue
            mode, kind, oid = tree[rel]
            require(kind == 'blob' and mode == '100644', f'unexpected SDK source: {rel}')
            data = git('cat-file', 'blob', oid)
            require(sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() == oid, f'Git blob drift: {rel}')
            filtered = subprocess.run([PY, '-I', 'tests/control/offline.py',
                '/usr/local/bin/ob-plugin-prompt-shield-sanitize', '--source', f'{PIN}:{rel}', '--max-chars', '180000'],
                input=data, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd=PROJECT, env=ENV, timeout=12)
            report = json.loads(filtered.stderr)
            require(filtered.returncode in (0, 3) and report['level'] in ('clean', 'low', 'medium')
                    and not report['stats']['truncated'], f'new SDK source not admitted: {rel}')
            review.append(dict(path=rel, sha256=digest(data), level=report['level'],
                               heuristics=[item['id'] for item in report['matches']]))
            save(base / 'source' / rel, data)
            inputs[rel] = digest(data)
        for rel, sha in TS_FILES.items():
            save(base / 'typescript' / rel, verified(HISTORY / 'sdk-exact-node24' / rel, sha))
        require(TS_FILES['package.json'] == inputs['sdk/typescript/package.json'], 'TS package manifest drift')
    b = verified(HISTORY / 'target/debug/ov', OV_SHA)
    save(base / 'target/debug/ov', b, 0o500)
    for helper, sha in HELPERS.items():
        save(base / helper, verified(HISTORY / helper, sha))
    ref = json.loads(verified(HISTORY / REFERENCE, '77a424685a06d70d46377e85898b180c05dd8313576ad5e90b8dd48f99f42a71'))
    require(ref['source_pin'] == PIN and ref['binary_sha256'] == OV_SHA and
            all(inputs[path] == sha for path, sha in ref['stock_files_sha256'].items()), 'CLI reference drift')
    record(base / 'inputs.json', dict(pin=PIN, inputs=inputs, node_sha256=NODE_SHA, binary_sha256=OV_SHA,
                                      guards=HELPERS, typescript=TS_FILES if with_sdk else {}, python_review=review))
    return ref


def read_events(log, prefix):
    # pytest's progress dots can precede an observer marker on the same line.
    return [json.loads(line.split(prefix, 1)[1]) for line in log.splitlines()
            if re.match(r'^[.sFE xX]*' + re.escape(prefix), line)]


def receipt_and_log(base, receipt_name, bundle):
    root = base / 'logs'
    raw = (root / f'{receipt_name}.log').read_bytes()
    receipt = (root / f'{receipt_name}.receipt.json').read_bytes()
    r = json.loads(receipt)
    require(r['endpoint'] == ORIGIN and r['bundle_sha256'] == bundle and r['profile'] == 'worker'
            and r['confinement'].endswith('probes=ok') and r['exit'] in (0, 1)
            and not (r['timed_out'] or r['output_truncated'] or r['supervisor_error']), f'unqualified {receipt_name} receipt')
    return r, raw, dict(log_sha256=digest(raw), receipt_sha256=digest(receipt))


def seal_cli(base, receipt_name, ref, bundle, code):
    r, raw, digests = receipt_and_log(base, receipt_name, bundle)
    require(r['exit'] == code, 'CLI launch verdict drift')
    log = raw.decode()
    collected, = read_events(log, 'CLI_COLLECT ')
    expected = {n['node'] for n in ref['nodes']}
    require(len(expected) == len(collected) == 72 and {r['node'] for r in collected} == expected
            and all(r['remote'] for r in collected) and not read_events(log, 'CLI_DESELECTED '), 'CLI collection drift')
    events = {node: {} for node in sorted(expected)}
    for row in read_events(log, 'CLI_NODE '):
        phase = events[row['node']]
        require(row['phase'] not in phase and row['outcome'] in ('passed', 'failed', 'skipped'), 'invalid CLI phase')
        phase[row['phase']] = row
    outcomes = {}
    for node, entries in events.items():
        choices = {e['outcome'] for e in entries.values()}
        require(choices, f'no CLI verdict: {node}')
        outcomes[node] = next(k for k in ('failed', 'skipped', 'passed') if k in choices)
    summary = dict(Counter(outcomes.values()))
    require((code == 0) == (summary.get('failed', 0) == 0), 'CLI results contradict exit code')
    record(base / 'cli-index.json', dict(pin=PIN, bundle_sha256=bundle, endpoint=ORIGIN, counts=summary,
        rows=events, outcomes=outcomes, **digests,
        snapshot_observation=read_events(log, 'CLI_SNAPSHOT_OP ')))
    return summary


def seal_sdk(base, name, bundle, code):
    r, raw, digests = receipt_and_log(base, f'{name}-{bundle[:12]}', bundle)
    expected = ['health', 'filesystem', 'search', 'auth-denial', 'file-delete', 'session']
    if name == 'typescript':
        expected.insert(3, 'optional-download')
    rows = read_events(raw.decode(), 'SDK_NODE ')
    require([row['name'] for row in rows] == expected and all(row['vote'] in ('pass', 'fail') for row in rows),
            f'{name} did not produce the expected complete ordered probe inventory')
    counts = dict(Counter(row['vote'] for row in rows))
    require(r['exit'] == code == int(bool(counts.get('fail'))), f'{name} exit contradicts probe votes')
    record(base / f'{name}-index.json', dict(pin=PIN, bundle_sha256=bundle, endpoint=ORIGIN, counts=counts,
                                             rows=rows, **digests))
    return counts


def run(base, scratch, ref, lane):
    sys.path.insert(0, str(base))
    launcher = importlib.import_module('run')
    guard = importlib.import_module('guard')
    # Only add this lane's verified read-only program files; keep the original guard,
    # supervisor, capture/redaction, fork and timeout code unchanged.
    original = launcher.restrict
    additions = []
    launcher.restrict = lambda ro, rw, *opts: original([*ro, *additions], rw, *opts)
    launcher.OLD_PY = PY_DEPS
    verified(NODE, NODE_SHA)
    env = {**ENV, 'TMPDIR': str(scratch / 'tmp')}
    Path(env['TMPDIR']).mkdir()
    loopback = scratch / 'loopback.so'
    subprocess.run([PY, '-I', 'tests/control/offline.py', '/usr/bin/cc', '-Wall', '-Wextra', '-Werror',
                    '-shared', '-fPIC', '-Wl,-z,now', 'studio-patches/loopback.c', '-o', str(loopback), '-ldl'],
                   cwd=PROJECT, env=env, timeout=15, check=True)
    require(not bound_sockets(), '8824 already occupied; request a new admission, do not substitute a port')
    keyfile = scratch / f'.work/browser/synthetic-{PORT}.key'
    keyfile.parent.mkdir(parents=True)
    require(launcher.ROOT == guard.ROOT == scratch, 'unexpected launcher root')
    # Existing probe expects present-but-inaccessible sibling paths in its private layout.
    save(scratch / '.work/original/confine.py', b'# private guard sentinel; never executed\n')
    save(scratch / 'README.md', b'Private guard sentinel.\n')
    with (scratch / 'worker.log').open('xb') as journal:
        worker = subprocess.Popen([str(NODE), str(HERE / 'fixture.mjs'), str(keyfile)], cwd=PROJECT, stdin=subprocess.DEVNULL,
                                  stdout=journal, stderr=subprocess.STDOUT, env={**env, 'LD_PRELOAD': str(loopback)})
        try:
            deadline = time.monotonic() + 25
            while not keyfile.exists() and worker.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            require(worker.poll() is None and keyfile.is_file(), 'Worker did not start; inspect worker.log')
            require(bound_sockets(listeners_only=True) == [('tcp', '0100007F:2278', '0A')], 'fixture listen scope drift')
            rows = [json.loads(line) for line in (scratch / 'worker.log').read_text().splitlines() if line.startswith('{"origin":')]
            fixture, = rows
            bundle = fixture['bundle_sha256']
            require(fixture['origin'] == ORIGIN and fixture['health_http'] == 200 and
                    re.fullmatch('[0-9a-f]{64}', bundle), 'invalid Worker attestation')
            print(json.dumps(fixture), flush=True)

            def launch(name, argv, seconds):
                require(worker.poll() is None, 'original fixture process exited')
                return launcher.launch(SimpleNamespace(profile='worker', candidate_port=PORT, bundle_sha=bundle,
                    name=f'{name}-{bundle[:12]}', command=[str(x) for x in argv], seconds=seconds))

            votes = {}
            if lane in ('all', 'cli'):
                files = sorted(p for p in ref['stock_files_sha256'] if re.fullmatch(r'tests/cli/test_cli_[a-z]+\.py', p))
                require(len(files) == 10, 'CLI stock file set drift')
                cli_exit = launch('cli', [PY, '-sSB', base / 'py_entry.py', '--trace-snapshot', '-q', *files], 440)
                votes['cli'] = seal_cli(base, f'cli-{bundle[:12]}', ref, bundle, cli_exit)
            if lane in ('all', 'sdk'):
                for name, argv, extra in (
                    ('typescript', [NODE, HERE / 'sdk.mjs'], [NODE, base / 'typescript', HERE / 'sdk.mjs']),
                    ('python', [PY, '-sSB', HERE / 'sdk.py'], [HERE / 'sdk.py']),
                ):
                    additions[:] = extra
                    status = launch(name, argv, 35)
                    # Keep raw diagnostics and run the other SDK even after a bootstrap failure.
                    try:
                        votes[name] = seal_sdk(base, name, bundle, status)
                    except (OSError, ValueError, RuntimeError) as exc:
                        votes[name] = dict(unqualified=str(exc), exit=status)
            require(worker.poll() is None, 'original fixture process exited before all verdicts')
            record(scratch / 'campaign.json', dict(**fixture, votes=votes, lane=lane, candidate=str(PROJECT)))
            print(json.dumps(votes), flush=True)
            green = {'cli': {'passed': 72}, 'typescript': {'pass': 7}, 'python': {'pass': 6}}
            return int(any(v != green[k] for k, v in votes.items()))
        finally:
            if worker.poll() is None:
                worker.terminate()
                try:
                    worker.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait(timeout=5)
            keyfile.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('id')
    parser.add_argument('lane', choices=('all', 'cli', 'sdk'))
    args = parser.parse_args()
    require(sys.flags.isolated and sys.flags.dont_write_bytecode, 'invoke using python3 -IB')
    require(re.fullmatch('[a-z0-9][a-z0-9-]{0,47}', args.id), 'invalid receipt ID')
    os.umask(0o077)
    work = PROJECT / '.work'
    require(work.is_dir() and work.resolve() == work, 'prepared .work directory required')
    scratch = work / f'clients-{args.id}'
    scratch.mkdir()
    base = scratch / '.work/cli'
    ref = stage(base, args.lane != 'cli')
    return run(base, scratch, ref, args.lane)


if __name__ == '__main__':
    sys.exit(main())
