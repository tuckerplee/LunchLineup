export function passwordValidationMessage(password: string): string | null {
    if (password.length < 8) return 'Use at least 8 characters.';
    if (new TextEncoder().encode(password).byteLength > 72) {
        return 'Use a password of at most 72 UTF-8 bytes.';
    }
    return null;
}

export function resetConfirmationErrorMessage(status: number): string {
    if (status === 429) return 'Too many reset attempts. Wait a moment, then try again.';
    if (status >= 500) return 'Password reset is temporarily unavailable. Please try again.';
    if (status === 401) return 'Reset link is invalid or expired.';
    if (status === 400 || status === 422) return 'Check the password requirements and try again.';
    return 'Unable to reset password. Please try again.';
}

export function isPasswordResetConfirmation(payload: unknown): boolean {
    return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)
        && (payload as Record<string, unknown>).success === true);
}
