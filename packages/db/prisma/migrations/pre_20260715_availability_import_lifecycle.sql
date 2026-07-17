-- Stage required availability-import identity data before Prisma makes the
-- canonical targetIdentityHash column NOT NULL.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public."AvailabilityImportJob"') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE public."AvailabilityImportJob"
    ADD COLUMN IF NOT EXISTS "targetIdentityHash" TEXT;

  UPDATE public."AvailabilityImportJob" job
  SET "targetIdentityHash" = encode(
    public.digest(
      lower(
        CASE
          WHEN btrim(target."username") ~ '^[-A-Za-z0-9._:@+]{1,128}$'
            THEN btrim(target."username")
          ELSE target."id"
        END
      ),
      'sha256'
    ),
    'hex'
  )
  FROM public."User" target
  WHERE target."id" = job."userId"
    AND target."tenantId" = job."tenantId"
    AND (
      job."targetIdentityHash" IS NULL
      OR job."targetIdentityHash" !~ '^[a-f0-9]{64}$'
    );

  IF EXISTS (
    SELECT 1
    FROM public."AvailabilityImportJob"
    WHERE "targetIdentityHash" IS NULL
       OR "targetIdentityHash" !~ '^[a-f0-9]{64}$'
  ) THEN
    RAISE EXCEPTION 'Cannot stage availability-import target identity hashes while invalid rows remain';
  END IF;
END
$$;
