-- Require every location writer to choose an explicit timezone without rewriting existing rows.

ALTER TABLE IF EXISTS "Location"
  ALTER COLUMN "timezone" DROP DEFAULT;
