#!/usr/bin/env python3
"""Fixed native finalizer: preserve evidence and report unresolved ownership.

PID1 handles only fixed owned-unit termination. No engine API, process kill,
WAL append, fence retirement, admission, cleanup, automatic retry or key access.
"""
import os
import sys


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise RuntimeError('fixed native finalizer only')
    # Deliberately no clean/success assertion. The separately pinned recovery
    # entry must reconcile full original history and actual current dead owners.
    data = b'{"authorityRestored":false,"automaticRetryAllowed":false,"fenceClearAuthorized":false,"requiresSeparateOwnerRecovery":true}\n'
    if os.write(1, data) != len(data):
        raise RuntimeError('native finalizer observation short write')


if __name__ == '__main__':
    main()
