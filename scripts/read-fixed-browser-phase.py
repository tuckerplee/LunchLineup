#!/usr/bin/env python3
"""Read only the fixed owner phase record; absence preserves generic wrapper mode."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time
import sys



def require_readonly_mount(path):
    """Identify the visible mount through this directory FD, including bind mounts.

    ismount() cannot distinguish a same-device bind from its parent. The kernel
    fdinfo mount ID selects the actual visible mountinfo row, not an inferred
    newest ID or a hidden stacked mount. Both VFS options and fstatvfs must be RO.
    """
    if path.resolve(strict=True) != path:
        raise ValueError('runtime input parent is not canonical')
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        first = os.fstat(fd)
        if not stat.S_ISDIR(first.st_mode) or first.st_uid != 0 or first.st_mode & 0o022:
            raise ValueError('runtime input parent is not protected')
        descriptor = Path('/proc/self/fdinfo') / str(fd)
        ids = [line.split(':', 1)[1].strip() for line in descriptor.read_text().splitlines()
               if line.startswith('mnt_id:')]
        if len(ids) != 1 or not re.fullmatch(r'[1-9][0-9]*', ids[0]):
            raise ValueError('runtime visible mount ID unavailable')
        entries = [line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()]
        rows = [row for row in entries if row and row[0] == ids[0]]
        if len(rows) != 1 or len(rows[0]) < 10 or '-' not in rows[0][6:]:
            raise ValueError('runtime visible mount row unavailable')
        row = rows[0]
        mountpoint = re.sub(r'\\(040|011|012|134)', lambda match: chr(int(match[1], 8)), row[4])
        expected_device = str(os.major(first.st_dev)) + ':' + str(os.minor(first.st_dev))
        if (mountpoint != str(path) or row[2] != expected_device or
                'ro' not in row[5].split(',') or 'rw' in row[5].split(',') or
                not os.fstatvfs(fd).f_flag & os.ST_RDONLY):
            raise ValueError('runtime input parent is not an exact read-only mount')
        after = os.fstat(fd); named = path.lstat()
        if any(getattr(first, key) != getattr(after, key) or getattr(first, key) != getattr(named, key)
               for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode')):
            raise ValueError('runtime input parent changed during mount check')
    finally:
        os.close(fd)

def validate_c08_source_binding(phase, source_record, run, source, reference):
    profile = source_record.get('sourceProfile', {})
    if (set(source_record) != {'sourceProfile', 'runId', 'materializerSha256'} or
            source_record['runId'] != run or phase.get('cohort') != 'c08' or
            profile.get('version') != 2 or profile.get('sourcePurpose') != 'disposable-development' or
            profile.get('repository') != 'tuckerplee/LunchLineup' or
            profile.get('pipelinePath') != '.ci/development-c08.pipeline.json' or
            profile.get('sourceSha') != source or profile.get('sourceRef') != reference or
            profile.get('pipelineSha256') != phase.get('pipelineSha256') or
            not re.fullmatch('[a-f0-9]{64}', source_record.get('materializerSha256', ''))):
        raise ValueError('C08 authenticated source mismatch')
    return profile


def select_phase():
    run = os.environ.get('CI_RUN_ID', '')
    source = os.environ.get('CI_COMMIT_SHA', '')
    if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,159}', run):
        raise ValueError('invalid run identity')
    root = Path('/var/lib/custom-ci/runs') / run
    record = root / 'browser-phase.json'
    if not record.exists() and not record.is_symlink():
        return {'phase': 'all', 'runtimeDirectory': '-'}
    # This helper stays adjacent to the authenticated source storage guard.
    spec = importlib.util.spec_from_file_location('fixed_storage', Path(__file__).with_name('check-internal-ci-storage.py'))
    guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
    phase = guard.read_finite_attestation(record)
    mock_kinds = {
        'fixed-mock-ux-runtime': ('.ci/development-mock-ux.pipeline.json',
            '.ci/development-mock-ux-cases.json', 'fixed-mock-ux-sandbox'),
        'fixed-mock-ux-next-nine-runtime': ('.ci/development-mock-ux-next-nine.pipeline.json',
            '.ci/development-mock-ux-next-nine-cases.json', 'fixed-mock-ux-next-nine-sandbox'),
    }
    if phase.get('kind') in mock_kinds:
        pipeline_path, selection_path, sandbox_kind = mock_kinds[phase['kind']]
        expected = {'version', 'kind', 'phase', 'runId', 'sourceSha', 'pipelineSha256',
                    'selectionSha256', 'deadlineMonotonic', 'networkNamespaceInode',
                    'mountNamespaceInode', 'cgroup', 'sandboxAdmissionSha256'}
        source_record = guard.read_finite_attestation(root / 'browser-source-profile.json')
        profile = source_record.get('sourceProfile', {})
        build = root / 'tmp/job-tmp' / ('lunchlineup-source-' + run) / 'build'
        if (set(phase) != expected or phase['version'] != 3 or phase['phase'] != 'runtime' or
                set(source_record) != {'sourceProfile', 'runId', 'materializerSha256'} or
                profile.get('version') != 2 or profile.get('sourcePurpose') != 'disposable-development' or
                profile.get('repository') != 'tuckerplee/LunchLineup' or
                not re.fullmatch('[a-f0-9]{40}', source) or
                not re.fullmatch('[a-f0-9]{64}', source_record.get('materializerSha256', '')) or
                type(phase['deadlineMonotonic']) not in (int, float) or
                phase['runId'] != run or phase['sourceSha'] != source or
                not 0 < phase['deadlineMonotonic'] - time.monotonic() <= 1800 or
                profile.get('pipelinePath') != pipeline_path or
                profile.get('sourceSha') != source or profile.get('sourceRef') != os.environ.get('CI_REF') or
                profile.get('pipelineSha256') != phase['pipelineSha256'] or
                source_record.get('runId') != run or os.environ.get('CI_REPOSITORY') != 'lunchlineup' or
                os.environ.get('CI_RUN_ATTEMPT') != '1' or os.environ.get('LUNCHLINEUP_DEVELOPMENT_QA') != '1' or
                Path(__file__).resolve().parent.parent != build or
                Path('/proc/self/ns/net').stat().st_ino != phase['networkNamespaceInode'] or
                Path('/proc/self/ns/mnt').stat().st_ino != phase['mountNamespaceInode'] or
                Path('/proc/self/cgroup').read_text().strip() != phase['cgroup']):
            raise ValueError('fixed mock UX source/physical invocation mismatch')
        for relative, digest in [(pipeline_path, phase['pipelineSha256']),
                                 (selection_path, phase['selectionSha256'])]:
            if not re.fullmatch('[a-f0-9]{64}', digest) or hashlib.sha256((build / relative).read_bytes()).hexdigest() != digest:
                raise ValueError('fixed mock UX pinned input differs')
        admission = root / 'browser-mock-sandbox.json'
        attestation = guard.read_finite_attestation(admission)
        if (attestation.get('kind') != sandbox_kind or
                attestation.get('runId') != run or attestation.get('sourceSha') != source or
                attestation.get('preEntrySignalWait') is not True or
                hashlib.sha256(admission.read_bytes()).hexdigest() != phase['sandboxAdmissionSha256']):
            raise ValueError('fixed mock UX original sandbox admission differs')
        return phase
    c08 = phase.get('version') == 2
    keys = {'version', 'runId', 'sourceSha', 'phase', 'runtimeDirectory',
            'runtimeIdentity', 'sealedInputs', 'deadlineMonotonic'}
    if c08:
        keys |= {'cohort', 'pipelineSha256', 'selectionSha256'}
    if (set(phase) != keys or phase['version'] not in (1, 2) or
            phase['runId'] != run or phase['sourceSha'] != source or
            not re.fullmatch('[a-f0-9]{40}', source) or phase['phase'] not in ('acquisition', 'runtime') or
            type(phase['deadlineMonotonic']) not in (int, float) or
            not 0 < phase['deadlineMonotonic'] - time.monotonic() <= (1200 if c08 else 9000)):
        raise ValueError('invalid fixed owner phase')
    if c08:
        source_record = guard.read_finite_attestation(root / 'browser-source-profile.json')
        validate_c08_source_binding(phase, source_record, run, source, os.environ.get('CI_REF'))
        build = root / 'tmp/job-tmp' / ('lunchlineup-source-' + run) / 'build'
        if (os.environ.get('CI_REPOSITORY') != 'lunchlineup' or os.environ.get('CI_RUN_ATTEMPT') != '1' or
                os.environ.get('LUNCHLINEUP_DEVELOPMENT_QA') != '1' or
                Path(__file__).resolve().parent.parent != build):
            raise ValueError('C08 authenticated source invocation mismatch')
        for relative, expected_hash in [('.ci/development-c08.pipeline.json', phase['pipelineSha256']),
                                         ('.ci/development-c08-cases.json', phase['selectionSha256'])]:
            if not re.fullmatch('[a-f0-9]{64}', expected_hash) or hashlib.sha256((build / relative).read_bytes()).hexdigest() != expected_hash:
                raise ValueError('C08 source selection hash mismatch')
    runtime = Path(phase['runtimeDirectory'])
    if not re.fullmatch(r'/tmp/llr\.[A-Za-z0-9]{6}', str(runtime)):
        raise ValueError('unowned short runtime path')
    info = runtime.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or
            stat.S_IMODE(info.st_mode) != 0o700 or runtime.resolve(strict=True) != runtime or
            [info.st_dev, info.st_ino] != phase['runtimeIdentity'] or
            (runtime / 'owner').read_text().strip() != run):
        raise ValueError('owner runtime directory identity changed')
    containers = runtime / 'containers'
    info2 = containers.lstat()
    if (not stat.S_ISDIR(info2.st_mode) or info2.st_uid != os.geteuid() or
            info2.st_dev != info.st_dev or containers.resolve(strict=True) != containers):
        raise ValueError('owner runtime container directory changed')
    qualification = root / 'tmp/job-tmp' / ('lunchlineup-beta-qualification-' + run)
    expected = set() if phase['phase'] == 'acquisition' else ({'c08-selection.json'} if c08 else {'runtime.env', 'development-compose.json'})
    if type(phase['sealedInputs']) is not dict or set(phase['sealedInputs']) != expected:
        raise ValueError('owner runtime input roster changed')
    if expected:
        require_readonly_mount(qualification)
    for name, pin in phase['sealedInputs'].items():
        path = qualification / name
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            first = os.fstat(fd)
            if (not os.statvfs(path).f_flag & os.ST_RDONLY or not stat.S_ISREG(first.st_mode) or first.st_uid != 0 or first.st_nlink != 1 or
                    stat.S_IMODE(first.st_mode) not in (0o440, 0o444) or
                    set(pin) != {'bytes', 'sha256'} or not 0 < first.st_size == pin['bytes'] <= 1048576):
                raise ValueError('runtime input is not sealed')
            body = os.read(fd, 1048577)
            after = os.fstat(fd); final = path.lstat()
            fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_mode', 'st_nlink')
            if (len(body) != first.st_size or hashlib.sha256(body).hexdigest() != pin['sha256'] or
                    any(getattr(first, k) != getattr(after, k) or getattr(first, k) != getattr(final, k) for k in fields)):
                raise ValueError('sealed runtime input changed')
        finally:
            os.close(fd)
    if c08:
        if phase['phase'] == 'runtime' and phase['sealedInputs']['c08-selection.json']['sha256'] != phase['selectionSha256']:
            raise ValueError('C08 sealed selection differs from authenticated selection')
        return {**phase, 'selectionPath': str(build / '.ci/development-c08-cases.json'), 'buildRoot': str(build)}
    return {'phase': phase['phase'], 'runtimeDirectory': str(runtime)}


if __name__ == '__main__':
    value = select_phase()
    if sys.argv[1:] == ['--mock-ux-json']:
        if value.get('kind') != 'fixed-mock-ux-runtime':
            raise ValueError('Mock UX requires an authenticated fixed phase')
        print(json.dumps(value, sort_keys=True))
    elif sys.argv[1:] == ['--mock-ux-next-nine-json']:
        if value.get('kind') != 'fixed-mock-ux-next-nine-runtime':
            raise ValueError('Next nine requires its own authenticated fixed phase')
        print(json.dumps(value, sort_keys=True))
    elif sys.argv[1:] == ['--c08-json']:
        if value.get('cohort') != 'c08':
            raise ValueError('C08 requires an authenticated fixed phase')
        print(json.dumps(value, sort_keys=True))
    elif len(sys.argv) == 1:
        if value.get('cohort') == 'c08' or value.get('kind') in ('fixed-mock-ux-runtime', 'fixed-mock-ux-next-nine-runtime'):
            raise ValueError('C08 phase cannot enter browser wrapper')
        print(value['phase'])
        print(value['runtimeDirectory'])
    else:
        raise ValueError('unsupported phase reader arguments')
