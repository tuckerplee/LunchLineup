#!/usr/bin/env python3
"""Bounded read-only preflight of Docker/OCI save metadata; never extracts.
Finalized byte custody and exclusive daemon custody remain admission dependencies.
"""
import gzip
import fcntl
import struct
import threading
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys
import tarfile
import tempfile

MAX_ARCHIVE = 32 * 1024**3
MAX_EXPANDED = 64 * 1024**3
MAX_METADATA = 16 * 1024**2
MAX_ENTRIES = 10000
MAX_TAGS = 4096
HEX = r"[a-f0-9]{64}"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def decode(data):
    return json.loads(data, object_pairs_hook=unique_object)


def secure_file(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, "noncanonical input path")
    for parent in [path, *path.parents]:
        st = parent.lstat()
        require(st.st_uid == 0 and not st.st_mode & 0o022, "input ancestry is not root-controlled")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    st = os.fstat(fd)
    require(stat.S_ISREG(st.st_mode), "input is not a regular file")
    return os.fdopen(fd, "rb"), st.st_size


def canonical_tag(tag):
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


def parse_reference(value):
    """Validate name[:tag][@sha256:digest], keeping tag/port colons distinct."""
    require(isinstance(value, str) and value.count('@') <= 1, 'invalid image reference')
    if '@' not in value:
        return {'kind': 'tag', 'normalizedTag': canonical_tag(value)}
    name, digest_value = value.rsplit('@', 1)
    require(re.fullmatch('sha256:' + HEX, digest_value), 'invalid reference digest')
    # A port or IPv6 registry occurs before the last slash, not in the image's
    # final name component. Only a colon in that final component introduces tag.
    final_component = name.rsplit('/', 1)[-1]
    normalized = canonical_tag(name if ':' in final_component else name + ':validation-only')
    repository = normalized.rsplit(':', 1)[0]
    return {'kind': 'digest', 'normalizedRepository': repository,
            'digest': digest_value, 'normalizedTag': normalized if ':' in final_component else None}


def validate_platform(record):
    require(isinstance(record, dict) and set(record) == {'configImageId', 'os', 'architecture', 'variant'}, 'closed platform record required')
    require(isinstance(record['configImageId'], str) and re.fullmatch('sha256:' + HEX, record['configImageId']), 'platform config identity invalid')
    require(all(isinstance(record[k], str) and re.fullmatch('[a-z0-9][a-z0-9._-]{0,63}', record[k]) for k in ('os', 'architecture')), 'concrete OS/architecture required')
    require(record['variant'] is None or isinstance(record['variant'], str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,63}', record['variant']), 'platform variant invalid')


def archive_mapping(open_archive, archive, expected, budget):
    raw, size = open_archive()
    with raw:
        require(type(archive['bytes']) is int and 0 < size == archive['bytes'] <= MAX_ARCHIVE, "archive size mismatch or limit")
        budget['compressed'] += size
        require(budget['compressed'] <= 64 * 1024**3, "aggregate compressed archive limit")
        digest = hashlib.sha256()
        while chunk := raw.read(1024 * 1024):
            digest.update(chunk)
        require(digest.hexdigest() == archive['sha256'], "archive checksum mismatch")
        raw.seek(0)
        require(raw.read(2) == b'\x1f\x8b', "gzip archive required")
        raw.seek(0)
        with gzip.GzipFile(fileobj=raw) as stream:
            class BoundedReader:
                expanded = 0
                def read(self, count):
                    require(0 <= count <= MAX_METADATA, "oversized tar metadata read")
                    require(self.expanded + count <= MAX_EXPANDED, "expanded archive limit")
                    require(budget['expanded'] + count <= 128 * 1024**3, "aggregate expanded archive limit")
                    data = stream.read(count)
                    self.expanded += len(data)
                    budget['expanded'] += len(data)
                    return data
            reader = BoundedReader()
            files = {}
            # tarfile interprets bounded PAX/GNU long-name records without extracting.
            # Links/sparse/special members remain forbidden after interpretation.
            class BoundedTarInfo(tarfile.TarInfo):
                extension_bytes = 0
                physical_records = 0
                @classmethod
                def frombuf(cls, buf, encoding, errors):
                    info = super().frombuf(buf, encoding, errors)
                    cls.physical_records += 1
                    require(cls.physical_records <= MAX_ENTRIES, "physical tar record limit")
                    return info
                def extension_limit(self):
                    require(0 <= self.size <= MAX_METADATA, "tar extension size limit")
                    BoundedTarInfo.extension_bytes += self.size
                    require(BoundedTarInfo.extension_bytes <= 128 * 1024**2, "aggregate tar extension limit")
                def _proc_pax(self, tar):
                    self.extension_limit()
                    return super()._proc_pax(tar)
                def _proc_gnulong(self, tar):
                    self.extension_limit()
                    return super()._proc_gnulong(tar)
                def _proc_sparse(self, tar):
                    raise ValueError('sparse tar forbidden')
            with tarfile.open(fileobj=reader, mode='r|', tarinfo=BoundedTarInfo) as tar:
                logical_records = 0
                for info in tar:
                    logical_records += 1
                    require(logical_records <= MAX_ENTRIES, "logical tar member limit")
                    require(not info.name.startswith('/'), "absolute member path")
                    name = info.name.rstrip('/')
                    while name.startswith('./'):
                        name = name[2:]
                    require(info.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) and not info.linkname and info.sparse is None, "unsupported link/sparse/special member")
                    require(set(info.pax_headers) <= {'path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'}, "unsupported PAX semantics")
                    require(0 <= info.size <= MAX_EXPANDED and (not info.isdir() or info.size == 0), "invalid member size")
                    if info.isdir() and name in ('', '.'):
                        continue
                    require(name and all(x not in ('', '.', '..') for x in name.split('/')), "unsafe member path")
                    require(name not in files, "duplicate archive member")
                    digest = hashlib.sha256()
                    if not info.isdir():
                        member = tar.extractfile(info)
                        remaining = info.size
                        while remaining:
                            chunk = member.read(min(1024 * 1024, remaining))
                            require(chunk, "truncated member")
                            digest.update(chunk)
                            remaining -= len(chunk)
                    files[name] = (digest.hexdigest(), info.size, info.isdir(), info.offset_data)
                # Reject another archive or any nonzero data after tar EOF.
                # Include tarfile's buffered bytes as well as the underlying reader.
                require(not any(tar.fileobj.buf), "nonzero trailing tar buffer")
                while tail := reader.read(1024 * 1024):
                    require(not any(tail), "nonzero trailing archive data")

    documents, roles = {}, {}
    metadata_bytes = 0
    def role(name, kind):
        require(name in files and not files[name][2], "missing role payload")
        require(name not in roles or roles[name] == kind, "conflicting metadata/layer role")
        roles[name] = kind

    def document(name):
        nonlocal metadata_bytes
        role(name, 'metadata')
        if name not in documents:
            dg, length, _, offset = files[name]
            require(length <= MAX_METADATA, "metadata item limit")
            metadata_bytes += length
            require(metadata_bytes <= 128 * 1024**2, "aggregate metadata byte limit")
            # Role-driven bounded reread: small binary layers are never cached.
            # Charge all decompression needed to seek, not just returned JSON.
            work = offset + length
            require(work <= MAX_EXPANDED and budget['expanded'] + work <= 128 * 1024**3, "metadata reread expansion budget")
            budget['expanded'] += work
            again, observed_size = open_archive()
            with again:
                require(observed_size == size, "archive changed before metadata reread")
                with gzip.GzipFile(fileobj=again) as stream:
                    require(stream.seek(offset) == offset, "metadata offset unavailable")
                    data = stream.read(length)
            require(len(data) == length and hashlib.sha256(data).hexdigest() == dg, "metadata reread identity mismatch")
            documents[name] = decode(data)
        return documents[name]

    def blob(descriptor):
        require(isinstance(descriptor, dict), "invalid OCI descriptor")
        dg = descriptor.get('digest', '')
        require(re.fullmatch('sha256:' + HEX, dg), "unsupported OCI digest")
        name = 'blobs/sha256/' + dg[7:]
        require(name in files and not files[name][2] and files[name][0] == dg[7:] and type(descriptor.get('size')) is int and files[name][1] == descriptor['size'], "OCI descriptor payload mismatch")
        return name

    docker_tags, config_ids, tops = {}, set(), {}
    parents, config_layers = {}, {}
    platform_records = {}
    if 'manifest.json' in files:
        manifests = document('manifest.json')
        require(isinstance(manifests, list) and 0 < len(manifests) <= 256, "invalid Docker image manifest")
        for item in manifests:
            require(isinstance(item, dict) and {'Config', 'RepoTags', 'Layers'} <= set(item) and set(item) <= {'Config', 'RepoTags', 'Layers', 'LayerSources', 'Parent'}, "unsupported Docker manifest fields")
            config = item['Config']; layers = item['Layers']
            require(isinstance(config, str) and config in files and not files[config][2], "missing config")
            identity = 'sha256:' + files[config][0]
            config_ids.add(identity)
            require(isinstance(layers, list) and len(layers) <= 256 and all(isinstance(x, str) and x in files and not files[x][2] for x in layers), "invalid Docker layers")
            for layer in layers:
                role(layer, 'layer')
            conf = document(config)
            require(isinstance(conf, dict), "invalid config object")
            diffids = conf.get('rootfs', {}).get('diff_ids', [])
            require(isinstance(diffids, list) and len(diffids) == len(layers) and all(re.fullmatch('sha256:' + HEX, x) for x in diffids), "invalid config layer identities")
            platform_records[identity] = {'configImageId': identity, 'os': conf.get('os'), 'architecture': conf.get('architecture'), 'variant': conf.get('variant')}
            validate_platform(platform_records[identity])
            config_layers[identity] = diffids
            # Legacy repositories points to the top layer directory (old saves)
            # or the final diff ID (new Moby saves). Reconcile both representations.
            if layers:
                legacy_top = layers[-1].split('/')[0]
                if re.fullmatch(HEX, legacy_top):
                    tops.setdefault(legacy_top, set()).add(identity)
                tops.setdefault(diffids[-1][7:], set()).add(identity)
            tags = item['RepoTags'] or []
            require(isinstance(tags, list) and len(tags) <= MAX_TAGS, "invalid Docker tags")
            for tag in tags:
                normalized = canonical_tag(tag)
                require(normalized not in docker_tags or docker_tags[normalized] == {identity}, "contradictory Docker tag assignments")
                docker_tags[normalized] = {identity}
                require(len(docker_tags) <= MAX_TAGS, "Docker tag count limit")
            sources = item.get('LayerSources') or {}
            require(isinstance(sources, dict) and len(sources) <= 256, "invalid LayerSources")
            # LayerSources cannot introduce tags; require its digest keys belong
            # to the declared config rather than silently dropping foreign layers.
            require(set(sources) <= set(diffids), "unbound LayerSources")
            for diffid, descriptor in sources.items():
                require(isinstance(descriptor, dict), "invalid LayerSources descriptor")
                layer_name = layers[diffids.index(diffid)]
                require(re.fullmatch('sha256:' + HEX, descriptor.get('digest', '')) and type(descriptor.get('size')) is int and descriptor['size'] >= 0 and isinstance(descriptor.get('mediaType'), str), "invalid LayerSources identity")
                # LayerSources describes distribution bytes; Moby may retain a
                # compressed descriptor while saving an uncompressed TarStream.
                # Its digest/size are not the identity of the local archive member.
                # The Docker-save layer payload is independently bound to diff_id.
                require('sha256:' + files[layer_name][0] == diffid,
                        "local Docker-save layer differs from config diff ID")
                require(isinstance(descriptor.get('urls', []), list) and all(isinstance(x, str) for x in descriptor.get('urls', [])), "invalid LayerSources URLs")
            parent = item.get('Parent')
            require(parent is None or isinstance(parent, str) and re.fullmatch('sha256:' + HEX, parent) and parent != identity, "invalid Docker parent")
            if parent is not None:
                require(identity not in parents or parents[identity] == parent, "contradictory parent relation")
                parents[identity] = parent
        for child, parent in parents.items():
            require(parent in config_layers and config_layers[child][:len(config_layers[parent])] == config_layers[parent], "unbound or incompatible Docker parent")
            seen = {child}
            current = parent
            while current in parents:
                require(current not in seen, "cyclic Docker parent relation")
                seen.add(current)
                current = parents[current]
    if 'repositories' in files:
        repos = document('repositories')
        require(isinstance(repos, dict) and len(repos) <= MAX_TAGS, "invalid legacy repositories")
        for repo, tags in repos.items():
            require(isinstance(tags, dict) and len(tags) <= MAX_TAGS, "invalid legacy tags")
            for tag, top in tags.items():
                name = canonical_tag(repo + ':' + tag)
                require(isinstance(top, str) and name in docker_tags and docker_tags[name] <= tops.get(top, set()), "legacy/Docker tag disagreement")

    oci_tags, oci_ids, visited = {}, set(), set()
    graph_configs, graph_types = {}, {}
    index_types = {'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'}
    manifest_types = {'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'}
    config_types = {'application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'}
    visits = 0
    def visit(desc, depth=0):
        nonlocal visits
        visits += 1
        require(depth <= 16 and visits <= 4096, "OCI graph bound")
        name = blob(desc); dg = desc['digest']
        require(dg not in visited, "OCI cyclic or repeated recursion")
        visited.add(dg)
        doc = document(name)
        require(isinstance(doc, dict) and doc.get('schemaVersion') == 2, "invalid OCI schema")
        media = desc.get('mediaType')
        require(media in index_types | manifest_types and doc.get('mediaType', media) == media, "OCI media type mismatch")
        if media in index_types:
            require('config' not in doc and 'layers' not in doc, "ambiguous OCI index")
            children = doc['manifests']
            require(isinstance(children, list) and 0 < len(children) <= 256, "invalid OCI index")
            identities = set()
            for child in children:
                identities.update(visit(child, depth + 1))
        else:
            require('manifests' not in doc and doc['config'].get('mediaType') in config_types, "invalid OCI image shape")
            config = blob(doc['config'])
            identity = 'sha256:' + files[config][0]
            conf = document(config)
            require(isinstance(conf, dict) and isinstance(conf.get('os'), str) and isinstance(conf.get('architecture'), str), "invalid OCI config platform")
            diffids = conf.get('rootfs', {}).get('diff_ids', [])
            require(isinstance(diffids, list) and len(diffids) == len(doc.get('layers', [])) and all(isinstance(x, str) and re.fullmatch('sha256:' + HEX, x) for x in diffids), "invalid OCI config layers")
            platform_records[identity] = {'configImageId': identity, 'os': conf.get('os'), 'architecture': conf.get('architecture'), 'variant': conf.get('variant')}
            validate_platform(platform_records[identity])
            identities = {identity}
            config_ids.add(identity)
            require(isinstance(doc.get('layers'), list) and len(doc['layers']) <= 256, "invalid OCI layers")
            for layer in doc['layers']:
                require(isinstance(layer.get('mediaType'), str) and ('image.layer.' in layer['mediaType'] or 'image.rootfs.' in layer['mediaType']), "unsupported OCI layer media type")
                role(blob(layer), 'layer')
        graph_configs[dg] = identities
        graph_types[dg] = media
        oci_ids.add(dg)
        annotations = desc.get('annotations', {})
        require(isinstance(annotations, dict), "invalid OCI annotations")
        full = annotations.get('io.containerd.image.name')
        ref = annotations.get('org.opencontainers.image.ref.name')
        if full and '@sha256:' in full:
            reference = parse_reference(full)
            digest = reference['digest']
            require(digest == dg, "OCI digest reference differs from descriptor target")
            # Digest references introduce no mutable repository tag.
            require(not ref or ref in (full, digest, digest[7:]), "OCI digest annotation disagreement")
        elif full:
            tag = canonical_tag(full)
            require(not ref or ref == full or ref == full.rsplit(':', 1)[1], "OCI annotation disagreement")
            require(tag not in oci_tags or oci_tags[tag] == dg, "contradictory OCI tag targets")
            oci_tags[tag] = dg
        elif ref:
            # OCI exporters may put the complete tagged name directly here.
            tag = canonical_tag(ref)
            require(tag not in oci_tags or oci_tags[tag] == dg, "contradictory OCI tag targets")
            oci_tags[tag] = dg
        require(len(oci_tags) <= MAX_TAGS, "OCI tag count limit")
        visited.remove(dg)
        return identities
    if 'index.json' in files or 'oci-layout' in files:
        require(document('oci-layout') == {'imageLayoutVersion': '1.0.0'}, "invalid OCI layout")
        index = document('index.json')
        require(index.get('schemaVersion') == 2 and isinstance(index.get('manifests'), list) and 0 < len(index['manifests']) <= 256, "invalid OCI root index")
        for desc in index['manifests']:
            visit(desc)
    require(config_ids and expected in config_ids | oci_ids, "expected image absent from archive")
    # Exact targets are distinct from their platform/config descendants.
    # Never turn a set containing expected into an assignment to expected.
    result = {}
    for tag in docker_tags.keys() | oci_tags.keys():
        docker = docker_tags.get(tag)
        target = oci_tags.get(tag)
        if docker is not None:
            require(docker == {expected}, "Docker tag differs from expected exported identity")
            if target is not None:
                require(graph_types[target] in manifest_types and graph_configs[target] == docker, "Docker/OCI tag targets disagree")
        elif target is not None:
            configs = graph_configs[target]
            require(target == expected or graph_types[target] in manifest_types and configs == {expected}, "OCI tag has ambiguous or different exported target")
            # Multi-platform indexes retain their exact top-level identity; a
            # single descendant config cannot authorize overwriting that tag.
        result[tag] = expected

    require(len(result) <= MAX_TAGS, "archive tag bound")
    return {'tags': sorted(result), 'configImageIds': sorted(config_ids), 'ociDescriptorIds': sorted(oci_ids), 'platforms': [platform_records[k] for k in sorted(platform_records)]}


def output_limit():
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))


def require_existing_identities(mappings, owner_gate=None):
    require(owner_gate is not None, "live owner/daemon inventory custody is not installed")
    owner_gate.require_live_inventory_custody()
    # Read the whole bounded inventory: exact normalized comparison avoids Docker
    # reference-filter spelling differences hiding a retained tag alias.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        result = subprocess.run(
            ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', '--config',
             '/etc/lunchlineup/docker', 'image', 'ls', '--no-trunc', '--format',
             '{{json .}}'],
            env={'PATH': '/usr/bin:/bin'}, stdout=stdout, stderr=stderr,
            timeout=30, check=False, preexec_fn=output_limit)
        require(result.returncode == 0, "local image inventory failed")
        stdout.seek(0)
        data = stdout.read(1024 * 1024 + 1)
        require(len(data) < 1024 * 1024, "local image inventory limit")
        for line in data.splitlines():
            row = decode(line)
            require(isinstance(row, dict), "invalid local image inventory")
            repository, tag, identity = row['Repository'], row['Tag'], row['ID']
            require(isinstance(identity, str) and re.fullmatch('sha256:' + HEX, identity), "invalid local image identity")
            if repository == '<none>' or tag == '<none>':
                continue
            normalized = canonical_tag(repository + ':' + tag)
            require(normalized not in mappings or mappings[normalized] == identity,
                    "archive/candidate tag conflicts with retained image: " + normalized)


# Trusted in-process supervisor API only. Caller owns all original FDs and the
# operation flock/lease. This lock serializes parser duplicates and shared offsets
# within this module; the supervisor must exclude all other readers of those FDs.
_FD_PARSE_LOCK = threading.Lock()
SERVICE_ARTIFACTS = {
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


class PinnedArchiveInput:
    """Borrowed immutable FD. Never closes the supervisor's descriptor."""
    def __init__(self, entry, maximum):
        require(isinstance(entry, dict) and set(entry) == {'fd', 'bytes', 'sha256', 'veritySha256', 'device', 'inode'}, 'invalid pinned input fields')
        require(type(entry['fd']) is int and entry['fd'] >= 0 and type(entry['bytes']) is int and 0 < entry['bytes'] <= maximum, 'pinned descriptor/size bound')
        require(all(isinstance(entry[k], str) and re.fullmatch(HEX, entry[k]) for k in ('sha256', 'veritySha256')), 'pinned digest invalid')
        require(all(type(entry[k]) is int and entry[k] >= 0 for k in ('device', 'inode')), 'pinned device/inode invalid')
        require(fcntl.fcntl(entry['fd'], fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY, 'read-only borrowed FD required')
        self.entry = dict(entry)
        info = os.fstat(entry['fd'])
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and info.st_size == entry['bytes'] and info.st_dev == entry['device'] and info.st_ino == entry['inode'], 'pinned FD identity differs')
        measurement = bytearray(struct.pack('HH', 0, 64) + bytes(64))
        fcntl.ioctl(entry['fd'], 0xC0046686, measurement, True)
        require(struct.unpack('HH', measurement[:4]) == (1, 32) and measurement[4:36].hex() == entry['veritySha256'], 'immutable input measurement differs')

    def verify_content(self):
        entry = self.entry
        os.lseek(entry['fd'], 0, os.SEEK_SET)
        h = hashlib.sha256()
        while chunk := os.read(entry['fd'], 1024 * 1024):
            h.update(chunk)
        require(h.hexdigest() == entry['sha256'], 'pinned input content differs')
        os.lseek(entry['fd'], 0, os.SEEK_SET)

    def open(self):
        # dup shares file offset. All reads are serialized by bundle_preflight_fds.
        original = self.entry['fd']
        info = os.fstat(original)
        require((info.st_dev, info.st_ino, info.st_size) == (self.entry['device'], self.entry['inode'], self.entry['bytes']), 'pinned input changed')
        os.lseek(original, 0, os.SEEK_SET)
        duplicate = os.dup(original)
        try:
            return os.fdopen(duplicate, 'rb'), self.entry['bytes']
        except BaseException:
            os.close(duplicate)
            raise

    def identity(self):
        return {k: v for k, v in self.entry.items() if k != 'fd'}


def bundle_preflight_fds(inputs, approved):
    """Pure FD/metadata preflight: no pathname opens or Docker subprocess.

    `approved` comes only from independently pinned supervisor policy. It is not
    an RPC parameter or permission token. Returns inventoryPending, never ready.
    """
    require(isinstance(approved, dict) and set(approved) == {'sourceSha', 'treeSha', 'prefix', 'manifestSha256', 'helperSha256', 'artifacts'}, 'closed candidate policy required')
    require(all(isinstance(approved[k], str) and re.fullmatch('[a-f0-9]{40}', approved[k]) for k in ('sourceSha', 'treeSha')), 'candidate source/tree required')
    require(isinstance(approved['prefix'], str) and re.fullmatch('[a-z0-9][a-z0-9._/-]*', approved['prefix']), 'approved image prefix required')
    require(set(approved['artifacts']) == set(SERVICE_ARTIFACTS.values()), 'complete 21-artifact policy required')
    require(isinstance(inputs, dict) and set(inputs) == {'manifest', 'helper', *('archive:' + name for name in approved['artifacts'])}, 'exact pinned role set required')
    require(_FD_PARSE_LOCK.acquire(blocking=False), 'another FD parser owns offsets')
    borrowed = []
    try:
        pinned = {}
        for role, entry in inputs.items():
            # Remember only validated numeric descriptors for best-effort rewind;
            # ownership never transfers and originals are never closed here.
            require(isinstance(entry, dict) and type(entry.get('fd')) is int, 'invalid borrowed FD')
            require(entry['fd'] not in borrowed, 'duplicate borrowed descriptor role')
            borrowed.append(entry['fd'])
            pinned[role] = PinnedArchiveInput(entry, MAX_ARCHIVE if role.startswith('archive:') else MAX_METADATA)
        total_archive_bytes = sum(value.entry['bytes'] for role, value in pinned.items() if role.startswith('archive:'))
        require(total_archive_bytes <= 64 * 1024**3, 'aggregate compressed archive limit before scan')
        require(pinned['manifest'].entry['sha256'] == approved['manifestSha256'] and pinned['helper'].entry['sha256'] == approved['helperSha256'], 'manifest/helper differs from installed candidate policy')
        pinned['manifest'].verify_content()
        pinned['helper'].verify_content()
        raw, _ = pinned['manifest'].open()
        with raw:
            manifest = decode(raw.read(MAX_METADATA + 1))
        require(manifest.get('sourceSha') == approved['sourceSha'] and manifest.get('treeSha') == approved['treeSha'], 'manifest candidate differs')
        images, services = manifest.get('images'), manifest.get('services')
        require(isinstance(images, dict) and set(images) == set(approved['artifacts']) and isinstance(services, dict) and set(services) == set(SERVICE_ARTIFACTS), 'complete service/artifact mapping required')
        for service, artifact in SERVICE_ARTIFACTS.items():
            require(services[service]['imageArtifact'] == artifact and services[service]['resolvedRef'] == images[artifact]['resolvedRef'], 'service image assignment differs')
        mappings, archive_receipts = {}, {}
        budget = {'compressed': 0, 'expanded': 0}
        for name, image in images.items():
            policy = approved['artifacts'][name]
            require(isinstance(policy, dict) and set(policy) == {'localImageId', 'resolvedRef', 'archiveSha256', 'archiveBytes', 'platforms'}, 'closed artifact policy required')
            archive, expected = image['archive'], image['localImageId']
            require(expected == policy['localImageId'] and re.fullmatch('sha256:' + HEX, expected) and image['resolvedRef'] == policy['resolvedRef'], 'artifact identity differs')
            require(archive['path'] == 'images/' + name + '.tar.gz' and archive['sha256'] == policy['archiveSha256'] == pinned['archive:' + name].entry['sha256'] and type(archive['bytes']) is int and archive['bytes'] == policy['archiveBytes'] == pinned['archive:' + name].entry['bytes'], 'archive role binding differs')
            require(sorted(image['composeServices']) == sorted(s for s, a in SERVICE_ARTIFACTS.items() if a == name), 'artifact consumer set differs')
            require(isinstance(image['resolvedRef'], str), 'resolved reference type invalid')
            parse_reference(image['resolvedRef'])
            require(isinstance(policy['platforms'], list) and policy['platforms'], 'concrete platform policy required')
            for platform in policy['platforms']:
                validate_platform(platform)
        # All artifact declarations/pins/platform shapes pass before archive IO.
        for name, image in images.items():
            policy = approved['artifacts'][name]
            archive, expected = image['archive'], image['localImageId']
            result = archive_mapping(pinned['archive:' + name].open, archive, expected, budget)
            require(isinstance(policy['platforms'], list) and result['platforms'] == policy['platforms'], 'complete platform/config set differs; no platform filtering permitted')
            candidate_tag = canonical_tag(approved['prefix'] + '/' + name + ':' + approved['sourceSha'])
            reference = image['resolvedRef']
            require(isinstance(reference, str), 'resolved reference must be a string')
            if '@' in reference:
                ref_digest = parse_reference(reference)['digest']
                reference_status = {'resolvedRef': reference, 'status': 'pending-live-repodigest-association', 'descriptorPresent': ref_digest in result['ociDescriptorIds']}
            else:
                normalized = canonical_tag(reference)
                require(normalized in result['tags'] or normalized == candidate_tag, 'resolved tag has no exported or planned mapping')
                reference_status = {'resolvedRef': reference, 'normalizedRef': normalized, 'status': 'exported-tag' if normalized in result['tags'] else 'planned-candidate-tag', 'expectedImageId': expected}
            tags = result['tags'] + [candidate_tag]
            for tag in tags:
                require(tag not in mappings or mappings[tag] == expected, 'conflicting bundle tag mapping')
                mappings[tag] = expected
            require(len(mappings) <= MAX_TAGS, 'bundle tag-count limit')
            archive_receipts[name] = dict(result, resolvedReference=reference_status, inputIdentity=pinned['archive:' + name].identity(), expectedImageId=expected)
        receipt = {'version': 1, 'kind': 'immutable-fd-archive-preflight',
            'sourceSha': approved['sourceSha'], 'treeSha': approved['treeSha'],
            'manifest': pinned['manifest'].identity(), 'helper': pinned['helper'].identity(),
            'services': {service: {'artifact': artifact, 'resolvedReference': archive_receipts[artifact]['resolvedReference']} for service, artifact in SERVICE_ARTIFACTS.items()}, 'archives': archive_receipts,
            'tags': dict(sorted(mappings.items())), 'chargedWork': dict(budget, archiveIntegrityHashBytes=budget['compressed'], manifestHelperIntegrityHashBytes=pinned['manifest'].entry['bytes'] + pinned['helper'].entry['bytes']),
            'inventoryStatus': 'pending-live-owner-custody', 'loadAuthorized': False}
        serialized = json.dumps(receipt, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
        require(len(serialized) <= 1024 * 1024, 'FD preflight receipt limit')
        return {'receipt': receipt, 'sha256': hashlib.sha256(serialized).hexdigest(), 'bytes': len(serialized)}
    finally:
        # Do not close supervisor-owned FDs. Rewind even after refusal. A failed
        # rewind poisons integration: caller must not proceed to a later reader.
        rewind_errors = []
        for fd in borrowed:
            try:
                os.lseek(fd, 0, os.SEEK_SET)
            except OSError as error:
                rewind_errors.append(error)
        _FD_PARSE_LOCK.release()
        if rewind_errors:
            raise ValueError('supervisor FD rewind failed; input custody unusable') from rewind_errors[0]


def owner_gated_inventory(preflight, binding, owner_gate=None, *, read_backend=None):
    """Read-only source adapter. No default authority, loading or tagging.

    Only installed Manager integration may supply owner_gate/lease. It must
    authenticate fresh estate/storage/hold/exclusive-writer/daemon/store custody.
    An arbitrary caller-provided object is not an authenticated owner context.
    """
    require(owner_gate is not None, 'authenticated live inventory owner is not installed')
    require(isinstance(binding, dict) and set(binding) == {'managerContextId', 'candidateSha', 'preflightSha256', 'daemonId', 'dockerRootDir', 'serverVersion', 'maxImages'}, 'closed live inventory binding required')
    encoded = json.dumps(preflight['receipt'], sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    require(len(encoded) <= 1024 * 1024 and hashlib.sha256(encoded).hexdigest() == preflight['sha256'] == binding['preflightSha256'] and preflight['receipt']['sourceSha'] == binding['candidateSha'] and preflight['receipt']['loadAuthorized'] is False, 'live inventory candidate binding differs')
    require(type(binding['maxImages']) is int and 1 <= binding['maxImages'] <= 256, 'inventory image limit required')
    lease = owner_gate.acquire_readonly_inventory(binding)
    # No permissive fallback: absent/unimplemented adapter raises before Docker.
    command_count = 0
    output_bytes = 0
    stdout_bytes = 0
    stderr_bytes = 0
    diagnostics = []
    def read(args):
        nonlocal command_count, output_bytes, stdout_bytes, stderr_bytes
        lease.assert_current(binding)
        command_count += 1
        require(command_count <= binding['maxImages'] + 3, 'inventory command bound')
        require(read_backend is not None, 'fixed guardian inventory broker required; direct Docker unavailable')
        result = read_backend.read(args)
        require(isinstance(result, dict) and isinstance(result.get('stdout'), bytes), 'broker output required')
        out_size, err_size = result['stdoutBytes'], result['stderrBytes']
        require(type(out_size) is int and type(err_size) is int and 0 <= out_size < 1024 * 1024 and
                0 <= err_size < 1024 * 1024 and len(result['stdout']) == out_size, 'broker stream accounting differs')
        diagnostic_hex = result['stderrPrefixHex']
        require(isinstance(diagnostic_hex, str) and len(diagnostic_hex) <= 8192 and
                re.fullmatch('[a-f0-9]*', diagnostic_hex) and len(diagnostic_hex) % 2 == 0 and
                len(diagnostic_hex) // 2 <= err_size, 'broker diagnostic bound')
        stdout_bytes += out_size
        stderr_bytes += err_size
        output_bytes = stdout_bytes + stderr_bytes
        summary = {'command': command_count, 'stdoutBytes': out_size, 'stderrBytes': err_size,
                   'stderrPrefixHex': diagnostic_hex, 'stderrTruncated': err_size > len(diagnostic_hex) // 2}
        diagnostics.append(summary)
        lease.record_readonly_diagnostic(summary)
        require(type(result['returncode']) is int and result['returncode'] == 0, 'read-only daemon inventory returned nonzero status')
        require(output_bytes <= 16 * 1024 * 1024, 'combined inventory output bound')
        lease.assert_current(binding)
        return result['stdout']
    try:
        info_format = '{"id":{{json .ID}},"dockerRootDir":{{json .DockerRootDir}},"serverVersion":{{json .ServerVersion}}}'
        info = decode(read(['info', '--format', info_format]))
        require(info == {'id': binding['daemonId'], 'dockerRootDir': binding['dockerRootDir'], 'serverVersion': binding['serverVersion']}, 'daemon/store identity differs')
        rows = [decode(line) for line in read(['image', 'ls', '--no-trunc', '--format', '{{json .}}']).splitlines()]
        ids = set()
        for row in rows:
            require(isinstance(row, dict) and isinstance(row.get('ID'), str) and re.fullmatch('sha256:' + HEX, row['ID']), 'invalid retained image ID')
            ids.add(row['ID'])
        require(len(ids) <= binding['maxImages'], 'retained image inventory exceeds admitted scope')
        tags, digests = {}, {}
        inspect_format = '{"id":{{json .Id}},"tags":{{json .RepoTags}},"digests":{{json .RepoDigests}}}'
        for identity in sorted(ids):
            image = decode(read(['image', 'inspect', '--format', inspect_format, identity]))
            require(isinstance(image, dict) and set(image) == {'id', 'tags', 'digests'} and image['id'] == identity, 'retained image changed')
            image_tags, image_digests = image['tags'] or [], image['digests'] or []
            require(isinstance(image_tags, list) and isinstance(image_digests, list), 'invalid image references')
            for tag in image_tags:
                normalized = canonical_tag(tag)
                require(normalized not in tags or tags[normalized] == identity, 'ambiguous retained tag')
                tags[normalized] = identity
            for ref in image_digests:
                parsed = parse_reference(ref)
                require(parsed['kind'] == 'digest', 'invalid retained RepoDigest')
                name = parsed['normalizedRepository'] + '@' + parsed['digest']
                require(name not in digests or digests[name] == identity, 'ambiguous retained RepoDigest')
                digests[name] = identity
            require(len(tags) <= MAX_TAGS and len(digests) <= MAX_TAGS, 'retained reference bound')
        for tag, expected in preflight['receipt']['tags'].items():
            require(tag not in tags or tags[tag] == expected, 'retained tag conflicts with candidate')
        associations = {}
        for artifact, archive in preflight['receipt']['archives'].items():
            ref = archive['resolvedReference']['resolvedRef']
            parsed = parse_reference(ref)
            expected = archive['expectedImageId']
            observed = digests.get(parsed['normalizedRepository'] + '@' + parsed['digest']) if parsed['kind'] == 'digest' else tags.get(parsed['normalizedTag'])
            require(observed is None or observed == expected, 'resolved reference points to another retained image')
            associations[artifact] = {'resolvedRef': ref, 'expectedImageId': expected, 'observedImageId': observed,
                'status': 'verified-current-daemon-association' if observed == expected else 'pending-image-load-and-postload-readback'}
        # Context must remain admitted through all reads; no mutation is authorized.
        require(decode(read(['info', '--format', info_format])) == info, 'daemon/store changed during inventory')
        lease.assert_current(binding)
        receipt = {'kind': 'owner-gated-read-only-image-inventory', 'managerContextId': binding['managerContextId'], 'candidateSha': binding['candidateSha'], 'preflightSha256': binding['preflightSha256'], 'daemon': info, 'associations': associations, 'retainedImageIds': sorted(ids), 'commands': command_count, 'stdoutBytes': stdout_bytes, 'stderrBytes': stderr_bytes, 'outputBytes': output_bytes, 'diagnostics': [{'command': x['command'], 'stdoutBytes': x['stdoutBytes'], 'stderrBytes': x['stderrBytes']} for x in diagnostics], 'loadAuthorized': False}
        data = json.dumps(receipt, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
        require(len(data) <= 1024 * 1024, 'inventory receipt limit')
        return {'receipt': receipt, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    finally:
        # Preserve a primary read failure if sublease settlement also fails.
        primary = sys.exc_info()[1]
        try:
            lease.finish_readonly_inventory()
        except BaseException as secondary:
            if primary is None:
                raise
            if hasattr(primary, 'add_note'):
                primary.add_note('Read-only sublease settlement failure: ' + type(secondary).__name__)


def main():
    # No public pathname mode may perform legacy default-socket inspection.
    # The pinned worker calls bundle_preflight_fds through the authenticated
    # guardian input channel; owner_gated_inventory remains read-only.
    raise ValueError('standalone preflight refused: authenticated owner worker context required')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('image archive preflight refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
