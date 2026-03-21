import { PrismaClient } from '@lunchlineup/db';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding initial permissions and roles...');

    const planDefinitions = [
        {
            code: 'FREE',
            name: 'Free',
            monthlyPriceCents: null,
            locationLimit: 1,
            userLimit: 10,
            creditQuotaLimit: null,
            active: true,
            metadata: { features: [] },
        },
        {
            code: 'STARTER',
            name: 'Starter',
            monthlyPriceCents: 3900,
            locationLimit: 5,
            userLimit: 50,
            creditQuotaLimit: null,
            active: true,
            metadata: { features: ['scheduling'] },
        },
        {
            code: 'GROWTH',
            name: 'Growth',
            monthlyPriceCents: 7900,
            locationLimit: 25,
            userLimit: 250,
            creditQuotaLimit: null,
            active: true,
            metadata: { features: ['scheduling', 'lunch_breaks'] },
        },
        {
            code: 'ENTERPRISE',
            name: 'Enterprise',
            monthlyPriceCents: null,
            locationLimit: null,
            userLimit: null,
            creditQuotaLimit: null,
            active: true,
            metadata: { features: ['scheduling', 'lunch_breaks'] },
        },
    ] as const;

    for (const plan of planDefinitions) {
        await prisma.planDefinition.upsert({
            where: { code: plan.code },
            update: {
                name: plan.name,
                monthlyPriceCents: plan.monthlyPriceCents,
                locationLimit: plan.locationLimit,
                userLimit: plan.userLimit,
                creditQuotaLimit: plan.creditQuotaLimit,
                active: plan.active,
                metadata: plan.metadata,
            },
            create: plan,
        });
    }

    // 1. Create System Tenant
    const systemTenant = await prisma.tenant.upsert({
        where: { slug: 'system' },
        update: {},
        create: {
            name: 'System Administration',
            slug: 'system',
        },
    });

    // 2. Create Initial Super Admin
    const existingAdmin = await prisma.user.findFirst({
        where: {
            tenantId: systemTenant.id,
            email: 'admin@lunchlineup.com',
        },
    });

    if (!existingAdmin) {
        await prisma.user.create({
            data: {
                email: 'admin@lunchlineup.com',
                name: 'System Admin',
                tenantId: systemTenant.id,
            },
        });
    }

    console.log('Seeding complete.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
