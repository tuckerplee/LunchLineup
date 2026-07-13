export type LegalContact = {
  displayName: string;
  email: string | null;
  href: string | null;
  text: string;
  configured: boolean;
  envVars: string[];
};

export type PublicSubprocessor = {
  name: string;
  purpose: string;
  data: string;
  location: string;
  notes: string;
};

type ContactCandidate = {
  envVar: string;
  value: string | undefined;
};

const RESERVED_EXAMPLE_LABEL = 'example';

function usesReservedExampleDomain(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;

  return (
    domain === [RESERVED_EXAMPLE_LABEL, 'com'].join('.') ||
    domain.startsWith(`${RESERVED_EXAMPLE_LABEL}.`) ||
    domain.endsWith(`.${RESERVED_EXAMPLE_LABEL}`)
  );
}

function normalizePublicEmail(value: string | undefined): string | null {
  const email = value?.trim();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (usesReservedExampleDomain(email)) return null;

  return email;
}

function publicEmail(displayName: string, candidates: ContactCandidate[]): LegalContact {
  const email = candidates
    .map((candidate) => normalizePublicEmail(candidate.value))
    .find((value): value is string => Boolean(value));
  return {
    displayName,
    email: email ?? null,
    href: email ? `mailto:${email}` : null,
    text: email ?? `${displayName} contact pending owner signoff`,
    configured: Boolean(email),
    envVars: candidates.map((candidate) => candidate.envVar),
  };
}

export const LEGAL_LAST_UPDATED = 'July 9, 2026';

export const selfServiceTermsReadiness = {
  counselApproved: false,
  version: null as string | null,
  status: 'Draft - not counsel approved',
};

export const legalContacts = {
  privacy: publicEmail('Privacy', [
    { envVar: 'NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL', value: process.env.NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL },
  ]),
  support: publicEmail('Support', [
    { envVar: 'NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL', value: process.env.NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL },
  ]),
  dpa: publicEmail('DPA', [
    { envVar: 'NEXT_PUBLIC_DPA_CONTACT_EMAIL', value: process.env.NEXT_PUBLIC_DPA_CONTACT_EMAIL },
  ]),
};

const requiredLegalContacts = [
  legalContacts.privacy,
  legalContacts.support,
  legalContacts.dpa,
];

export const legalContactReadiness = {
  ready: requiredLegalContacts.every((contact) => contact.configured),
  missingNames: requiredLegalContacts
    .filter((contact) => !contact.configured)
    .map((contact) => contact.displayName),
  missingEnvVars: Array.from(new Set(
    requiredLegalContacts
      .filter((contact) => !contact.configured)
      .flatMap((contact) => contact.envVars),
  )),
};

export const publicSubprocessors: PublicSubprocessor[] = [
  {
    name: 'Stripe',
    purpose: 'Subscription billing, checkout, invoices, and payment processing.',
    data: 'Billing contact details, subscription state, invoice metadata, payment metadata, and Stripe customer identifiers.',
    location: 'United States and other Stripe processing locations.',
    notes: 'Used when paid billing is enabled for a workspace.',
  },
  {
    name: 'Resend',
    purpose: 'Transactional email delivery for login OTPs, account notices, and service emails.',
    data: 'Recipient email address, sender address, message metadata, and the email body required to deliver the message.',
    location: 'United States and other Resend processing locations.',
    notes: 'Required for production email delivery outside local development.',
  },
];
