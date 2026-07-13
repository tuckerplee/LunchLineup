import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyProductionAudit,
  NEXT_POSTCSS_ADVISORY,
} from '../../scripts/audit-prod.mjs';

function knownPostcssAdvisory(overrides = {}) {
  return {
    name: 'postcss',
    severity: 'moderate',
    via: [
      {
        url: NEXT_POSTCSS_ADVISORY.url,
        range: NEXT_POSTCSS_ADVISORY.postcssRange,
      },
    ],
    nodes: [NEXT_POSTCSS_ADVISORY.postcssNode],
    ...overrides,
  };
}

function knownNextAdvisory(overrides = {}) {
  return {
    name: 'next',
    severity: 'moderate',
    via: ['postcss'],
    range: NEXT_POSTCSS_ADVISORY.nextRange,
    fixAvailable: {
      name: NEXT_POSTCSS_ADVISORY.nextFixName,
      version: NEXT_POSTCSS_ADVISORY.nextFixVersion,
      isSemVerMajor: true,
    },
    ...overrides,
  };
}

test('production dependency audit allows only the documented Next PostCSS advisory pair', () => {
  const result = classifyProductionAudit({
    vulnerabilities: {
      next: knownNextAdvisory(),
      postcss: knownPostcssAdvisory(),
    },
  });

  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.known.map((vulnerability) => vulnerability.name).sort(), ['next', 'postcss']);
});

test('production dependency audit blocks unexpected advisories sharing the postcss package object', () => {
  const result = classifyProductionAudit({
    vulnerabilities: {
      postcss: knownPostcssAdvisory({
        via: [
          {
            url: NEXT_POSTCSS_ADVISORY.url,
            range: NEXT_POSTCSS_ADVISORY.postcssRange,
          },
          {
            url: 'https://github.com/advisories/GHSA-new-postcss',
            range: '<8.5.11',
          },
        ],
      }),
    },
  });

  assert.equal(result.known.length, 0);
  assert.deepEqual(result.blockers.map((vulnerability) => vulnerability.name), ['postcss']);
});

test('production dependency audit blocks unexpected advisories sharing the next package object', () => {
  const result = classifyProductionAudit({
    vulnerabilities: {
      next: knownNextAdvisory({
        via: [
          'postcss',
          {
            url: 'https://github.com/advisories/GHSA-new-next',
            range: '<16.2.11',
          },
        ],
      }),
    },
  });

  assert.equal(result.known.length, 0);
  assert.deepEqual(result.blockers.map((vulnerability) => vulnerability.name), ['next']);
});

test('production dependency audit blocks high and unexpected lower-severity production advisories', () => {
  const result = classifyProductionAudit({
    vulnerabilities: {
      axios: {
        name: 'axios',
        severity: 'high',
      },
      qs: {
        name: 'qs',
        severity: 'low',
      },
    },
  });

  assert.deepEqual(result.blockers.map((vulnerability) => vulnerability.name).sort(), ['axios', 'qs']);
  assert.deepEqual(result.known, []);
});
