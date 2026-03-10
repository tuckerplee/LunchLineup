import { PrismaClient } from '@lunchlineup/db';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding initial permissions and roles...');

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
