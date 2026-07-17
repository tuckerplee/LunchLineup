DO $$
BEGIN
  CREATE TYPE "AvailabilityImportStatus" AS ENUM (
    'PENDING', 'QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TYPE "AvailabilityImportStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "AvailabilityImportStatus" ADD VALUE IF NOT EXISTS 'QUEUED';
ALTER TYPE "AvailabilityImportStatus" ADD VALUE IF NOT EXISTS 'RUNNING';
ALTER TYPE "AvailabilityImportStatus" ADD VALUE IF NOT EXISTS 'RETRYING';
ALTER TYPE "AvailabilityImportStatus" ADD VALUE IF NOT EXISTS 'SUCCEEDED';
ALTER TYPE "AvailabilityImportStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "AvailabilityImportStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTERED';

DO $$
BEGIN
  CREATE TYPE "AvailabilityImportPublicationStatus" AS ENUM (
    'PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TYPE "AvailabilityImportPublicationStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "AvailabilityImportPublicationStatus" ADD VALUE IF NOT EXISTS 'PUBLISHING';
ALTER TYPE "AvailabilityImportPublicationStatus" ADD VALUE IF NOT EXISTS 'PUBLISHED';
ALTER TYPE "AvailabilityImportPublicationStatus" ADD VALUE IF NOT EXISTS 'FAILED';
