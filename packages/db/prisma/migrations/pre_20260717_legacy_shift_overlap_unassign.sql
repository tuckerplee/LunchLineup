-- Preserve ambiguous legacy shifts and their break history while removing only
-- assignments that cannot satisfy the public scheduling overlap invariant.

DO $$
DECLARE
  candidate_ids TEXT[];
  expected_count INTEGER;
  updated_count INTEGER;
BEGIN
  IF to_regclass('public."Shift"') IS NULL THEN
    RETURN;
  END IF;

  LOCK TABLE public."Shift" IN SHARE ROW EXCLUSIVE MODE;
  IF to_regclass('public."TimeCard"') IS NOT NULL THEN
    LOCK TABLE public."TimeCard" IN SHARE MODE;
  END IF;

  SELECT array_agg(DISTINCT conflict.shift_id ORDER BY conflict.shift_id)
  INTO candidate_ids
  FROM (
    SELECT first_shift.id AS shift_id
    FROM public."Shift" first_shift
    JOIN public."Shift" second_shift
      ON second_shift."tenantId" = first_shift."tenantId"
      AND second_shift."userId" = first_shift."userId"
      AND second_shift.id > first_shift.id
      AND second_shift."deletedAt" IS NULL
      AND second_shift."startTime" < first_shift."endTime"
      AND second_shift."endTime" > first_shift."startTime"
    WHERE first_shift."deletedAt" IS NULL
      AND first_shift."userId" IS NOT NULL
    UNION
    SELECT second_shift.id AS shift_id
    FROM public."Shift" first_shift
    JOIN public."Shift" second_shift
      ON second_shift."tenantId" = first_shift."tenantId"
      AND second_shift."userId" = first_shift."userId"
      AND second_shift.id > first_shift.id
      AND second_shift."deletedAt" IS NULL
      AND second_shift."startTime" < first_shift."endTime"
      AND second_shift."endTime" > first_shift."startTime"
    WHERE first_shift."deletedAt" IS NULL
      AND first_shift."userId" IS NOT NULL
  ) conflict;

  IF candidate_ids IS NULL THEN
    RETURN;
  END IF;

  expected_count := cardinality(candidate_ids);

  IF EXISTS (
    SELECT 1
    FROM public."Shift" candidate
    WHERE candidate.id = ANY(candidate_ids)
      AND (
        candidate."deletedAt" IS NOT NULL
        OR candidate."userId" IS NULL
        OR candidate."scheduleId" IS NOT NULL
        OR candidate."locationId" NOT LIKE 'legacy-%'
        OR candidate.role IS DISTINCT FROM 'STAFF'
        OR candidate.notes IS NOT NULL
        OR candidate."endTime" - candidate."startTime" <> INTERVAL '8 hours'
        OR candidate."createdAt" >= TIMESTAMP '2026-07-17 00:00:00'
      )
  ) THEN
    RAISE EXCEPTION 'Cannot reconcile assigned shift overlaps: a conflict does not match the supported legacy shape'
      USING ERRCODE = '23514';
  END IF;

  IF to_regclass('public."TimeCard"') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public."TimeCard" time_card
      WHERE time_card."shiftId" = ANY(candidate_ids)
    ) THEN
    RAISE EXCEPTION 'Cannot reconcile assigned shift overlaps: a conflict has time-card history'
      USING ERRCODE = '23503';
  END IF;

  UPDATE public."Shift"
  SET
    "userId" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE id = ANY(candidate_ids);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> expected_count THEN
    RAISE EXCEPTION 'Legacy shift overlap reconciliation updated % rows; expected %',
      updated_count,
      expected_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."Shift" first_shift
    JOIN public."Shift" second_shift
      ON second_shift."tenantId" = first_shift."tenantId"
      AND second_shift."userId" = first_shift."userId"
      AND second_shift.id > first_shift.id
      AND second_shift."deletedAt" IS NULL
      AND second_shift."startTime" < first_shift."endTime"
      AND second_shift."endTime" > first_shift."startTime"
    WHERE first_shift."deletedAt" IS NULL
      AND first_shift."userId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Legacy shift overlap reconciliation left an assigned overlap'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public."Shift" candidate
    WHERE candidate.id = ANY(candidate_ids)
      AND candidate."userId" IS NULL
  ) <> expected_count THEN
    RAISE EXCEPTION 'Legacy shift overlap reconciliation did not clear every ambiguous assignment';
  END IF;
END
$$;
