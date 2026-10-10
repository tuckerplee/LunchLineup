import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stableJson } from './internal-ci-evidence.mjs';

// Build/receipt binding only. A profile is not permission to activate a server.
export function readPrivateTargetProfile(path = process.env.LUNCHLINEUP_PRIVATE_TARGET_PROFILE) {
  if (!path || !isAbsolute(path)) throw new Error('An absolute LUNCHLINEUP_PRIVATE_TARGET_PROFILE is required.');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Private target profile must be a bounded regular file.');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const keys = ['version', 'kind', 'targetId', 'origin', 'expectedHostname', 'machineId'];
  if (!value || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()
      || ['targetId', 'origin', 'expectedHostname', 'machineId'].some(key => typeof value[key] !== 'string')
      || value.version !== 1 || value.kind !== 'lunchlineup-private-target'
      || !/^[a-z][a-z0-9-]{0,62}$/.test(value.targetId ?? '')
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.expectedHostname ?? '')
      || !/^[a-f0-9]{32}$/.test(value.machineId ?? '')) throw new Error('Private target profile schema is invalid.');
  const url = new URL(value.origin);
  const labels = url.hostname.split('.');
  if (url.protocol !== 'https:' || value.origin !== `https://${url.hostname}`
      || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || url.hostname.length > 253 || /^\d+(?:\.\d+)+$/.test(url.hostname)
      || ['lunchlineup.com', 'beta.lunchlineup.com'].includes(url.hostname)
      || ['localhost', 'local', 'example', 'invalid', 'test'].includes(labels.at(-1))) {
    throw new Error('Private target requires a canonical separate HTTPS domain; production domains are forbidden.');
  }
  const binding = { targetId: value.targetId, origin: value.origin,
    profileSha256: createHash('sha256').update(stableJson(value)).digest('hex') };
  return { ...value, host: url.hostname, binding };
}

export function readInstalledPrivateTargetProfile() {
  const path = '/etc/lunchlineup/trust/private-target.json';
  for (const entry of ['/etc/lunchlineup', '/etc/lunchlineup/trust', path]) {
    const stat = lstatSync(entry);
    if (realpathSync(entry) !== entry || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error('Installed private target configuration must be root-owned and not writable by others.');
    }
  }
  return readPrivateTargetProfile(path);
}

export function assertPrivateTargetBinding(actual, profile) {
  if (stableJson(actual ?? null) !== stableJson(profile.binding)) throw new Error('Private target binding mismatch.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profile = readInstalledPrivateTargetProfile();
  process.stdout.write([profile.host, profile.origin, profile.expectedHostname, profile.machineId].join('\n') + '\n');
}
