#!/usr/bin/env python3
"""Admission check before source cloning/dependencies/image pulls on VM218."""
import json
import stat
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tomllib
import time

GIB = 1024 ** 3


def validate_context(environment, hostname, cwd):
    if hostname != 'custom-ci' or environment.get('CI_REPOSITORY') != 'lunchlineup':
        raise ValueError('LunchLineup builds are restricted to the controlled CI appliance')
    run_id = environment.get('CI_RUN_ID', '')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,159}', run_id):
        raise ValueError('invalid CI run identity')
    root = Path('/var/lib/custom-ci')
    workspace = root / 'workspaces' / run_id
    temporary = root / 'runs' / run_id / 'tmp'
    expected = {'CI_WORKSPACE': workspace, 'RUNNER_TEMP': temporary / 'job-tmp',
                'CONTAINERS_STORAGE_CONF': temporary / 'step-inputs/container-storage.conf'}
    if str(cwd) != str(workspace) or any(environment.get(k) != str(v) for k, v in expected.items()):
        raise ValueError('build paths must be the exact disposable CI job paths')
    if environment.get('DOCKER_HOST') or environment.get('CONTAINER_HOST'):
        raise ValueError('a shared or remote container daemon is forbidden')
    return workspace, temporary


def require_capacity(free_bytes):
    # Reserve the entire 32 GiB working budget plus the 20 GiB early-stop floor.
    if free_bytes < 52 * GIB:
        raise ValueError('build admission requires 52 GiB free; prune expired artifacts before retrying')


def require_backing_capacity(budget, now):
    if (budget.get('version') != 1 or budget.get('vmid') != 218
            or budget.get('project_id') != 218 or budget.get('dataset') != 'data/zd0'
            or not 0 <= now - budget['observed_at_epoch'] <= 90):
        raise ValueError('fresh verified backing-storage measurement is required')
    if min(budget['quota_bytes'] - budget['used_bytes'], budget['dataset_available_bytes']) < 36 * GIB:
        raise ValueError('backing quota needs 36 GiB headroom: 32 GiB build plus 4 GiB reserve')
    if budget['dataset_available_bytes'] < 52 * GIB:
        raise ValueError('parent storage needs 52 GiB available: 32 GiB work plus 20 GiB margin')
    if budget['pool_free_bytes'] < 60 * GIB:
        raise ValueError('shared pool is below the 60 GiB safety floor')


# A finite job has a distinct capacity ceiling; this is not backing reservation.
FINITE_IMAGE_BYTES = 32 * GIB - 1024 ** 2
FINITE_INITIAL_FREE_BYTES = 29 * GIB


def read_finite_attestation(path):
    """Only the fixed root-owned run metadata path, never an env-selected file."""
    for parent in reversed(path.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('finite attestation parent must be protected by the owner')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        first = os.fstat(fd)
        if (not stat.S_ISREG(first.st_mode) or first.st_uid != 0 or first.st_nlink != 1
                or stat.S_IMODE(first.st_mode) != 0o444 or not 0 < first.st_size <= 8192):
            raise ValueError('finite attestation must be an immutable owner record')
        body = os.read(fd, 8193)
        last = os.fstat(fd)
        final = path.lstat()
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        if len(body) != first.st_size or any(getattr(first, k) != getattr(last, k) or
                getattr(first, k) != getattr(final, k) for k in fields):
            raise ValueError('finite attestation changed during read')
        def unique(pairs):
            obj = {}
            for key, value in pairs:
                if key in obj: raise ValueError('duplicate finite attestation key')
                obj[key] = value
            return obj
        return json.loads(body, object_pairs_hook=unique)
    finally:
        os.close(fd)


def finite_observation(workspace, temporary):
    result = {}
    for name, path in [('workspace', workspace), ('temporary', temporary)]:
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or path.resolve(strict=True) != path:
            raise ValueError('finite job path changed')
        usage = shutil.disk_usage(path)
        result[name] = dict(path=str(path), device=info.st_dev, inode=info.st_ino,
                            total=usage.total, free=usage.free)
    if not os.path.ismount(workspace) or not os.path.ismount(temporary.parent):
        raise ValueError('finite canonical job mounts are absent')
    return result


def require_finite_capacity(attestation, run_id, source_sha, observation):
    fields = {'version', 'kind', 'runId', 'sourceSha', 'imageBytes', 'filesystemBytes',
              'minimumFreeBytes', 'allocationImageIdentity', 'workspace', 'temporary',
              'backingReservation'}
    if (type(attestation) is not dict or set(attestation) != fields or
            attestation['version'] != 1 or attestation['kind'] != 'fixed-browser-job-filesystem' or
            attestation['runId'] != run_id or attestation['sourceSha'] != source_sha or
            not re.fullmatch('[a-f0-9]{40}', source_sha or '') or
            attestation['imageBytes'] != FINITE_IMAGE_BYTES or
            attestation['minimumFreeBytes'] != FINITE_INITIAL_FREE_BYTES or
            attestation['backingReservation'] != 'none-sparse-image' or
            type(attestation['filesystemBytes']) is not int or
            not FINITE_INITIAL_FREE_BYTES <= attestation['filesystemBytes'] <= FINITE_IMAGE_BYTES):
        raise ValueError('finite capacity attestation is not the fixed owner contract')
    image = attestation['allocationImageIdentity']
    if (type(image) is not list or len(image) != 2 or
            any(type(v) is not int or v <= 0 for v in image)):
        raise ValueError('finite image identity missing')
    expected_paths = {'workspace': f'/var/lib/custom-ci/workspaces/{run_id}',
                      'temporary': f'/var/lib/custom-ci/runs/{run_id}/tmp'}
    if set(observation) != set(expected_paths): raise ValueError('finite observation roster changed')
    devices = set()
    for name, expected in expected_paths.items():
        identity = attestation[name]
        actual = observation[name]
        if (type(identity) is not dict or set(identity) != {'path', 'device', 'inode'} or
                identity['path'] != expected or type(identity['device']) is not int or
                type(identity['inode']) is not int or min(identity['device'], identity['inode']) <= 0 or
                any(actual.get(k) != identity[k] for k in identity) or
                type(actual.get('total')) is not int or actual['total'] != attestation['filesystemBytes'] or
                type(actual.get('free')) is not int or
                not FINITE_INITIAL_FREE_BYTES <= actual['free'] <= actual['total']):
            raise ValueError('finite filesystem identity or usable capacity changed')
        devices.add(identity['device'])
    if len(devices) != 1: raise ValueError('job paths do not share the finite filesystem')


def main():
    workspace, temporary = validate_context(os.environ, socket.gethostname(), Path.cwd())
    budget_path = Path('/etc/lunchlineup-maintenance/builder-budget.json')
    for path in (budget_path, *budget_path.parents):
        info = path.lstat()
        if path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('backing measurement must be root-owned and read-only to jobs')
    require_backing_capacity(json.loads(budget_path.read_text()), time.time())
    for path in (workspace, temporary, Path(os.environ['CONTAINERS_STORAGE_CONF'])):
        if path.resolve() != path:
            raise ValueError('CI paths must not contain symlinks')
    configuration = tomllib.loads(Path(os.environ['CONTAINERS_STORAGE_CONF']).read_text())['storage']
    if (configuration.get('graphroot') != str(temporary / 'containers/graphroot')
            or configuration.get('runroot') != str(temporary / 'containers/runroot')):
        raise ValueError('container layers must use the disposable job-private store')
    for service in ('lunchlineup-ci-retention', 'lunchlineup-ci-storage-guard'):
        subprocess.run(['systemctl', 'is-active', '--quiet', service + '.timer'], check=True)
        result = subprocess.check_output(['systemctl', 'show', '--value', '-p', 'Result', service + '.service'], text=True).strip()
        if result != 'success':
            raise ValueError(f'{service} has not completed successfully')
    free = min(shutil.disk_usage(workspace).free, shutil.disk_usage(temporary).free)
    # Absence preserves the original generic52GiB contract. A malformed present
    # record is a refusal, never a fallback or caller-controlled opt-in.
    attestation_path = temporary.parent / 'browser-filesystem.json'
    finite_attestation = None
    if attestation_path.exists() or attestation_path.is_symlink():
        finite_attestation = read_finite_attestation(attestation_path)
        require_finite_capacity(finite_attestation, os.environ['CI_RUN_ID'],
                                os.environ.get('CI_COMMIT_SHA', ''), finite_observation(workspace, temporary))
    else:
        require_capacity(free)
    receipt = {'storage_admission': 'passed', 'free_bytes': free,
               'working_limit_bytes': 32 * GIB, 'free_floor_bytes': 20 * GIB}
    if finite_attestation is not None:
        receipt.update(capacityMode='finite-job', free_floor_bytes=FINITE_INITIAL_FREE_BYTES,
                       finiteMinimumFreeBytes=FINITE_INITIAL_FREE_BYTES,
                       finiteFilesystemBytes=finite_attestation['filesystemBytes'],
                       finiteImageCeilingBytes=FINITE_IMAGE_BYTES,
                       backingReservation='none-sparse-image',
                       backingQuotaHeadroomMinimumBytes=36 * GIB,
                       backingParentAvailableMinimumBytes=52 * GIB,
                       backingPoolFreeMinimumBytes=60 * GIB,
                       backingEarlyStopMarginBytes=20 * GIB)
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
