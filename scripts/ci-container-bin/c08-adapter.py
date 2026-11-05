#!/usr/bin/env python3
"""Closed C08 operations inside the existing authenticated owner/store only."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import selectors
import tempfile
import time
import sys


def require(value, reason):
    if not value:
        raise ValueError(reason)


def run_plan(args, images, project, build):
    """Pure translation; never accept caller networks, labels, stores or mounts."""
    require(args and args[0] == 'run', 'not a container run')
    rest = list(args[1:]); options = []; alias = None; detached = False; publish = False
    while rest and rest[0] not in images.values():
        flag = rest.pop(0)
        if flag == '--rm':
            continue  # Adapter owns explicit ID cleanup after attached completion.
        if flag == '--detach':
            detached = True; continue
        require(flag in ('--name', '--env', '-e', '-v', '--entrypoint', '--workdir', '--publish'), 'unsupported C08 run option')
        require(rest, 'missing C08 option value'); value = rest.pop(0)
        if flag == '--name':
            require(alias is None and re.fullmatch(r'lunchlineup-(legacy-credit|staff-invitation)-[0-9]+-[a-f0-9-]{36}', value), 'unexpected PG alias')
            alias = value
        elif flag in ('--env', '-e'):
            require(value in ('POSTGRES_PASSWORD=disposable-test-only', 'POSTGRES_DB=legacy_credit_cleanup_test',
                              'POSTGRES_DB=staff_invitation_migration_test'), 'unexpected C08 env')
            options += ['--env', value]
        elif flag == '-v':
            parts = value.split(':')
            require(len(parts) == 3 and parts[2] == 'ro', 'C08 mounts must be read-only')
            source = Path(parts[0]); root = Path(build)
            require(source.is_absolute() and source.resolve(strict=True).is_relative_to(root.resolve(strict=True)), 'C08 mount escaped source')
            require(parts[1].startswith(('/etc/', '/run/secrets/')), 'unexpected mount destination')
            options += ['-v', value]
        elif flag == '--publish':
            require(value == '127.0.0.1::5432' and not publish, 'unexpected PG publication')
            publish = True
        else:
            require(value in ('/usr/bin/caddy', '/bin/promtool', '/etc/estate/tests'), 'unexpected validator entry/workdir')
            options += [flag, value]
    require(rest, 'missing pinned C08 image')
    image = rest.pop(0); key = next(key for key, value in images.items() if value == image)
    name = project + '-' + key
    if key == 'postgres':
        require(detached and alias and not rest, 'unexpected PG invocation')
        require(publish == alias.startswith('lunchlineup-legacy-credit-'), 'PG publication/alias mismatch')
        options += ['--network', project + '_c08', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,size=1g,mode=0700']
        if publish:
            options += ['--publish', '127.0.0.1:54329:5432']
    else:
        require(not detached and alias is None and not publish and rest, 'unexpected validator invocation')
        options += ['--network=none']
    return {'key': key, 'name': name, 'alias': alias, 'detached': detached,
            'argv': ['create', '--pull=never', '--image-volume=ignore', '--name', name,
                     '--label', 'com.docker.compose.project=' + project,
                     '--label', 'com.docker.compose.service=' + key,
                     '--group-add', 'keep-groups', '--memory=1g', '--pids-limit=128', '--cpus=1.5',
                     *options, image, *rest]}


class Adapter:
    def __init__(self, phase):
        self.phase = phase
        self.runtime = Path(phase['runtimeDirectory'])
        self.project = 'lunchlineup-beta-' + re.sub('[^a-z0-9]', '', phase['runId'].lower())
        self.selection = json.loads(Path(phase['selectionPath']).read_text())
        self.images = self.selection['images']
        require(set(self.images) == {'caddy', 'prometheus', 'postgres'}, 'C08 image roster changed')
        self.store = self.runtime / 'c08-containers.json'
        self.state = json.loads(self.store.read_text()) if self.store.exists() else {}
        self.adapter = str(Path(__file__).with_name('podman'))

    def podman(self, args, *, capture=True, timeout=40):
        return subprocess.run([self.adapter, *args], capture_output=capture, text=True, timeout=timeout)

    def capture_start_command(self, args, timeout):
        """Finite diagnostic capture; no new process-group or network authority."""
        command = [self.adapter, *args]
        output = {'stdout': bytearray(), 'stderr': bytearray()}
        issue = None
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic() + timeout
        selector = None
        try:
            selector = selectors.DefaultSelector()
            for key, pipe in (('stdout', process.stdout), ('stderr', process.stderr)):
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, key)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    issue = subprocess.TimeoutExpired(command, timeout)
                    break
                for event, _ in selector.select(min(remaining, 0.1)):
                    chunk = os.read(event.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(event.fileobj)
                        continue
                    target = output[event.data]
                    available = 1048576 - len(target)
                    target.extend(chunk[:available])
                    if len(chunk) > available:
                        issue = ValueError('C08 diagnostic capture exceeded 1 MiB per stream; output incomplete')
                        break
                if issue is not None:
                    break
            if issue is None:
                try:
                    process.wait(timeout=max(0.001, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    issue = subprocess.TimeoutExpired(command, timeout)
        except Exception as capture_error:
            if issue is None:
                issue = capture_error
        finally:
            # Preserve a known timeout/capture error through cleanup failures.
            for action in (lambda: selector.close() if selector is not None else None,
                           lambda: process.kill() if process.poll() is None else None,
                           process.wait, process.stdout.close, process.stderr.close):
                try:
                    action()
                except Exception as cleanup_error:
                    if issue is None:
                        issue = cleanup_error
        return {'command': command, 'returncode': process.returncode,
                'stdout': bytes(output['stdout']), 'stderr': bytes(output['stderr']),
                'error': issue, 'timeoutSeconds': timeout}

    def retain_start_failure(self, entry, start):
        # Caller keeps the original failure even if any diagnostic operation fails.
        destination = Path(os.environ['LUNCHLINEUP_OBSERVABILITY_DIAGNOSTICS_DIR'])
        require(destination.is_dir() and not destination.is_symlink(), 'C08 diagnostic directory unavailable')
        directory = Path(tempfile.mkdtemp(prefix='container-start-', dir=destination))
        records = []
        for label, observation in [('start', start), ('inspect', None), ('logs', None)]:
            if observation is None:
                try:
                    observation = self.capture_start_command([label, entry['id']], 3)
                except Exception as error:
                    records.append({'operation': label, 'captureError': repr(error)})
                    continue
            for stream in ('stdout', 'stderr'):
                with (directory / (label + '.' + stream + '.log')).open('xb') as target:
                    target.write(observation[stream])
            records.append({'operation': label, 'command': observation['command'],
                            'returncode': observation['returncode'],
                            'timeoutSeconds': observation['timeoutSeconds'],
                            'captureError': repr(observation['error']) if observation['error'] else None,
                            'stdoutBytes': len(observation['stdout']), 'stderrBytes': len(observation['stderr']),
                            'captureComplete': observation['error'] is None})
            with (directory / (label + '.json')).open('x') as target:
                json.dump(records[-1], target, sort_keys=True)
        with (directory / 'result.json').open('x') as target:
            json.dump({'runId': self.phase['runId'], 'ownedEntry': entry,
                       'maxBytesPerStream': 1048576, 'observations': records}, target, sort_keys=True)
        self.report_start_diagnostic('C08 container start diagnostics: ' + str(directory))

    @staticmethod
    def report_start_diagnostic(message):
        try:
            print(message, file=sys.stderr)
        except Exception:
            pass  # Reporting must never replace an already known start failure.

    def start_detached(self, entry):
        observation = self.capture_start_command(['--log-level=debug', 'start', entry['id']], 40)
        if observation['error'] is not None or observation['returncode'] != 0:
            try:
                self.retain_start_failure(entry, observation)
            except Exception as diagnostic_error:
                self.report_start_diagnostic('C08 start diagnostic retention failed: ' + repr(diagnostic_error))
        for stream, target in (('stdout', sys.stdout), ('stderr', sys.stderr)):
            try:
                target.buffer.write(observation[stream]); target.buffer.flush()
            except Exception as replay_error:
                self.report_start_diagnostic('C08 start output replay failed: ' + repr(replay_error))
                if observation['error'] is None and observation['returncode'] == 0:
                    raise  # Preserve output failure on an otherwise successful start.
        if observation['error'] is not None:
            raise observation['error']
        return observation['returncode']

    def save(self):
        temporary = self.store.with_suffix('.pending')
        temporary.write_text(json.dumps(self.state, sort_keys=True))
        temporary.replace(self.store)

    def inspect(self, entry):
        result = self.podman(['inspect', entry['id']])
        require(result.returncode == 0, 'owned C08 container disappeared before operation')
        rows = json.loads(result.stdout); require(len(rows) == 1, 'ambiguous C08 inspect')
        row = rows[0]; labels = row.get('Config', {}).get('Labels') or {}
        image = self.podman(['image', 'inspect', self.images[entry['key']]])
        require(image.returncode == 0, 'C08 pinned image unavailable')
        image_rows = json.loads(image.stdout)
        require(len(image_rows) == 1, 'ambiguous C08 image')
        require(row.get('Id') == entry['id'] and row.get('Name', '').lstrip('/') == entry['name'] and
                str(row.get('Image', '')).removeprefix('sha256:') == str(image_rows[0].get('Id', '')).removeprefix('sha256:') and
                labels.get('com.docker.compose.project') == self.project and
                labels.get('com.docker.compose.service') == entry['key'], 'C08 resource identity changed')
        return row

    def remove(self, entry):
        self.inspect(entry)
        result = self.podman(['rm', '--force', entry['id']])
        require(result.returncode == 0, 'C08 owned removal failed')
        require(self.podman(['container', 'exists', entry['id']]).returncode == 1, 'C08 container survived removal')
        entry['removed'] = True; self.save()

    def dispatch(self, args):
        if self.phase['phase'] == 'acquisition':
            require(len(args) == 2 and args[0] == 'pull' and args[1] in self.images.values(), 'C08 acquisition only pulls fixed images')
            return self.podman(args, capture=False, timeout=110).returncode
        require(self.phase['phase'] == 'runtime', 'C08 requires runtime phase')
        if args == ['c08-network-create']:
            name = self.project + '_c08'
            require(self.podman(['network', 'exists', name]).returncode == 1, 'C08 network slot occupied')
            result = self.podman(['network', 'create', '--driver', 'bridge', '--internal', '--ipv6=false',
                                 '--opt', 'isolate=true', '--label', 'com.docker.compose.project=' + self.project,
                                 '--label', 'io.podman.compose.project=' + self.project, name])
            require(result.returncode == 0, 'C08 network create failed'); return 0
        if args == ['c08-cleanup']:
            for entry in self.state.values():
                if not entry.get('removed'):
                    self.remove(entry)
            name = self.project + '_c08'
            rows = json.loads(self.podman(['network', 'inspect', name]).stdout)
            require(len(rows) == 1 and rows[0].get('name') == name and rows[0].get('internal') is True and rows[0].get('driver') == 'bridge' and
                    rows[0].get('ipv6_enabled') is False and rows[0].get('options', {}).get('isolate') == 'true' and
                    rows[0].get('labels', {}).get('com.docker.compose.project') == self.project and
                    rows[0].get('labels', {}).get('io.podman.compose.project') == self.project, 'C08 network ownership mismatch')
            require(self.podman(['network', 'rm', name]).returncode == 0, 'C08 network removal failed')
            require(self.podman(['network', 'exists', name]).returncode == 1, 'C08 network remains'); return 0
        if args == ['version', '--format', '{{.Server.Version}}']:
            return self.podman(args, capture=False).returncode
        if args and args[0] == 'run':
            plan = run_plan(args, self.images, self.project, self.phase['buildRoot'])
            require(self.podman(['container', 'exists', plan['name']]).returncode == 1, 'C08 container slot occupied')
            result = self.podman(plan['argv'])
            require(result.returncode == 0 and re.fullmatch('[a-f0-9]{64}', result.stdout.strip()), 'C08 container creation failed')
            entry = {key: plan[key] for key in ('key', 'name', 'alias')}; entry['id'] = result.stdout.strip()
            self.state[entry['id']] = entry; self.save(); self.inspect(entry)
            if plan['detached']:
                return self.start_detached(entry)
            try:
                return self.podman(['start', '--attach', entry['id']], capture=False, timeout=100).returncode
            finally:
                self.remove(entry)
        require(args, 'empty C08 operation')
        if args[0] == 'exec':
            offset = 2 if len(args) > 1 and args[1] == '-i' else 1
        elif args[0] == 'rm':
            require(len(args) == 3 and args[1] == '--force', 'unsupported C08 remove'); offset = 2
        elif args[0] in ('inspect', 'port'):
            offset = 1
        else:
            raise ValueError('unsupported C08 operation')
        require(len(args) > offset, 'missing C08 alias')
        entries = [e for e in self.state.values() if e['alias'] == args[offset]]
        require(len(entries) == 1, 'unknown C08 alias'); entry = entries[0]
        if args[0] == 'inspect' and entry.get('removed'):
            return 1
        require(not entry.get('removed'), 'C08 container already removed'); self.inspect(entry)
        if args[0] == 'rm':
            self.remove(entry); return 0
        if args[0] == 'port':
            require(args[offset + 1:] == ['5432/tcp'], 'unexpected C08 port query')
        if args[0] == 'exec':
            require(args[offset + 1:] and args[offset + 1] in ('psql', 'pg_isready'), 'unexpected PG exec')
        argv = list(args); argv[offset] = entry['id']
        return self.podman(argv, capture=False, timeout=100).returncode


def main():
    script = Path(__file__).resolve().parents[1] / 'read-fixed-browser-phase.py'
    spec = importlib.util.spec_from_file_location('fixed_phase', script)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    phase = module.select_phase()
    if phase.get('cohort') != 'c08':
        # A C08 source record without its phase must not fall into the generic adapter.
        run = os.environ.get('CI_RUN_ID', '')
        if re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,159}', run):
            record = Path('/var/lib/custom-ci/runs') / run / 'browser-source-profile.json'
            if record.exists() and json.loads(record.read_text()).get('sourceProfile', {}).get('pipelinePath') == '.ci/development-c08.pipeline.json':
                raise ValueError('missing C08 owner phase')
        return 77
    if sys.argv[1:2] in (['exec'], ['inspect'], ['port'], ['version']):
        status = Adapter(phase).dispatch(sys.argv[1:])
    else:
        with (Path(phase['runtimeDirectory']) / 'c08-adapter.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            status = Adapter(phase).dispatch(sys.argv[1:])
    return 1 if status == 77 else status


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('C08 adapter refused: ' + str(error), file=sys.stderr)
        sys.exit(64)
