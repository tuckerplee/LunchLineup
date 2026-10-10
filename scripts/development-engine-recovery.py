#!/usr/bin/env python3
"""Fixed dead-guardian read-only recovery observation. No authority restoration."""
import os
import sys
import time
import types

MAX = 1048576


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 1, 'fixed read-only recovery entry only')
    os.lseek(5, 0, os.SEEK_SET); source = os.read(5, MAX + 1)
    require(0 < len(source) <= MAX, 'inherited recovery installation bound')
    installation = types.ModuleType('native_recovery_installation')
    exec(compile(source, '<native-recovery-installation>', 'exec'), installation.__dict__)
    authority = installation.anchor()
    fd = installation.pin(authority['roles']['common']); common = installation.load_module('common', fd)
    settings = common.Settings(installation, authority)
    for number, role in [(4, 'recovery'), (5, 'installation')]:
        left, right = os.fstat(number), os.fstat(settings.fds[role])
        require((left.st_dev, left.st_ino) == (right.st_dev, right.st_ino), 'recovery immutable entry/library differs')
    common.pinned_process(os.getpid(), common.starttime(os.getpid()), settings.fds['interpreter'],
                         common.PROFILES['recovery'], '/system.slice/' + common.UNITS['recovery'])
    unit = settings.unit('recovery', time.monotonic_ns() + 500_000_000, os.getpid())
    require(unit['ExecMainStartTimestampMonotonic'].isdigit(), 'recovery original PID1 start unavailable')
    original_end = int(unit['ExecMainStartTimestampMonotonic']) * 1000 + 20_000_000_000
    guardian_installation = installation.load_module('guardianInstallation', settings.fds['guardianInstallation'])
    guardian_authority = guardian_installation.anchor()  # Metadata only, not its Manager key contents.
    require(guardian_authority['roles']['recoveryHistory'] == authority['roles']['guardianRecoveryHistory'],
            'independent guardian/native recovery library pins differ')
    recovery = installation.load_module('guardianRecoveryHistory', settings.fds['guardianRecoveryHistory'])
    native_module = installation.load_module('reader', settings.fds['reader'])
    reader = native_module.Reader(installation, authority)
    try:
        result = recovery.observe(settings.p, guardian_installation, guardian_authority, reader)
    except recovery.RecoveryQueryUnsettled as error:
        # Retain the exact owned read-only Popen, never retry or emit a result.
        # PID1's independently verified original20s unit deadline is the final
        # containment boundary for this recovery unit and its own query only.
        while error.query_child.poll() is None:
            time.sleep(0.025 if time.monotonic_ns() < original_end else 0.1)
        raise
    require(time.monotonic_ns() < original_end, 'recovery completed after original PID1 deadline')
    settings.p.closed(result, ['version', 'guardianSessionId', 'localSessionId', 'requestNonce', 'requestSha256',
        'guestBootId', 'terminalSha256', 'ackSha256', 'hostClearedEnvelopeSha256', 'retirementNonce',
        'guestFencePresent', 'guestFenceSha256', 'guestRetirementStage', 'guestRetirementRecordSha256',
        'protectedHistorySha256', 'authorityRestored', 'fenceClearAuthorized', 'automaticRetryAllowed', 'requiresSeparateOwnerRecovery'])
    require(type(result['version']) is int and result['version'] == 1 and result['authorityRestored'] is False and
            result['fenceClearAuthorized'] is False and result['automaticRetryAllowed'] is False and
            result['requiresSeparateOwnerRecovery'] is True, 'recovery library returned authority or unsupported version')
    data = settings.p.canonical(result) + b'\n'
    require(len(data) <= 16384 and os.write(1, data) == len(data), 'recovery observation output bound/short write')


if __name__ == '__main__':
    main()
