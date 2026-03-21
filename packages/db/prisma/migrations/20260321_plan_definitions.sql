-- packages/db/prisma/migrations/20260321_plan_definitions.sql
-- Add admin-manageable plan definitions and seed the legacy tenant plan tiers.

CREATE TABLE IF NOT EXISTS "PlanDefinition" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPriceCents" INTEGER,
    "locationLimit" INTEGER,
    "userLimit" INTEGER,
    "creditQuotaLimit" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanDefinition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlanDefinition_code_key" ON "PlanDefinition"("code");
CREATE INDEX IF NOT EXISTS "PlanDefinition_active_idx" ON "PlanDefinition"("active");

INSERT INTO "PlanDefinition" (
    "id",
    "code",
    "name",
    "monthlyPriceCents",
    "locationLimit",
    "userLimit",
    "creditQuotaLimit",
    "active",
    "metadata",
    "createdAt",
    "updatedAt"
) VALUES
    (
        gen_random_uuid()::text,
        'FREE',
        'Free',
        NULL,
        1,
        10,
        NULL,
        true,
        '{"features":[]}'::jsonb,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    ),
    (
        gen_random_uuid()::text,
        'STARTER',
        'Starter',
        3900,
        5,
        50,
        NULL,
        true,
        '{"features":["scheduling"]}'::jsonb,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    ),
    (
        gen_random_uuid()::text,
        'GROWTH',
        'Growth',
        7900,
        25,
        250,
        NULL,
        true,
        '{"features":["scheduling","lunch_breaks"]}'::jsonb,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    ),
    (
        gen_random_uuid()::text,
        'ENTERPRISE',
        'Enterprise',
        NULL,
        NULL,
        NULL,
        NULL,
        true,
        '{"features":["scheduling","lunch_breaks"]}'::jsonb,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    )
ON CONFLICT ("code") DO UPDATE
SET
    "name" = EXCLUDED."name",
    "monthlyPriceCents" = EXCLUDED."monthlyPriceCents",
    "locationLimit" = EXCLUDED."locationLimit",
    "userLimit" = EXCLUDED."userLimit",
    "creditQuotaLimit" = EXCLUDED."creditQuotaLimit",
    "active" = EXCLUDED."active",
    "metadata" = EXCLUDED."metadata",
    "updatedAt" = CURRENT_TIMESTAMP;
