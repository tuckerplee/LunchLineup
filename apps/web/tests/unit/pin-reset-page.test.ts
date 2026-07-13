import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(resolve(__dirname, '../../app/auth/reset-pin/page.tsx'), 'utf8');

describe('temporary PIN reset page', () => {
    it('clears the revoked session through logout after rotating the PIN', () => {
        const rotateIndex = pageSource.indexOf('/users/me/pin');
        const logoutIndex = pageSource.indexOf("window.location.assign('/auth/logout')");

        expect(rotateIndex).toBeGreaterThan(-1);
        expect(logoutIndex).toBeGreaterThan(rotateIndex);
        expect(pageSource).toContain("'x-csrf-token': csrfToken");
        expect(pageSource).not.toContain('/auth/refresh');
        expect(pageSource).not.toContain('/mfa?');
    });
});
