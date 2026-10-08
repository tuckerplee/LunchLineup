import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('storage admission enforces independent parent, project, freshness and guest boundaries', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = spawnSync('python3', ['-B', '-c', `
import importlib.util
spec = importlib.util.spec_from_file_location('admission', 'scripts/check-internal-ci-storage.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
G = m.GIB
budget = dict(version=1, vmid=218, project_id=218, dataset='data/zd0',
              observed_at_epoch=1000, quota_bytes=60*G, used_bytes=24*G,
              dataset_available_bytes=52*G, pool_free_bytes=72*G)
m.require_backing_capacity(budget, 1090)
m.require_capacity(52*G)
for changes, now in [
    ({'dataset_available_bytes': 52*G-1}, 1000),
    ({'used_bytes': 24*G+1}, 1000),
    ({'pool_free_bytes': 60*G-1}, 1000),
    ({}, 1091), ({}, 999), ({'vmid': 107}, 1000),
]:
    try:
        m.require_backing_capacity(dict(budget, **changes), now)
    except ValueError:
        pass
    else:
        raise AssertionError((changes, now))
try:
    m.require_capacity(52*G-1)
except ValueError:
    pass
else:
    raise AssertionError('guest floor ignored')
env = dict(CI_REPOSITORY='lunchlineup', CI_RUN_ID='controller-123',
           CI_WORKSPACE='/var/lib/custom-ci/workspaces/controller-123',
           RUNNER_TEMP='/var/lib/custom-ci/runs/controller-123/tmp/job-tmp',
           CONTAINERS_STORAGE_CONF='/var/lib/custom-ci/runs/controller-123/tmp/step-inputs/container-storage.conf')
m.validate_context(env, 'custom-ci', m.Path(env['CI_WORKSPACE']))
for changes in [dict(DOCKER_HOST='unix:///var/run/docker.sock'),
                dict(CONTAINER_HOST='ssh://shared'), dict(CI_RUN_ID='../escape'),
                dict(RUNNER_TEMP='/tmp/shared')]:
    try:
        m.validate_context(dict(env, **changes), 'custom-ci', m.Path(env['CI_WORKSPACE']))
    except ValueError:
        pass
    else:
        raise AssertionError(changes)
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('QA target checks reject external volumes, foreign prefixes and occupied browser ports', () => {
  const result = spawnSync('python3', ['-B', '-c', `
import importlib.util
import socket
spec = importlib.util.spec_from_file_location('target', 'scripts/check-internal-ci-target.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
project = 'lunchlineup-beta-controller123'
valid = {'volumes': {'postgres_data': {'name': project + '_postgres_data'}}}
assert m.validate_volumes(valid, project) == [project + '_postgres_data']
for invalid in [
    {'volumes': {'postgres_data': {'external': True, 'name': project + '_postgres_data'}}},
    {'volumes': {'postgres_data': {'name': 'retained_postgres_data'}}},
    {'volumes': {}},
]:
    try:
        m.validate_volumes(invalid, project)
    except ValueError:
        pass
    else:
        raise AssertionError(invalid)
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    try:
        m.require_ports_free([port])
    except OSError:
        pass
    else:
        raise AssertionError('occupied port admitted')
m.require_ports_free([port])
`], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});


test('bounded QA port handoff retains exclusive binds and refuses persistent contention', () => {
  const result = spawnSync('python3', ['-B', '-c', `
import errno
import importlib.util
import socket
import threading
import time
spec = importlib.util.spec_from_file_location('target', 'scripts/check-internal-ci-target.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
for budget in (-1, 66, float('inf'), float('nan')):
    try:
        m.require_ports_free([], wait_seconds=budget)
    except ValueError:
        pass
    else:
        raise AssertionError('unbounded retry admitted')
# Even a SO_REUSEADDR listener must not be admitted by the guard's normal bind.
with socket.socket() as occupied:
    occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    occupied.bind(('127.0.0.1', 0))
    occupied.listen()
    port = occupied.getsockname()[1]
    started = time.monotonic()
    try:
        m.require_ports_free([port], wait_seconds=0.1)
    except OSError as failure:
        assert failure.errno == errno.EADDRINUSE
    else:
        raise AssertionError('listening port admitted')
    assert 0.09 <= time.monotonic() - started < 1
# Hold the first bind while the second remains occupied; then release the
# occupied non-listening socket. Only a genuinely exclusive rebind may pass.
with socket.socket() as first:
    first.bind(('127.0.0.1', 0))
    first_port = first.getsockname()[1]
second = socket.socket()
second.bind(('127.0.0.1', 0))
second_port = second.getsockname()[1]
observed = []
def release():
    time.sleep(0.05)
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', first_port))
        except OSError as failure:
            observed.append(failure.errno)
        else:
            observed.append('first bind lost')
    second.close()
thread = threading.Thread(target=release)
thread.start()
try:
    m.require_ports_free([first_port, second_port], wait_seconds=0.75)
finally:
    thread.join()
    second.close()
assert observed == [errno.EADDRINUSE]
# Both held sockets must be closed after success and after a later-port error.
m.require_ports_free([first_port, second_port])
with socket.socket() as occupied:
    occupied.bind(('127.0.0.1', second_port))
    try:
        m.require_ports_free([first_port, second_port], wait_seconds=0.02)
    except OSError:
        pass
    else:
        raise AssertionError('bound non-listening port admitted')
    m.require_ports_free([first_port])
# A retry at the second port receives only the remainder of the shared budget.
first = socket.socket()
second = socket.socket()
first.bind(('127.0.0.1', 0))
second.bind(('127.0.0.1', 0))
ports = [first.getsockname()[1], second.getsockname()[1]]
thread = threading.Thread(target=lambda: (time.sleep(0.05), first.close()))
thread.start()
started = time.monotonic()
try:
    try:
        m.require_ports_free(ports, wait_seconds=0.4)
    except OSError as failure:
        assert failure.errno == errno.EADDRINUSE
    else:
        raise AssertionError('second occupied port admitted')
    assert 0.35 <= time.monotonic() - started < 0.6
finally:
    thread.join()
    first.close()
    second.close()
# Other bind failures must be propagated immediately and the socket closed.
from unittest.mock import Mock, patch
failure = OSError(errno.EACCES, 'synthetic bind denial')
probe = Mock()
probe.bind.side_effect = failure
with patch.object(m.socket, 'socket', return_value=probe), patch.object(m.time, 'sleep') as sleeping:
    try:
        m.require_ports_free([8080], wait_seconds=65)
    except OSError as caught:
        assert caught is failure
    else:
        raise AssertionError('non-contention bind failure admitted')
    probe.close.assert_called_once()
    sleeping.assert_not_called()
# Scheduler oversleep must not admit a newly free port after the deadline.
probe = Mock()
probe.bind.side_effect = [OSError(errno.EADDRINUSE, 'synthetic contention'), None]
with patch.object(m.socket, 'socket', return_value=probe), patch.object(m.time, 'sleep'), patch.object(m.time, 'monotonic', side_effect=[0, 0, 2]):
    try:
        m.require_ports_free([8080], wait_seconds=1)
    except OSError as caught:
        assert caught.errno == errno.EADDRINUSE
    else:
        raise AssertionError('port admitted after the deadline')
    probe.bind.assert_called_once()
    probe.close.assert_called_once()
`], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});


test('finite job attestation keeps physical reserves and rejects forged filesystem custody', () => {
  const result = spawnSync('python3', ['-B', '-c', String.raw`
import copy, importlib.util, json, os, stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('finite_guard',Path('scripts/check-internal-ci-storage.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
G=m.GIB;run='20261007T230000Z-lunchlineup-8fac0b2f-123456';sha='8fac0b2fb8090112592dc7b9b3023e0f6f8a9bb8'
a={'version':1,'kind':'fixed-browser-job-filesystem','runId':run,'sourceSha':sha,'imageBytes':m.FINITE_IMAGE_BYTES,
   'filesystemBytes':31*G,'minimumFreeBytes':29*G,'allocationImageIdentity':[5,6],'backingReservation':'none-sparse-image',
   'workspace':{'path':'/var/lib/custom-ci/workspaces/'+run,'device':19,'inode':21},
   'temporary':{'path':'/var/lib/custom-ci/runs/'+run+'/tmp','device':19,'inode':22}}
o={k:dict(a[k],total=31*G,free=30*G) for k in ('workspace','temporary')}
checks=[]
def check(name,fn,bad=False):
 try:
  result=fn()
  assert result is not False,name
 except (ValueError,OSError) as e:
  if not bad:raise
 else:
  assert not bad,name
 checks.append(name)
check('exact-finite-observation',lambda:m.require_finite_capacity(a,run,sha,o))
for key,value in [('version',2),('runId','foreign'),('sourceSha','0'*40),('imageBytes',64*G),('minimumFreeBytes',0),
                  ('backingReservation','reserved'),('filesystemBytes',64*G),('allocationImageIdentity',[5,0])]:
 b=copy.deepcopy(a);b[key]=value
 check('reject-'+key,lambda b=b:m.require_finite_capacity(b,run,sha,o),True)
for where,key,value in [('workspace','path','/tmp'),('workspace','device',20),('temporary','device',20),
                       ('temporary','inode',99),('workspace','free',29*G-1),('workspace','total',64*G),
                       ('temporary','free',float('nan')),('temporary','free',True)]:
 b=copy.deepcopy(o);b[where][key]=value
 check('reject-actual-'+where+'-'+key,lambda b=b:m.require_finite_capacity(a,run,sha,b),True)
b=copy.deepcopy(a);b['temporary']['device']=20;c=copy.deepcopy(o);c['temporary']['device']=20
check('reject-two-selfconsistent-filesystems',lambda:m.require_finite_capacity(b,run,sha,c),True)
check('preserve-generic52-positive',lambda:m.require_capacity(52*G))
check('preserve-generic52-negative',lambda:m.require_capacity(52*G-1),True)
budget=dict(version=1,vmid=218,project_id=218,dataset='data/zd0',observed_at_epoch=1000,
 quota_bytes=60*G,used_bytes=24*G,dataset_available_bytes=52*G,pool_free_bytes=60*G)
check('backing-exact-boundaries',lambda:m.require_backing_capacity(budget,1090))
for changes,now in [({'dataset_available_bytes':52*G-1},1000),({'used_bytes':24*G+1},1000),
                    ({'pool_free_bytes':60*G-1},1000),({},1091),({},999),({'vmid':107},1000)]:
 check('backing-refusal-'+str(changes)+'-'+str(now),lambda ch=changes,n=now:m.require_backing_capacity(dict(budget,**ch),n),True)
# Mock kernel metadata only. No file, namespace, mount or environment is created.
body=json.dumps(a).encode();path=Path('/var/lib/custom-ci/runs')/run/'browser-filesystem.json'
fi=SimpleNamespace(st_mode=stat.S_IFREG|0o444,st_uid=0,st_nlink=1,st_size=len(body),st_dev=5,st_ino=6,st_mtime_ns=1,st_ctime_ns=1)
di=SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0)
def lstat(p):return fi if p==path else di
with patch.object(Path,'lstat',lstat),patch.object(m.os,'open',return_value=55) as opened,\
     patch.object(m.os,'fstat',return_value=fi),patch.object(m.os,'read',return_value=body),patch.object(m.os,'close') as closed:
 check('protected-descriptor-read',lambda: m.read_finite_attestation(path)==a)
 assert opened.call_args.args[1] & os.O_NOFOLLOW;assert opened.call_args.args[1]&os.O_NONBLOCK
 for key,value in [('st_uid',1000),('st_nlink',2),('st_mode',stat.S_IFREG|0o644),('st_mode',stat.S_IFLNK|0o777)]:
  old=getattr(fi,key);setattr(fi,key,value)
  check('descriptor-refuse-'+key+'-'+str(value),lambda:m.read_finite_attestation(path),True);setattr(fi,key,old)
 di.st_mode=stat.S_IFDIR|0o777
 check('writable-parent-refused',lambda:m.read_finite_attestation(path),True)
 di.st_mode=stat.S_IFDIR|0o755
 oldbody=body;body=b'{"version":1,"version":1}';fi.st_size=len(body)
 with patch.object(m.os,'read',return_value=body):
  check('duplicate-key-refused',lambda:m.read_finite_attestation(path),True)
 assert closed.call_count>=6
# Main stdout must describe the applied bound; all actual host calls are mocked.
import contextlib, io
for finite in [False, True]:
    capture=io.StringIO()
    config='[storage]\ngraphroot="'+o['temporary']['path']+'/containers/graphroot"\nrunroot="'+o['temporary']['path']+'/containers/runroot"\n'
    def read_text(path,*args,**kwargs):
        return json.dumps(budget) if str(path).endswith('builder-budget.json') else config
    with patch.object(m,'validate_context',return_value=(Path(o['workspace']['path']),Path(o['temporary']['path']))), \
         patch.object(m.socket,'gethostname',return_value='custom-ci'),patch.object(Path,'cwd',return_value=Path(o['workspace']['path'])), \
         patch.object(Path,'lstat',return_value=SimpleNamespace(st_uid=0,st_mode=0o40755)), \
         patch.object(Path,'is_symlink',return_value=False),patch.object(Path,'exists',return_value=finite), \
         patch.object(Path,'resolve',lambda self,*args,**kwargs:self),patch.object(Path,'read_text',read_text), \
         patch.object(m.time,'time',return_value=1000),patch.object(m.subprocess,'run') as running, \
         patch.object(m.subprocess,'check_output',return_value='success'), \
         patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=(30 if finite else 52)*G)), \
         patch.object(m,'read_finite_attestation',return_value=a),patch.object(m,'finite_observation',return_value=o), \
         patch.dict(m.os.environ,{'CI_RUN_ID':run,'CI_COMMIT_SHA':sha,'CONTAINERS_STORAGE_CONF':o['temporary']['path']+'/step-inputs/container-storage.conf'}),contextlib.redirect_stdout(capture):
        m.main()
    receipt=json.loads(capture.getvalue())
    assert running.call_count==2
    if finite:
        assert receipt['capacityMode']=='finite-job'
        assert receipt['free_floor_bytes']==receipt['finiteMinimumFreeBytes']==29*G
        assert receipt['finiteImageCeilingBytes']==32*G-1024**2
        assert receipt['finiteFilesystemBytes']==31*G
        assert receipt['backingReservation']=='none-sparse-image'
        assert [receipt[k] for k in ['backingQuotaHeadroomMinimumBytes','backingParentAvailableMinimumBytes',
                'backingPoolFreeMinimumBytes','backingEarlyStopMarginBytes']]==[36*G,52*G,60*G,20*G]
    else:
        assert receipt=={'storage_admission':'passed','free_bytes':52*G,'working_limit_bytes':32*G,'free_floor_bytes':20*G}
    checks.append('main-output-finite' if finite else 'main-output-generic-exact')
print(json.dumps({'passed':len(checks),'checks':checks,'runtimeExecuted':False},indent=2))
`], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.passed, 36);
  assert.equal(proof.runtimeExecuted, false);
});

// Pure kernel/descriptor models; no mount, service, application or namespace starts.
test('fixed browser phase proves the visible read-only bind and sealed context', () => {
  const result = spawnSync('python3', ['-B', '-c', String.raw`"""Mocked fixed-descriptor/kernel inputs only; no services or application imports."""
import copy,importlib.util,json,os,stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
D=Path.cwd()
spec=importlib.util.spec_from_file_location('phase_helper',D/'scripts/read-fixed-browser-phase.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
run='20261007T230000Z-lunchlineup-8fac0b2f-123456';sha='a'*40
base={'version':1,'runId':run,'sourceSha':sha,'phase':'acquisition','runtimeDirectory':'/tmp/llr.abcdef',
 'runtimeIdentity':[21,22],'sealedInputs':{},'deadlineMonotonic':9100.}
checks=[]
def check(name,call,bad=False):
 try:value=call()
 except (ValueError,OSError,TypeError,KeyError):
  assert bad,name;checks.append(name);return
 assert not bad,name;checks.append(name);return value
with patch.dict(os.environ,{'CI_RUN_ID':run,'CI_COMMIT_SHA':sha}),patch.object(Path,'exists',return_value=False),patch.object(Path,'is_symlink',return_value=False):
 assert check('generic-missing-record-preserves-two-shell-fields',m.select_phase)=={'phase':'all','runtimeDirectory':'-'}
record=copy.deepcopy(base)
guard=SimpleNamespace(read_finite_attestation=lambda path:copy.deepcopy(record))
specfake=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module:None))
runtime=SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_uid=1001,st_dev=21,st_ino=22)
container=SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_uid=1001,st_dev=21,st_ino=23)
root=SimpleNamespace(st_mode=stat.S_IFDIR|0o750,st_uid=0,st_dev=21,st_ino=24)
def lst(path):return runtime if str(path)==base['runtimeDirectory'] else container if path.name=='containers' else root
with patch.dict(os.environ,{'CI_RUN_ID':run,'CI_COMMIT_SHA':sha}),patch.object(Path,'exists',return_value=True), \
 patch.object(m.importlib.util,'spec_from_file_location',return_value=specfake), \
 patch.object(m.importlib.util,'module_from_spec',return_value=guard),patch.object(m.time,'monotonic',return_value=100.), \
 patch.object(m.os,'geteuid',return_value=1001),patch.object(Path,'lstat',lst),patch.object(Path,'resolve',lambda self,strict=True:self), \
 patch.object(Path,'read_text',return_value=run+'\n'):
 assert check('exact-acquisition',m.select_phase)['phase']=='acquisition'
 for key,value in [('version',2),('runId','other'),('sourceSha','b'*40),('phase','all'),('deadlineMonotonic',100.),('deadlineMonotonic',9200.),('deadlineMonotonic',float('nan')),('runtimeIdentity',[21,99]),('runtimeDirectory','/tmp/foreign'),('sealedInputs',{'runtime.env':{}})]:
  record=copy.deepcopy(base);record[key]=value;check('reject-'+key+'-'+str(value),m.select_phase,True)
 record=copy.deepcopy(base);runtime.st_uid=0;check('reject-root-runtime-directory',m.select_phase,True);runtime.st_uid=1001
 record.update(phase='runtime',sealedInputs={'runtime.env':{'bytes':1,'sha256':'a'*64},'development-compose.json':{'bytes':1,'sha256':'b'*64}})
 with patch.object(m,'require_readonly_mount',side_effect=ValueError('not exact readonly mount')):
  check('reject-unmounted-or-writable-runtime-seal',m.select_phase,True)
# Same-device RO bind: ismount's parent-device shortcut would return false.
path=Path('/finite/qualification');info=SimpleNamespace(st_mode=stat.S_IFDIR|0o750,st_uid=0,st_gid=1002,st_dev=os.makedev(7,8),st_ino=24)
original_row='42 9 7:8 /run/tmp/qualification /finite/qualification ro,nosuid,nodev - ext4 /dev/loop8 rw\n'
row=original_row;fdinfo='pos:\t0\nmnt_id:\t42\n';flags=os.ST_RDONLY
with patch.object(m.os,'open',return_value=90),patch.object(m.os,'close'),patch.object(m.os,'fstat',return_value=info), \
 patch.object(m.os,'fstatvfs',side_effect=lambda fd:SimpleNamespace(f_flag=flags)),patch.object(Path,'lstat',return_value=info), \
 patch.object(Path,'resolve',lambda self,strict=True:self),patch.object(Path,'read_text',lambda self:fdinfo if 'fdinfo' in str(self) else row):
 check('accept-same-device-visible-readonly-bind',lambda:m.require_readonly_mount(path))
 for name,changed in [('not-mountpoint',original_row.replace('/finite/qualification','/finite')),('wrong-visible-id',original_row.replace('42 9','43 9')),
                      ('wrong-device',original_row.replace('7:8','7:9')),('writable-options',original_row.replace(' ro,',' rw,')),('duplicate-visible-id',original_row*2)]:
  row=changed;check('reject-'+name,lambda:m.require_readonly_mount(path),True)
 row=original_row;flags=0;check('reject-statvfs-writable',lambda:m.require_readonly_mount(path),True)
 flags=os.ST_RDONLY;fdinfo='mnt_id: 42\nmnt_id: 43\n';check('reject-ambiguous-visible-id',lambda:m.require_readonly_mount(path),True)
print(json.dumps({'passed':len(checks),'checks':checks,'runtimeExecuted':False},indent=2))
`], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, 22);
  assert.equal(report.runtimeExecuted, false);
});
