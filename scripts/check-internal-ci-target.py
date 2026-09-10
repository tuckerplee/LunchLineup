#!/usr/bin/env python3
"""Validate and record controller-owned disposable QA targets before mutations."""
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tomllib

# The candidate build clone must remain clean after guard imports.
sys.dont_write_bytecode = True


def output(command):
    return subprocess.check_output(command, text=True).strip()


def validate_volumes(configuration, project):
    names = []
    for key, volume in configuration.get('volumes', {}).items():
        name = volume.get('name', f'{project}_{key}')
        if volume.get('external') or not name.startswith(project + '_'):
            raise ValueError('qualification volumes must be private and project-prefixed')
        names.append(name)
    if f'{project}_postgres_data' not in names:
        raise ValueError('qualification PostgreSQL volume is missing')
    return sorted(names)


def require_ports_free(ports):
    sockets = []
    try:
        for port in ports:
            listener = socket.socket()
            sockets.append(listener)
            listener.bind(('127.0.0.1', port))
    finally:
        for listener in sockets:
            listener.close()


def main():
    mode = sys.argv[1]
    spec = importlib.util.spec_from_file_location('storage', Path(__file__).with_name('check-internal-ci-storage.py'))
    storage = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(storage)
    workspace, temporary = storage.validate_context(os.environ, socket.gethostname(), Path.cwd())
    for path in (workspace, temporary, Path(os.environ['RUNNER_TEMP'])):
        if path.resolve() != path:
            raise ValueError('QA paths must not contain symlinks')
    run_id = os.environ['CI_RUN_ID']
    sha = os.environ['CI_COMMIT_SHA']
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('exact candidate SHA required')
    artifact = workspace / '.release/internal-ci' / sha
    artifact.mkdir(parents=True, exist_ok=True)
    receipt = dict(runId=run_id, sourceSha=sha, workspace=str(workspace),
                   temporaryRoot=os.environ['RUNNER_TEMP'], mutationRole='lunchlineup_ci_app',
                   dataTargetEnvironment='disposable')
    if mode == 'integration':
        store = Path(os.environ['RUNNER_TEMP']) / f'lunchlineup-integration-containers-{run_id}'
        if store.exists() or store.is_symlink():
            raise ValueError('refusing pre-existing integration store')
        prefix = 'lunchlineup-integration-' + re.sub('[^a-zA-Z0-9]', '', run_id)
        receipt.update(database='lunchlineup_test', store=str(store),
                       containers=[prefix + '-' + name for name in ('postgres', 'redis', 'rabbitmq')])
    elif mode in ('fullstack', 'stack-start'):
        project = 'lunchlineup-beta-' + re.sub('[^a-z0-9]', '', run_id.lower())
        configuration = tomllib.loads(Path(os.environ['CONTAINERS_STORAGE_CONF']).read_text())['storage']
        store = temporary / 'containers/graphroot'
        if (configuration.get('graphroot') != str(store)
                or configuration.get('runroot') != str(temporary / 'containers/runroot')
                or store.resolve() != store):
            raise ValueError('qualification store escaped the controller run')
        if 'podman' not in output(['docker', '--version']).lower():
            raise ValueError('qualification requires the controller private Podman adapter')
        info = json.loads(output(['docker', 'info', '--format', 'json']))
        if info['store']['graphRoot'] != str(store):
            raise ValueError('active container store differs from admitted store')
        config = json.loads((artifact / 'compose-config.json').read_text())
        volumes = validate_volumes(config, project)
        for resource in ('container', 'volume', 'network'):
            # Labels catch generated names; prefixes catch unlabelled name collisions.
            args = ['docker', 'ps', '-a'] if resource == 'container' else ['docker', resource, 'ls']
            rows = json.loads(output([*args, '--format', 'json']))
            for row in rows:
                if project in json.dumps(row):
                    raise ValueError(f'refusing pre-existing qualification {resource}')
        https_port = 18443 if os.environ.get('LUNCHLINEUP_DEVELOPMENT_QA') == '1' else 8443
        require_ports_free((8080, 4000, https_port))
        receipt.update(database='lunchlineup_ci', store=str(store), project=project,
                       volumes=volumes, httpsPort=https_port, browserEndpoint='http://127.0.0.1:8080',
                       runtimeEnvironment=str(Path(os.environ['RUNNER_TEMP']) / f'lunchlineup-beta-qualification-{run_id}/runtime.env'))
        if mode == 'stack-start':
            prior = json.loads((artifact / 'fullstack-target.json').read_text())
            if prior != receipt:
                raise ValueError('qualification target changed after image preparation')
            return
    else:
        raise ValueError('unsupported QA target')
    with (artifact / f'{mode}-target.json').open('x') as handle:
        json.dump(receipt, handle, indent=2)
        handle.write('\n')


if __name__ == '__main__':
    main()
