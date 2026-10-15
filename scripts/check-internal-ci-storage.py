#!/usr/bin/env python3
"""Admission check before source cloning/dependencies/image pulls on VM218."""
import json
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
    require_capacity(free)
    print(json.dumps({'storage_admission': 'passed', 'free_bytes': free,
                      'working_limit_bytes': 32 * GIB, 'free_floor_bytes': 20 * GIB}))


if __name__ == '__main__':
    main()
