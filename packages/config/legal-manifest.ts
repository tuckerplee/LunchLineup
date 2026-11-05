import launchConfig from './legal-launch.json';

export type PublicLegalDocument = Readonly<{
    route: '/terms' | '/privacy';
    version: string;
    lastUpdated: string;
}>;

export type PublicLegalManifest = Readonly<{
    schemaVersion: 1;
    documents: Readonly<{
        terms: PublicLegalDocument;
        privacy: PublicLegalDocument;
    }>;
    selfServiceSignup: Readonly<{
        productionEnabled: boolean;
        counselApproved: boolean;
        status: string;
        approvedVersions: Readonly<{
            terms: string | null;
            privacy: string | null;
        }>;
    }>;
}>;

const terms = Object.freeze({
    route: '/terms' as const,
    version: launchConfig.documents.terms.version,
    lastUpdated: launchConfig.documents.terms.lastUpdated,
});

const privacy = Object.freeze({
    route: '/privacy' as const,
    version: launchConfig.documents.privacy.version,
    lastUpdated: launchConfig.documents.privacy.lastUpdated,
});

// The single approval switch: legal-launch.json `approval.approved`. When false
// (the committed state) no versions count as approved and every consumer fails
// closed. When true the recorded versions must still equal the current document
// versions or hasCurrentSelfServiceLegalApproval() stays false.
const approved = launchConfig.approval.approved === true;

const approvedVersions = Object.freeze({
    terms: approved ? launchConfig.approval.termsVersion : null,
    privacy: approved ? launchConfig.approval.privacyVersion : null,
});

export const PUBLIC_LEGAL_MANIFEST: PublicLegalManifest = Object.freeze({
    schemaVersion: 1,
    documents: Object.freeze({ terms, privacy }),
    selfServiceSignup: Object.freeze({
        productionEnabled: approved,
        counselApproved: approved,
        status: approved ? 'Counsel approved' : 'Draft - not counsel approved',
        approvedVersions,
    }),
});

const OWNER_PLACEHOLDER_RE = /^\s*(?:OWNER\b|TODO\b|TBD\b|CHANGE_ME)/i;

export type PublicLegalBusiness = Readonly<{
    legalEntityName: string;
    mailingAddress: string;
    governingLaw: string;
    effectiveDate: string;
}>;

export const PUBLIC_LEGAL_BUSINESS: PublicLegalBusiness = Object.freeze({ ...launchConfig.business });

export function isLegalValueConfigured(value: string | null | undefined): boolean {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 && !OWNER_PLACEHOLDER_RE.test(trimmed);
}

export function missingLegalBusinessFields(
    business: PublicLegalBusiness = PUBLIC_LEGAL_BUSINESS,
): string[] {
    return (Object.keys(business) as Array<keyof PublicLegalBusiness>)
        .filter((key) => !isLegalValueConfigured(business[key]));
}

export function hasCurrentSelfServiceLegalApproval(
    manifest: PublicLegalManifest = PUBLIC_LEGAL_MANIFEST,
): boolean {
    const { approvedVersions } = manifest.selfServiceSignup;
    return manifest.selfServiceSignup.productionEnabled
        && manifest.selfServiceSignup.counselApproved
        && approvedVersions.terms === manifest.documents.terms.version
        && approvedVersions.privacy === manifest.documents.privacy.version;
}
