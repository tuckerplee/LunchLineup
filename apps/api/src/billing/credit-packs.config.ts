export type CreditPackCode = 'CREDITS_100' | 'CREDITS_500' | 'CREDITS_2000';

export type CreditPackConfig = {
    code: CreditPackCode;
    credits: number;
    envKey:
        | 'STRIPE_PRICE_CREDIT_PACK_100'
        | 'STRIPE_PRICE_CREDIT_PACK_500'
        | 'STRIPE_PRICE_CREDIT_PACK_2000';
};

export type CreditPackMetadata = {
    purchaseType: 'credit_pack';
    tenantId: string;
    creditPackCode: CreditPackCode;
    creditAmount: string;
    priceId: string;
    unitAmount: string;
    currency: string;
    quantity: '1';
};

export const CREDIT_PACK_PURCHASE_TYPE = 'credit_pack' as const;

export const CREDIT_PACKS: readonly CreditPackConfig[] = [
    { code: 'CREDITS_100', credits: 100, envKey: 'STRIPE_PRICE_CREDIT_PACK_100' },
    { code: 'CREDITS_500', credits: 500, envKey: 'STRIPE_PRICE_CREDIT_PACK_500' },
    { code: 'CREDITS_2000', credits: 2000, envKey: 'STRIPE_PRICE_CREDIT_PACK_2000' },
];

export function findCreditPack(code: unknown): CreditPackConfig | null {
    const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
    return CREDIT_PACKS.find((pack) => pack.code === normalized) ?? null;
}

export function buildCreditPackMetadata(
    tenantId: string,
    pack: CreditPackConfig,
    priceId: string,
    unitAmount: number,
    currency: string,
): CreditPackMetadata {
    return {
        purchaseType: CREDIT_PACK_PURCHASE_TYPE,
        tenantId,
        creditPackCode: pack.code,
        creditAmount: String(pack.credits),
        priceId,
        unitAmount: String(unitAmount),
        currency: currency.toLowerCase(),
        quantity: '1',
    };
}

export function creditPackMetadataMatches(
    value: unknown,
    expected: CreditPackMetadata,
): boolean {
    if (!value || typeof value !== 'object') return false;
    const metadata = value as Record<string, unknown>;
    return Object.entries(expected).every(([key, expectedValue]) => metadata[key] === expectedValue);
}

export function configuredCreditPackPriceIds(
    read: (key: CreditPackConfig['envKey']) => string | undefined,
): string[] {
    return CREDIT_PACKS
        .map((pack) => read(pack.envKey)?.trim())
        .filter((priceId): priceId is string => Boolean(priceId));
}
