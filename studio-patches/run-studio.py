#!/usr/bin/python3
"""Build/test the pinned Studio with a fresh HOME, files and kernel restrictions."""

import argparse
import ctypes as c
import errno
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import resource
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import urlsplit

PATCHES = Path(__file__).resolve().parent
ROOT = PATCHES.parent
WORK = ROOT / '.work' / 'studio'
UPSTREAM = ROOT / 'upstream'
REVISION = '000f0765d7ec183886fbabbc22e69bc289cc429d'
SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin'
GIT_ENV = dict(PATH='/usr/bin:/bin', HOME='/nonexistent', GIT_CONFIG_GLOBAL='/dev/null',
               GIT_CONFIG_NOSYSTEM='1', GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0',
               GIT_NO_REPLACE_OBJECTS='1')
LIBC = c.CDLL('libc.so.6', use_errno=True)
LIBC.syscall.restype = c.c_long
READ = (1 << 0) | (1 << 2) | (1 << 3)  # execute, read file, read dir
FS_RIGHTS = (1 << 16) - 1              # all through ABI 5 (incl. IOCTL_DEV)
REG_RIGHTS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 14) | (1 << 15)
LOOPBACK_FIXTURES = frozenset([
    'src/shared/api/admin-probe.test.ts',
    'src/features/connection/hooks/use-studio-capabilities.test.tsx',
    'src/features/connection/hooks/use-app-connection.trusted.test.tsx',
    'src/features/connection/hooks/use-app-connection.isolation.test.tsx',
    'src/features/connection/hooks/use-app-connection.bootstrap.test.tsx',
])
EXTRA_TEST_ROOT = 'script/studio-edge-tests'
SUPPORT_SOURCES = (
    'docs/en/gateway', 'docs/zh/gateway',
    *(f'docs/{lang}/guides/{page}.md' for lang in ('en', 'zh')
      for page in ('15-gateway', '22-gateway-operations')),
    'tests/fixtures/gateway_upstream_urls.json',
)


class Ruleset(c.Structure):
    _fields_ = [('fs', c.c_uint64), ('net', c.c_uint64), ('scope', c.c_uint64)]


class PathRule(c.Structure):
    _pack_ = 1
    _fields_ = [('access', c.c_uint64), ('parent_fd', c.c_int)]


class PortRule(c.Structure):
    _fields_ = [('access', c.c_uint64), ('port', c.c_uint64)]


class ArgTest(c.Structure):
    _fields_ = [('arg', c.c_uint), ('op', c.c_int), ('a', c.c_uint64), ('b', c.c_uint64)]


def checked(result, operation):
    if result < 0:
        code = c.get_errno() if result == -1 else -result
        raise OSError(code, operation)
    return result


def restrict_files_and_tcp(run, cache, node, npm, mode, local_ports):
    # x86-64 Linux syscall numbers. No best-effort fallback.
    abi = checked(LIBC.syscall(444, 0, 0, 1), 'Landlock version')
    if abi < 6:
        raise RuntimeError(f'Landlock ABI ≥ 6 required, found {abi}')
    spec = Ruleset(FS_RIGHTS, 3, 3)  # TCP bind/connect; scoped abstract UNIX and signals
    fd = checked(LIBC.syscall(444, c.byref(spec), c.sizeof(spec), 0), 'Landlock ruleset')
    ro = (
        '/usr/lib', '/usr/lib64', '/usr/bin/env', '/bin/sh', '/etc/ld.so.cache',
        '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime', '/proc/cpuinfo',
        '/dev/random', '/dev/urandom', node, npm.parent.parent,
    )
    paths = [(path, READ) for path in ro] + [(run, FS_RIGHTS), ('/dev/null', 6), ('/dev/zero', 6)]
    if mode in ('install', 'cache'):
        paths.append((cache, FS_RIGHTS & ~1))
    if mode == 'install':
        paths.extend((path, READ) for path in ('/etc/resolv.conf', '/etc/ssl/certs'))
    try:
        for path, access in paths:
            try:
                parent = os.open(path, os.O_PATH | os.O_CLOEXEC)
            except FileNotFoundError:
                if path in ('/usr/lib64', '/etc/localtime', '/etc/ld.so.cache'):
                    continue
                raise
            try:
                if not stat.S_ISDIR(os.fstat(parent).st_mode):
                    access &= REG_RIGHTS
                rule = PathRule(access, parent)
                checked(LIBC.syscall(445, fd, 1, c.byref(rule), 0), 'Landlock path rule')
            finally:
                os.close(parent)
        ports = ()
        if mode == 'install':
            ports = ((2, 443), (2, 53))                 # HTTPS registry and DNS TCP fallback
        elif mode == 'test':
            ports = [(1, 0)] + [(2, port) for port in local_ports]  # official fixtures listen(0)
        for access, port in ports:
            rule = PortRule(access, port)
            checked(LIBC.syscall(445, fd, 2, c.byref(rule), 0), 'Landlock TCP port rule')
        checked(LIBC.prctl(38, 1, 0, 0, 0), 'no_new_privs')
        checked(LIBC.syscall(446, fd, 0), 'Landlock enforce')
    finally:
        os.close(fd)
    return abi


def restrict_syscalls(mode):
    lib = c.CDLL('libseccomp.so.2', use_errno=True)
    lib.seccomp_init.argtypes = [c.c_uint32]
    lib.seccomp_init.restype = c.c_void_p
    lib.seccomp_load.argtypes = [c.c_void_p]
    lib.seccomp_release.argtypes = [c.c_void_p]
    lib.seccomp_syscall_resolve_name.argtypes = [c.c_char_p]
    lib.seccomp_rule_add_array.argtypes = [c.c_void_p, c.c_uint32, c.c_int, c.c_uint, c.POINTER(ArgTest)]
    ctx = lib.seccomp_init(0x7fff0000)
    if not ctx:
        raise RuntimeError('seccomp init')

    def deny(name, *conditions):
        nr = checked(lib.seccomp_syscall_resolve_name(name.encode()), f'syscall {name}')
        checked(lib.seccomp_rule_add_array(ctx, 0x00050000 | errno.EPERM, nr,
                                          len(conditions), (ArgTest * len(conditions))(*conditions)), name)

    try:
        for name in ('io_uring_setup', 'io_uring_enter', 'io_uring_register', 'ptrace',
                     'process_vm_readv', 'process_vm_writev', 'pidfd_getfd', 'bpf',
                     'add_key', 'request_key', 'keyctl', 'mount', 'setns', 'unshare'):
            deny(name)
        # Anonymous Unix socketpairs are needed by the runtime, but no external Unix sockets.
        deny('socketpair', ArgTest(0, 1, socket.AF_UNIX, 0))
        if mode not in ('install', 'test'):
            deny('socket')
        else:
            families = (socket.AF_INET,) if mode == 'test' else (socket.AF_INET, socket.AF_INET6)
            for family in range(46):
                if family not in families:
                    deny('socket', ArgTest(0, 4, family, 0))
            deny('socket', ArgTest(0, 5, 46, 0))
            for family in families:
                same_family = ArgTest(0, 4, family, 0)
                if mode == 'test':
                    # Only TCP (socket flags are not part of type); no DNS, UDP, raw sockets.
                    for sock_type in (2, 3, 4, 5, 6, 10):
                        deny('socket', same_family, ArgTest(1, 7, 15, sock_type))
                else:
                    for sock_type in (3, 4, 5, 6, 10):
                        deny('socket', same_family, ArgTest(1, 7, 15, sock_type))
        checked(lib.seccomp_load(ctx), 'seccomp enforce')
    finally:
        lib.seccomp_release(ctx)


def preflight(run, mode, abi):
    def denied(operation):
        try:
            operation()
        except PermissionError:
            return
        raise RuntimeError('Studio sandbox probe unexpectedly allowed an operation')

    def read(path):
        with path.open('rb') as source:
            return source.read(1)

    denied(lambda: read(ROOT / 'README.md'))
    denied(lambda: read(UPSTREAM / 'README.md'))
    denied(lambda: read(Path('/proc/self/environ')))
    denied(lambda: read(Path('/proc/self/fd/1')))
    denied(lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).close())
    with (run / 'tmp' / 'sandbox-probe').open('w') as witness:
        witness.write('ephemeral\n')
    if mode in ('offline', 'cache'):
        for family in (socket.AF_INET, socket.AF_INET6):
            denied(lambda: socket.socket(family, socket.SOCK_STREAM).close())
    elif mode == 'test':
        denied(lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).close())
        with socket.socket() as listener, socket.socket() as client:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            client.connect(listener.getsockname())
        with socket.socket() as client:
            # Guard against well-known destination ports; no service is queried.
            denied(lambda: client.connect(('127.0.0.1', 1)))
    print(f'Confinement admis (Landlock {abi} + seccomp, {mode}): home/proc Unix externes refusés.', flush=True)


def run_node(run, cache, node, npm, mode, args, log, *, edge=False, timeout=300):
    local_ports = ()
    if mode == 'test':
        low, high = map(int, Path('/proc/sys/net/ipv4/ip_local_port_range').read_text().split())
        if not 1024 <= low <= high <= 65535 or low <= 1933 <= high:
            raise RuntimeError('Unexpected ephemeral TCP port range')
        local_ports = range(low, high + 1)
    env = dict(PATH=f'{node.parent}:{SYSTEM_PATH}', HOME=str(run / 'home'),
               TMPDIR=str(run / 'tmp'), XDG_CONFIG_HOME=str(run / 'home' / 'config'),
               XDG_CACHE_HOME=str(run / 'home' / 'cache'), XDG_DATA_HOME=str(run / 'home' / 'data'),
               XDG_STATE_HOME=str(run / 'home' / 'state'), LANG='C.UTF-8', TZ='UTC', CI='1',
               OPENSSL_CONF='/dev/null',
               RAYON_NUM_THREADS='2', GOMAXPROCS='2',
               npm_config_userconfig=str(run / 'home' / 'user.npmrc'),
               npm_config_globalconfig=str(run / 'home' / 'global.npmrc'),
               npm_config_cache=str(cache if mode in ('install', 'cache') else run / 'npm-logs'),
               npm_config_registry='https://registry.npmjs.org/', npm_config_fetch_retries='1',
               npm_config_fetch_timeout='30000', npm_config_audit='false', npm_config_fund='false',
               npm_config_update_notifier='false', GIT_CONFIG_NOSYSTEM='1',
               GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
    if edge:
        env['VITE_STUDIO_EDGE'] = 'true'
    if mode == 'test':
        preload = run / 'loopback.so'
        if not preload.is_file() or preload.is_symlink():
            raise RuntimeError('Loopback preload was not prepared')
        env['LD_PRELOAD'] = str(preload)
    cmd = [str(node), *args]
    print(f'[{mode}] {" ".join(args)} → {log.relative_to(ROOT)}', flush=True)

    def sandbox_child():
        os.environ.clear()
        os.umask(0o077)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        abi = restrict_files_and_tcp(run, cache, node, npm, mode, local_ports)
        restrict_syscalls(mode)
        preflight(run, mode, abi)

    with log.open('w') as output:
        # Keep the original fork/exec boundary (Popen's exec-error FD would be
        # inherited by preflight). Give each bounded stage its own process group.
        pid = os.fork()
        if not pid:
            try:
                os.setpgid(0, 0)
                os.dup2(output.fileno(), 1)
                os.dup2(1, 2)
                with open('/dev/null', 'rb') as no_input:
                    os.dup2(no_input.fileno(), 0)
                os.closerange(3, resource.getrlimit(resource.RLIMIT_NOFILE)[0])
                os.chdir(run / 'web-studio')
                sandbox_child()
                os.execve(cmd[0], cmd, env)
            except BaseException as error:
                print(f'Studio sandbox refused: {error}', flush=True)
                os._exit(126)
        return wait_stage(pid, timeout, output)


def wait_stage(pid, timeout, output):
    import time

    def interrupted(signum, _frame):
        raise InterruptedError(signum)

    def stop_group():
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            # The child may not yet have entered its own group.
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.waitpid(pid, 0)

    previous = signal.signal(signal.SIGTERM, interrupted)
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited:
                return os.waitstatus_to_exitcode(status)
            time.sleep(0.1)
        # Record whether the launcher/children were still waiting, without any env or argv.
        output.write(f'\nStudio stage timeout ({timeout}s); process group stopped.\n')
        stop_group()
        return 124
    except (InterruptedError, KeyboardInterrupt):
        stop_group()
        raise
    finally:
        signal.signal(signal.SIGTERM, previous)


def run_npm(run, cache, node, npm, mode, args, log, **options):
    return run_node(run, cache, node, npm, mode, [str(npm), *args], log, **options)


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '-C', str(UPSTREAM), *args], env=GIT_ENV)


def archive_source(run):
    if git('rev-parse', 'HEAD').decode().strip() != REVISION:
        raise RuntimeError('upstream/ is not at the pinned SHA')
    blob = git('archive', '--format=tar', REVISION, 'web-studio')
    with tarfile.open(fileobj=io.BytesIO(blob)) as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if (path.parts[:1] != ('web-studio',) or '..' in path.parts
                    or not (member.isfile() or member.isdir())
                    or any(part in ('.env', '.npmrc', '.dev.vars', '.git')
                           or part.startswith(('.env.', '.dev.vars.')) for part in path.parts)):
                raise RuntimeError(f'Unexpected Studio archive entry: {member.name}')
        for member in archive.getmembers():
            target = run / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as data, target.open('xb') as output:
                    shutil.copyfileobj(data, output)


def archive_test_support(run):
    """Restore only the data inputs two original Studio suites import from the repo root."""
    entries = git('ls-tree', '-rz', REVISION, '--', *SUPPORT_SOURCES).split(b'\0')
    hashes = {}
    for entry in filter(None, entries):
        header, name = entry.decode('utf-8').split('\t', 1)
        mode, kind, blob = header.split()
        allowlisted = name in SUPPORT_SOURCES[2:] or bool(re.fullmatch(r'docs/(en|zh)/gateway/[\w.-]+\.md', name))
        if not (allowlisted and mode == '100644' and kind == 'blob' and re.fullmatch(r'[a-f0-9]{40}', blob)):
            raise RuntimeError(f'Unexpected Studio test support input: {name}')
        target = run / name
        data = git('cat-file', 'blob', blob)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as output:
            output.write(data)
        hashes[name] = hashlib.sha256(data).hexdigest()
    if len(hashes) != 31 or not set(SUPPORT_SOURCES[2:]) <= hashes.keys():
        raise RuntimeError('Incomplete pinned Studio test support inputs')
    return hashes


def check_lock(studio):
    lock = json.loads((studio / 'package-lock.json').read_text())
    if lock.get('lockfileVersion') != 3 or lock.get('name') != 'web-studio':
        raise RuntimeError('Unrecognized Studio lockfile')
    packages = lock['packages']
    for name, entry in packages.items():
        if not name:
            continue
        if (entry.get('inBundle') and entry.get('optional') and not entry.get('link')
                and not entry.get('resolved') and not entry.get('integrity')
                and name.startswith('node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/')
                and 'node_modules/@tailwindcss/oxide-wasm32-wasi' in packages):
            # These files ship inside the optional parent tarball, verified below.
            continue
        url = urlsplit(entry.get('resolved', ''))
        if (url.scheme != 'https' or url.netloc != 'registry.npmjs.org'
                or url.query or url.fragment or not url.path.endswith('.tgz')
                or not re.fullmatch(r'sha(?:512|384|256|1)-[A-Za-z0-9+/]+=*', entry.get('integrity', ''))
                or entry.get('link') or entry.get('inBundle')):
            raise RuntimeError(f'Unapproved source in npm lock: {name}')


def test_digests(studio):
    results = {}
    for directory, subdirs, names in os.walk(studio):
        subdirs[:] = sorted(d for d in subdirs if d not in ('node_modules', 'dist'))
        for name in sorted(names):
            if re.search(r'\.(test|spec)\.[^.]+$', name):
                path = Path(directory) / name
                if not stat.S_ISREG(path.lstat().st_mode):
                    raise RuntimeError(f'Not a regular test file: {path}')
                results[path.relative_to(studio).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return results


def compile_loopback(run):
    # Compile only this repository's small guard, never a dependency lifecycle script.
    subprocess.run(['/usr/bin/cc', '-Wall', '-Wextra', '-Werror', '-shared', '-fPIC', '-Wl,-z,now',
                    str(PATCHES / 'loopback.c'), '-o', str(run / 'loopback.so'), '-ldl'],
                   env=dict(PATH='/usr/bin:/bin', HOME=str(run / 'home'), TMPDIR=str(run / 'tmp')),
                   check=True)


def cohorts(inventory):
    groups = {'loopback': sorted(LOOPBACK_FIXTURES)}
    if not LOOPBACK_FIXTURES <= inventory.keys():
        raise RuntimeError('The pinned loopback inventory has changed')
    heavy = ('overview-page.test.tsx', 'upstreams-pages.test.tsx', 'server-configuration.test.tsx')
    for path in sorted(inventory.keys() - LOOPBACK_FIXTURES):
        if path.endswith(heavy):
            name = Path(path).name.split('.')[0]
        else:
            parts = path.split('/')
            name = '-'.join(parts[1:3]) if parts[1] == 'features' else parts[1] if parts[0] == 'src' else parts[0]
            if name == 'features-workbench':
                name += '-' + parts[3]
        groups.setdefault(name, []).append(path)
    return dict(sorted(groups.items()))


def report_summary(run, logs, name, status, files):
    source = run / 'vitest.json'
    if not source.exists():
        return {'exit': status, 'files': len(files), 'reported': 0, 'status': 'incomplete'}
    if not stat.S_ISREG(source.lstat().st_mode) or source.stat().st_size > 64 * 1024 * 1024:
        raise RuntimeError('Invalid Vitest report file')
    document = json.loads(source.read_text())
    source.rename(logs / f'{name}.json')
    studio = run / 'web-studio'
    results = {}
    for file in document['testResults']:
        path = Path(file['name']).relative_to(studio).as_posix()
        if path in results:
            raise RuntimeError(f'Duplicate Vitest report file: {path}')
        results[path] = dict(status=file['status'], tests=len(file['assertionResults']))
    missing = sorted(set(files) - results.keys())
    unexpected = sorted(results.keys() - set(files))
    return dict(exit=status, files=len(files), reported=len(results), missing=missing, unexpected=unexpected,
                status='incomplete' if missing or unexpected else 'passed' if status == 0 and document['success'] else 'failed',
                passed=document['numPassedTests'], failed=document['numFailedTests'], skipped=document['numPendingTests'],
                todo=document['numTodoTests'], results=results)


def test_cohorts(run, cache, node, npm, logs, args, original, support):
    studio = run / 'web-studio'
    groups = cohorts(original)
    groups.pop('loopback')  # Run and report offline cohorts before the TCP fixtures.
    groups['loopback'] = sorted(LOOPBACK_FIXTURES)
    (logs / 'inventory.json').write_text(json.dumps(dict(sha=REVISION, files=original, support=support, cohorts=groups), indent=2) + '\n')
    extras = {}
    if not args.upstream_only:
        extra_root = studio / EXTRA_TEST_ROOT
        extra_root.mkdir()
        for path in sorted(PATCHES.glob('edge-*.test.ts*')):
            shutil.copyfile(path, extra_root / path.name)
        extras = test_digests(studio).keys() - original.keys()
        groups['edge-regressions'] = sorted(extras)
    expected = test_digests(studio)
    if any(name not in groups for name in args.cohort):
        raise RuntimeError('Unknown cohort; see inventory.json (port also offers edge-regressions)')
    selected = {name: files for name, files in groups.items() if not args.cohort or name in args.cohort}
    if args.file:
        requested = set(args.file)
        if not requested <= set(path for files in selected.values() for path in files):
            raise RuntimeError('A requested file is not in the selected inventory')
        selected = {name: sorted(requested.intersection(files)) for name, files in selected.items()
                    if requested.intersection(files)}
    results = {}
    summary = logs / 'summary.json'
    for name, files in selected.items():
        started = time.monotonic()
        mode = 'test' if name == 'loopback' else 'offline'
        if mode == 'test':
            compile_loopback(run)
            # No traffic is sent: reject a non-loopback address before the syscall.
            probe = ['-e', "const n=require('node:net');const s=n.createServer();s.on('error',e=>{if(e.code!=='EPERM')process.exitCode=1});s.listen(0,'0.0.0.0',()=>{process.exitCode=1;s.close()})"]
            if run_node(run, cache, node, npm, mode, probe, logs / 'loopback-probe.log', timeout=15):
                raise RuntimeError('Loopback bind guard did not self-verify')
        status = run_npm(run, cache, node, npm, mode,
                         ['test', '--', f'--pool={args.pool}', f'--maxWorkers={args.workers}', '--minWorkers=1',
                          f'--testTimeout={args.test_timeout_ms}', '--reporter=default', '--reporter=json',
                          f'--outputFile.json={run / "vitest.json"}', *files],
                         logs / f'{name}.log', edge=name == 'edge-regressions' or args.edge_originals,
                         timeout=args.cohort_timeout)
        if test_digests(studio) != expected:
            raise RuntimeError('Test sources changed during execution')
        if any(not stat.S_ISREG((run / name).lstat().st_mode) or hashlib.sha256((run / name).read_bytes()).hexdigest() != digest
               for name, digest in support.items()):
            raise RuntimeError('Test support sources changed during execution')
        result = report_summary(run, logs, name, status, files)
        result['seconds'] = round(time.monotonic() - started, 3)
        results[name] = result
        print(f'{name}: {result["status"]} ({result["reported"]}/{result["files"]} fichiers), exit {status}', flush=True)
        summary.write_text(json.dumps(dict(upstream_only=args.upstream_only, edge_originals=args.edge_originals,
                                            selected=list(selected), results=results,
                                            runner=dict(strategy='sequential', pool=args.pool, workers=args.workers,
                                                        cohort_timeout_seconds=args.cohort_timeout,
                                                        test_timeout_ms=args.test_timeout_ms)), indent=2) + '\n')
    return int(any(result['status'] != 'passed' for result in results.values()))


def adapt_tinypool(studio):
    # The pool only needs V8 heap usage. Node's process.memoryUsage() also
    # attempts to read /proc/self/stat, which this sandbox intentionally denies.
    # In both pool entrypoints that throws again in catch, before the reply.
    root = studio / 'node_modules/tinypool'
    package = json.loads((root / 'package.json').read_text())
    locked = json.loads((studio / 'package-lock.json').read_text())['packages']['node_modules/tinypool']
    if package['version'] != locked['version']:
        raise RuntimeError('Tinypool version differs from the pinned lock')
    old = 'const memoryUsage = process.memoryUsage.bind(process);'
    for name in ('worker.js', 'process.js'):
        entry = root / 'dist' / 'entry' / name
        text = entry.read_text()
        if text.count(old) != 1 or text.count('memoryUsage().heapUsed') != 2:
            raise RuntimeError(f'Unexpected Tinypool transport: {name}')
        entry.write_text("import { getHeapStatistics } from 'node:v8';\n" +
                         text.replace(old, '').replace('memoryUsage().heapUsed', 'getHeapStatistics().used_heap_size'))


def apply_patches(studio):
    for patch in sorted(PATCHES.glob('*.patch')):
        cmd = ['/usr/bin/git', 'apply', '--recount', '--whitespace=error', str(patch)]
        subprocess.run([*cmd[:2], '--check', *cmd[2:]], cwd=studio, env=GIT_ENV, check=True)
        subprocess.run(cmd, cwd=studio, env=GIT_ENV, check=True)


def stage_assets(studio, logs):
    # The runner is not confined, so only promote regular files after checking the bundle.
    source = studio / 'dist'
    if source.is_symlink() or not source.is_dir():
        raise RuntimeError('Studio build did not produce dist/')
    files = []
    for path in sorted(source.rglob('*')):
        mode = path.lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)) or path.name.startswith('.'):
            raise RuntimeError(f'Unexpected Studio artifact: {path.relative_to(source)}')
        if stat.S_ISREG(mode):
            if path.stat().st_size > 25 * 1024 * 1024:
                raise RuntimeError(f'Asset exceeds 25 MiB: {path.relative_to(source)}')
            if re.search(r'\.map(?:\.(?:gz|br))?$', path.name, re.I):
                raise RuntimeError(f'Public sourcemap refused: {path.relative_to(source)}')
            if path.suffix in ('.js', '.mjs', '.css', '.html') and re.search(
                rb'(?m)^[ \t]*//[#@]\s*sourceMappingURL\s*=|/\*[#@]\s*sourceMappingURL\s*=',
                path.read_bytes(),
            ):
                raise RuntimeError(f'Public sourcemap directive refused: {path.relative_to(source)}')
            files.append(path)
    html = (source / 'index.html').read_text()
    entry = re.findall(r'<script\s+type="module"[^>]*\bsrc="([^"]+)"', html)
    if (len(entry) != 1 or not entry[0].startswith('/studio/assets/')
            or '<div id="app"></div>' not in html or 'OpenViking Studio' not in html):
        raise RuntimeError('Unexpected Studio entrypoint')
    for url in re.findall(r'\b(?:src|href)="([^"]+)"', html):
        if not url.startswith('/studio/') or (source / url.removeprefix('/studio/')) not in files:
            raise RuntimeError(f'Static Studio URL is not local and packaged: {url}')
    (logs / 'assets.sha256').write_text(''.join(
        f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(source)}\n' for path in files))
    destination = logs / 'dist'
    if destination.exists() or destination.is_symlink():
        raise RuntimeError('The staging destination already exists')
    shutil.move(str(source), str(destination))
    print(f'{len(files)} fichiers Studio → {destination.relative_to(ROOT)}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('build', 'test'))
    parser.add_argument('--offline', action='store_true', help='Use the Studio-only npm cache, with no network during npm ci')
    parser.add_argument('--upstream-only', action='store_true', help='For test only: run the pristine upstream source, without local patches')
    parser.add_argument('--stage', action='store_true', help='Retain assets under this run’s logs (default for every build)')
    parser.add_argument('--node', type=Path, help='Explicit Node binary (upstream CI uses Node 22)')
    parser.add_argument('--pool', choices=('threads', 'forks'), default='threads', help='Vitest execution pool')
    parser.add_argument('--cohort', action='append', default=[], help='Select a named cohort; repeat to select more (default all)')
    parser.add_argument('--file', action='append', default=[], help='Replay an exact pinned test file (repeatable; does not count as a complete cohort)')
    parser.add_argument('--edge-originals', action='store_true', help='Run the original assertions with the Edge-specific feature flag')
    parser.add_argument('--cohort-timeout', type=int, default=300, choices=range(30, 601), metavar='30..600')
    stages = parser.add_mutually_exclusive_group()
    stages.add_argument('--bundle-only', action='store_true', help='Only Vite; does not qualify npm prebuild')
    stages.add_argument('--prebuild-only', action='store_true', help='Only the upstream lint and i18n prebuild')
    parser.add_argument('--workers', default=2, type=int, choices=range(1, 5), help='Vitest worker count')
    parser.add_argument('--test-timeout-ms', type=int, choices=(5000, 10000, 20000, 30000), default=20000,
                        help='Vitest runner deadline per test (not interaction/expectation deadlines)')
    args = parser.parse_args()
    if args.action == 'build' and args.upstream_only:
        parser.error('--upstream-only is for test only')
    if (args.action != 'test' and (args.cohort or args.file or args.edge_originals)) or (args.upstream_only and args.edge_originals):
        parser.error('invalid test-only flags')
    if args.action != 'build' and (args.bundle_only or args.prebuild_only or args.stage):
        parser.error('stage flags are for build only')
    if sys.platform != 'linux' or platform.machine() != 'x86_64':
        parser.error('this runner requires Linux x86-64 and Landlock ABI 6+')
    local_node = WORK / 'toolchain/bin/node'
    node = (args.node or (local_node if local_node.exists() else Path(shutil.which('node', path=SYSTEM_PATH) or '/nonexistent'))).resolve(strict=True)
    if node.name != 'node':
        parser.error('--node must name the Node executable')
    npm = Path(shutil.which('npm', path=SYSTEM_PATH) or '/nonexistent').resolve(strict=True)
    if npm.name != 'npm-cli.js' or npm.parent.name != 'bin':
        parser.error('a system npm CLI is required (npm → npm/bin/npm-cli.js)')
    for path in (WORK.parent, WORK, WORK / 'npm-cache', WORK / 'logs'):
        if path.is_symlink():
            parser.error(f'not a real directory: {path}')
        path.mkdir(mode=0o700, exist_ok=True)
    cache = WORK / 'npm-cache'
    with tempfile.TemporaryDirectory(prefix=f'{args.action}-', dir=WORK) as work_path:
        run = Path(work_path)
        logs = WORK / 'logs' / run.name
        logs.mkdir(mode=0o700)
        print(f'Logs : {logs.relative_to(ROOT)}', flush=True)
        (run / 'home').mkdir()
        (run / 'tmp').mkdir()
        archive_source(run)
        support = archive_test_support(run) if args.action == 'test' else {}
        studio = run / 'web-studio'
        check_lock(studio)
        original = test_digests(studio)
        (logs / 'source.sha256').write_text(''.join(
            f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n'
            for path in sorted(PATCHES.glob('*.patch')) if not args.upstream_only))
        if not args.upstream_only:
            apply_patches(studio)
        if test_digests(studio) != original:
            raise RuntimeError('Official test sources changed')
        print(f'{len(original)} fichiers de tests amont, empreintes inchangées.', flush=True)
        version_log = logs / 'node.log'
        if run_node(run, cache, node, npm, 'offline', ['--version'], version_log, timeout=15) or not re.search(r'^v22\.', version_log.read_text(), re.M):
            raise RuntimeError('Node 22 is required (use --node)')
        rc = run_npm(run, cache, node, npm, 'cache' if args.offline else 'install',
                     ['ci', '--ignore-scripts', '--no-audit', '--no-fund',
                      '--offline' if args.offline else '--prefer-offline'], logs / 'install.log')
        if rc:
            raise SystemExit(rc)
        if not args.bundle_only:
            adapt_tinypool(studio)
        if args.action == 'test':
            raise SystemExit(test_cohorts(run, cache, node, npm, logs, args, original, support))
        else:
            # npm invokes the original prebuild (lint + test:i18n) before Vite.
            command = (['run', 'prebuild'] if args.prebuild_only else
                       [*(['--ignore-scripts'] if args.bundle_only else []), 'run', 'build', '--', '--base=/studio/'])
            rc = run_npm(run, cache, node, npm, 'offline', command,
                         logs / 'build.log', edge=True, timeout=480)
        if test_digests(studio) != original:
            raise RuntimeError('Official test sources changed during execution')
        if rc:
            raise SystemExit(rc)
        if args.action == 'build' and not args.prebuild_only:
            stage_assets(studio, logs)


if __name__ == '__main__':
    main()
