import { describe, expect, it } from "vitest";
import {
  PUBLIC_LEGAL_MANIFEST,
  hasCurrentSelfServiceLegalApproval,
  isLegalValueConfigured,
  missingLegalBusinessFields,
} from "@lunchlineup/config";
import { legalBusiness, legalBusinessReadiness } from "../../app/legal-config";

describe("shared legal launch configuration", () => {
  it("treats OWNER placeholders and blanks as unconfigured", () => {
    expect(isLegalValueConfigured("OWNER: registered legal entity name")).toBe(false);
    expect(isLegalValueConfigured("  ")).toBe(false);
    expect(isLegalValueConfigured(undefined)).toBe(false);
    expect(isLegalValueConfigured("LunchLineup Inc.")).toBe(true);
  });

  it("ships with every business field pending and the approval switch off", () => {
    expect(missingLegalBusinessFields().sort()).toEqual([
      "effectiveDate",
      "governingLaw",
      "legalEntityName",
      "mailingAddress",
    ]);
    expect(legalBusinessReadiness.ready).toBe(false);
    expect(legalBusiness.entity.value).toMatch(/pending owner signoff/);
    expect(PUBLIC_LEGAL_MANIFEST.selfServiceSignup.counselApproved).toBe(false);
    expect(hasCurrentSelfServiceLegalApproval()).toBe(false);
  });

  it("requires recorded approval versions to equal the current document versions", () => {
    const approved = (terms: string | null, privacy: string | null) => ({
      ...PUBLIC_LEGAL_MANIFEST,
      selfServiceSignup: {
        ...PUBLIC_LEGAL_MANIFEST.selfServiceSignup,
        productionEnabled: true,
        counselApproved: true,
        approvedVersions: { terms, privacy },
      },
    });
    const { terms, privacy } = PUBLIC_LEGAL_MANIFEST.documents;
    expect(hasCurrentSelfServiceLegalApproval(approved(terms.version, privacy.version))).toBe(true);
    expect(hasCurrentSelfServiceLegalApproval(approved("1999-01-01", privacy.version))).toBe(false);
    expect(hasCurrentSelfServiceLegalApproval(approved(null, null))).toBe(false);
  });
});
