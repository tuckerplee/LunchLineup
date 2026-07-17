import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const AUDIT_REPORT_VERSION = 2;
const AUDIT_TIMEOUT_MS = 120_000;
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function classifyProductionAudit(report) {
  const schemaErrors = [];
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));

  if (!isRecord(report)) {
    return {
      blockers: [],
      schemaErrors: ["npm audit output must be a JSON object."],
      vulnerabilities: [],
    };
  }

  if (report.auditReportVersion !== AUDIT_REPORT_VERSION) {
    schemaErrors.push(
      `npm audit report version must be ${AUDIT_REPORT_VERSION}; received ${String(report.auditReportVersion)}.`,
    );
  }

  const vulnerabilityMap = isRecord(report.vulnerabilities)
    ? report.vulnerabilities
    : {};
  if (!isRecord(report.vulnerabilities)) {
    schemaErrors.push("npm audit output is missing the vulnerabilities object.");
  }

  const vulnerabilities = [];
  for (const [packageName, vulnerability] of Object.entries(vulnerabilityMap)) {
    if (!isRecord(vulnerability)) {
      schemaErrors.push(`Vulnerability entry ${packageName} must be an object.`);
      continue;
    }

    vulnerabilities.push(vulnerability);
    if (vulnerability.name !== packageName) {
      schemaErrors.push(
        `Vulnerability entry ${packageName} must identify itself with the same package name.`,
      );
    }
    if (!SEVERITIES.includes(vulnerability.severity)) {
      schemaErrors.push(
        `Vulnerability entry ${packageName} has an unknown severity: ${String(vulnerability.severity)}.`,
      );
      continue;
    }
    counts[vulnerability.severity] += 1;
  }

  const metadataCounts = report.metadata?.vulnerabilities;
  if (!isRecord(metadataCounts)) {
    schemaErrors.push("npm audit output is missing metadata.vulnerabilities.");
  } else {
    for (const severity of SEVERITIES) {
      const reported = metadataCounts[severity];
      if (!Number.isInteger(reported) || reported < 0) {
        schemaErrors.push(
          `npm audit metadata count for ${severity} must be a non-negative integer.`,
        );
      } else if (reported !== counts[severity]) {
        schemaErrors.push(
          `npm audit metadata reports ${reported} ${severity} advisories but includes ${counts[severity]} entries.`,
        );
      }
    }

    const reportedTotal = metadataCounts.total;
    if (!Number.isInteger(reportedTotal) || reportedTotal < 0) {
      schemaErrors.push(
        "npm audit metadata total must be a non-negative integer.",
      );
    } else if (reportedTotal !== Object.keys(vulnerabilityMap).length) {
      schemaErrors.push(
        `npm audit metadata reports ${reportedTotal} total advisories but includes ${Object.keys(vulnerabilityMap).length} entries.`,
      );
    }
  }

  return {
    blockers: vulnerabilities,
    schemaErrors,
    vulnerabilities,
  };
}

export function assessProductionAudit(report, exitStatus) {
  const classification = classifyProductionAudit(report);
  const executionErrors = [];

  if (exitStatus !== 0 && exitStatus !== 1) {
    executionErrors.push(
      `npm audit exited with unexpected status ${String(exitStatus)}.`,
    );
  } else if (exitStatus === 1 && classification.blockers.length === 0) {
    executionErrors.push(
      "npm audit exited nonzero without reporting a production advisory.",
    );
  }

  return {
    ...classification,
    executionErrors,
    passed:
      classification.blockers.length === 0 &&
      classification.schemaErrors.length === 0 &&
      executionErrors.length === 0,
  };
}

function run() {
  const auditArgs = ["audit", "--omit=dev", "--json"];
  const command = process.env.npm_execpath
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const args = process.env.npm_execpath
    ? [process.env.npm_execpath, ...auditArgs]
    : auditArgs;

  const audit = spawnSync(command, args, {
    encoding: "utf8",
    shell: !process.env.npm_execpath && process.platform === "win32",
    timeout: AUDIT_TIMEOUT_MS,
    windowsHide: true,
  });

  if (audit.error) {
    console.error(`Unable to run npm audit: ${audit.error.message}`);
    return 1;
  }

  let report;
  try {
    report = JSON.parse(audit.stdout || "{}");
  } catch (error) {
    console.error("Unable to parse npm audit JSON output.");
    console.error(error instanceof Error ? error.message : String(error));
    if (audit.stderr) {
      console.error(audit.stderr.trim());
    }
    return 1;
  }

  const { blockers, executionErrors, passed, schemaErrors } =
    assessProductionAudit(report, audit.status);
  for (const error of [...schemaErrors, ...executionErrors]) {
    console.error(`Production dependency audit could not be verified: ${error}`);
  }

  if (blockers.length > 0) {
    console.error("Production dependency audit failed.");
    for (const vulnerability of blockers) {
      const dependencyType = vulnerability.isDirect ? "direct" : "transitive";
      console.error(
        `- ${vulnerability.name}: ${vulnerability.severity} (${dependencyType})`,
      );
    }
  }

  if (!passed) {
    return 1;
  }
  console.log("Production dependency audit passed with no advisories.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run());
}
