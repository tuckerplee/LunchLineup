#!/usr/bin/env python3
"""Fixed guardian child: existing bootstrap, serialized loop, no key arguments.

The service pins this entry at FD4 and confines it under the independently
installed supervisor AppArmor profile before execution. No public CLI mode.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import sys
import types


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise RuntimeError('fixed confined supervisor entry only')
    if Path('/proc/self/attr/current').read_text().strip() != 'lunchlineup-development-supervisor (enforce)':
        raise RuntimeError('supervisor profile is not enforcing')
    # Fixed bootstrap is pinned independently in the root-controlled public
    # bootstrap anchor. No guardian-private anchor/key path is readable here.
    anchor_path = Path('/etc/lunchlineup/trust/development-bootstrap.json')
    for part in [anchor_path, *anchor_path.parents]:
        info = part.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or part.resolve(strict=True) != part:
            raise RuntimeError('supervisor public anchor custody')
    fd = os.open(anchor_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        raw = os.read(fd, 1048577)
    finally:
        os.close(fd)
    if len(raw) > 1048576:
        raise RuntimeError('supervisor anchor bound')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise RuntimeError('duplicate public anchor key')
            result[key] = value
        return result
    anchor = json.loads(raw, object_pairs_hook=unique)
    # Entry itself is trusted/pinned; bootstrap has a fixed role in the same
    # installation receipt, not a request-selected module or candidate source.
    pin = anchor['bootstrapEntry']
    if pin['path'] != '/usr/local/libexec/lunchlineup/development-admission-bootstrap.py':
        raise RuntimeError('wrong fixed bootstrap entry')
    import fcntl
    import stat
    import struct
    path = Path(pin['path'])
    for part in [path, *path.parents]:
        info = part.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or part.resolve(strict=True) != part:
            raise RuntimeError('bootstrap entry custody')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        measure = bytearray(struct.pack('HH', 0, 64) + bytes(64))
        fcntl.ioctl(fd, 0xC0046686, measure, True)
        source = os.read(fd, 1048577)
        if not stat.S_ISREG(os.fstat(fd).st_mode) or len(source) > 1048576 or len(source) != pin['bytes'] or hashlib.sha256(source).hexdigest() != pin['sha256'] or struct.unpack('HH', measure[:4]) != (1, 32) or measure[4:36].hex() != pin['veritySha256']:
            raise RuntimeError('bootstrap entry pin differs')
    finally:
        os.close(fd)
    bootstrap = types.ModuleType('fixed_development_bootstrap')
    exec(compile(source, '<fixed-bootstrap>', 'exec'), bootstrap.__dict__)
    request_fd, request, _ = bootstrap.pin(anchor['inputs']['approvedRequest'])
    os.close(request_fd)
    control = bootstrap.bootstrap(request)
    control.start()
    # No arbitrary operation argument; source only admits the fixed read-only
    # sequence after live guardian/Manager custody. Mutation stays refused.
    stage = 'WAIT_BOUND'
    while not control.fenced:
        control.tick()
        if stage == 'WAIT_BOUND' and control.lease.state == 'BOUND':
            if anchor['workflow'] == 'no-execution':
                control.terminal(); stage = 'WAIT_RELEASE'
            elif anchor['workflow'] == 'readonly-workers':
                control.start_preflight(); stage = 'WAIT_PREFLIGHT'
            else:
                raise RuntimeError('unapproved fixed workflow')
        elif stage == 'WAIT_PREFLIGHT' and control.preflight_result is not None:
            control.start_inventory(); stage = 'WAIT_INVENTORY'
        elif stage == 'WAIT_INVENTORY' and control.inventory_result is not None:
            # Distinct host156 read-only worker terminal, never no-execution.
            control.finish_readonly_observation()
            stage = 'WAIT_RETIREMENT'
        select.select([], [], [], 0.02)


if __name__ == '__main__':
    main()
