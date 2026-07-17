import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_LEGAL_MANIFEST } from "@lunchlineup/config";
import {
  buildOnboardingOtpPayload,
  isSelfServiceSignupAvailable,
  normalizePublicSignupMode,
  onboardingApiErrorMessage,
  onboardingRequestErrorMessage,
  shouldUseOpenSignupChallenge,
} from "../../app/onboarding/challenge";

const CURRENT_TERMS_VERSION = PUBLIC_LEGAL_MANIFEST.documents.terms.version;
const CURRENT_PRIVACY_VERSION = PUBLIC_LEGAL_MANIFEST.documents.privacy.version;

describe("onboarding signup challenge helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enables Turnstile only for open signup with a site key", () => {
    expect(shouldUseOpenSignupChallenge("open", "site-key")).toBe(true);
    expect(shouldUseOpenSignupChallenge("open", "   ")).toBe(false);
    expect(shouldUseOpenSignupChallenge("invite_only", "site-key")).toBe(false);
    expect(shouldUseOpenSignupChallenge("closed_beta", "site-key")).toBe(false);
  });

  it("keeps missing signup mode open outside production", () => {
    expect(normalizePublicSignupMode(undefined)).toBe("open");
    expect(normalizePublicSignupMode("INVITE_ONLY")).toBe("invite_only");
    expect(normalizePublicSignupMode("closed_beta")).toBe("closed_beta");
    expect(normalizePublicSignupMode("unexpected")).toBe("open");
  });

  it("defaults missing or invalid production signup mode to closed beta", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(normalizePublicSignupMode(undefined)).toBe("closed_beta");
    expect(normalizePublicSignupMode("unexpected")).toBe("closed_beta");
    expect(normalizePublicSignupMode("invite_only")).toBe("closed_beta");
    expect(normalizePublicSignupMode("open")).toBe("closed_beta");
    expect(isSelfServiceSignupAvailable("open")).toBe(false);
  });

  it("preserves non-production invite and open self-service flows", () => {
    expect(isSelfServiceSignupAvailable("invite_only")).toBe(true);
    expect(isSelfServiceSignupAvailable("open")).toBe(true);
    expect(isSelfServiceSignupAvailable("closed_beta")).toBe(false);
  });

  it("surfaces structured API failures and keeps network recovery actionable", () => {
    expect(onboardingApiErrorMessage(
      { message: "Please wait before requesting another code", error: "ignored" },
      "fallback",
    )).toBe("Please wait before requesting another code");
    expect(onboardingApiErrorMessage({ error: "Invite code is invalid" }, "fallback"))
      .toBe("Invite code is invalid");
    expect(onboardingApiErrorMessage({ message: ["invalid"] }, "fallback")).toBe("fallback");
    expect(onboardingRequestErrorMessage(
      new TypeError("Failed to fetch"),
      "Unable to confirm code delivery.",
    )).toBe("Unable to confirm code delivery.");
    expect(onboardingRequestErrorMessage(
      new Error("Invalid or expired code"),
      "fallback",
    )).toBe("Invalid or expired code");
  });

  it("adds invite and Turnstile fields only when present", () => {
    expect(
      buildOnboardingOtpPayload({
        email: " Manager@Example.COM ",
        tenantName: " Test Diner ",
        signupCode: " invite-123 ",
        turnstileToken: " token-abc ",
        termsAccepted: true,
        onboardingChallengeToken: " durable-challenge ",
        privacyAccepted: true,
      }),
    ).toEqual({
      email: "manager@example.com",
      tenantName: "Test Diner",
      onboarding: true,
      onboardingChallengeToken: "durable-challenge",
      signupCode: "invite-123",
      turnstileToken: "token-abc",
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
    });
    expect(
      buildOnboardingOtpPayload({
        email: "manager@example.com",
        tenantName: "Test Diner",
        code: "123456",
      }),
    ).toEqual({
      email: "manager@example.com",
      tenantName: "Test Diner",
      onboarding: true,
      code: "123456",
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
    });
  });
});
