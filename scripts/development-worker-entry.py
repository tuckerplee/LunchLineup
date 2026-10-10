#!/usr/bin/env python3
"""Fixed non-root worker entry. FD3 control, FD4 immutable entry, one nonce arg.

No key, daemon socket, Docker group, arbitrary command/path or network context.
Only registered guardian supplies immutable FDs in the initial context packet.
"""
import array
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import struct
import sys
import time
import types

MAX = 1048576


def require(value, why):
    if not value:
        raise RuntimeError(why)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def parse(data):
    require(0 < len(data) <= MAX, 'worker message bound')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate worker field')
            result[key] = value
        return result
    def invalid(_):
        raise RuntimeError('noninteger worker number')
    value = json.loads(data, object_pairs_hook=unique, parse_float=invalid, parse_constant=invalid)
    require(type(value) is dict and canonical(value) == data, 'canonical worker object required')
    return value


def main():
    require(os.geteuid() != 0 and len(sys.argv) == 2 and re.fullmatch('[a-f0-9]{64}', sys.argv[1]), 'fixed non-root worker entry')
    nonce = sys.argv[1]
    parent = os.getppid()
    require(Path('/proc', str(parent), 'cgroup').read_text() == '0::/system.slice/lunchlineup-development-guardian.service\n', 'worker parent is not fixed guardian')
    endpoint = socket.socket(fileno=3)
    require(endpoint.family == socket.AF_UNIX and endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_SEQPACKET and
            struct.unpack('3i', endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)) == (parent, 0, 0), 'worker guardian endpoint provenance')
    endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
    endpoint.settimeout(5)
    sequence = 0
    received = []
    def send(kind, body):
        nonlocal sequence
        data = canonical({'sequence': sequence, 'workerNonce': nonce, 'type': kind, 'body': body})
        require(len(data) <= MAX and endpoint.send(data, socket.MSG_NOSIGNAL) == len(data), 'worker short send')
        sequence += 1
    def take(expected_fds=0):
        data, ancillary, flags, _ = endpoint.recvmsg(MAX + 1, socket.CMSG_SPACE(12) + socket.CMSG_SPACE(256 * 4), socket.MSG_CMSG_CLOEXEC)
        fds = []; creds = []; invalid = False
        try:
            for level, kind, payload in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    values = array.array('i')
                    values.frombytes(payload[:len(payload) - len(payload) % values.itemsize])
                    fds.extend(values)
                    invalid |= bool(len(payload) % values.itemsize)
                elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(payload) == 12:
                    creds.append(struct.unpack('3i', payload))
                else:
                    invalid = True
            require(data and not invalid and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) and creds == [(parent, 0, 0)], 'worker response identity')
            # -1 is only the initial transfer, capped before adoption.
            require((0 < len(fds) <= 68) if expected_fds == -1 else len(fds) == expected_fds, 'unexpected worker rights')
            return parse(data), fds
        except BaseException:
            for fd in fds:
                try:
                    os.close(fd)
                except OSError:
                    pass
            raise
    try:
        send('HELLO', {'guardianPid': parent})
        initial, received = take(-1)
        require(set(initial) == {'type', 'context', 'inputRoles', 'guardianPid', 'guardianLockFd'} and
                initial['type'] == 'CONTEXT' and initial['guardianPid'] == parent, 'worker context shape')
        context = initial['context']; roles = initial['inputRoles']
        require(type(roles) is list and roles == sorted(set(roles)) and len(received) == 1 + len(roles) and
                context['workerNonce'] == nonce and context['role'] in ('archive-preflight', 'image-inventory') and
                set(roles) == set(context['inputTable']) and 'protocol' in roles and 'helper' in roles, 'worker role/nonce/context')
        fds = dict(zip(roles, received[1:]))
        context_sha = hashlib.sha256(canonical(context)).hexdigest()
        send('FD_ACK', {'contextSha256': context_sha, 'lockFd': received[0], 'inputFds': fds})
        admitted, _ = take()
        require(admitted == {'type': 'ENTER', 'workerNonce': nonce, 'contextSha256': context_sha}, 'guardian did not prove registered OFDs')
        deadline_text = context['originalDeadlineNs']
        require(type(deadline_text) is str and re.fullmatch('[1-9][0-9]{0,18}', deadline_text), 'worker original deadline')
        original_deadline = int(deadline_text)
        require(time.monotonic_ns() < original_deadline <= 2**63 - 1, 'expired worker original deadline')
        def module_from(role):
            fd = fds[role]; pin = context['inputTable'][role]
            require(type(pin['bytes']) is int and 0 < pin['bytes'] <= MAX, 'worker code bound')
            os.lseek(fd, 0, os.SEEK_SET)
            source = os.read(fd, MAX + 1)
            os.lseek(fd, 0, os.SEEK_SET)
            require(len(source) == pin['bytes'] and hashlib.sha256(source).hexdigest() == pin['sha256'], 'immutable worker code differs')
            result = types.ModuleType('installed_worker_' + role)
            exec(compile(source, '<immutable-' + role + '>', 'exec'), result.__dict__)
            return result
        p = module_from('protocol')
        helper = module_from('helper')
        p.closed(context, ['role', 'workerNonce', 'requestSha256', 'selectionSha256', 'grantId', 'managerEpoch',
                           'guardianSessionId', 'originalDeadlineNs', 'inputTable', 'operation'])
        def current_lease():
            require(time.monotonic_ns() < original_deadline, 'worker original deadline elapsed')
            send('LEASE_CHECK', {})
            reply, _ = take()
            p.closed(reply, ['type', 'workerNonce', 'expiryNs'])
            require(reply['type'] == 'LEASE' and reply['workerNonce'] == nonce, 'worker lease identity')
            expiry = min(original_deadline, p.local_nanoseconds(reply['expiryNs']))
            require(time.monotonic_ns() < expiry, 'worker lease expired')
            return expiry
        current_lease()
        if context['role'] == 'archive-preflight':
            table = {role: dict(context['inputTable'][role], fd=fd) for role, fd in fds.items() if role != 'protocol'}
            result = helper.bundle_preflight_fds(table, context['operation']['policy'])
        else:
            # The helper is adapted to the fixed guardian broker transport;
            # this entry never invokes Docker or receives a daemon descriptor.
            class Lease:
                def assert_current(self, _binding):
                    current_lease()
                def record_readonly_diagnostic(self, summary):
                    require(len(canonical(summary)) <= 16384, 'private diagnostic bound')
                    send('DIAGNOSTIC', summary)
                def finish_readonly_inventory(self):
                    pass
            class Gate:
                def acquire_readonly_inventory(self, _binding):
                    current_lease()
                    return Lease()
            class Broker:
                def read(self, args):
                    current_lease()
                    send('BROKER_READ', {'args': args})
                    header, _ = take()
                    while header.get('type') == 'BROKER_WAIT':
                        p.closed(header, ['type', 'workerNonce', 'expiryNs'])
                        require(header['workerNonce'] == nonce and time.monotonic_ns() < min(original_deadline, p.local_nanoseconds(header['expiryNs'])), 'broker progress identity/deadline')
                        header, _ = take()
                    p.closed(header, ['type', 'workerNonce', 'stdoutBytes', 'stderrBytes', 'stderrPrefixHex', 'returncode', 'stdoutSha256', 'chunks'])
                    require(header['type'] == 'BROKER_BEGIN' and header['workerNonce'] == nonce, 'broker response identity')
                    p.integer(header['stdoutBytes'], 0, MAX - 1); p.integer(header['stderrBytes'], 0, MAX)
                    p.integer(header['chunks'], 0, 32); p.sha(header['stdoutSha256'])
                    output = bytearray()
                    for index in range(header['chunks']):
                        part, _ = take()
                        p.closed(part, ['type', 'workerNonce', 'index', 'base64'])
                        require(part['type'] == 'BROKER_CHUNK' and part['workerNonce'] == nonce and type(part['index']) is int and part['index'] == index and type(part['base64']) is str and len(part['base64']) <= 43692, 'broker chunk identity/bound')
                        output.extend(base64.b64decode(part['base64'], validate=True))
                        require(len(output) <= MAX, 'broker accumulated output bound')
                    require(len(output) == header['stdoutBytes'] and hashlib.sha256(output).hexdigest() == header['stdoutSha256'], 'broker output hash/size')
                    current_lease()
                    return dict(header, stdout=bytes(output))
            result = helper.owner_gated_inventory(context['operation']['preflight'], context['operation']['binding'], Gate(), read_backend=Broker())
        current_lease()
        send('RESULT', result)
        receipt, _ = take()
        require(receipt == {'type': 'RESULT_ACK', 'workerNonce': nonce, 'resultSha256': hashlib.sha256(canonical(result)).hexdigest()}, 'result not durably acknowledged')
    finally:
        for fd in received:
            try:
                os.close(fd)
            except OSError:
                pass
        endpoint.close()


if __name__ == '__main__':
    main()
