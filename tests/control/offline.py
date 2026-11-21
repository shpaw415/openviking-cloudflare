# SPDX-License-Identifier: AGPL-3.0-only
"""Run the Control test commands with no inherited credentials or IP sockets (Linux)."""

import ctypes as c
import errno
import os
import socket
import sys


class Arg(c.Structure):
    _fields_ = [('index', c.c_uint), ('op', c.c_int), ('a', c.c_uint64), ('b', c.c_uint64)]


lib = c.CDLL('libseccomp.so.2')
lib.seccomp_init.argtypes = [c.c_uint32]
lib.seccomp_init.restype = c.c_void_p
lib.seccomp_rule_add_array.argtypes = [c.c_void_p, c.c_uint32, c.c_int, c.c_uint, c.POINTER(Arg)]
lib.seccomp_syscall_resolve_name.argtypes = [c.c_char_p]
lib.seccomp_load.argtypes = [c.c_void_p]
ctx = lib.seccomp_init(0x7fff0000)  # default allow; restrict only the networking admission
if not ctx:
    raise RuntimeError('seccomp is unavailable')
socket_call = lib.seccomp_syscall_resolve_name(b'socket')
if socket_call < 0:
    raise RuntimeError('Cannot locate socket syscall')
families = (socket.AF_INET, socket.AF_INET6, socket.AF_PACKET)
for family in families:
    if lib.seccomp_rule_add_array(ctx, 0x00050000 | errno.EPERM, socket_call, 1,
                                 c.byref(Arg(0, 4, family, 0))) != 0:
        raise RuntimeError('Cannot deny IP socket syscall')
# Do not let asynchronous IO submit socket operations outside the syscall filter.
for name in (b'io_uring_setup', b'io_uring_enter', b'io_uring_register', b'socketcall'):
    call = lib.seccomp_syscall_resolve_name(name)
    if call >= 0 and lib.seccomp_rule_add_array(ctx, 0x00050000 | errno.EPERM, call, 0, None) != 0:
        raise RuntimeError('Cannot deny alternate socket submission')
if lib.seccomp_load(ctx) != 0:
    raise RuntimeError('Cannot load network filter')
for family in families:
    try:
        socket.socket(family, socket.SOCK_DGRAM).close()
    except PermissionError:
        pass
    else:
        raise RuntimeError('IP socket denial not enforced')
with socket.socket(socket.AF_UNIX):
    pass
os.execvpe(sys.argv[1], sys.argv[1:], {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/nonexistent'})
