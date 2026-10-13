"""KPT266 finite mutation-plan data contract; never an authority or executor.

Not registered in an installed role table. Future pinned owner code must bind
these validated bytes to independent policy and actual admission. No CLI, input
file loading, credential/FD adoption, process, network or mutation API exists.
Existing read-only request/grant and workers remain separate and unchanged.
"""
import hashlib
import json
import re

MAX_BYTES = 1048576
SERVICES = frozenset(('proxy', 'web', 'api', 'webhook-replay', 'migrate', 'engine',
    'pdf-parser', 'worker', 'pgbouncer', 'pitr-wal-provider', 'api-v2',
    'pitr-lifecycle-audit', 'postgres', 'redis', 'rabbitmq', 'control', 'autoheal',
    'prometheus', 'backup', 'pitr-base-backup', 'pitr-restore', 'alertmanager',
    'node-exporter', 'loki', 'promtail', 'otel-collector', 'tempo', 'grafana'))
# Operation -> exact resource kind. These are contracts, not admitted APIs.
OPERATIONS = {
    'image-import': 'image', 'image-tag': 'image',
    'network-create': 'network', 'volume-create': 'volume',
    'container-create': 'container', 'container-start': 'container',
    'container-stop': 'container', 'migration-run': 'container',
    'observe': 'container', 'snapshot-export': 'source-database',
    'snapshot-encrypt': 'scratch', 'snapshot-decrypt': 'scratch',
    'scratch-create': 'scratch', 'scratch-remove': 'scratch',
    'restore-database-create': 'restore-database',
    'restore-apply': 'restore-database', 'restore-compare': 'restore-database',
    'restore-database-drop': 'restore-database', 'proof-publish': 'proof',
}
BACKUP = frozenset(('snapshot-export', 'snapshot-encrypt', 'snapshot-decrypt',
    'scratch-create', 'scratch-remove', 'restore-database-create', 'restore-apply',
    'restore-compare', 'restore-database-drop', 'proof-publish'))
ACTIONS = {
    'load': frozenset(('image-import', 'image-tag')),
    'start': frozenset(('network-create', 'volume-create', 'container-create',
        'container-start', 'container-stop', 'migration-run', 'observe', 'proof-publish')),
    'verify': frozenset(('observe', 'proof-publish')),
    'pause': frozenset(('container-stop', 'observe', 'proof-publish')),
    'backup-proof': BACKUP,
}
CLEANUP = {'scratch-create': 'scratch-remove',
           'restore-database-create': 'restore-database-drop'}
RECEIPTS = frozenset(('intent', 'dispatch', 'effect', 'children-settled',
    'backend-settled', 'cleanup', 'terminal'))
# Hard contract ceilings, not measurements or additional time allowances.
OPERATION_LIMITS = {
    name: {'count': (21 if name == 'image-import' else 42 if name == 'image-tag'
                    else 84 if name == 'observe' else 28 if name.startswith('container-')
                    else 17 if name == 'volume-create' else 16 if name == 'network-create' else 1),
           'maximumMs': (90000 if name in ('image-import', 'snapshot-export', 'restore-apply')
                         else 30000 if name in ('container-start', 'migration-run', 'snapshot-encrypt',
                                               'snapshot-decrypt', 'restore-compare') else 10000),
           'requestBytes': (32 * 1024**3 if name == 'image-import' else 65536),
           'responseBytes': (16 * 1024**2 if name == 'observe' else 1048576)}
    for name in OPERATIONS
}


# Exact candidate logical names, not caller-selected Docker names/options.
VOLUME_OPTIONS = {name: {} for name in (
    'caddy_data', 'caddy_config', 'postgres_data', 'postgres_pitr_restore_data',
    'backup_data', 'redis_data', 'rabbitmq_data', 'pitr_staging', 'prometheus_data',
    'alertmanager_data', 'loki_data', 'promtail_positions', 'tempo_data',
    'grafana_data', 'tenant_export_artifacts')}
VOLUME_OPTIONS.update({
    'availability_uploads': {'type': 'tmpfs', 'device': 'tmpfs',
        'o': 'size=268435456,mode=0777,noexec,nosuid,nodev'},
    'parser_ipc': {'type': 'tmpfs', 'device': 'tmpfs',
        'o': 'size=1048576,mode=0700,uid=65532,gid=65532,noexec,nosuid,nodev'},
})
# These exact candidate configurations conflict with the retained boundary.
# Inventory remains mandatory; no operation can silently substitute a recipe.
UNSUPPORTED_CONTAINER_SERVICES = frozenset(('autoheal', 'node-exporter'))
BACKUP_ARTIFACT_PHASES = {
    'snapshot-export': ('', 'plain'),
    'snapshot-encrypt': ('plain', 'encrypted'),
    'snapshot-decrypt': ('encrypted', 'recovered'),
    'restore-apply': ('recovered', ''),
}


class Refusal(ValueError):
    pass


def require(ok, why):
    if not ok:
        raise Refusal(why)


def closed(value, fields):
    require(type(value) is dict and set(value) == set(fields), 'closed contract fields')


def integer(value, low, high):
    require(type(value) is int and low <= value <= high, 'contract integer bound')


def sha(value):
    require(type(value) is str and re.fullmatch('[a-f0-9]{64}', value), 'SHA256 required')


def identifier(value):
    require(type(value) is str and re.fullmatch('[a-z][a-z0-9-]{0,63}', value), 'finite identifier')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=True, allow_nan=False).encode('ascii')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def parse_plan(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES, 'plan byte bound')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate plan field')
            result[key] = value
        return result
    def invalid(_):
        raise Refusal('noninteger JSON number')
    value = json.loads(raw.decode('ascii'), object_pairs_hook=pairs,
                       parse_float=invalid, parse_constant=invalid)
    require(canonical(value) == raw, 'canonical plan bytes required')
    return value



PRIVATE_CADDY_SHA256 = '166c836aca2877fa5224dd1858ea9b025e1c03e472b5b8b8bb68b1af60fdc31b'
PRIVATE_PROXY_OVERLAY_SHA256 = 'e9d95845bcbc74c34a269e3c99cc0338a51245b846599ad15ca0eb03ab52dd29'
BASE_COMPOSE_SHA256 = '1cd8749a1b244ba4bafe15b03ca6ca83c6d347e1759325da91af43b956f2a943'


def validate_proxy_recipes(plan, resources, inputs):
    """Exact closed normalized recipe, still not effective-config authentication.

    Future pinned adapter must derive this complete representation from actual
    effective config and reject unrepresentable settings, never trust a request
    projection that omits extra mounts/ports/security settings. Dispatch refuses.
    """
    recipes = plan['proxyRecipes']
    proxies = {name for name, item in resources.items()
               if item['kind'] == 'container' and item['service'] == 'proxy'}
    require(type(recipes) is dict and set(recipes) == proxies and len(proxies) <= 1,
            'exact one-or-zero private proxy resource recipe')
    for name, recipe in recipes.items():
        closed(recipe, ('kind', 'baseComposeInput', 'overlayInput', 'caddyInput',
            'imageFactsInput', 'installedIngressInput', 'effective', 'networkResources'))
        require(recipe['kind'] == 'private-proxy-http8080-v1', 'only compatible private proxy recipe')
        for rolekey in ('baseComposeInput', 'overlayInput', 'caddyInput', 'imageFactsInput', 'installedIngressInput'):
            require(type(recipe[rolekey]) is str and recipe[rolekey] in inputs, 'held proxy input required')
        for rolekey, expected in (('baseComposeInput', BASE_COMPOSE_SHA256),
                ('overlayInput', PRIVATE_PROXY_OVERLAY_SHA256), ('caddyInput', PRIVATE_CADDY_SHA256)):
            require(inputs[recipe[rolekey]]['sha256'] == expected, 'exact private recipe source bytes')
        closed(recipe['networkResources'], ('app', 'external'))
        network_names = list(recipe['networkResources'].values())
        require(all(type(name) is str and name in resources and resources[name]['kind'] == 'network'
                    for name in network_names) and len(set(network_names)) == 2,
                'proxy exact distinct network resources')
        effective = recipe['effective']
        closed(effective, ('imageId', 'artifactSha256', 'environment', 'capAdd', 'capDrop',
            'securityOpt', 'readOnly', 'cpuNano', 'memoryBytes', 'pidsLimit', 'nofile',
            'logging', 'tmpfs', 'ports', 'mounts', 'networks', 'healthcheck', 'restart',
            'privileged', 'hostNamespaces', 'devices', 'dockerSocket', 'commandOverride',
            'entrypointOverride', 'userOverride', 'sysctls', 'extraHosts'))
        sha(effective['imageId']); sha(effective['artifactSha256'])
        require(effective['artifactSha256'] == plan['services']['proxy']['artifactSha256'], 'proxy selected artifact')
        env = effective['environment']
        closed(env, ('PRIVATE_APP_HOST', 'CADDY_SITE_ADDRESSES', 'ADMIN_EMAIL', 'DEPLOY_RELEASE_SHA'))
        require(env['PRIVATE_APP_HOST'] == 'dev.lunchlineup.com' and
                env['CADDY_SITE_ADDRESSES'] == 'http://dev.lunchlineup.com', 'canonical private site')
        require(type(env['ADMIN_EMAIL']) is str and 1 <= len(env['ADMIN_EMAIL']) <= 254 and
                all(32 <= ord(c) <= 126 for c in env['ADMIN_EMAIL']), 'bounded independently approved admin value')
        require(type(env['DEPLOY_RELEASE_SHA']) is str and
                re.fullmatch('[a-f0-9]{40}', env['DEPLOY_RELEASE_SHA']), 'exact selected release reference')
        # All non-selection fields are fixed; empty means absent, not inherited.
        expected = {
            'capAdd': [], 'capDrop': ['ALL'], 'securityOpt': ['no-new-privileges:true'],
            'readOnly': True, 'cpuNano': 1000000000, 'memoryBytes': 536870912, 'pidsLimit': 256,
            'nofile': {'soft': 4096, 'hard': 8192},
            'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '5'}},
            'tmpfs': ['/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777'],
            'ports': [{'hostIp': '10.231.10.108', 'published': 80, 'target': 8080, 'protocol': 'tcp'}],
            'mounts': [
                {'kind': 'held-bind', 'inputRole': recipe['caddyInput'], 'target': '/etc/caddy/Caddyfile', 'readOnly': True},
                {'kind': 'volume', 'logicalName': 'caddy_data', 'target': '/data', 'readOnly': False},
                {'kind': 'volume', 'logicalName': 'caddy_config', 'target': '/config', 'readOnly': False}],
            'networks': ['app', 'external'],
            'healthcheck': {'test': ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider',
                                   'http://127.0.0.1:2015/health'], 'intervalMs': 15000, 'timeoutMs': 5000, 'retries': 3},
            'restart': 'unless-stopped', 'privileged': False, 'hostNamespaces': [],
            'devices': [], 'dockerSocket': False, 'commandOverride': None,
            'entrypointOverride': None, 'userOverride': None, 'sysctls': {}, 'extraHosts': [],
        }
        actual = {key: effective[key] for key in expected}
        # Canonical comparison also distinguishes JSON booleans from integers.
        require(canonical(actual) == canonical(expected), 'exact compatible normalized private proxy configuration')
        require(plan['services']['proxy']['configSha256'] == digest(effective), 'full normalized proxy config digest')
        require(inputs[resources[name]['specInput']]['sha256'] == digest(recipe), 'proxy recipe immutable spec binding')
        # Volumes may already exist, but both need exact declared resource/spec
        # identities. Actual held mounting, ownership and backing are not inferred.
        require(all(any(spec['logicalName'] == logical for spec in plan['volumeSpecs'].values())
                    for logical in ('caddy_data', 'caddy_config')), 'both named proxy volumes inventoried')


def validate_plan(raw):
    """Validate finite declarations; return a non-authorizing obligation summary.

    No supplied digest, proof name, rights or owner reference is evidence of
    real custody. Host/native/guardian must independently implement and admit
    those obligations. This function cannot grant a mutation, even on success.
    """
    plan = parse_plan(raw)
    closed(plan, ('version', 'kind', 'action', 'requestSha256', 'selectionSha256',
        'authorityPolicySha256', 'ownerDecisionSha256', 'target', 'services',
        'inputs', 'resources', 'steps', 'budget', 'receiptObligations',
        'backupArtifacts', 'volumeSpecs', 'proxyRecipes'))
    require(type(plan['version']) is int and plan['version'] == 5 and
            plan['kind'] == 'development-mutation-plan', 'plan version/kind')
    require(type(plan['action']) is str and plan['action'] in ACTIONS,
            'unsupported action; physical PITR remains separately refused')
    for key in ('requestSha256', 'selectionSha256', 'authorityPolicySha256', 'ownerDecisionSha256'):
        sha(plan[key])
    target = plan['target']
    closed(target, ('estate', 'vmid', 'machineId', 'origin', 'project', 'guestBootId'))
    require(target['estate'] == 'Proxmox1' and type(target['vmid']) is int and target['vmid'] == 107 and
        target['machineId'] == '80a9dfd43bbc6a074cf9148daa5335c2' and
        target['origin'] == 'https://dev.lunchlineup.com', 'fixed private target')
    identifier(target['project'])
    require(target['project'] not in ('lunchlineup', 'lunchlineup-ux-20260907'), 'retained project forbidden')
    require(type(target['guestBootId']) is str and re.fullmatch(
        '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', target['guestBootId']), 'boot identity')
    services = plan['services']
    require(type(services) is dict and set(services) == SERVICES, 'complete 28-service inventory')
    for name, item in services.items():
        closed(item, ('artifactSha256', 'configSha256', 'profileSha256', 'disposition'))
        for key in ('artifactSha256', 'configSha256', 'profileSha256'):
            sha(item[key])
        require(item['disposition'] in ('required', 'deferred-separate-action'), 'service disposition')
    # Deferred recovery/profile services remain inventoried, never counted as passed.
    inputs = plan['inputs']
    require(type(inputs) is dict and 1 <= len(inputs) <= 256, 'input inventory bound')
    for role, item in inputs.items():
        identifier(role)
        closed(item, ('sha256', 'bytes', 'veritySha256'))
        sha(item['sha256']); sha(item['veritySha256']); integer(item['bytes'], 1, 64 * 1024**3)
    resources = plan['resources']
    require(type(resources) is dict and 1 <= len(resources) <= 256, 'resource inventory bound')
    for name, item in resources.items():
        identifier(name)
        closed(item, ('kind', 'project', 'service', 'specInput', 'precondition', 'identitySha256', 'retention'))
        require(item['kind'] in set(OPERATIONS.values()) and item['project'] == target['project'], 'resource kind/project')
        require(item['service'] in SERVICES and item['specInput'] in inputs, 'resource service/spec binding')
        require(item['precondition'] in ('absent', 'present'), 'resource precondition')
        if item['precondition'] == 'present':
            sha(item['identitySha256'])
        else:
            require(item['identitySha256'] == '', 'absent resource has no invented identity')
        require(item['retention'] in ('preserve', 'owned-temporary'), 'resource retention')
        if item['kind'] in ('scratch', 'restore-database'):
            require(item['retention'] == 'owned-temporary' and item['precondition'] == 'absent',
                    'restore/scratch must be new operation-owned resources')
        else:
            require(item['retention'] == 'preserve', 'no cleanup authority for retained resources')
        if item['kind'] == 'source-database':
            require(item['precondition'] == 'present', 'source database must exist')
    # Explicit closed candidates for every volume resource. No arbitrary options,
    # logical duplicates or aliases to another declared engine volume name.
    volume_specs = plan['volumeSpecs']
    volume_resources = {name for name, item in resources.items() if item['kind'] == 'volume'}
    require(type(volume_specs) is dict and set(volume_specs) == volume_resources,
            'every volume needs a closed candidate specification')
    logical_names = set(); engine_names = set()
    for name, spec in volume_specs.items():
        closed(spec, ('logicalName', 'engineName', 'driver', 'driverOpts'))
        logical = spec['logicalName']
        require(type(logical) is str and logical in VOLUME_OPTIONS and logical not in logical_names,
                'unique candidate logical volume')
        identifier(spec['engineName'])
        require(spec['engineName'] not in engine_names, 'distinct declared volume names')
        require(spec['driver'] == 'local' and type(spec['driverOpts']) is dict and
                spec['driverOpts'] == VOLUME_OPTIONS[logical], 'exact bounded candidate driver variant')
        # specInput binds these bytes; independently authenticated backing/owner
        # labels and observed incarnation are still required before dispatch.
        require(inputs[resources[name]['specInput']]['sha256'] == digest(spec),
                'volume immutable spec digest')
        logical_names.add(logical); engine_names.add(spec['engineName'])
    validate_proxy_recipes(plan, resources, inputs)
    backup_artifacts = plan['backupArtifacts']
    if plan['action'] == 'backup-proof':
        closed(backup_artifacts, ('scratchResource', 'plain', 'encrypted', 'recovered'))
        scratch = backup_artifacts['scratchResource']
        require(type(scratch) is str and scratch in resources and resources[scratch]['kind'] == 'scratch',
                'backup artifact scratch binding')
        artifact_ids = []
        for phase in ('plain', 'encrypted', 'recovered'):
            identifier(backup_artifacts[phase]); artifact_ids.append(backup_artifacts[phase])
        require(len(set(artifact_ids)) == 3, 'distinct scratch artifact roles')
    else:
        require(backup_artifacts is None, 'no ambient backup artifacts')
    budget = plan['budget']
    closed(budget, ('overallMs', 'admissionMs', 'terminationMs', 'terminalMs', 'cleanupMs', 'workingBytes', 'evidenceBytes'))
    integer(budget['overallMs'], 1, 180000)
    for key in ('admissionMs', 'terminationMs', 'terminalMs', 'cleanupMs'):
        integer(budget[key], 1, budget['overallMs'])
    require(budget['terminationMs'] >= 5000, 'reserve existing stop grace inside original budget')
    integer(budget['workingBytes'], 1, 32 * 1024**3)
    integer(budget['evidenceBytes'], 1, 16 * 1024**2)
    require(type(plan['receiptObligations']) is list and
            plan['receiptObligations'] == sorted(RECEIPTS), 'complete closed receipt obligations')
    steps = plan['steps']
    require(type(steps) is list and 1 <= len(steps) <= 512, 'step count bound')
    used = set(); operations = set(); cleanup_ms = 0; normal_ms = 0
    creates = {}; cleanups = {}; rights = []; ancestors = []; counts = {}
    for index, step in enumerate(steps):
        closed(step, ('index', 'operation', 'resource', 'dependsOn', 'inputRoles',
                      'maximumMs', 'requestBytes', 'responseBytes', 'phase', 'artifactFlow'))
        require(type(step['index']) is int and step['index'] == index, 'contiguous step order')
        operation = step['operation']; resource = step['resource']
        require(type(operation) is str and operation in ACTIONS[plan['action']], 'action-specific finite operation')
        limits = OPERATION_LIMITS[operation]
        counts[operation] = counts.get(operation, 0) + 1
        require(counts[operation] <= limits['count'], 'operation count ceiling')
        integer(step['requestBytes'], 1, limits['requestBytes'])
        integer(step['responseBytes'], 1, limits['responseBytes'])
        require(type(resource) is str and resource in resources and
                resources[resource]['kind'] == OPERATIONS[operation], 'operation resource kind')
        selected = resources[resource]
        if selected['kind'] == 'container':
            require(selected['service'] not in UNSUPPORTED_CONTAINER_SERVICES,
                    'candidate service policy unsupported; capability remains unqualified')
        flow = step['artifactFlow']
        if operation in BACKUP_ARTIFACT_PHASES:
            closed(flow, ('scratchResource', 'inputArtifact', 'outputArtifact'))
            before, after = BACKUP_ARTIFACT_PHASES[operation]
            require(flow['scratchResource'] == backup_artifacts['scratchResource'] and
                    flow['inputArtifact'] == (backup_artifacts[before] if before else '') and
                    flow['outputArtifact'] == (backup_artifacts[after] if after else ''),
                    'exact export/encryption/decryption/restore artifact lineage')
        else:
            require(flow is None, 'no undeclared artifact flow')
        require(services[selected['service']]['disposition'] == 'required', 'deferred service cannot be operated')
        dependencies = step['dependsOn']
        require(type(dependencies) is list and all(type(n) is int and 0 <= n < index for n in dependencies) and
                dependencies == sorted(set(dependencies)), 'prior-only ordered dependencies')
        prior = set(dependencies)
        for dependency in dependencies:
            prior.update(ancestors[dependency])
        ancestors.append(prior)
        if operation in BACKUP_ARTIFACT_PHASES:
            require(any(steps[n]['operation'] == 'scratch-create' and
                        steps[n]['resource'] == flow['scratchResource'] for n in prior),
                    'exclusive scratch ownership must precede export and every artifact use')
            if operation in ('snapshot-encrypt', 'snapshot-decrypt'):
                require(resource == flow['scratchResource'], 'crypto uses the same admitted scratch')
        roles = step['inputRoles']
        require(type(roles) is list and all(type(role) is str and role in inputs for role in roles) and
                roles == sorted(set(roles)) and selected['specInput'] in roles, 'exact declared input roles')
        if operation in BACKUP_ARTIFACT_PHASES:
            require(resources[flow['scratchResource']]['specInput'] in roles,
                    'artifact consumer binds immutable scratch specification')
        if selected['kind'] == 'container' and selected['service'] == 'proxy':
            recipe = plan['proxyRecipes'][resource]
            require(all(recipe[key] in roles for key in ('baseComposeInput', 'overlayInput',
                        'caddyInput', 'imageFactsInput', 'installedIngressInput')),
                    'proxy operation binds all actual recipe dependencies')
            for logical in ('caddy_data', 'caddy_config'):
                volume_resource = next(name for name, spec in plan['volumeSpecs'].items()
                                       if spec['logicalName'] == logical)
                volume = resources[volume_resource]
                require(volume['specInput'] in roles, 'proxy binds exact named-volume specification')
                if volume['precondition'] == 'absent':
                    require(any(steps[n]['operation'] == 'volume-create' and
                                steps[n]['resource'] == volume_resource for n in prior),
                            'proxy use requires prior creation of its absent volume')
                # Read-only reference to a present volume is a real dependency,
                # not unused authority and not permission to create/remove it.
                used.add(volume_resource)
            for network_resource in recipe['networkResources'].values():
                network = resources[network_resource]
                require(network['specInput'] in roles, 'proxy binds exact network specification')
                if network['precondition'] == 'absent':
                    require(any(steps[n]['operation'] == 'network-create' and
                                steps[n]['resource'] == network_resource for n in prior),
                            'proxy use requires prior creation of its absent network')
                used.add(network_resource)
        integer(step['maximumMs'], 1, min(budget['overallMs'], limits['maximumMs']))
        cleanup = operation in CLEANUP.values()
        require(step['phase'] == ('cleanup' if cleanup else 'work'), 'fixed cleanup classification')
        if cleanup:
            cleanup_ms += step['maximumMs']
            require(resource not in cleanups, 'one cleanup per temporary resource')
            cleanups[resource] = (index, operation)
        else:
            normal_ms += step['maximumMs']
        if operation in CLEANUP:
            require(resource not in creates and selected['precondition'] == 'absent', 'unique absent creation')
            creates[resource] = (index, operation)
        if operation in ('network-create', 'volume-create', 'container-create'):
            require(selected['precondition'] == 'absent', 'creation requires observed absence')
            require(not any(previous['operation'] == operation and previous['resource'] == resource
                            for previous in steps[:index]), 'one creation per exact declared resource')
        if operation == 'container-stop':
            if plan['action'] == 'pause':
                require(selected['precondition'] == 'present', 'pause requires exact existing container')
            else:
                require(any(steps[n]['operation'] == 'container-start' and
                            steps[n]['resource'] == resource for n in prior), 'bounded start stop dependency')
        if operation in ('container-start', 'migration-run', 'observe') and selected['precondition'] == 'absent':
            require(any(steps[n]['operation'] == 'container-create' and
                        steps[n]['resource'] == resource for n in prior), 'new container requires creation dependency')
        if operation in ('snapshot-encrypt', 'snapshot-decrypt', 'restore-apply', 'restore-compare'):
            predecessor = {'snapshot-encrypt': 'snapshot-export', 'snapshot-decrypt': 'snapshot-encrypt',
                           'restore-apply': 'snapshot-decrypt', 'restore-compare': 'restore-apply'}[operation]
            require(any(steps[n]['operation'] == predecessor for n in prior), 'backup phase dependency')
        if operation in ('snapshot-encrypt', 'snapshot-decrypt', 'restore-apply', 'restore-compare'):
            creation = 'scratch-create' if selected['kind'] == 'scratch' else 'restore-database-create'
            require(any(steps[n]['operation'] == creation and steps[n]['resource'] == resource
                        for n in prior), 'temporary resource requires creation dependency')
        used.add(resource); operations.add(operation)
        rights.append({'index': index, 'operation': operation, 'resource': resource,
                       'resourceSpecSha256': inputs[selected['specInput']]['sha256'],
                       'maximumMs': step['maximumMs'], 'requestBytes': step['requestBytes'],
                       'responseBytes': step['responseBytes'], 'phase': step['phase'],
                       'artifactFlow': flow})
    require(used == set(resources), 'no unused ambient resource authority')
    if plan['action'] == 'start':
        for index, step in enumerate(steps):
            if step['operation'] == 'container-start':
                require(any(later['operation'] == 'container-stop' and
                            later['resource'] == step['resource'] and index in ancestors[n]
                            for n, later in enumerate(steps)), 'bounded readiness cannot leave a running service')
            if step['operation'] == 'container-stop':
                require(all(n in ancestors[index] for n, earlier in enumerate(steps)
                            if earlier['resource'] == step['resource'] and
                            earlier['operation'] in ('container-start', 'observe')),
                        'readiness observations precede exact stop')
    require(set(creates) == set(cleanups), 'temporary resources need exact paired cleanup')
    for resource, (index, operation) in creates.items():
        cleanup_index, cleanup_operation = cleanups[resource]
        require(cleanup_index > index and cleanup_operation == CLEANUP[operation] and
                index in steps[cleanup_index]['dependsOn'], 'cleanup requires creation receipt dependency')
        require(all(i in ancestors[cleanup_index] for i, step in enumerate(steps)
                    if step['resource'] == resource and i != cleanup_index),
                'cleanup must follow every normal use of its resource')
    if plan['action'] == 'backup-proof':
        require(operations == BACKUP and len(steps) == len(BACKUP) and
                all(len([r for r in resources.values() if r['kind'] == kind]) == 1
                    for kind in ('source-database', 'restore-database', 'scratch', 'proof')),
                'complete logical backup obligations; no partial restore proof')
        for index, step in enumerate(steps):
            if step['phase'] == 'cleanup':
                require(all(n in ancestors[index] for n, previous in enumerate(steps)
                            if previous['phase'] == 'work' and previous['operation'] != 'proof-publish'),
                        'backup cleanup follows all normal backend work')
            if step['operation'] == 'proof-publish':
                require(all(n in ancestors[index] for n, previous in enumerate(steps)
                            if previous['operation'] in ('restore-compare', 'scratch-remove', 'restore-database-drop')),
                        'backup proof requires comparison and completed cleanup')
    require(cleanup_ms <= budget['cleanupMs'] and budget['admissionMs'] + normal_ms +
            budget['terminationMs'] + budget['cleanupMs'] + budget['terminalMs'] <= budget['overallMs'],
            'single original budget with reserved termination and cleanup')
    return {'kind': 'mutation-plan-obligations', 'planSha256': hashlib.sha256(raw).hexdigest(),
            'requestSha256': plan['requestSha256'], 'rights': rights,
            'rightsSha256': digest(rights), 'budget': dict(budget),
            'mutationAuthorized': False, 'executorImplemented': False,
            'hostAdmissionImplemented': False, 'confinementImplemented': False}


def validate_effect(raw_plan, effect):
    """Validate one proposed executor evidence record; never verify live truth.

    Guardian must independently authenticate/retain every linked receipt and
    exact resource incarnation. This interface cannot settle backend work.
    """
    obligations = validate_plan(raw_plan)
    closed(effect, ('kind', 'planSha256', 'step', 'operation', 'resource',
        'outcome', 'intentSha256', 'dispatchSha256', 'observationSha256',
        'childrenSettlementSha256', 'backendSettlementSha256', 'ownershipSha256'))
    require(effect['kind'] == 'mutation-step-effect' and
            effect['planSha256'] == obligations['planSha256'], 'effect plan binding')
    integer(effect['step'], 0, len(obligations['rights']) - 1)
    right = obligations['rights'][effect['step']]
    require(effect['operation'] == right['operation'] and effect['resource'] == right['resource'],
            'effect exact right')
    require(effect['outcome'] in ('not-dispatched', 'applied', 'confirmed-absent', 'unknown',
                                 'cleanup-unresolved'), 'effect outcome')
    if effect['outcome'] == 'cleanup-unresolved':
        require(right['phase'] == 'cleanup', 'cleanup outcome requires cleanup right')
    if effect['outcome'] == 'confirmed-absent':
        require(right['phase'] == 'cleanup', 'absence outcome requires exact owned cleanup')
    sha(effect['intentSha256']); sha(effect['observationSha256'])
    if effect['outcome'] == 'not-dispatched':
        require(all(effect[key] == '' for key in ('dispatchSha256', 'ownershipSha256')),
                'not-dispatched cannot claim dispatch/ownership')
    else:
        sha(effect['dispatchSha256'])
        if effect['outcome'] in ('applied', 'confirmed-absent', 'cleanup-unresolved'):
            sha(effect['ownershipSha256'])
        else:
            require(effect['ownershipSha256'] == '', 'unknown effect cannot grant cleanup ownership')
    if effect['outcome'] not in ('unknown', 'cleanup-unresolved'):
        sha(effect['childrenSettlementSha256']); sha(effect['backendSettlementSha256'])
    else:
        require(effect['childrenSettlementSha256'] == effect['backendSettlementSha256'] == '',
                'unknown remains unsettled')
    return {'kind': 'mutation-effect-data', 'effectSha256': digest(effect),
            'mutationAuthorized': False, 'settlementVerified': False,
            'retryAuthorized': False, 'cleanupAuthorized': False}


def _binding_json(value):
    """Canonical strict JSON data; reject Python coercions and cyclic inputs."""
    active = set()
    def check(item):
        if item is None or type(item) in (str, bool, int):
            return
        require(type(item) in (dict, list), 'strict JSON binding data required')
        identity = id(item)
        require(identity not in active, 'cyclic binding data')
        active.add(identity)
        if type(item) is dict:
            require(all(type(key) is str for key in item), 'JSON binding string keys')
            children = item.values()
        else:
            children = item
        for child in children:
            check(child)
        active.remove(identity)
    check(value)
    return canonical(value)


def bind_load_plan(raw_plan, *, expected_plan_bindings, expected_services,
                   expected_inputs, expected_resources, expected_images,
                   expected_manifest_services, resource_images, archive_roles,
                   spec_bytes):
    """Pure independent-data binding, not input custody or image/backend proof."""
    obligations = validate_plan(raw_plan)
    plan = parse_plan(raw_plan)
    require(plan['action'] == 'load', 'load plan required')
    binding_keys = ('requestSha256', 'selectionSha256', 'authorityPolicySha256',
                    'ownerDecisionSha256', 'target')
    closed(expected_plan_bindings, binding_keys)
    require(_binding_json({k: plan[k] for k in binding_keys}) ==
            _binding_json(expected_plan_bindings),
            'independent plan binding differs')
    for key, expected in (('services', expected_services), ('inputs', expected_inputs),
                          ('resources', expected_resources)):
        require(_binding_json(plan[key]) == _binding_json(expected),
                'independent '+key+' differs')
    require(type(expected_manifest_services) is dict and
            set(expected_manifest_services) == SERVICES, 'full manifest service roster')
    require(type(expected_images) is dict and 0 < len(expected_images) <= len(SERVICES),
            'finite complete image roster')
    consumers = set(); archives = set(); refs = set()
    for name, row in expected_images.items():
        identifier(name)
        closed(row, ('composeServices', 'resolvedRef', 'localImageId', 'archive', 'source'))
        require(type(row['localImageId']) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', row['localImageId']), 'immutable image ID')
        ref = row['resolvedRef']
        require(type(ref) is str and ref and ref not in refs, 'unique image reference')
        refs.add(ref)
        first = ref.startswith('lunchlineup-internal-ci/')
        require(row['source'] == ('first-party' if first else 'third-party') and
                (first or re.search(r'@sha256:[a-f0-9]{64}$', ref)), 'image source classification')
        archive = row['archive'];closed(archive, ('path', 'sha256', 'bytes'))
        require(type(archive['path']) is str and re.fullmatch(r'images/[a-z0-9-]+\.tar\.gz', archive['path']) and archive['path'] not in archives, 'unique archive path')
        archives.add(archive['path']);sha(archive['sha256']);integer(archive['bytes'], 1, 64*1024**3)
        names = row['composeServices']
        require(type(names) is list and names and all(type(n) is str and n in SERVICES for n in names) and len(names) == len(set(names)), 'image consumer roster')
        for service in names:
            require(service not in consumers, 'duplicate image consumer');consumers.add(service)
            item = expected_manifest_services[service]
            closed(item, ('imageArtifact', 'resolvedRef', 'oneShot', 'hasHealthCheck'))
            require(item['imageArtifact'] == name and item['resolvedRef'] == ref and
                    type(item['oneShot']) is bool and type(item['hasHealthCheck']) is bool,
                    'bidirectional image service binding')
    require(consumers == SERVICES, 'complete 28-service image union')
    resources = plan['resources'];inputs = plan['inputs']
    require(type(resource_images) is dict and type(archive_roles) is dict and
            set(resource_images) == set(archive_roles) == set(resources), 'exact resource maps')
    required = {name for name, row in expected_images.items() if any(
        expected_services[n]['disposition'] == 'required' for n in row['composeServices'])}
    require(all(type(v) is str for v in resource_images.values()) and
            len(set(resource_images.values())) == len(resource_images) and
            set(resource_images.values()) == required, 'exact required shared-image resources')
    used_roles = set();expected_spec_roles = set()
    for name, resource in resources.items():
        image = expected_images[resource_images[name]]
        require(resource['kind'] == 'image' and resource['service'] in image['composeServices'] and
                expected_services[resource['service']]['disposition'] == 'required',
                'required representative image service')
        spec = resource['specInput'];role = archive_roles[name]
        require(type(role) is str and role in inputs and role != spec, 'independent archive role')
        raw = spec_bytes.get(spec) if type(spec_bytes) is dict else None
        require(type(raw) is bytes and raw == canonical({resource_images[name]: image}),
                'exact canonical image specification')
        require(inputs[spec]['sha256'] == hashlib.sha256(raw).hexdigest() and
                inputs[spec]['bytes'] == len(raw), 'spec input byte binding')
        require(inputs[role]['sha256'] == image['archive']['sha256'] and
                inputs[role]['bytes'] == image['archive']['bytes'], 'archive input binding')
        used_roles.update((spec, role));expected_spec_roles.add(spec)
    require(type(spec_bytes) is dict and set(spec_bytes) == expected_spec_roles and
            used_roles == set(inputs), 'no extra specification/input authority')
    imports = {};tags = set();ancestors = []
    for index, step in enumerate(plan['steps']):
        prior = set(step['dependsOn'])
        for dependency in step['dependsOn']:prior.update(ancestors[dependency])
        ancestors.append(prior)
        resource = step['resource'];row = resources[resource]
        image = expected_images[resource_images[resource]]
        if step['operation'] == 'image-import':
            require(resource not in imports, 'shared image imported only once')
            require(step['inputRoles'] == sorted((row['specInput'], archive_roles[resource])) and
                    step['requestBytes'] >= image['archive']['bytes'], 'exact import inputs/request bound')
            imports[resource] = index
        else:
            require(step['operation'] == 'image-tag' and resource not in tags and
                    resource in imports and imports[resource] in prior, 'unique tag after same-resource import')
            require(image['source'] == 'first-party' and re.fullmatch(
                r'lunchlineup-internal-ci/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', image['resolvedRef']), 'exact first-party tag reference required')
            require(step['inputRoles'] == [row['specInput']] and step['requestBytes'] >= len(spec_bytes[row['specInput']]), 'exact tag input/request bound')
            tags.add(resource)
    require(set(imports) == set(resources), 'every required image imported exactly once')
    return obligations


def validate_bound_load_effect(raw_plan, effect, **independent):
    """Repeat pure binding, then validate effect data without observing truth."""
    bind_load_plan(raw_plan, **independent)
    return validate_effect(raw_plan, effect)


# Exact definition-only mirrors of the existing archive preflight relation and
# tag normalization; no parser imports, IO, or independent permission roster.
ARCHIVE_SERVICE_ARTIFACTS = {
    'proxy': 'proxy', 'web': 'web', 'api': 'api', 'webhook-replay': 'api',
    'migrate': 'migrate', 'engine': 'engine', 'pdf-parser': 'worker',
    'worker': 'worker', 'pgbouncer': 'pgbouncer', 'pitr-wal-provider': 'backup',
    'api-v2': 'api-v2', 'pitr-lifecycle-audit': 'backup', 'postgres': 'postgres',
    'redis': 'redis', 'rabbitmq': 'rabbitmq', 'control': 'control',
    'autoheal': 'autoheal', 'prometheus': 'prometheus', 'backup': 'backup',
    'pitr-base-backup': 'backup', 'pitr-restore': 'backup',
    'alertmanager': 'alertmanager', 'node-exporter': 'node-exporter',
    'loki': 'loki', 'promtail': 'otel-collector', 'otel-collector': 'otel-collector',
    'tempo': 'tempo', 'grafana': 'grafana',
}


def _archive_canonical_tag(tag):
    require(isinstance(tag, str) and ':' in tag, "explicit image tag required")
    repository, version = tag.rsplit(':', 1)
    require(len(repository) <= 255 and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', version), "invalid repository/tag length or tag")
    parts = repository.split('/')
    component = r'[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
    first = parts[0]
    explicit = len(parts) > 1 and ('.' in first or ':' in first or first == 'localhost' or first.lower() != first)
    if explicit:
        host = first.lower()
        require(re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[a-f0-9:]+\])(?::[0-9]+)?', host), "invalid registry")
        path = parts[1:]
    else:
        host, path = 'docker.io', parts
    require(path and all(re.fullmatch(component, x) for x in path), "invalid repository path")
    if host == 'index.docker.io':
        host = 'docker.io'
    if host == 'docker.io' and len(path) == 1:
        path.insert(0, 'library')
    return host + '/' + '/'.join(path) + ':' + version



def bind_load_plan_with_archive_preflight(raw_plan, *, preflight_result,
        expected_preflight_pin, expected_archive_policy, expected_input_identities,
        expected_source_binding, **independent_load_bindings):
    """Pure retained-result joins; caller must authenticate every independent input."""
    obligations = bind_load_plan(raw_plan, **independent_load_bindings)
    # Reject Python coercions and non-JSON values before comparing supplied data.
    for value in (preflight_result, expected_preflight_pin, expected_archive_policy,
                  expected_input_identities, expected_source_binding):
        _binding_json(value)
    def same(left, right):
        return _binding_json(left) == _binding_json(right)
    def identity(value, maximum):
        closed(value, ('bytes', 'sha256', 'veritySha256', 'device', 'inode'))
        integer(value['bytes'], 1, maximum)
        sha(value['sha256']); sha(value['veritySha256'])
        integer(value['device'], 0, 2**53-1); integer(value['inode'], 0, 2**53-1)
    def ids(value, maximum):
        require(type(value) is list and len(value) <= maximum and
                all(type(x) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', x) for x in value) and
                value == sorted(set(value)), 'canonical unique archive identity list')
    def platform(value):
        closed(value, ('configImageId', 'os', 'architecture', 'variant'))
        require(type(value['configImageId']) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', value['configImageId']), 'platform config identity')
        require(all(type(value[k]) is str and re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,63}', value[k]) for k in ('os', 'architecture')), 'platform OS/architecture')
        require(value['variant'] is None or type(value['variant']) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', value['variant']), 'platform variant')
    closed(preflight_result, ('receipt', 'sha256', 'bytes'))
    closed(expected_preflight_pin, ('sha256', 'bytes'))
    receipt = preflight_result['receipt']; raw = _binding_json(receipt)
    require(0 < len(raw) <= 1024**2, 'preflight receipt byte bound')
    actual = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    require(same(actual, expected_preflight_pin) and
            same(actual, {k: preflight_result[k] for k in actual}), 'independent preflight receipt pin differs')
    closed(receipt, ('version', 'kind', 'sourceSha', 'treeSha', 'manifest', 'helper',
                    'services', 'archives', 'tags', 'chargedWork', 'inventoryStatus', 'loadAuthorized'))
    require(type(receipt['version']) is int and receipt['version'] == 1 and
            receipt['kind'] == 'immutable-fd-archive-preflight' and receipt['loadAuthorized'] is False and
            receipt['inventoryStatus'] == 'pending-live-owner-custody', 'preflight identity/authority differs')
    source_keys = ('sourceSha', 'treeSha', 'manifestSha256', 'helperSha256')
    closed(expected_source_binding, source_keys)
    policy = expected_archive_policy
    closed(policy, (*source_keys, 'prefix', 'artifacts'))
    for key in ('sourceSha', 'treeSha'):
        require(type(expected_source_binding[key]) is str and re.fullmatch('[a-f0-9]{40}', expected_source_binding[key]), 'source/tree binding')
        require(receipt[key] == policy[key] == expected_source_binding[key], 'preflight source differs')
    for key in ('manifestSha256', 'helperSha256'):
        sha(expected_source_binding[key]); require(policy[key] == expected_source_binding[key], 'independent bootstrap source pin differs')
    require(type(policy['prefix']) is str and re.fullmatch('[a-z0-9][a-z0-9._/-]*', policy['prefix']), 'independent candidate prefix')
    images = independent_load_bindings['expected_images']
    services = independent_load_bindings['expected_manifest_services']
    names = set(ARCHIVE_SERVICE_ARTIFACTS.values())
    require(set(ARCHIVE_SERVICE_ARTIFACTS) == SERVICES and len(names) == 21 and
            set(images) == names and set(services) == set(ARCHIVE_SERVICE_ARTIFACTS), 'fixed complete 28-service/21-artifact relation')
    closed(policy['artifacts'], names); closed(receipt['archives'], names)
    closed(receipt['services'], ARCHIVE_SERVICE_ARTIFACTS)
    closed(expected_input_identities, ('manifest', 'helper', *('archive:'+n for n in names)))
    for role, wanted in expected_input_identities.items():
        identity(wanted, 32*1024**3 if role.startswith('archive:') else 16*1024**2)
    for role in ('manifest', 'helper'):
        identity(receipt[role], 16*1024**2)
        require(same(receipt[role], expected_input_identities[role]) and
                receipt[role]['sha256'] == policy[role+'Sha256'], 'preflight bootstrap custody differs')
    tags = {}; compressed = 0
    for name in sorted(names):
        image = images[name]; item = receipt['archives'][name]; approved = policy['artifacts'][name]
        closed(approved, ('localImageId', 'resolvedRef', 'archiveSha256', 'archiveBytes', 'platforms'))
        closed(item, ('tags', 'configImageIds', 'ociDescriptorIds', 'platforms', 'resolvedReference', 'inputIdentity', 'expectedImageId'))
        require(image['localImageId'] == approved['localImageId'] == item['expectedImageId'] and
                image['resolvedRef'] == approved['resolvedRef'], 'archive image/reference differs')
        require(sorted(image['composeServices']) == sorted(s for s, n in ARCHIVE_SERVICE_ARTIFACTS.items() if n == name), 'fixed shared consumers differ')
        ids(item['configImageIds'], 256+4096); ids(item['ociDescriptorIds'], 4096)
        require(item['expectedImageId'] in item['configImageIds'], 'disposable config image missing')
        require(type(item['platforms']) is list and item['platforms'] and len(item['platforms']) <= 256+4096, 'complete platforms required')
        for row in item['platforms']: platform(row)
        require([row['configImageId'] for row in item['platforms']] == item['configImageIds'] and
                same(item['platforms'], approved['platforms']), 'full independent platform set differs')
        identity(item['inputIdentity'], 32*1024**3)
        require(same(item['inputIdentity'], expected_input_identities['archive:'+name]), 'archive immutable identity differs')
        archive = image['archive']; observed = item['inputIdentity']
        require(archive['path'] == 'images/'+name+'.tar.gz' and
                archive['sha256'] == approved['archiveSha256'] == observed['sha256'] and
                same(archive['bytes'], approved['archiveBytes']) and archive['bytes'] == observed['bytes'], 'archive content pin differs')
        compressed += observed['bytes']; integer(compressed, 1, 64*1024**3)
        exported = item['tags']
        require(type(exported) is list and len(exported) <= 4096 and
                all(type(t) is str and _archive_canonical_tag(t) == t for t in exported) and
                exported == sorted(set(exported)), 'canonical unique exported tags')
        reference = image['resolvedRef']; status = item['resolvedReference']
        if '@' in reference:
            closed(status, ('resolvedRef', 'status', 'descriptorPresent'))
            require(status['resolvedRef'] == reference and status['status'] == 'pending-live-repodigest-association' and
                    type(status['descriptorPresent']) is bool and status['descriptorPresent'] ==
                    (reference.rsplit('@', 1)[1] in item['ociDescriptorIds']), 'pending digest association differs')
        else:
            closed(status, ('resolvedRef', 'normalizedRef', 'status', 'expectedImageId'))
            normalized = _archive_canonical_tag(reference)
            candidate = _archive_canonical_tag(policy['prefix']+'/'+name+':'+policy['sourceSha'])
            require(normalized in exported or normalized == candidate, 'unbound preflight tag')
            require(same(status, {'resolvedRef': reference, 'normalizedRef': normalized,
                    'status': 'exported-tag' if normalized in exported else 'planned-candidate-tag',
                    'expectedImageId': image['localImageId']}), 'tag reference status differs')
        candidate = _archive_canonical_tag(policy['prefix']+'/'+name+':'+policy['sourceSha'])
        for tag in [*exported, candidate]:
            require(tag not in tags or tags[tag] == image['localImageId'], 'conflicting receipt tag')
            tags[tag] = image['localImageId']
        require(len(tags) <= 4096, 'complete receipt tag bound')
    require(same(receipt['tags'], dict(sorted(tags.items()))), 'complete preflight tag inventory differs')
    for service, name in ARCHIVE_SERVICE_ARTIFACTS.items():
        require(services[service]['imageArtifact'] == name and
                same(receipt['services'][service], {'artifact': name,
                     'resolvedReference': receipt['archives'][name]['resolvedReference']}), 'full preflight service relation differs')
    work = receipt['chargedWork']
    closed(work, ('compressed', 'expanded', 'archiveIntegrityHashBytes', 'manifestHelperIntegrityHashBytes'))
    for key in work: integer(work[key], 0, 128*1024**3)
    require(work['compressed'] == work['archiveIntegrityHashBytes'] == compressed and
            work['manifestHelperIntegrityHashBytes'] == sum(expected_input_identities[k]['bytes'] for k in ('manifest', 'helper')), 'preflight accounting differs')
    for resource, name in independent_load_bindings['resource_images'].items():
        role = independent_load_bindings['archive_roles'][resource]
        plan_pin = independent_load_bindings['expected_inputs'][role]
        observed = receipt['archives'][name]['inputIdentity']
        require(all(same(plan_pin[k], observed[k]) for k in ('bytes', 'sha256', 'veritySha256')), 'load archive input differs from preflight')
    return obligations


def dispatch(*_args, **_kwargs):
    # Validation never turns data into an authenticated owner or mutation grant.
    raise Refusal('mutation refused: executor, host admission and confinement are not implemented')


if __name__ == '__main__':
    raise SystemExit('No public mutation-plan CLI or execution authority.')
