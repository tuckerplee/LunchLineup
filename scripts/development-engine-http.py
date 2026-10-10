#!/usr/bin/env python3
"""Bounded single-loop native read proxy and private Docker plugin transport.

Owner supplies actual peer/custody checks, registry and WAL. No threads, generic
forwarding, tunnel, gRPC, caller-selected upstream or mutating HTTP methods.
"""
import errno
import hashlib
import json
import os
import re
import select
import socket
import time

MAX = 1048576
HEADER = 16384


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def parse_head(data):
    index = data.find(b'\r\n\r\n')
    if index < 0:
        require(len(data) <= HEADER, 'HTTP header bound')
        return None
    require(index <= HEADER, 'HTTP header bound')
    lines = data[:index].split(b'\r\n')
    first = lines[0].decode('ascii')
    fields = {}
    require(len(lines) <= 65, 'HTTP header count')
    for line in lines[1:]:
        name, sep, value = line.partition(b':')
        require(sep and re.fullmatch(b'[A-Za-z0-9-]{1,128}', name), 'HTTP header syntax')
        key = name.decode().lower()
        require(key not in fields and not re.search(b'[\x00-\x08\x0a-\x1f\x7f]', value), 'duplicate/folded/control HTTP header')
        fields[key] = value.strip(b' \t').decode('ascii')
    return first, fields, index + 4


def response_body(data, eof, head_only):
    header = parse_head(data)
    if header is None:
        require(not eof, 'partial response header')
        return None
    first, fields, offset = header
    require(re.fullmatch(r'HTTP/1\.[01] 200 [\x20-\x7e]{1,64}', first) and
            'upgrade' not in fields and 'trailer' not in fields, 'response status/upgrade/trailer refused')
    body = data[offset:]
    if head_only:
        require(not body, 'HEAD wire response has body')
        return fields, b''
    require(not ('content-length' in fields and 'transfer-encoding' in fields), 'ambiguous response framing')
    if 'content-length' in fields:
        value = fields['content-length']
        require(re.fullmatch(r'(?:0|[1-9][0-9]{0,6})', value), 'response content-length grammar')
        count = int(value)
        require(count < MAX and len(body) <= count, 'response content-length bound/excess')
        if len(body) != count:
            require(not eof, 'truncated content-length response')
            return None
        return fields, bytes(body)
    if 'transfer-encoding' in fields:
        require(fields['transfer-encoding'].lower() == 'chunked', 'unsupported transfer encoding')
        result = bytearray(); cursor = 0; chunks = 0
        while True:
            end = body.find(b'\r\n', cursor)
            if end < 0:
                require(not eof and len(body) - cursor <= 16, 'truncated chunk size')
                return None
            size = body[cursor:end]
            require(re.fullmatch(b'[0-9A-Fa-f]{1,6}', size), 'chunk extensions/size unsupported')
            count = int(size, 16); chunks += 1
            require(chunks <= 4096 and len(result) + count < MAX, 'chunk count/body bound')
            cursor = end + 2
            if len(body) < cursor + count + 2:
                require(not eof, 'truncated chunk body')
                return None
            require(body[cursor + count:cursor + count + 2] == b'\r\n', 'chunk delimiter/trailer invalid')
            result.extend(body[cursor:cursor + count]); cursor += count + 2
            if count == 0:
                require(cursor == len(body), 'response trailers/extra wire bytes refused')
                return fields, bytes(result)
    # HTTP/1.0 close framing is bounded and accepted only after actual EOF.
    require(len(body) < MAX, 'close-framed response bound')
    if not eof:
        return None
    return fields, bytes(body)


class PluginConnection:
    def __init__(self, owner, endpoint):
        self.owner, self.endpoint = owner, endpoint
        self.owner.assert_daemon_peer(endpoint)
        endpoint.setblocking(False)
        self.input = bytearray(); self.output = None
        self.deadline = min(owner.deadline, time.monotonic_ns() + 2_000_000_000)
        self.closed = False; self.activation = False
        owner.plugin_inflight += 1

    def sockets(self):
        return ([self.endpoint], []) if self.output is None else ([], [self.endpoint])

    def poll(self, readable, writable):
        require(time.monotonic_ns() < self.deadline, 'plugin original connection deadline')
        self.owner.assert_daemon_peer(self.endpoint)
        if self.output is None and self.endpoint in readable:
            block = self.endpoint.recv(65536)
            require(block, 'plugin request EOF')
            self.input.extend(block)
            require(len(self.input) <= 2 * MAX + HEADER, 'plugin request bound')
            parsed = parse_head(self.input)
            if parsed is None:
                return
            first, fields, offset = parsed
            require(first in ('POST /Plugin.Activate HTTP/1.1', 'POST /AuthZPlugin.AuthZReq HTTP/1.1',
                              'POST /AuthZPlugin.AuthZRes HTTP/1.1') and
                    'transfer-encoding' not in fields and 'upgrade' not in fields and
                    re.fullmatch(r'(?:0|[1-9][0-9]{0,6})', fields.get('content-length', '')), 'plugin request framing/route')
            count = int(fields['content-length'])
            require(count <= 2 * MAX and len(self.input) <= offset + count, 'plugin pipelining/size refused')
            if len(self.input) < offset + count:
                return
            path = first.split()[1]
            value = self.owner.decode_plugin(bytes(self.input[offset:])) if count else {}
            if path == '/Plugin.Activate':
                require(value == {}, 'plugin activation body')
                result = {'Implements': ['authz']}
                self.activation = True
            elif path == '/AuthZPlugin.AuthZReq':
                result = self.owner.authorizer.authorize_request(value)
            else:
                result = self.owner.authorizer.authorize_response(value)
            data = self.owner.p.canonical(result)
            self.output = memoryview(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ' +
                                     str(len(data)).encode() + b'\r\n\r\n' + data)
        if self.output is not None and self.endpoint in writable:
            count = self.endpoint.send(self.output)
            require(count > 0, 'plugin response short send')
            self.output = self.output[count:]
            if not self.output:
                if self.activation:
                    self.owner.activation_delivered()
                self.close()

    def close(self):
        if not self.closed:
            self.endpoint.close(); self.closed = True
            self.owner.plugin_inflight -= 1


class ProxyConnection:
    def __init__(self, owner, endpoint):
        self.owner, self.client = owner, endpoint
        self.client_identity = owner.assert_client_peer(endpoint)
        endpoint.setblocking(False)
        self.backend = None
        self.input = bytearray(); self.response = bytearray()
        self.upstream = self.output = None
        self.proxy_id = None; self.method = None
        self.closed = False
        self.deadline = min(owner.deadline, time.monotonic_ns() + 2_000_000_000)
        self.stage = 'REQUEST'
        owner.proxy_inflight += 1

    def sockets(self):
        if self.stage == 'REQUEST':
            return [self.client], []
        if self.stage in ('CONNECT', 'FORWARD'):
            return [], [self.backend]
        if self.stage == 'RESPONSE':
            return [self.backend], []
        if self.stage == 'DELIVER':
            return [], [self.client]
        return [], []

    def poll(self, readable, writable):
        require(time.monotonic_ns() < self.deadline, 'proxy original request deadline')
        self.owner.assert_client_peer(self.client, self.client_identity)
        if self.stage == 'REQUEST' and self.client in readable:
            block = self.client.recv(65536)
            require(block, 'client request EOF')
            self.input.extend(block)
            parsed = parse_head(self.input)
            if parsed is None:
                return
            first, fields, offset = parsed
            pieces = first.split(' ')
            require(len(pieces) == 3 and pieces[2] == 'HTTP/1.1' and len(self.input) == offset and
                    fields.get('content-length', '0') == '0' and 'transfer-encoding' not in fields and
                    'upgrade' not in fields and 'expect' not in fields, 'finite request only; no body/pipeline/upgrade')
            self.method, uri = pieces[:2]
            target = self.owner.authz_module.request_target(self.method, uri)
            token = fields.get(self.owner.authz_module.TOKEN_HEADER.lower(), '')
            # Owner binds actual fixed client, registration, exact command token,
            # current daemon incarnation and original command deadline.
            registration = self.owner.open_proxy_request(self.client_identity, token, self.method, uri, target)
            self.proxy_id = registration['proxyId']
            self.deadline = min(self.deadline, registration['deadlineNs'])
            self.backend = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.backend.setblocking(False)
            code = self.backend.connect_ex(self.owner.raw_docker_socket)
            require(code in (0, errno.EINPROGRESS, errno.EAGAIN), 'fixed raw daemon connection failed')
            self.upstream = memoryview((self.method + ' ' + uri + ' HTTP/1.1\r\nHost: docker\r\nConnection: close\r\nContent-Length: 0\r\n' +
                self.owner.authz_module.TOKEN_HEADER + ': ' + token + '\r\nX-Lunchlineup-Proxy-Request: ' +
                self.proxy_id + '\r\n\r\n').encode('ascii'))
            self.stage = 'CONNECT'
        if self.stage == 'CONNECT' and self.backend in writable:
            require(self.backend.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0, 'raw daemon connect error')
            self.owner.assert_daemon_peer(self.backend)
            self.stage = 'FORWARD'
        if self.stage == 'FORWARD' and self.backend in writable:
            count = self.backend.send(self.upstream)
            require(count > 0, 'raw daemon request short send')
            self.upstream = self.upstream[count:]
            if not self.upstream:
                self.stage = 'RESPONSE'
        if self.stage == 'RESPONSE' and self.backend in readable:
            self.owner.assert_daemon_peer(self.backend)
            block = self.backend.recv(65536)
            self.response.extend(block)
            require(len(self.response) <= 2 * MAX + HEADER, 'raw response wire bound')
            complete = response_body(self.response, not block, self.method == 'HEAD')
            if complete is None:
                return
            fields, body = complete
            # Complete actual wire must match the independently observed AuthZ
            # RETURNED callback. A partial callback, missing hook, lost response
            # or unpaired request poisons the original custody, never guesses.
            self.owner.verify_proxy_response(self.proxy_id, fields, body, self.method == 'HEAD')
            self.backend.close(); self.backend = None
            forwarded = {'content-type': fields.get('content-type', 'text/plain'),
                         'content-length': str(len(body)), 'connection': 'close'}
            for key in ('api-version', 'docker-experimental', 'ostype', 'builder-version'):
                if key in fields:
                    forwarded[key] = fields[key]
            data = b'HTTP/1.1 200 OK\r\n' + b''.join(key.encode() + b': ' + value.encode() + b'\r\n'
                    for key, value in forwarded.items()) + b'\r\n' + body
            self.output = memoryview(data); self.stage = 'DELIVER'
        if self.stage == 'DELIVER' and self.client in writable:
            count = self.client.send(self.output)
            require(count > 0, 'proxy client response short send')
            self.output = self.output[count:]
            if not self.output:
                self.owner.proxy_delivered(self.proxy_id)
                self.close()

    def close(self):
        if not self.closed:
            self.client.close()
            if self.backend is not None:
                self.backend.close()
            self.closed = True
            self.owner.proxy_inflight -= 1


if __name__ == '__main__':
    raise SystemExit('Native finite HTTP transports require the fixed custodian.')
