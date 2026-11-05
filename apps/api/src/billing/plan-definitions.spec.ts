import { describe, expect, it } from 'vitest';
import { internalBetaEntitlementsRuntimeEnabled } from './plan-definitions';

describe('internalBetaEntitlementsRuntimeEnabled', () => {
    it.each(['https://beta.lunchlineup.com', 'https://dev.lunchlineup.com', 'https://dev.lunchlineup.com/'])(
        'allows approved private origin %s when the flag is on',
        (APP_ORIGIN) => {
            expect(internalBetaEntitlementsRuntimeEnabled({ INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true', APP_ORIGIN })).toBe(true);
        },
    );

    it.each([
        'https://lunchlineup.com',
        'https://www.lunchlineup.com',
        'https://app.lunchlineup.com',
        'http://dev.lunchlineup.com',
        'http://beta.lunchlineup.com',
        'https://dev.lunchlineup.com:8443',
        'https://dev.lunchlineup.com/path',
        'https://dev.lunchlineup.com/?x=1',
        'https://dev.lunchlineup.com/#x',
        'https://user:pw@dev.lunchlineup.com',
        'https://dev.lunchlineup.com.evil.example',
        'https://evil-dev.lunchlineup.com',
        '',
        'not a url',
    ])('refuses origin %j even when the flag is on', (APP_ORIGIN) => {
        expect(internalBetaEntitlementsRuntimeEnabled({ INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true', APP_ORIGIN })).toBe(false);
    });

    it.each([undefined, '', 'false', '1', 'yes'])('refuses approved origins when the flag is %j', (flag) => {
        for (const APP_ORIGIN of ['https://beta.lunchlineup.com', 'https://dev.lunchlineup.com']) {
            expect(internalBetaEntitlementsRuntimeEnabled({ INTERNAL_BETA_ENTITLEMENTS_ENABLED: flag, APP_ORIGIN })).toBe(false);
        }
    });
});
