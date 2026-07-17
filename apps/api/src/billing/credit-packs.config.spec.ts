import { describe, expect, it } from 'vitest';
import {
    buildCreditPackMetadata,
    configuredCreditPackPriceIds,
    CREDIT_PACKS,
    creditPackMetadataMatches,
    findCreditPack,
} from './credit-packs.config';

describe('credit-pack catalog', () => {
    it('defines only the fixed supported packs', () => {
        expect(CREDIT_PACKS.map(({ code, credits, envKey }) => ({ code, credits, envKey }))).toEqual([
            { code: 'CREDITS_100', credits: 100, envKey: 'STRIPE_PRICE_CREDIT_PACK_100' },
            { code: 'CREDITS_500', credits: 500, envKey: 'STRIPE_PRICE_CREDIT_PACK_500' },
            { code: 'CREDITS_2000', credits: 2000, envKey: 'STRIPE_PRICE_CREDIT_PACK_2000' },
        ]);
        expect(findCreditPack(' credits_500 ')?.credits).toBe(500);
        expect(findCreditPack('CREDITS_UNLIMITED')).toBeNull();
    });

    it('builds and exactly matches the server-owned metadata contract', () => {
        const pack = findCreditPack('CREDITS_100')!;
        const metadata = buildCreditPackMetadata('tenant-1', pack, 'price_credit_100', 1200, 'USD');
        expect(metadata).toEqual({
            purchaseType: 'credit_pack',
            tenantId: 'tenant-1',
            creditPackCode: 'CREDITS_100',
            creditAmount: '100',
            priceId: 'price_credit_100',
            unitAmount: '1200',
            currency: 'usd',
            quantity: '1',
        });
        expect(creditPackMetadataMatches({ ...metadata, ignored: 'safe' }, metadata)).toBe(true);
        expect(creditPackMetadataMatches({ ...metadata, creditAmount: '2000' }, metadata)).toBe(false);
    });

    it('normalizes configured Price IDs without inventing defaults', () => {
        const values: Record<string, string | undefined> = {
            STRIPE_PRICE_CREDIT_PACK_100: ' price_credit_100 ',
        };
        expect(configuredCreditPackPriceIds((key) => values[key])).toEqual(['price_credit_100']);
    });
});
