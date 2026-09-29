#!/usr/bin/env bash
# Disposable application QA only. No release signing, publication or deployment.
set -euo pipefail
umask 077
[[ "${1:-}" == --source-context && $# == 2 && "${LUNCHLINEUP_DEVELOPMENT_QA:-}" == 1 ]] || exit 64
context=$2
workspace=$PWD
artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"
source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"
build_root="$source_root/build"
qualification_root="$RUNNER_TEMP/lunchlineup-beta-qualification-$CI_RUN_ID"
env_file="$qualification_root/runtime.env"
project_suffix=${CI_RUN_ID,,}; project_suffix=${project_suffix//[^a-z0-9]/}
project="lunchlineup-beta-$project_suffix"
[[ "$context" == "$source_root/source-context.json" && ! -e "$qualification_root" && ! -L "$qualification_root" ]] || exit 64
node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$build_root" --purpose build --require-clean >/dev/null
node - "$artifact_root/development-browser-isolation.json" "$CI_RUN_ID" "$CI_COMMIT_SHA" <<'NODE'
const fs=require('node:fs');const [path,runId,sourceSha]=process.argv.slice(2),proof=JSON.parse(fs.readFileSync(path));
if(!Number.isInteger(proof.proxy?.approvedConnects)||proof.proxy.approvedConnects<1||proof.proxy?.openUpstreamSockets!==0||proof.proxy?.socketsClosed!==true)throw new Error('Fixed local proxy transport or socket cleanup proof is missing; refusing runtime preparation.');
if(proof.deniedTrapConnections!==0||proof.checkpoints?.some(x=>x.deniedTrapConnections!==0)||proof.optionOverrideProof?.attempts!==3||proof.optionOverrideProof?.rejectedBeforeCreation!==3||proof.optionOverrideProof?.factoryCalls!==0||proof.optionOverrideProof?.deniedTrapConnections!==0)throw new Error('Browser connection/proxy-override proof is missing or incomplete; refusing runtime preparation.');
if(proof.kind!=='disposable-development-browser-isolation-selftest'||proof.releaseQualified!==false||proof.runId!==runId||proof.sourceSha!==sourceSha||proof.status!=='passed'||proof.approvedOrigin!=='http://127.0.0.1:8080'||proof.expectedCheckpointCount!==10||proof.completedCheckpointCount!==10||proof.deniedTrapHits!==0||proof.cleanupVerified!==true||!Array.isArray(proof.checkpoints)||proof.checkpoints.length!==10||new Set(proof.checkpoints.map(x=>x.case)).size!==10||proof.checkpoints.some(x=>x.deniedTrapHits!==0)||proof.proxy?.upstream?.hostname!=='127.0.0.1'||proof.proxy?.upstream?.port!==8080||!proof.proxy?.stoppedAt||proof.ownedHarness?.syntheticTarget?.serverClosed!==true||proof.ownedHarness?.deniedTrap?.serverClosed!==true||proof.ownedHarness?.browserClosed!==true)throw new Error('Current isolated Chromium proof is missing or incomplete; refusing runtime preparation.');
NODE
export PATH="$build_root/scripts/ci-container-bin:$PATH"
compose=(docker compose --project-name "$project" --env-file "$env_file" -f "$build_root/docker-compose.yml")
mkdir -- "$qualification_root"
runtime_root=""
cleanup(){
  status=$?; cleanup_status=0; down_status=0
  if [[ -f "$artifact_root/fullstack-target.json" ]]; then
    # Collect only existing declared runtime services; one-shot migrate may be absent.
    if timeout --kill-after=5s 30s docker ps -a --format json >"$artifact_root/development-final-log-containers.json" 2>"$artifact_root/development-final-log-collection.log" &&
       node - "${qualification_root:-}/development-compose.json" "$artifact_root/development-final-log-containers.json" "$project" >"$artifact_root/development-final-log-services.txt" 2>>"$artifact_root/development-final-log-collection.log" <<'NODE'
const fs=require('node:fs'),[configPath,inventoryPath,project]=process.argv.slice(2),config=JSON.parse(fs.readFileSync(configPath)),rows=JSON.parse(fs.readFileSync(inventoryPath));
if(!Array.isArray(rows))throw new Error('Log container inventory malformed.');
const services=new Set();
for(const row of rows){let labels=row.Labels??row.labels??{};if(typeof labels==='string')labels=Object.fromEntries(labels.split(',').filter(part=>part.includes('=')).map(part=>part.split(/=(.*)/s).slice(0,2)));if(labels['com.docker.compose.project']!==project&&labels['io.podman.compose.project']!==project)continue;const service=labels['com.docker.compose.service']??labels['io.podman.compose.service'];if(service!=='migrate'&&/^[a-z][a-z0-9-]*$/.test(service)&&Object.hasOwn(config.services,service))services.add(service);}
for(const service of [...services].sort())console.log(service);
NODE
    then
      mapfile -t log_services <"$artifact_root/development-final-log-services.txt"
      if (( ${#log_services[@]} )); then
        timeout --kill-after=5s 30s "${compose[@]}" --profile ops logs --tail 120 "${log_services[@]}" >"$artifact_root/development-runtime-final.log" 2>&1 || true
      fi
    fi
    timeout --kill-after=5s 60s "${compose[@]}" --profile ops down -v --remove-orphans >"$artifact_root/development-cleanup.log" 2>&1 || down_status=$?
  fi
  # The adapter fixes every read to this controller run's private store. Keep
  # the short runroot available until independent readback proves no survivor.
  containers_status=0; volumes_status=0; networks_status=0
  timeout --kill-after=5s 30s docker ps -a --format json >"$artifact_root/development-cleanup-containers.json" 2>"$artifact_root/development-cleanup-containers.log" || containers_status=$?
  timeout --kill-after=5s 30s docker volume ls --format json >"$artifact_root/development-cleanup-volumes.json" 2>"$artifact_root/development-cleanup-volumes.log" || volumes_status=$?
  timeout --kill-after=5s 30s docker network ls --format json >"$artifact_root/development-cleanup-networks.json" 2>"$artifact_root/development-cleanup-networks.log" || networks_status=$?
  python3 - "$artifact_root" "$project" "$CI_RUN_ID" "$CI_COMMIT_SHA" "$runtime_root" "$status" "$down_status" "$containers_status" "$volumes_status" "$networks_status" <<'PY' || cleanup_status=$?
import datetime, errno, json, socket, sys
from pathlib import Path
root, project, run_id, source_sha, runtime_root = sys.argv[1:6]
primary_status, down_status, *read_statuses = map(int, sys.argv[6:])
root = Path(root)
absence = {}
errors = []
for resource, read_status in zip(('containers', 'volumes', 'networks'), read_statuses):
    absent = False
    if read_status == 0:
        try:
            rows = json.loads((root / f'development-cleanup-{resource}.json').read_text())
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ValueError('invalid inventory')
            def owned(row):
                labels = row.get('Labels', row.get('labels', {})) or {}
                if isinstance(labels, str):
                    labels = dict(part.split('=', 1) for part in labels.split(',') if '=' in part)
                if not isinstance(labels, dict):
                    raise ValueError('invalid labels')
                if any(labels.get(key) == project for key in ('com.docker.compose.project', 'io.podman.compose.project')):
                    return True
                names = row.get('Names', row.get('names', row.get('Name', row.get('name'))))
                if isinstance(names, str):
                    names = [names]
                if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
                    raise ValueError('invalid names')
                return any(name.lstrip('/') == project or name.lstrip('/').startswith((project + '_', project + '-')) for name in names)
            absent = not any(owned(row) for row in rows)
        except (OSError, ValueError, TypeError):
            errors.append(f'{resource}_inventory_unverified')
    else:
        errors.append(f'{resource}_readback_failed')
    absence[resource] = absent
ports = {}
for port in (4000, 8080, 18443):
    with socket.socket() as probe:
        probe.settimeout(1)
        ports[str(port)] = probe.connect_ex(('127.0.0.1', port)) == errno.ECONNREFUSED
passed = down_status == 0 and all(absence.values()) and all(ports.values()) and not errors
receipt = dict(version=1, runId=run_id, sourceSha=source_sha, project=project,
               completedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
               primaryExitCode=primary_status,
               cleanupCommand='timeout --kill-after=5s 60s docker compose --project-name <project> --env-file <run-private-env> -f <candidate-compose> --profile ops down -v --remove-orphans',
               cleanupAttempted=(root / 'fullstack-target.json').is_file(),
               cleanupExitCode=down_status,
               inventoryCommands=['docker ps -a --format json', 'docker volume ls --format json', 'docker network ls --format json'],
               inventoryExitCodes=dict(zip(('containers', 'volumes', 'networks'), read_statuses)),
               ownedResourceAbsence=absence, loopbackPortsClosed=ports,
               runtimeDirectory=runtime_root, runtimePreservationRequired=not passed,
               errors=errors, resourceAbsenceVerified=passed, cleanupVerified=False)
with (root / 'development-cleanup-receipt.json').open('x') as output:
    json.dump(receipt, output, indent=2)
    output.write('\n')
sys.exit(0 if passed else 1)
PY
  runtime_outcome=not-created
  if [[ "$cleanup_status" == 0 && -n "$runtime_root" && -d "$runtime_root" && ! -L "$runtime_root" && "$(cat "$runtime_root/owner")" == "$CI_RUN_ID" ]]; then
    runtime_outcome=removed
    rm -rf -- "$runtime_root" || { cleanup_status=$?; runtime_outcome=removal-failed; }
    if [[ -e "$runtime_root" ]]; then cleanup_status=1; runtime_outcome=removal-failed; fi
  elif [[ -n "$runtime_root" ]]; then
    runtime_outcome=preserved
    [[ "$cleanup_status" != 0 ]] || runtime_outcome=ownership-unverified
    cleanup_status=1
    printf 'Development cleanup is unverified; preserving run-owned runtime directory: %s\n' "$runtime_root" >&2
  fi
  python3 - "$artifact_root/development-cleanup-receipt.json" "$cleanup_status" "$runtime_outcome" <<'PY' || cleanup_status=$?
import datetime, json, sys
from pathlib import Path
path = Path(sys.argv[1])
status = int(sys.argv[2])
outcome = sys.argv[3]
receipt = json.loads(path.read_text())
receipt['runtimeDirectoryOutcome'] = outcome
receipt['runtimeDirectoryRemoved'] = outcome == 'removed'
receipt['runtimePreservationRequired'] = outcome in ('preserved', 'removal-failed', 'ownership-unverified')
receipt['cleanupVerified'] = receipt['resourceAbsenceVerified'] and status == 0 and outcome in ('removed', 'not-created')
receipt['finalCleanupExitCode'] = status
receipt['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
if outcome in ('removal-failed', 'ownership-unverified'):
    receipt['errors'].append('runtime_' + outcome.replace('-', '_'))
temporary = path.with_suffix('.final.json')
with temporary.open('x') as output:
    json.dump(receipt, output, indent=2)
    output.write('\n')
temporary.replace(path)
PY
  trap - EXIT
  if [[ "$status" == 0 && "$cleanup_status" != 0 ]]; then exit "$cleanup_status"; fi
  exit "$status"
}
trap cleanup EXIT
# Unix sockets require a short path; image/volume storage remains in the bounded controller store.
runtime_root=$(mktemp -d /tmp/llr.XXXXXX)
printf '%s\n' "$CI_RUN_ID" >"$runtime_root/owner"
mkdir "$runtime_root/containers"
export XDG_RUNTIME_DIR="$runtime_root" LUNCHLINEUP_DEV_RUNTIME="$runtime_root"
node "$build_root/scripts/write-internal-beta-qualification-env.mjs" --source-context "$context" --output "$env_file" --public-build-config "$artifact_root/public-build-config.json" --secrets-dir "$qualification_root/secrets"
"${compose[@]}" --profile ops config --format json >"$artifact_root/compose-config.json"
python3 "$build_root/scripts/check-internal-ci-target.py" fullstack
node - "$artifact_root/compose-config.json" "$artifact_root/development-images.tsv" "$qualification_root/development-compose.json" "$artifact_root/development-network-policy.json" "$project" <<'NODE'
const fs=require('node:fs');const [configPath,out,runtimePath,policyPath,project]=process.argv.slice(2),config=JSON.parse(fs.readFileSync(configPath));
const selected=new Set();function include(name){if(selected.has(name))return;const service=config.services[name];if(!service)throw new Error(`Missing development service ${name}`);selected.add(name);for(const dep of Object.keys(service.depends_on??{})){if(dep==='pitr-wal-provider'&&String(config.services.postgres.environment.PITR_ENABLED)==='false')continue;include(dep);}}
for(const name of ['api-v2','web','worker','engine','proxy'])include(name);
const seen=new Set(),lines=[];for(const name of [...selected].sort()){const s=config.services[name];if(seen.has(s.image))continue;seen.add(s.image);lines.push([s.build?'build':'pull',name,s.image].join('\t'));}
fs.writeFileSync(out,lines.join('\n')+'\n',{flag:'wx'});
config.services=Object.fromEntries([...selected].map(name=>{const service=config.services[name];delete service.depends_on;return [name,service];}));
// Use the application's existing isolated browser-test throttle configuration.
Object.assign(config.services.api.environment,{NODE_ENV:'test',DATA_TARGET_ENV:'test',E2E_FULL_STACK:'1',E2E_PREAUTH_IP_LIMIT:'120',E2E_PREAUTH_IDENTIFIER_LIMIT:'30'});
// Only this disposable development wrapper admits the exact local HTTP origin
// to server authentication. Keep the optimized Next runtime in production mode.
if(process.env.LUNCHLINEUP_DEVELOPMENT_QA!=='1'||config.services.web.environment.NODE_ENV!=='production'||config.services.web.environment.NEXT_PUBLIC_APP_ORIGIN!=='http://127.0.0.1:8080'||config.services.web.environment.NEXT_PUBLIC_APP_URL!=='http://127.0.0.1:8080')throw new Error('Disposable web origin admission requires the exact local production-build configuration.');
Object.assign(config.services.web.environment,{LUNCHLINEUP_DEVELOPMENT_QA:'1',DATA_TARGET_ENV:'disposable',APP_ENV:'test',DEPLOY_ENV:'test'});
// Runtime isolation is independent of provider flags and synthetic credentials.
// Build/pull traffic remains unrestricted and needs separate qualification;
// these runtime receipts do not qualify or restrict build-time networking.
const usedNetworks=new Set(),servicePolicy={};
for(const [name,service] of Object.entries(config.services)){
  if(service.privileged===true||(service.cap_add??[]).some(cap=>['NET_ADMIN','ALL'].includes(String(cap).toUpperCase().replace(/^CAP_/,''))))throw new Error(`Unsafe runtime network privileges: ${name}`);
  if(service.network_mode&&service.network_mode!=='none')throw new Error(`Unapproved runtime network mode: ${name}`);
  const keys=Object.keys(service.networks??{});
  if(service.network_mode==='none'&&keys.length)throw new Error(`Conflicting runtime networks: ${name}`);
  if(service.network_mode!=='none'&&!keys.length)throw new Error(`Implicit runtime network is forbidden: ${name}`);
  for(const key of keys)usedNetworks.add(key);
  for(const port of service.ports??[]){
    if(!port||typeof port!=='object'||port.host_ip!=='127.0.0.1'||!['4000','8080','18443'].includes(String(port.published))||port.protocol!=='tcp')throw new Error(`Unapproved runtime published port: ${name}`);
  }
  servicePolicy[name]={networkMode:service.network_mode??'named-internal',networks:keys,publishedPorts:(service.ports??[]).map(port=>({hostIp:port.host_ip,published:String(port.published),target:port.target,protocol:port.protocol}))};
}
config.networks=Object.fromEntries([...usedNetworks].sort().map(key=>{
  const network=config.networks?.[key],name=`${project}_${key}`;
  if(!/^[a-z][a-z0-9_-]*$/.test(key)||!network||network.external===true||(network.driver??'bridge')!=='bridge'||(network.name&&network.name!==name))throw new Error(`Unapproved runtime network: ${key}`);
  return [key,{...network,name,driver:'bridge',internal:true,enable_ipv6:false,driver_opts:{isolate:'true'}}];
}));
config.name=project;
fs.writeFileSync(policyPath,JSON.stringify({version:1,runId:process.env.CI_RUN_ID,sourceSha:process.env.CI_COMMIT_SHA,project,externalEgress:'denied',requiredBackend:'netavark',networks:Object.entries(config.networks).map(([key,network])=>({key,name:network.name,driver:'bridge',internal:true,isolate:'true',ipv6:false})),services:servicePolicy},null,2)+'\n',{flag:'wx',mode:0o600});
fs.writeFileSync(runtimePath,JSON.stringify(config),{flag:'wx',mode:0o600});
NODE
export LUNCHLINEUP_DEV_COMPOSE="$qualification_root/development-compose.json"
build_image(){
  local action=$1 service=$2 image=$3
  printf 'Development image: %s\n' "$service"
  if [[ "$action" == build ]]; then "${compose[@]}" --profile ops build "$service"; else docker pull "$image"; fi
  docker image inspect --format '{{.Id}}' "$image"
}
prepare_runtime_networks(){
  timeout --kill-after=5s 30s docker info --format json >"$artifact_root/development-network-backend.json"
  node - "$artifact_root/development-network-policy.json" "$artifact_root/development-network-backend.json" "$artifact_root/fullstack-target.json" <<'NODE'
const fs=require('node:fs');const [policyPath,infoPath,targetPath]=process.argv.slice(2),policy=JSON.parse(fs.readFileSync(policyPath)),info=JSON.parse(fs.readFileSync(infoPath)),target=JSON.parse(fs.readFileSync(targetPath));
if(info.host?.networkBackend!=='netavark'||info.store?.graphRoot!==target.store||policy.runId!==target.runId||policy.sourceSha!==target.sourceSha||policy.project!==target.project||!policy.networks.length)throw new Error('Runtime network backend/store/policy is unverified; no application startup is allowed.');
NODE
  mapfile -t runtime_networks < <(node -e 'for(const network of JSON.parse(require("fs").readFileSync(process.argv[1])).networks)console.log(network.name)' "$artifact_root/development-network-policy.json")
  [[ "${#runtime_networks[@]}" -gt 0 ]] || return 1
  for network in "${runtime_networks[@]}"; do
    if timeout --kill-after=5s 30s docker network exists "$network"; then
      echo 'Refusing a pre-existing runtime network.' >&2; return 1
    else
      network_status=$?; [[ "$network_status" == 1 ]] || return "$network_status"
    fi
    timeout --kill-after=5s 30s docker network create --internal --label "io.podman.compose.project=$project" --label "com.docker.compose.project=$project" --driver bridge --opt isolate=true "$network" >/dev/null
    timeout --kill-after=5s 30s docker network inspect "$network" >"$artifact_root/development-network-inspect-$network.json"
  done
  node - "$artifact_root/development-network-policy.json" "$artifact_root" <<'NODE'
const fs=require('node:fs'),crypto=require('node:crypto');const [policyPath,root]=process.argv.slice(2),policy=JSON.parse(fs.readFileSync(policyPath)),bindings=[];
for(const expected of policy.networks){
  const bytes=fs.readFileSync(`${root}/development-network-inspect-${expected.name}.json`),rows=JSON.parse(bytes);
  if(!Array.isArray(rows)||rows.length!==1)throw new Error('Runtime network inspection is incomplete.');
  const actual=rows[0];
  if(actual.name!==expected.name||actual.driver!=='bridge'||actual.internal!==true||actual.dns_enabled!==true||actual.ipv6_enabled!==false||String(actual.options?.isolate)!=='true'||actual.labels?.['io.podman.compose.project']!==policy.project||actual.labels?.['com.docker.compose.project']!==policy.project)throw new Error(`Runtime network isolation is unverified: ${expected.name}`);
  if(!/^[a-f0-9]{64}$/.test(actual.id))throw new Error('Runtime network immutable ID is missing.');
  bindings.push({name:expected.name,networkId:actual.id,inspectionSha256:crypto.createHash('sha256').update(bytes).digest('hex'),inspectionBytes:bytes.length,internal:true,dnsEnabled:true,ipv6Enabled:false});
}
fs.writeFileSync(`${root}/development-network-readiness.json`,JSON.stringify({version:1,runId:policy.runId,sourceSha:policy.sourceSha,project:policy.project,checkedAt:new Date().toISOString(),runtimeStarted:false,externalEgress:'denied',backend:'netavark',networks:bindings},null,2)+'\n',{flag:'wx',mode:0o600});
NODE
}
verify_runtime_attachments(){
  local phase=$1 required=$2
  [[ "$phase" =~ ^(early-api|pre-fixtures)$ ]] || return 64
  mkdir -- "$artifact_root/development-runtime-network-$phase"
  node - "$qualification_root/development-compose.json" "$artifact_root/development-network-policy.json" "$artifact_root/development-network-readiness.json" "$artifact_root/development-runtime-network-$phase" "$phase" "$required" <<'NODE'
const fs=require('node:fs'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const [configPath,policyPath,networkProofPath,root,phase,required]=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(configPath)),policy=JSON.parse(fs.readFileSync(policyPath)),networkProof=JSON.parse(fs.readFileSync(networkProofPath));
if(policy.sourceSha!==networkProof.sourceSha||policy.runId!==networkProof.runId||policy.project!==networkProof.project)throw new Error('Runtime network proof identity changed.');
const networkIds=new Map(networkProof.networks.map(network=>[network.name,network.networkId])),services=new Set(),containers=[];
const secretValues=Object.values(config.services).flatMap(service=>Object.entries(service.environment??{}).filter(([key,value])=>/secret|token|password|credential|(?:^|_)key(?:$|_)/i.test(key)&&typeof value==='string'&&value.length>=4).map(([,value])=>value)).sort((a,b)=>b.length-a.length);
function redact(value){let text=String(value??'');for(const secret of secretValues)text=text.split(secret).join('[REDACTED]');return text;}
function read(args){
  const result=spawnSync('docker',args,{encoding:'utf8',timeout:30000,killSignal:'SIGKILL'});
  if(result.error||result.status!==0){write('failed-command.json',{command:'docker',args,status:result.status,signal:result.signal,error:result.error?redact(result.error.message):null,stdout:redact(result.stdout),stderr:redact(result.stderr)});throw new Error(`Private container readback failed: ${args[0]}`);}
  return result.stdout;
}
function json(args){try{return JSON.parse(read(args));}catch{throw new Error(`Private container JSON readback failed: ${args[0]}`);}}
function write(name,value){const bytes=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';fs.writeFileSync(`${root}/${name}`,bytes,{flag:'wx',mode:0o600});return {artifact:name,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:Buffer.byteLength(bytes)};}
const inventory=json(['ps','--no-trunc','--format','json']);
if(!Array.isArray(inventory))throw new Error('Private container inventory is malformed.');
for(const row of inventory){
  if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Private container inventory row is malformed.');
  let labels=row.Labels??row.labels??{};
  if(typeof labels==='string')labels=Object.fromEntries(labels.split(',').filter(part=>part.includes('=')).map(part=>part.split(/=(.*)/s).slice(0,2)));
  if(!labels||typeof labels!=='object'||Array.isArray(labels))throw new Error('Private container inventory labels are malformed.');
  const names=row.Names??row.names??row.Name??row.name,list=Array.isArray(names)?names:[names];
  if(!list.length||list.some(name=>typeof name!=='string'||!name))throw new Error('Private container inventory names are malformed.');
  const owned=labels['com.docker.compose.project']===policy.project||labels['io.podman.compose.project']===policy.project||list.some(name=>typeof name==='string'&&(name===policy.project||name.startsWith(policy.project+'_')||name.startsWith(policy.project+'-')));
  if(!owned)continue;
  const id=row.Id??row.ID??row.id;
  if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Runtime container immutable ID is missing.');
  const rawInspect=read(['inspect',id]),rawInspection=write(`${id}-raw-inspect.json`,rawInspect);
  let rows;try{rows=JSON.parse(rawInspect);}catch{throw new Error('Runtime container inspection JSON is malformed.');}
  if(!Array.isArray(rows)||rows.length!==1)throw new Error('Runtime container inspection is incomplete.');
  const actual=rows[0],boundLabels=actual.Config?.Labels??{},service=boundLabels['com.docker.compose.service']??boundLabels['io.podman.compose.service'];
  if(actual.Id!==id||actual.State?.Running!==true||boundLabels['com.docker.compose.project']!==policy.project||!Object.hasOwn(policy.services,service)||services.has(service))throw new Error('Unexpected, duplicate, or inactive runtime container.');
  services.add(service);
  const declared=policy.services[service],networks=actual.NetworkSettings?.Networks??{};
  let attachments=Object.keys(networks).sort();
  // Podman 5.4.2 emits a zero-valued none pseudo-network via setDefaultNetworks:
  // https://github.com/containers/podman/blob/v5.4.2/libpod/networking_common.go#L222-L265
  // Dummy field schema: https://github.com/containers/podman/blob/v5.4.2/libpod/define/container_inspect.go#L660-L706
  if(declared.networkMode==='none'){
    if(actual.HostConfig?.NetworkMode!=='none')throw new Error('Parser network mode is not none.');
    if(attachments.length){
      const dummy=networks.none,strings=new Set(['EndpointID','Gateway','IPAddress','IPv6Gateway','GlobalIPv6Address','MacAddress']),prefixes=new Set(['IPPrefixLen','GlobalIPv6PrefixLen']),arrays=new Set(['Aliases','Links','SecondaryIPAddresses','SecondaryIPv6Addresses','AdditionalMACAddresses']),maps=new Set(['DriverOpts','IPAMConfig']);
      const zero=(key,value)=>strings.has(key)?value==='':prefixes.has(key)?value===0:arrays.has(key)?value===null||(Array.isArray(value)&&value.length===0):maps.has(key)?value===null||(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0):false;
      if(attachments.length!==1||attachments[0]!=='none'||!dummy||typeof dummy!=='object'||Array.isArray(dummy)||dummy.NetworkID!=='none'||Object.entries(dummy).some(([key,value])=>key!=='NetworkID'&&!zero(key,value)))throw new Error('Parser none pseudo-network is not an empty Podman dummy.');
      attachments=[];
    }
  }
  const expected=declared.networks.map(key=>config.networks[key].name).sort();
  if(JSON.stringify(attachments)!==JSON.stringify(expected))throw new Error(`Unexpected runtime network attachment: ${service}`);
  if(declared.networkMode==='none'&&actual.HostConfig?.NetworkMode!=='none')throw new Error('Parser network mode is not none.');
  for(const name of attachments)if(networks[name].NetworkID!==networkIds.get(name))throw new Error('Runtime container attached to a replaced or unverified network.');
  const imageRows=json(['image','inspect',config.services[service].image]);
  if(!Array.isArray(imageRows)||imageRows.length!==1)throw new Error('Runtime image inspection is incomplete.');
  const normalized=value=>String(value).replace(/^sha256:/,'');
  const imageId=normalized(actual.Image);
  if(!/^[a-f0-9]{64}$/.test(imageId)||imageId!==normalized(imageRows[0].Id))throw new Error('Runtime container image differs from its current declared image.');
  const routeReader=['engine','worker','pdf-parser'].includes(service)?['/opt/venv/bin/python','-c','import pathlib, sys; sys.stdout.write(pathlib.Path(sys.argv[1]).read_text())']:['cat'];
  const v4=read(['exec',id,...routeReader,'/proc/net/route']),v6=read(['exec',id,...routeReader,'/proc/net/ipv6_route']);
  const ipv4Routes=write(`${service}-ipv4-routes.txt`,v4),ipv6Routes=write(`${service}-ipv6-routes.txt`,v6);
  let interfaces=null;
  if(declared.networkMode==='none'){
    const dev=read(['exec',id,...routeReader,'/proc/net/dev']);interfaces=write(`${service}-interfaces.txt`,dev);
    const lines=dev.trim().split('\n');
    if(lines.length<3||!/^Inter-/.test(lines[0])||!lines[1].includes('face'))throw new Error('Parser interface readback is malformed.');
    const names=lines.slice(2).map(line=>{const match=line.match(/^\s*([^: ]+):\s*(.*)$/);if(!match||match[2].trim().split(/\s+/).length!==16||!match[2].trim().split(/\s+/).every(value=>/^\d+$/.test(value)))throw new Error('Parser interface readback is malformed.');return match[1];});
    if(JSON.stringify(names)!==JSON.stringify(['lo']))throw new Error('Parser has a non-loopback interface.');
  }
  const v4Rows=v4.trim().split('\n');
  if(!/^Iface\s+Destination\s+Gateway\s+Flags/.test(v4Rows.shift()??''))throw new Error('IPv4 route readback is malformed.');
  if(declared.networkMode==='none'&&v4Rows.length)throw new Error('Parser has IPv4 route entries.');
  for(const line of v4Rows){const fields=line.trim().split(/\s+/);if(fields.length<8||! /^[a-f0-9]{8}$/i.test(fields[1])||! /^[a-f0-9]{8}$/i.test(fields[7]))throw new Error('IPv4 route readback is malformed.');if(fields[1]==='00000000'&&fields[7]==='00000000')throw new Error(`IPv4 default route remains: ${service}`);}
  for(const line of v6.split('\n').filter(line=>line.trim())){const fields=line.trim().split(/\s+/);if(fields.length!==10||! /^[a-f0-9]{32}$/i.test(fields[0])||! /^[a-f0-9]{2}$/i.test(fields[1])||! /^[a-f0-9]{8}$/i.test(fields[8]))throw new Error('IPv6 route readback is malformed.');if(declared.networkMode==='none'&&fields[9]!=='lo')throw new Error('Parser IPv6 route has non-loopback interface.');const rejected=(parseInt(fields[8],16)&0x200)!==0;if(/^0{32}$/.test(fields[0])&&fields[1]==='00'&&!rejected)throw new Error(`Usable IPv6 default route remains: ${service}`);}
  const inspectProof=write(`${service}-attachment.json`,{containerId:id,project:policy.project,service,imageRef:config.services[service].image,imageId:'sha256:'+imageId,networkMode:actual.HostConfig?.NetworkMode,attachments:attachments.map(name=>({name,networkId:networks[name].NetworkID})),running:true});
  containers.push({service,containerId:id,imageId:'sha256:'+imageId,attachments:inspectProof,rawInspection,interfaces,ipv4Routes,ipv6Routes,noIpv4DefaultRoute:true,noUsableIpv6DefaultRoute:true});
}
for(const service of required.split(','))if(!services.has(service))throw new Error(`Required runtime service is missing: ${service}`);
write('proof.json',{version:1,runId:policy.runId,sourceSha:policy.sourceSha,project:policy.project,phase,checkedAt:new Date().toISOString(),scope:'running-application-containers-only',buildTrafficQualified:false,noExternalProbePerformed:true,containers});
NODE
}
# Prove fresh database setup before spending time building application images.
while IFS=$'\t' read -r action service image; do
  case "$service" in migrate|postgres|redis|rabbitmq|pitr-wal-provider) build_image "$action" "$service" "$image";; esac
done <"$artifact_root/development-images.tsv" >"$artifact_root/development-build.log" 2>&1
# All networks are internal and independently inspected before any runtime starts.
prepare_runtime_networks
if awk -F '\t' '$2 == "pitr-wal-provider" { found=1 } END { exit !found }' "$artifact_root/development-images.tsv"; then
  "${compose[@]}" --profile ops up -d --no-build --no-deps pitr-wal-provider >"$artifact_root/development-start.log" 2>&1
fi
"${compose[@]}" --profile ops up -d --no-build --no-deps postgres redis rabbitmq >"$artifact_root/development-start.log" 2>&1
for attempt in {1..60}; do
  if "${compose[@]}" exec -T postgres pg_isready -U lunchlineup_ci_admin -d lunchlineup_ci >/dev/null 2>&1; then break; fi
  [[ "$attempt" != 60 ]] || { "${compose[@]}" logs --tail 80 >"$artifact_root/development-runtime.log" 2>&1; exit 1; }
  sleep 2
done
"${compose[@]}" --profile ops run --rm --no-deps -e NODE_ENV=test -e APP_ENV=test -e DEPLOY_ENV=test -e NEXT_PUBLIC_APP_ENV=test migrate >"$artifact_root/development-migrations.log" 2>&1
while IFS=$'\t' read -r action service image; do
  case "$service" in migrate|postgres|redis|rabbitmq|pitr-wal-provider) continue;; esac
  build_image "$action" "$service" "$image"
  if [[ "$service" == api ]]; then
    "${compose[@]}" --profile ops up -d --no-build --no-deps api >>"$artifact_root/development-start.log" 2>&1
    for attempt in {1..60}; do
      if curl --silent --fail --max-time 3 http://127.0.0.1:4000/live >/dev/null; then break; fi
      [[ "$attempt" != 60 ]] || { echo 'Retained API startup failed'; exit 1; }
      sleep 2
    done
    verify_runtime_attachments early-api api,postgres,redis,rabbitmq
  fi
done <"$artifact_root/development-images.tsv" >>"$artifact_root/development-build.log" 2>&1
"${compose[@]}" --profile ops up -d --no-build --no-deps engine api api-v2 pdf-parser worker web proxy >>"$artifact_root/development-start.log" 2>&1
for attempt in {1..120}; do
  status=$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080/auth/login || true)
  api_status=$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080/api/v2/ready || true)
  if [[ "$status" == 200 && "$api_status" == 200 ]]; then break; fi
  [[ "$attempt" != 120 ]] || { "${compose[@]}" logs --tail 80 >"$artifact_root/development-runtime.log" 2>&1; exit 1; }
  sleep 2
done
verify_runtime_attachments pre-fixtures engine,api,api-v2,pdf-parser,worker,web,proxy,postgres,redis,rabbitmq
output="$artifact_root/fullstack-playwright"; mkdir -- "$output"
cd "$build_root/apps/web"
BASE_URL=http://127.0.0.1:8080 E2E_FULL_STACK=1 E2E_MOCK_API=0 E2E_SIGNUP_MODE=closed_beta E2E_COMPOSE_PROJECT_NAME="$project" E2E_COMPOSE_ENV_FILE="$env_file" E2E_CANDIDATE_SHA="$CI_COMMIT_SHA" E2E_ARTIFACT_ROOT="$output" PLAYWRIGHT_JSON_OUTPUT_NAME="$output/results.json" npx playwright test --reporter=json --grep='@full-stack' --project=chromium --workers=1 --retries=0 --trace=retain-on-failure tests/e2e/operations-workflows.spec.ts tests/e2e/month-volume-workflows.spec.ts tests/e2e/stress-workflows.spec.ts tests/e2e/tenant-admin-workflows.spec.ts tests/e2e/staff-repair-acceptance.spec.ts tests/e2e/settings-recovery-acceptance.spec.ts >"$output/test.log" 2>&1
node - "$output/results.json" <<'NODE'
const report=JSON.parse(require('node:fs').readFileSync(process.argv[2]));const s=report.stats;
if(!s||!(s.expected>0)||s.unexpected!==0||s.skipped!==0||s.flaky!==0)throw new Error('Development browser acceptance failed or incomplete');
console.log(JSON.stringify({developmentBrowserAcceptance:'passed',...s}));
NODE

# Development interaction evidence uses the actual candidate and built web image.
# It is deliberately not promoted as a release-qualified interaction receipt.
interaction="$artifact_root/development-interaction"; mkdir -- "$interaction"
web_image=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).services.web.image)' "$artifact_root/compose-config.json")
web_id=$(docker image inspect --format '{{.Id}}' "$web_image")
BASE_URL=http://127.0.0.1:8080 E2E_FULL_STACK=1 E2E_MOCK_API=0 E2E_SIGNUP_MODE=closed_beta E2E_COMPOSE_PROJECT_NAME="$project" E2E_COMPOSE_ENV_FILE="$env_file" E2E_CANDIDATE_SHA="$CI_COMMIT_SHA" E2E_CANDIDATE_TREE_SHA="$(git -C "$build_root" rev-parse 'HEAD^{tree}')" E2E_WEB_IMAGE_ID="$web_id" E2E_INTERACTION_PROOF_ROOT="$interaction" PLAYWRIGHT_JSON_OUTPUT_NAME="$interaction/results.json" npx playwright test --reporter=json --config=playwright.interaction-proof.config.ts --workers=1 --retries=0 >"$interaction/test.log" 2>&1
node - "$interaction/results.json" <<'NODE'
const report=JSON.parse(require('node:fs').readFileSync(process.argv[2]));const s=report.stats;
if(!s||!(s.expected>0)||s.unexpected!==0||s.skipped!==0||s.flaky!==0)throw new Error('Development interaction acceptance failed or incomplete');
console.log(JSON.stringify({developmentInteractionAcceptance:'passed',releaseQualified:false,...s}));
NODE
