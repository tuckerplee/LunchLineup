"""Fixed private proxy derivation from full bounded evidence, never authority.

No YAML/render/process/file/network API. Inputs must come from a pinned owner
adapter; supplied facts are not authenticated by this function. Missing actual
acquisition/image/daemon facts must refuse at that adapter, never be fabricated.
"""
import hashlib
import json
from decimal import Decimal

MAX = 1048576
ROOT_FIELDS = frozenset(('name', 'services', 'networks', 'volumes', 'secrets'))
PROXY_REQUIRED = frozenset(('image', 'build', 'environment', 'cap_drop', 'security_opt',
    'read_only', 'cpus', 'mem_limit', 'pids_limit', 'ulimits', 'logging', 'tmpfs',
    'ports', 'volumes', 'networks', 'healthcheck', 'restart'))
PROXY_OPTIONAL = frozenset(('cap_add', 'command', 'entrypoint', 'user', 'privileged'))
IMAGE_CONFIG_FIELDS = frozenset(('User', 'Entrypoint', 'Cmd', 'Env', 'WorkingDir',
    'ExposedPorts', 'Volumes', 'Healthcheck', 'StopSignal', 'Labels'))


def require(ok, why):
    if not ok:
        raise RuntimeError(why)


def closed(value, fields):
    require(type(value) is dict and set(value) == set(fields), 'closed normalization fields')


def decode(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX, 'full bounded JSON evidence required')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON field')
            result[key] = value
        return result
    def invalid(_):
        raise RuntimeError('nonfinite number')
    result = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                        parse_float=Decimal, parse_constant=invalid)
    def bounded(value, depth=0):
        require(depth <= 32, 'JSON depth')
        if type(value) is dict:
            for key, child in value.items():
                require(type(key) is str and len(key) <= 4096, 'JSON key bound'); bounded(child, depth + 1)
        elif type(value) is list:
            require(len(value) <= 4096, 'JSON list bound')
            for child in value: bounded(child, depth + 1)
        elif type(value) is str:
            require(len(value) <= 65536, 'JSON text bound')
        elif type(value) in (int, Decimal):
            require(abs(value) <= 2**53 - 1, 'JSON numeric bound')
    bounded(result)
    require(type(result) is dict, 'JSON object evidence')
    return result


def exact(p, value, expected, label):
    # Canonical comparison distinguishes bool/int and rejects unhandled Decimal.
    require(p.canonical(value) == p.canonical(expected), label)


def environment(value):
    if type(value) is dict:
        require(all(type(k) is str and type(v) is str for k, v in value.items()), 'resolved environment strings')
        return dict(value)
    require(type(value) is list, 'environment map/list')
    result = {}
    for item in value:
        require(type(item) is str and '=' in item, 'no ambient environment entry')
        name, val = item.split('=', 1)
        require(name and name not in result, 'duplicate environment entry')
        result[name] = val
    return result


def seconds(value, expected_ms):
    require(type(value) is str and value in {str(expected_ms // 1000) + 's', str(expected_ms) + 'ms'},
            'exact duration representation')
    return expected_ms


def facts_contract(p, facts):
    closed(facts, ('kind', 'acquisition', 'image', 'engine', 'mounts', 'networks', 'rootDefinitions', 'serviceImages', 'selectedImages'))
    require(facts['kind'] == 'private-proxy-normalization-facts-v1', 'fixed facts kind')
    acquisition = facts['acquisition']
    closed(acquisition, ('rendererPinSha256', 'rendererVersion', 'profile', 'rawComposeSha256',
        'baseComposeSha256', 'overlaySha256', 'caddySha256', 'projectDirectory', 'project',
        'sourceSha', 'treeSha', 'envInputSha256', 'profilesSha256', 'ownerReceiptSha256',
        'guestBootId', 'engineIncarnationSha256', 'adminEmail', 'orderedFiles', 'ambientEnvironmentCleared', 'selectedImageInventoryRole'))
    require(acquisition['profile'] == 'closed-compose-proxy-json-v1' and
        type(acquisition['rendererVersion']) is str and 1 <= len(acquisition['rendererVersion']) <= 64,
        'independently pinned renderer/version required')
    require(acquisition['ambientEnvironmentCleared'] is True, 'no implicit environment acquisition')
    for key, value in acquisition.items():
        if key.endswith('Sha256'): p.sha(value)
    image = facts['image']
    closed(image, ('inspectSha256', 'configBlobSha256', 'artifactSha256', 'imageId',
        'platform', 'approvedConfig', 'approvedInspect', 'filesystemReceiptSha256',
        'protectedResponseReceiptSha256', 'engineIncarnationSha256'))
    for key in ('inspectSha256', 'configBlobSha256', 'artifactSha256', 'imageId',
                'filesystemReceiptSha256', 'protectedResponseReceiptSha256', 'engineIncarnationSha256'):
        p.sha(image[key])
    closed(image['platform'], ('os', 'architecture', 'variant'))
    closed(image['approvedConfig'], IMAGE_CONFIG_FIELDS)
    require(type(image['approvedInspect']) is dict and image['engineIncarnationSha256'] == acquisition['engineIncarnationSha256'],
            'full independently reviewed inspect/engine facts')
    engine = facts['engine']
    closed(engine, ('engineIncarnationSha256', 'daemonConfigSha256', 'apiVersion', 'runtimePinSha256',
        'namespaceDefaults', 'securityDefaults', 'resourceDefaults', 'networkDefaults',
        'mountDefaults', 'healthDefaults', 'processDefaults', 'publicationDefaults',
        'restartDefaults', 'generatedLabels', 'generatedAliases', 'readbackReceiptSha256',
        'processFallbacks', 'healthFallbacks'))
    for key in ('engineIncarnationSha256', 'daemonConfigSha256', 'runtimePinSha256', 'readbackReceiptSha256'):
        p.sha(engine[key])
    require(engine['engineIncarnationSha256'] == acquisition['engineIncarnationSha256'], 'one actual engine incarnation')
    closed(engine['namespaceDefaults'], ('pid', 'ipc', 'uts', 'userns', 'cgroupns'))
    closed(engine['securityDefaults'], ('apparmorProfile', 'seccompProfileSha256', 'noNewPrivileges', 'capabilitiesSha256'))
    closed(engine['resourceDefaults'], ('memorySwapBytes', 'memoryReservationBytes', 'oomKillDisable', 'cgroupParent', 'ioPolicySha256'))
    closed(engine['networkDefaults'], ('dns', 'dnsSearch', 'dnsOptions', 'routePolicySha256'))
    closed(engine['mountDefaults'], ('bindPropagation', 'recursiveReadOnly', 'anonymousVolumes'))
    closed(engine['healthDefaults'], ('test', 'intervalMs', 'timeoutMs', 'retries', 'startPeriodMs', 'startIntervalMs', 'disabled'))
    closed(engine['healthFallbacks'], ('startPeriodMs', 'startIntervalMs'))
    closed(engine['processFallbacks'], ('workingDir', 'stopSignal'))
    closed(engine['processDefaults'], ('init', 'tty', 'stdinOpen', 'stopTimeoutSeconds', 'workingDir', 'stopSignal'))
    closed(engine['publicationDefaults'], ('publishAllPorts', 'mode'))
    closed(engine['restartDefaults'], ('name', 'maximumRetryCount'))
    require(type(engine['generatedLabels']) is dict and type(engine['generatedAliases']) is dict,
            'exact independently derived labels/aliases')
    closed(facts['mounts'], ('caddy', 'caddy_data', 'caddy_config'))
    closed(facts['mounts']['caddy'], ('resolvedPath', 'device', 'inode', 'sha256', 'readOnly', 'noSymlink', 'readbackReceiptSha256'))
    for name in ('caddy_data', 'caddy_config'):
        closed(facts['mounts'][name], ('engineName', 'identitySha256', 'ownerLabelsSha256', 'backingSha256', 'readbackReceiptSha256'))
    closed(facts['networks'], ('app', 'external'))
    for item in facts['networks'].values():
        closed(item, ('resource', 'engineId', 'identitySha256', 'configSha256', 'ownerLabelsSha256',
            'readbackReceiptSha256', 'resourceSpec', 'identity'))
    closed(facts['rootDefinitions'], ('networks', 'volumes', 'secrets'))
    require(engine['namespaceDefaults']['pid'] == engine['namespaceDefaults']['ipc'] ==
            engine['namespaceDefaults']['uts'] == engine['namespaceDefaults']['cgroupns'] == 'private' and
            engine['namespaceDefaults']['userns'] in ('private', 'none'), 'host namespace default refused')
    require(type(engine['securityDefaults']['apparmorProfile']) is str and
            engine['securityDefaults']['apparmorProfile'] not in ('', 'unconfined'), 'actual confinement profile required')
    for key in ('seccompProfileSha256', 'capabilitiesSha256'): p.sha(engine['securityDefaults'][key])
    p.sha(engine['resourceDefaults']['ioPolicySha256']); p.sha(engine['networkDefaults']['routePolicySha256'])
    for key in ('memorySwapBytes', 'memoryReservationBytes'):
        p.integer(engine['resourceDefaults'][key], 0, 2**53 - 1)
    require(engine['resourceDefaults']['oomKillDisable'] is False, 'OOM disable refused')
    require(engine['mountDefaults']['bindPropagation'] == 'rprivate' and
            type(engine['mountDefaults']['recursiveReadOnly']) is bool, 'exact private bind defaults')
    p.integer(engine['healthDefaults']['startPeriodMs'], 0, 0)
    p.integer(engine['healthDefaults']['startIntervalMs'], 0, 60000)
    p.integer(engine['processDefaults']['stopTimeoutSeconds'], 1, 30)
    for item in facts['mounts'].values():
        for key, value in item.items():
            if key.endswith('Sha256') or key == 'sha256':
                if key != 'identitySha256' or value != '': p.sha(value)
    for key in ('device', 'inode'): p.integer(facts['mounts']['caddy'][key], 0, 2**53 - 1)
    for item in facts['networks'].values():
        for key in ('configSha256', 'ownerLabelsSha256', 'readbackReceiptSha256'): p.sha(item[key])
        require(type(item['resource']) is str, 'exact plan network resource name')
        for key in ('engineId', 'identitySha256'):
            if item[key] != '': p.sha(item[key])
        closed(item['resourceSpec'], ('kind', 'logicalName', 'engineName', 'composeDefinitionSha256',
            'approvedConfigSha256', 'ownerLabelsSha256'))
    require(type(facts['serviceImages']) is dict, 'complete service image map')
    return acquisition, image, engine



def inherited_process_and_health(p, proxy, image_config, engine):
    """Fixed precedence: explicit Compose fields, image nonempty value, fallback.

    *Defaults objects describe observed EFFECTIVE values; *Fallbacks are actual
    independently reviewed daemon fallback values, not invented constants.
    """
    fallback = engine['processFallbacks']; actual = engine['processDefaults']
    for key in ('workingDir', 'stopSignal'):
        require(type(fallback[key]) is str and 1 <= len(fallback[key]) <= 4096, 'explicit process fallback')
    workdir = image_config['WorkingDir']; stop = image_config['StopSignal']
    require(type(workdir) is str and (stop is None or type(stop) is str), 'image process inheritance type')
    require(actual['workingDir'] == (workdir or fallback['workingDir']) and
            actual['stopSignal'] == (stop or fallback['stopSignal']), 'image/effective process precedence differs')
    inherited = image_config['Healthcheck']
    require(inherited is None or type(inherited) is dict and set(inherited).issubset(
        {'Test', 'Interval', 'Timeout', 'Retries', 'StartPeriod', 'StartInterval'}), 'closed inherited health fields')
    inherited = inherited or {}
    if 'Test' in inherited:
        test = inherited['Test']
        require(type(test) is list and 1 <= len(test) <= 64 and all(type(x) is str for x in test) and
            (test == ['NONE'] or len(test) >= 2 and test[0] in ('CMD', 'CMD-SHELL')), 'supported inherited health test')
    for field in ('Interval', 'Timeout', 'StartPeriod', 'StartInterval'):
        if field in inherited:
            p.integer(inherited[field], 0, 3600 * 1000000000)
            require(inherited[field] % 1000000 == 0, 'exact health nanosecond-to-ms conversion')
    if 'Retries' in inherited: p.integer(inherited['Retries'], 0, 100)
    for field in ('startPeriodMs', 'startIntervalMs'):
        p.integer(engine['healthFallbacks'][field], 0, 60000)
    # Compose explicitly supplies test/interval/timeout/retries. Image values
    # for those four are classified as overridden, not accidentally inherited.
    health = proxy['healthcheck']; closed(health, ('test', 'interval', 'timeout', 'retries'))
    derived = {'test': health['test'], 'intervalMs': seconds(health['interval'], 15000),
        'timeoutMs': seconds(health['timeout'], 5000), 'retries': health['retries'],
        'startPeriodMs': inherited.get('StartPeriod', 0) // 1000000 or engine['healthFallbacks']['startPeriodMs'],
        'startIntervalMs': inherited.get('StartInterval', 0) // 1000000 or engine['healthFallbacks']['startIntervalMs'],
        'disabled': False}
    exact(p, engine['healthDefaults'], derived, 'Compose/image/fallback effective health disagreement')
    require(derived['startPeriodMs'] == 0, 'nonzero inherited/effective start period unsupported by fixed recipe')


def selected_images_and_networks(p, mutation, facts, compose, plan, recipe):
    """Internal linkage of complete supplied selections; still no live truth."""
    selected = facts['selectedImages']
    require(type(selected) is dict and set(selected) == mutation.SERVICES, 'selected28 image/artifact records required')
    role = facts['acquisition']['selectedImageInventoryRole']
    require(type(role) is str and role in plan['inputs'] and
            plan['inputs'][role]['sha256'] == mutation.digest(selected), 'retained selected-image input digest')
    for service, item in selected.items():
        closed(item, ('artifactSha256', 'configImageId', 'platform', 'archiveInputRole', 'archiveSha256'))
        p.sha(item['artifactSha256']); p.sha(item['archiveSha256'])
        require(type(item['configImageId']) is str and item['configImageId'].startswith('sha256:'), 'selected immutable image reference')
        p.sha(item['configImageId'][7:])
        closed(item['platform'], ('os', 'architecture', 'variant'))
        require(all(type(item['platform'][key]) is str and 1 <= len(item['platform'][key]) <= 64
                    for key in ('os', 'architecture')) and
            (item['platform']['variant'] is None or type(item['platform']['variant']) is str and
             1 <= len(item['platform']['variant']) <= 64), 'selected platform')
        archive_role = item['archiveInputRole']
        require(type(archive_role) is str and archive_role in plan['inputs'] and
            plan['inputs'][archive_role]['sha256'] == item['archiveSha256'], 'selected held archive relationship')
        require(item['artifactSha256'] == plan['services'][service]['artifactSha256'] and
            item['configImageId'] == facts['serviceImages'][service] == compose['services'][service]['image'],
            'every rendered image binds selected plan artifact/config')
    require(selected['proxy']['configImageId'] == 'sha256:' + facts['image']['imageId'] and
        selected['proxy']['artifactSha256'] == facts['image']['artifactSha256'] and
        selected['proxy']['platform'] == facts['image']['platform'], 'proxy full inspect selection relationship')
    engine_names = [facts['networks'][logical]['resourceSpec']['engineName']
                    for logical in ('app', 'external')]
    allowed = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-'
    initial = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    require(all(type(name) is str and 1 <= len(name) <= 63 and name[0] in initial and
                all(char in allowed for char in name) for name in engine_names),
            'finite valid nonempty declared network engine names')
    require(len(set(engine_names)) == 2, 'distinct network engine names even before creation')
    for logical in ('app', 'external'):
        fact = facts['networks'][logical]; name = recipe['networkResources'][logical]
        require(fact['resource'] == name and name in plan['resources'], 'exact logical network resource')
        resource = plan['resources'][name]; spec = fact['resourceSpec']; definition = compose['networks'][logical]
        require(resource['kind'] == 'network' and resource['project'] == plan['target']['project'] and
                spec['kind'] == 'private-proxy-network-v1' and spec['logicalName'] == logical,
                'network kind/project/logical binding')
        require(type(definition) is dict and type(definition.get('name')) is str and
                definition['name'] == spec['engineName'], 'rendered network exact engine name')
        require(spec['composeDefinitionSha256'] == mutation.digest(definition) and
                spec['approvedConfigSha256'] == fact['configSha256'] and
                spec['ownerLabelsSha256'] == fact['ownerLabelsSha256'] and
                plan['inputs'][resource['specInput']]['sha256'] == mutation.digest(spec),
                'network full definition/config/owner spec linkage')
        require(fact['identitySha256'] == resource['identitySha256'], 'network exact incarnation binding')
        if resource['precondition'] == 'present':
            p.sha(fact['engineId']); p.sha(fact['identitySha256'])
            closed(fact['identity'], ('engineId', 'engineName', 'engineIncarnationSha256',
                'configSha256', 'ownerLabelsSha256'))
            exact(mutation, fact['identity'], {'engineId': fact['engineId'], 'engineName': spec['engineName'],
                'engineIncarnationSha256': facts['acquisition']['engineIncarnationSha256'],
                'configSha256': fact['configSha256'], 'ownerLabelsSha256': fact['ownerLabelsSha256']},
                'full network identity content differs')
            require(mutation.digest(fact['identity']) == fact['identitySha256'], 'network identity digest/content')
        else:
            require(fact['engineId'] == fact['identitySha256'] == '' and fact['identity'] is None,
                    'absent network cannot invent an engine identity')
    actual_ids = [item['engineId'] for item in facts['networks'].values() if item['engineId']]
    require(len(actual_ids) == len(set(actual_ids)), 'distinct declared actual network IDs')

def derive_and_compare(p, mutation, raw_compose, raw_inspect, raw_config, facts, approved_facts_sha256,
                       raw_plan, proxy_resource):
    """Derive every248 effective field; never accept supplied effective projection.

    approved_facts_sha256 must originate in independent held owner inputs. This
    function checks consistency, not authentication; output grants no authority.
    Full raw protected inspect is required, not the AuthZ ID/tag projection.
    """
    require(p.digest(facts) == approved_facts_sha256, 'independently approved full facts differ')
    acquisition, image, engine = facts_contract(p, facts)
    compose, inspect, config = decode(raw_compose), decode(raw_inspect), decode(raw_config)
    require(hashlib.sha256(raw_compose).hexdigest() == acquisition['rawComposeSha256'] and
        hashlib.sha256(raw_inspect).hexdigest() == image['inspectSha256'] and
        hashlib.sha256(raw_config).hexdigest() == image['configBlobSha256'] == image['imageId'], 'raw evidence identity')
    closed(compose, ROOT_FIELDS)
    require(compose['name'] == acquisition['project'] and type(compose['services']) is dict and
        set(compose['services']) == mutation.SERVICES and set(facts['serviceImages']) == mutation.SERVICES,
        'full28 candidate service/image inventory')
    require(type(acquisition['projectDirectory']) is str and acquisition['projectDirectory'].startswith('/') and
            '..' not in acquisition['projectDirectory'].split('/') and
            facts['mounts']['caddy']['resolvedPath'] == acquisition['projectDirectory'].rstrip('/') +
                '/infrastructure/caddy/Caddyfile.private-pilot', 'fixed base-relative held Caddy path')
    exact(p, acquisition['orderedFiles'], ['docker-compose.yml',
        'infrastructure/development-admission/compose.private-proxy.yml'], 'fixed base/overlay acquisition order')
    for name, service in compose['services'].items():
        require(type(service) is dict and type(service.get('image')) is str and
            service['image'] == facts['serviceImages'][name], 'full service image association')
    for name in ('networks', 'volumes', 'secrets'):
        exact(p, compose[name], facts['rootDefinitions'][name], 'complete root definitions differ')
    # Complete inspect equality includes every daemon-version field, not a
    # projection of Config/User/ID. Unknown inspect fields require new approval.
    exact(p, inspect, image['approvedInspect'], 'full reviewed image inspect differs')
    require(inspect.get('Id') == 'sha256:' + image['imageId'], 'exact immutable image ID')
    require(inspect.get('Os') == image['platform']['os'] and inspect.get('Architecture') == image['platform']['architecture'] and
        inspect.get('Variant') == image['platform']['variant'], 'exact inspected platform')
    require(config.get('os') == image['platform']['os'] and config.get('architecture') == image['platform']['architecture'] and
        config.get('variant') == image['platform']['variant'], 'archive configuration platform')
    # Raw config digest already binds all rootfs/history fields; accepted Config
    # must include the complete runtime field inventory for this fixed profile.
    exact(p, config.get('config'), image['approvedConfig'], 'full inherited image configuration')
    exact(p, inspect.get('Config'), image['approvedConfig'], 'inspect/archive inherited config disagreement')
    for key in ('Env', 'Entrypoint', 'Cmd'):
        require(image['approvedConfig'][key] is None or type(image['approvedConfig'][key]) is list and
            all(type(x) is str for x in image['approvedConfig'][key]), 'reviewed inherited image array')
    inherited_volumes = image['approvedConfig']['Volumes']
    require(inherited_volumes is None or type(inherited_volumes) is dict and
        set(inherited_volumes).issubset({'/data', '/config'}), 'anonymous image mount refused')
    for target in inherited_volumes or {}:
        require(inherited_volumes[target] == {}, 'unrepresented inherited mount options')
    # Actual values, including root/default user, are not invented here.
    require(type(image['approvedConfig']['User']) is str and type(image['approvedConfig']['WorkingDir']) is str,
            'reviewed image user/working directory')
    proxy = compose['services']['proxy']
    require(PROXY_REQUIRED <= set(proxy) <= PROXY_REQUIRED | PROXY_OPTIONAL, 'unknown/omitted proxy runtime field')
    for key in ('command', 'entrypoint', 'user'):
        require(key not in proxy or proxy[key] is None, 'explicit process/user override refused')
    require('privileged' not in proxy or proxy['privileged'] is False, 'privilege refused')
    exact(p, proxy.get('cap_add', []), [], 'capability addition refused')
    env = environment(proxy['environment'])
    exact(p, env, {'PRIVATE_APP_HOST': 'dev.lunchlineup.com', 'CADDY_SITE_ADDRESSES': 'http://dev.lunchlineup.com',
        'ADMIN_EMAIL': acquisition['adminEmail'], 'DEPLOY_RELEASE_SHA': acquisition['sourceSha']}, 'exact selected environment')
    closed(proxy['build'], ('context', 'dockerfile'))
    require(proxy['build'] == {'context': acquisition['projectDirectory'], 'dockerfile': 'infrastructure/docker/Dockerfile.proxy'},
            'build-only provenance differs; build never executed')
    require(type(proxy['cpus']) in (str, int, Decimal) and Decimal(str(proxy['cpus'])) == Decimal('1'), 'exact one CPU')
    require(type(proxy['mem_limit']) is int and proxy['mem_limit'] == 536870912 and
        type(proxy['pids_limit']) is int and proxy['pids_limit'] == 256, 'exact byte/PID resources')
    exact(p, proxy['ulimits'], {'nofile': {'soft': 4096, 'hard': 8192}}, 'ulimits')
    require(proxy['tmpfs'] == ['/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777'], 'only exact bounded tmpfs spelling')
    require(type(proxy['ports']) is list and len(proxy['ports']) == 1, 'one private publication')
    port = proxy['ports'][0]; closed(port, ('target', 'published', 'host_ip', 'protocol', 'mode'))
    require(type(port['target']) is int and port['target'] == 8080 and
        (type(port['published']) is int and port['published'] == 80 or type(port['published']) is str and port['published'] == '80') and
        port['host_ip'] == '10.231.10.108' and port['protocol'] == 'tcp' and port['mode'] == engine['publicationDefaults']['mode'],
        'exact private port/default mode')
    require(engine['publicationDefaults']['publishAllPorts'] is False, 'implicit publication refused')
    require(type(proxy['volumes']) is list and len(proxy['volumes']) == 3, 'exact three mounts')
    mounts = {}; caddy = facts['mounts']['caddy']
    require(caddy['sha256'] == acquisition['caddySha256'] and caddy['readOnly'] is True and caddy['noSymlink'] is True,
            'held Caddy identity/access')
    for mount in proxy['volumes']:
        require(type(mount) is dict and mount.get('target') not in mounts, 'duplicate mount target')
        target = mount['target']; mounts[target] = mount
        if target == '/etc/caddy/Caddyfile':
            closed(mount, ('type', 'source', 'target', 'read_only', 'bind'))
            exact(p, mount, {'type': 'bind', 'source': caddy['resolvedPath'], 'target': target, 'read_only': True,
                'bind': {'create_host_path': False}}, 'no automatic bind creation/extra propagation')
        else:
            closed(mount, ('type', 'source', 'target', 'volume'))
            require((target, mount['source']) in (('/data', 'caddy_data'), ('/config', 'caddy_config')) and
                mount['type'] == 'volume' and mount['volume'] == {}, 'named writable mount and no extra options')
    require(set(mounts) == {'/etc/caddy/Caddyfile', '/data', '/config'}, 'exact mount target set')
    closed(proxy['networks'], ('app', 'external'))
    for name, settings in proxy['networks'].items():
        require(settings in (None, {}), 'static IP/alias/priority/network extras refused')
    health = proxy['healthcheck']; closed(health, ('test', 'interval', 'timeout', 'retries'))
    inherited_process_and_health(p, proxy, image['approvedConfig'], engine)
    require(engine['healthDefaults']['startPeriodMs'] == 0 and engine['healthDefaults']['disabled'] is False,
            'unrepresented health start/disable behavior')
    require(engine['processDefaults']['init'] is False and engine['processDefaults']['tty'] is False and
        engine['processDefaults']['stdinOpen'] is False and engine['securityDefaults']['noNewPrivileges'] is True,
        'actual default process/security facts')
    require(engine['mountDefaults']['anonymousVolumes'] == [], 'actual anonymous mounts refused')
    exact(p, engine['restartDefaults'], {'name': 'unless-stopped', 'maximumRetryCount': 0}, 'actual restart facts')
    # This invokes the existing full plan validator first, so typed facts and
    # derivation cannot relax248's finite volume/operation/ownership obligations.
    mutation.validate_plan(raw_plan); plan = mutation.parse_plan(raw_plan)
    require(proxy_resource in plan['proxyRecipes'], 'exact proxy resource')
    recipe = plan['proxyRecipes'][proxy_resource]
    selected_images_and_networks(p, mutation, facts, compose, plan, recipe)
    require(proxy['image'] == 'sha256:' + image['imageId'], 'render must be rebound to exact immutable image')
    require(acquisition['baseComposeSha256'] == mutation.BASE_COMPOSE_SHA256 and
        acquisition['overlaySha256'] == mutation.PRIVATE_PROXY_OVERLAY_SHA256 and
        acquisition['caddySha256'] == mutation.PRIVATE_CADDY_SHA256 and acquisition['project'] == plan['target']['project'],
        'exact frozen input/target binding')
    require(acquisition['guestBootId'] == plan['target']['guestBootId'], 'actual target boot binding')
    for logical in ('caddy_data', 'caddy_config'):
        resource_name = next(name for name, spec in plan['volumeSpecs'].items() if spec['logicalName'] == logical)
        volume = plan['resources'][resource_name]; spec = plan['volumeSpecs'][resource_name]
        require(facts['mounts'][logical]['engineName'] == spec['engineName'] and
            facts['mounts'][logical]['identitySha256'] == volume['identitySha256'], 'exact volume incarnation/name binding')
    for rolekey, fact in (('imageFactsInput', facts['image']), ('installedIngressInput', facts)):

        require(plan['inputs'][recipe[rolekey]]['sha256'] == p.digest(fact), 'typed facts input digest')
    derived = {'imageId': image['imageId'], 'artifactSha256': image['artifactSha256'], 'environment': env,
        'capAdd': proxy.get('cap_add', []), 'capDrop': proxy['cap_drop'], 'securityOpt': proxy['security_opt'],
        'readOnly': proxy['read_only'], 'cpuNano': 1000000000, 'memoryBytes': proxy['mem_limit'],
        'pidsLimit': proxy['pids_limit'], 'nofile': proxy['ulimits']['nofile'], 'logging': proxy['logging'],
        'tmpfs': proxy['tmpfs'], 'ports': [{'hostIp': port['host_ip'], 'published': 80, 'target': port['target'], 'protocol': port['protocol']}],
        'mounts': [{'kind': 'held-bind', 'inputRole': recipe['caddyInput'], 'target': '/etc/caddy/Caddyfile', 'readOnly': True},
            {'kind': 'volume', 'logicalName': 'caddy_data', 'target': '/data', 'readOnly': False},
            {'kind': 'volume', 'logicalName': 'caddy_config', 'target': '/config', 'readOnly': False}],
        'networks': sorted(proxy['networks']), 'healthcheck': {'test': health['test'],
            'intervalMs': seconds(health['interval'], 15000), 'timeoutMs': seconds(health['timeout'], 5000), 'retries': health['retries']},
        'restart': proxy['restart'], 'privileged': False, 'hostNamespaces': [], 'devices': [], 'dockerSocket': False,
        'commandOverride': None, 'entrypointOverride': None, 'userOverride': None, 'sysctls': {}, 'extraHosts': []}
    exact(mutation, derived, recipe['effective'], 'derived complete recipe differs')
    require(mutation.digest(derived) == plan['services']['proxy']['configSha256'], 'mutation canonical config encoding')
    return {'kind': 'derived-private-proxy-configuration', 'effective': derived,
        'effectiveSha256': mutation.digest(derived), 'factsSha256': p.digest(facts),
        'authenticatedAcquisitionVerified': False, 'mutationAuthorized': False, 'tlsVerified': False}


def dispatch(*_args, **_kwargs):
    raise RuntimeError('normalization is not dispatch; actual pinned owner facts/admission remain required')
