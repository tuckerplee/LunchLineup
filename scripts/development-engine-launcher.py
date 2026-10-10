#!/usr/bin/env python3
"""One-shot pinned native engine exec after actual custodian authorization.

Fixed PID1 role only. No shell, caller executable/config, inherited engine-client
FD, old service stop, environment override, daemon retry or admission fallback.
"""
import os
from pathlib import Path
import select
import socket
import struct
import sys
import time
import types

MAX = 1048576
ROOT = '/run/lunchlineup/engine-custody'


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 2 and sys.argv[1] in ('daemon', 'containerd'), 'fixed native engine launcher only')
    role = sys.argv[1]
    os.lseek(5, 0, os.SEEK_SET); source = os.read(5, MAX + 1)
    require(0 < len(source) <= MAX, 'inherited native installation bound')
    installation = types.ModuleType('native_launcher_installation')
    exec(compile(source, '<native-installation>', 'exec'), installation.__dict__)
    authority = installation.anchor()
    common_fd = installation.pin(authority['roles']['common'])
    common = installation.load_module('common', common_fd)
    settings = common.Settings(installation, authority); p = settings.p
    deadline = min(settings.deadline, time.monotonic_ns() + 500_000_000)
    require(time.monotonic_ns() < deadline, 'native launcher original budget exhausted')
    for number, entry in [(4, 'launcher'), (5, 'installation')]:
        actual, held = os.fstat(number), os.fstat(settings.fds[entry])
        require((actual.st_dev, actual.st_ino) == (held.st_dev, held.st_ino), 'launcher immutable entry/library differs')
    own = common.pinned_process(os.getpid(), common.starttime(os.getpid()), settings.fds['interpreter'],
        common.PROFILES['launcher'], '/system.slice/' + common.UNITS[role])
    settings.unit(role, deadline, os.getpid())
    common.private_directory(ROOT); raw = common.private_directory(ROOT + '/raw')
    endpoint = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET); endpoint.settimeout(0.5)
    endpoint.connect(ROOT + '/control.sock')
    pid, uid, gid = struct.unpack('3i', endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    require((uid, gid) == (0, 0) and pid > 1 and endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERSEC, 4096).rstrip(b'\0').decode() ==
            common.PROFILES['native'] + ' (enforce)', 'launcher native owner credentials/profile')
    start = common.starttime(pid)
    native = common.pinned_process(pid, start, settings.fds['interpreter'], common.PROFILES['native'],
                                   '/system.slice/' + common.UNITS['native'])
    actual, held = Path('/proc', str(pid), 'fd/4').stat(), os.fstat(settings.fds['custodian'])
    require((actual.st_dev, actual.st_ino) == (held.st_dev, held.st_ino) and
            native['networkNamespaceInode'] == own['networkNamespaceInode'] != str(Path('/proc/1/ns/net').stat().st_ino),
            'launcher native entry/fresh namespace differs')
    settings.unit('native', deadline, pid)
    peer = p.CredentialPeer(endpoint, pid, 0, 0, start, '/system.slice/' + common.UNITS['native'], authority['roles']['interpreter']['sha256'])
    nonce = os.urandom(32).hex()
    request = {'sequence': 0, 'op': 'AUTHORIZE_LAUNCH', 'nonce': nonce,
               'body': {'role': role, 'nativePolicySha256': authority['policy']['sha256']}}
    data = p.canonical(request)
    require(endpoint.send(data, socket.MSG_NOSIGNAL) == len(data), 'launcher authorization short send')
    left = deadline - time.monotonic_ns()
    require(left > 0 and select.select([endpoint], [], [], left / 1e9)[0], 'launcher authorization timeout')
    wire = peer.receive(); require(wire is not None, 'launcher authorization reply missing')
    reply = p.parse(wire); p.closed(reply, ['sequence', 'op', 'nonce', 'body'])
    require(reply['sequence'] == 0 and type(reply['sequence']) is int and reply['op'] == request['op'] and reply['nonce'] == nonce,
            'launcher authorization reply differs')
    body = reply['body']
    p.closed(body, ['role', 'pid', 'starttime', 'generation', 'guestBootId', 'requestSha256', 'nativePolicySha256',
        'deadlineNs', 'argv', 'configSha256', 'executableSha256', 'nativePid', 'nativeStarttime', 'rawDirectory',
        'inheritedClientDescriptorsAllowed', 'launchRecordSha256'])
    p.sha(body['generation']); p.sha(body['launchRecordSha256'])
    require(body == dict(body, role=role, pid=os.getpid(), starttime=own['starttime'], guestBootId=settings.policy['bootId'],
        requestSha256=settings.policy['requestSha256'], nativePolicySha256=authority['policy']['sha256'],
        deadlineNs=str(settings.deadline), argv=settings.engine_argv(role), configSha256=settings.policy['configs'][role]['sha256'],
        executableSha256=authority['roles'][role]['sha256'], nativePid=pid, nativeStarttime=start,
        rawDirectory=raw, inheritedClientDescriptorsAllowed=False), 'launcher admitted role/birth/config differs')
    peer.assert_identity()
    require(time.monotonic_ns() < deadline, 'launcher response/check exceeded original budget')
    with open('/proc/self/attr/exec', 'w') as profile:
        profile.write('exec ' + common.PROFILES[role])
    executable = settings.fds[role]
    # Independent starter had only fixed installed descriptors. Close everything
    # now, including control socket and library FD4/5, before actual engine exec.
    # FD for the immutable executable is CLOEXEC and is consumed by this exec.
    os.set_inheritable(executable, False)
    descriptors = [int(path.name) for path in Path('/proc/self/fd').iterdir()]
    require(len(descriptors) <= 256, 'launcher inherited descriptor bound')
    for number in descriptors:
        if number > 2 and number != executable:
            try:
                os.close(number)
            except OSError as error:
                import errno
                require(error.errno == errno.EBADF, 'launcher failed descriptor closure')
    require(time.monotonic_ns() < deadline, 'launcher descriptor closure exceeded original budget')
    os.execve('/proc/self/fd/' + str(executable), body['argv'], {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})


if __name__ == '__main__':
    main()
