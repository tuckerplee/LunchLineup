import { PrismaClient } from '@lunchlineup/db';
import { faker } from '@faker-js/faker';

const prisma = new PrismaClient();

export const TenantFactory = {
    create: async (overrides = {}) => {
        return prisma.tenant.create({
            data: {
                name: faker.company.name(),
                slug: faker.lorem.slug(),
                ...overrides,
            },
        });
    },
};

export const UserFactory = {
    create: async (tenantId: string, overrides = {}) => {
        return prisma.user.create({
            data: {
                email: faker.internet.email(),
                name: faker.person.fullName(),
                tenantId,
                ...overrides,
            },
        });
    },
};
