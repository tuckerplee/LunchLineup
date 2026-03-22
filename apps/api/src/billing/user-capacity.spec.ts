import { describe, expect, it, vi } from 'vitest';
import { assertTenantCanAddActiveUser } from './user-capacity';

function buildPrismaMock(overrides: Record<string, any> = {}) {
    return {
        tenant: {
            findUnique: vi.fn(),
        },
        user: {
            count: vi.fn(),
        },
        planDefinition: {
            findUnique: vi.fn(),
        },
        ...overrides,
    };
}

describe('assertTenantCanAddActiveUser', () => {
    it('falls back to the free plan when the tenant plan code is unknown', async () => {
        const planDefinitionFindUnique = vi.fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        const prisma = buildPrismaMock({
            tenant: {
                findUnique: vi.fn().mockResolvedValue({ planTier: 'mystery-tier' }),
            },
            user: {
                count: vi.fn().mockResolvedValue(10),
            },
            planDefinition: {
                findUnique: planDefinitionFindUnique,
            },
        });

        await expect(assertTenantCanAddActiveUser(prisma as any, 'tenant-1')).rejects.toThrow(/FREE plan/i);
        expect(planDefinitionFindUnique).toHaveBeenNthCalledWith(1, {
            where: { code: 'MYSTERY-TIER' },
        });
        expect(planDefinitionFindUnique).toHaveBeenNthCalledWith(2, {
            where: { code: 'FREE' },
        });
    });
});
