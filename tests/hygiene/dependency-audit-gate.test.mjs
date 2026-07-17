import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessProductionAudit,
  classifyProductionAudit,
} from '../../scripts/audit-prod.mjs';

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

function auditReport(vulnerabilities = {}) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const vulnerability of Object.values(vulnerabilities)) {
    counts[vulnerability.severity] += 1;
  }

  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        ...counts,
        total: Object.keys(vulnerabilities).length,
      },
    },
  };
}

test('production dependency audit passes only a complete advisory-free npm report', () => {
  const result = assessProductionAudit(auditReport(), 0);

  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.schemaErrors, []);
  assert.deepEqual(result.executionErrors, []);
  assert.equal(result.passed, true);
});

test('production dependency audit blocks direct and transitive advisories at every severity', () => {
  const vulnerabilities = Object.fromEntries(
    SEVERITIES.map((severity, index) => [
      `package-${severity}`,
      {
        name: `package-${severity}`,
        severity,
        isDirect: index % 2 === 0,
        via: index % 2 === 0 ? [] : [`parent-${severity}`],
      },
    ]),
  );
  const result = assessProductionAudit(auditReport(vulnerabilities), 1);

  assert.deepEqual(
    result.blockers.map((vulnerability) => vulnerability.name),
    SEVERITIES.map((severity) => `package-${severity}`),
  );
  assert.deepEqual(result.schemaErrors, []);
  assert.equal(result.passed, false);
});

test('production dependency audit rejects metadata that could conceal a high advisory', () => {
  const report = auditReport();
  report.metadata.vulnerabilities.high = 1;
  report.metadata.vulnerabilities.total = 1;

  const result = classifyProductionAudit(report);

  assert.match(
    result.schemaErrors.join('\n'),
    /reports 1 high advisories but includes 0 entries/,
  );
  assert.match(
    result.schemaErrors.join('\n'),
    /reports 1 total advisories but includes 0 entries/,
  );
});

test('production dependency audit rejects malformed or incomplete vulnerability entries', () => {
  const result = classifyProductionAudit({
    auditReportVersion: 2,
    vulnerabilities: {
      postcss: {
        name: 'different-package',
        severity: 'urgent',
      },
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 1,
      },
    },
  });

  assert.match(result.schemaErrors.join('\n'), /same package name/);
  assert.match(result.schemaErrors.join('\n'), /unknown severity/);
});

test('production dependency audit rejects missing findings and npm operational failures', () => {
  const missingFindings = assessProductionAudit({
    auditReportVersion: 2,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    },
  }, 0);
  const operationalFailure = assessProductionAudit(auditReport(), 1);

  assert.match(
    missingFindings.schemaErrors.join('\n'),
    /missing the vulnerabilities object/,
  );
  assert.match(
    operationalFailure.executionErrors.join('\n'),
    /exited nonzero without reporting/,
  );
  assert.equal(missingFindings.passed, false);
  assert.equal(operationalFailure.passed, false);
});
