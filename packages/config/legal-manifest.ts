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
    version: '2026-07-09',
    lastUpdated: 'July 9, 2026',
});

const privacy = Object.freeze({
    route: '/privacy' as const,
    version: '2026-07-09',
    lastUpdated: 'July 9, 2026',
});

const approvedVersions = Object.freeze({
    terms: null,
    privacy: null,
});

export const PUBLIC_LEGAL_MANIFEST: PublicLegalManifest = Object.freeze({
    schemaVersion: 1,
    documents: Object.freeze({ terms, privacy }),
    selfServiceSignup: Object.freeze({
        productionEnabled: false,
        counselApproved: false,
        status: 'Draft - not counsel approved',
        approvedVersions,
    }),
});

export function hasCurrentSelfServiceLegalApproval(
    manifest: PublicLegalManifest = PUBLIC_LEGAL_MANIFEST,
): boolean {
    const { approvedVersions } = manifest.selfServiceSignup;
    return manifest.selfServiceSignup.productionEnabled
        && manifest.selfServiceSignup.counselApproved
        && approvedVersions.terms === manifest.documents.terms.version
        && approvedVersions.privacy === manifest.documents.privacy.version;
}
