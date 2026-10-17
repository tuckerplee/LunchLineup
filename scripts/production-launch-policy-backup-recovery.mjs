// Launch evidence policy. Backups and point-in-time recovery are estate
// systems (pgBackRest repo on the NAS plus host restic, configured by
// estate-infra), so no backup or PITR keys are validated here any more. The
// evidence references below may point at estate-owned drill and alert-route
// records.
function assertPublicStatusHealthUrl(context, key, domain) {
  const { collector, assertHttpsUrl, assertRequired } = context;
  const value = assertRequired(key);
  if (!value) return;

  const url = assertHttpsUrl(key, value);
  if (!url) return;

  const hostname = url.hostname.toLowerCase();
  if (domain && hostname !== domain && !hostname.endsWith(`.${domain}`)) {
    collector.fail(`${key} must use DOMAIN or a subdomain of DOMAIN so the public status page checks this launch surface.`);
    return;
  }

  if (!/\/health\/?$/i.test(url.pathname)) {
    collector.fail(`${key} must point at an HTTPS health endpoint ending in /health.`);
    return;
  }

  collector.pass(key);
}

function assertHttpsProofUrl(context, key) {
  const {
    collector,
    assertHttpsUrl,
    assertRequired,
    hasPlaceholderProofReference,
    isVagueProofReference,
  } = context;
  const value = assertRequired(key);
  if (!value) return;

  const url = assertHttpsUrl(key, value);
  if (!url) return;

  if (hasPlaceholderProofReference(value)) {
    collector.fail(`${key} must not contain placeholder text.`);
    return;
  }

  if (isVagueProofReference(value)) {
    collector.fail(`${key} must reference a specific retained proof artifact, ticket, or run, not latest/current.`);
    return;
  }

  collector.pass(key);
}

export function validateRecoveryEvidencePolicy(context, domain) {
  assertPublicStatusHealthUrl(context, 'LUNCHLINEUP_STATUS_HEALTH_URL', domain);
  context.assertProofArtifactUri('LAUNCH_PROOF_MANIFEST_URI', { requireJson: true, httpsOnly: true });
  assertHttpsProofUrl(context, 'LAUNCH_PROOF_DAST_URL');
  assertHttpsProofUrl(context, 'LAUNCH_PROOF_LOAD_TEST_URL');
  assertHttpsProofUrl(context, 'LAUNCH_PROOF_ALERT_ROUTE_URL');
  assertHttpsProofUrl(context, 'LAUNCH_PROOF_EXTERNAL_HEALTH_URL');
  context.assertProofArtifactUri('LAUNCH_PROOF_DR_DRILL_URI', { requireJson: true });
}
