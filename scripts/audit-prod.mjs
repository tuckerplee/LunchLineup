import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const NEXT_POSTCSS_ADVISORY = Object.freeze({
  url: "https://github.com/advisories/GHSA-qx2v-qp2m-jg93",
  postcssRange: "<8.5.10",
  postcssNode: "node_modules/next/node_modules/postcss",
  nextRange: "9.3.4-canary.0 - 16.3.0-canary.5",
  nextFixName: "next",
  nextFixVersion: "9.3.3",
});

function isOnlyKnownPostcssVia(via) {
  if (!Array.isArray(via) || via.length !== 1) {
    return false;
  }

  const [entry] = via;
  return (
    entry &&
    typeof entry === "object" &&
    entry.url === NEXT_POSTCSS_ADVISORY.url &&
    entry.range === NEXT_POSTCSS_ADVISORY.postcssRange
  );
}

export function isKnownNextPostcssAdvisory(vulnerability) {
  if (vulnerability.severity !== "moderate") {
    return false;
  }

  if (vulnerability.name === "postcss") {
    const nodes = Array.isArray(vulnerability.nodes) ? vulnerability.nodes : [];
    return (
      nodes.length === 1 &&
      nodes[0] === NEXT_POSTCSS_ADVISORY.postcssNode &&
      isOnlyKnownPostcssVia(vulnerability.via)
    );
  }

  if (vulnerability.name === "next") {
    const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];
    return (
      via.length === 1 &&
      via[0] === "postcss" &&
      vulnerability.range === NEXT_POSTCSS_ADVISORY.nextRange &&
      vulnerability.fixAvailable?.name === NEXT_POSTCSS_ADVISORY.nextFixName &&
      vulnerability.fixAvailable?.version === NEXT_POSTCSS_ADVISORY.nextFixVersion &&
      vulnerability.fixAvailable?.isSemVerMajor === true
    );
  }

  return false;
}

export function classifyProductionAudit(report) {
  const vulnerabilities = Object.values(report?.vulnerabilities ?? {});
  const blockers = vulnerabilities.filter((vulnerability) => {
    if (["high", "critical"].includes(vulnerability.severity)) {
      return true;
    }

    return !isKnownNextPostcssAdvisory(vulnerability);
  });
  const known = vulnerabilities.filter(isKnownNextPostcssAdvisory);

  return { blockers, known, vulnerabilities };
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

  const { blockers, known } = classifyProductionAudit(report);
  if (blockers.length > 0) {
    console.error("Production dependency audit failed.");
    for (const vulnerability of blockers) {
      console.error(`- ${vulnerability.name}: ${vulnerability.severity}`);
    }
    return 1;
  }

  if (known.length > 0) {
    console.warn(
      "Production dependency audit passed with the documented Next/PostCSS moderate advisory triage.",
    );
    for (const vulnerability of known) {
      console.warn(`- ${vulnerability.name}: ${vulnerability.severity}`);
    }
    return 0;
  }

  console.log("Production dependency audit passed with no advisories.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run());
}
