import {
  PUBLIC_LEGAL_MANIFEST,
  hasCurrentSelfServiceLegalApproval,
} from '@lunchlineup/config';

export type PublicSignupMode = "closed_beta" | "invite_only" | "open";

const PUBLIC_SIGNUP_MODES = new Set<PublicSignupMode>([
  "closed_beta",
  "invite_only",
  "open",
]);

export type OnboardingOtpPayloadInput = {
  email: string;
  tenantName: string;
  code?: string;
  signupCode?: string;
  turnstileToken?: string;
  termsAccepted?: boolean;
  onboardingChallengeToken?: string;
  privacyAccepted?: boolean;
};

type OnboardingApiErrorPayload = {
  message?: unknown;
  error?: unknown;
};

export function normalizePublicSignupMode(
  value: string | undefined,
): PublicSignupMode {
  if (
    process.env.NODE_ENV === "production" &&
    !hasCurrentSelfServiceLegalApproval()
  ) {
    return "closed_beta";
  }
  const fallback =
    process.env.NODE_ENV === "production" ? "closed_beta" : "open";
  const normalized = (value ?? fallback).trim().toLowerCase();
  return PUBLIC_SIGNUP_MODES.has(normalized as PublicSignupMode)
    ? (normalized as PublicSignupMode)
    : fallback;
}

export function isSelfServiceSignupAvailable(
  value: string | undefined,
): boolean {
  return normalizePublicSignupMode(value) !== "closed_beta";
}

export function shouldUseOpenSignupChallenge(
  signupMode: PublicSignupMode,
  siteKey: string | undefined,
): boolean {
  return signupMode === "open" && Boolean(siteKey?.trim());
}

export function buildOnboardingOtpPayload(
  input: OnboardingOtpPayloadInput,
): Record<string, string | boolean> {
  const onboardingChallengeToken = input.onboardingChallengeToken?.trim();
  const payload: Record<string, string | boolean> = {
    email: input.email.trim().toLowerCase(),
    tenantName: input.tenantName.trim(),
    onboarding: true,
    termsVersion: PUBLIC_LEGAL_MANIFEST.documents.terms.version,
    privacyVersion: PUBLIC_LEGAL_MANIFEST.documents.privacy.version,
  };
  const code = input.code?.trim();
  const signupCode = input.signupCode?.trim();
  if (onboardingChallengeToken)
    payload.onboardingChallengeToken = onboardingChallengeToken;
  const turnstileToken = input.turnstileToken?.trim();

  if (code) payload.code = code;
  if (signupCode) payload.signupCode = signupCode;
  if (turnstileToken) payload.turnstileToken = turnstileToken;
  if (input.termsAccepted === true) payload.termsAccepted = true;
  if (input.privacyAccepted === true) payload.privacyAccepted = true;

  return payload;
}
export function onboardingApiErrorMessage(
  payload: unknown,
  fallback: string,
): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return fallback;
  }
  const candidate = payload as OnboardingApiErrorPayload;
  for (const value of [candidate.message, candidate.error]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

export function onboardingRequestErrorMessage(
  error: unknown,
  networkFallback: string,
): string {
  if (error instanceof TypeError) return networkFallback;
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : networkFallback;
}
