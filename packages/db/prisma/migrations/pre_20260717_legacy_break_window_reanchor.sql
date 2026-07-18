-- Legacy break generation preserved correct durations and relative spacing but
-- could anchor the complete break set to the wrong date. Re-anchor only the
-- exact historical 10/30/10 paid/unpaid/paid pattern before integrity checks.

DO $$
DECLARE
  candidate_shift_count INTEGER;
  updated_break_count INTEGER;
BEGIN
  IF to_regclass('public."Shift"') IS NULL
    OR to_regclass('public."Break"') IS NULL THEN
    RETURN;
  END IF;

  LOCK TABLE public."Shift" IN SHARE MODE;
  LOCK TABLE public."Break" IN SHARE ROW EXCLUSIVE MODE;

  CREATE TEMP TABLE legacy_break_window_reanchor
  ON COMMIT DROP
  AS
  WITH break_rows AS (
    SELECT
      b."id",
      b."shiftId",
      b."type",
      b."paid",
      b."startTime",
      b."endTime",
      s."startTime" AS shift_start,
      s."endTime" AS shift_end,
      MIN(b."startTime") OVER (PARTITION BY b."shiftId") AS first_break_start
    FROM public."Break" b
    JOIN public."Shift" s ON s."id" = b."shiftId"
  ),
  break_sets AS (
    SELECT
      "shiftId",
      shift_start,
      shift_end,
      first_break_start,
      COUNT(*) AS break_count,
      BOOL_AND("type" IS NULL) AS all_types_null,
      BOOL_OR(
        "endTime" <= "startTime"
        OR "startTime" < shift_start
        OR "endTime" > shift_end
      ) AS has_invalid_window,
      ARRAY_AGG("paid" ORDER BY "startTime", "id") AS paid_pattern,
      ARRAY_AGG(
        (EXTRACT(EPOCH FROM ("endTime" - "startTime")) / 60)::INTEGER
        ORDER BY "startTime", "id"
      ) AS duration_minutes,
      ARRAY_AGG(
        (EXTRACT(EPOCH FROM ("startTime" - first_break_start)) / 60)::INTEGER
        ORDER BY "startTime", "id"
      ) AS relative_start_minutes
    FROM break_rows
    GROUP BY "shiftId", shift_start, shift_end, first_break_start
  )
  SELECT
    "shiftId",
    (shift_start + INTERVAL '120 minutes') - first_break_start AS reanchor_delta
  FROM break_sets
  WHERE has_invalid_window
    AND break_count = 3
    AND all_types_null
    AND paid_pattern = ARRAY[TRUE, FALSE, TRUE]
    AND duration_minutes = ARRAY[10, 30, 10]
    AND relative_start_minutes = ARRAY[0, 120, 270]
    AND shift_end - shift_start >= INTERVAL '400 minutes';

  IF EXISTS (
    SELECT 1
    FROM public."Break" b
    JOIN public."Shift" s ON s."id" = b."shiftId"
    WHERE (
      b."endTime" <= b."startTime"
      OR b."startTime" < s."startTime"
      OR b."endTime" > s."endTime"
    )
      AND NOT EXISTS (
        SELECT 1
        FROM legacy_break_window_reanchor candidate
        WHERE candidate."shiftId" = b."shiftId"
      )
  ) THEN
    RAISE EXCEPTION 'Cannot re-anchor legacy break windows because an invalid break set does not match the supported historical pattern'
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*)
  INTO candidate_shift_count
  FROM legacy_break_window_reanchor;

  UPDATE public."Break" b
  SET
    "startTime" = b."startTime" + candidate.reanchor_delta,
    "endTime" = b."endTime" + candidate.reanchor_delta
  FROM legacy_break_window_reanchor candidate
  WHERE candidate."shiftId" = b."shiftId";

  GET DIAGNOSTICS updated_break_count = ROW_COUNT;

  IF updated_break_count <> candidate_shift_count * 3 THEN
    RAISE EXCEPTION 'Legacy break-window re-anchor updated an unexpected number of rows'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."Break" b
    JOIN public."Shift" s ON s."id" = b."shiftId"
    WHERE b."endTime" <= b."startTime"
      OR b."startTime" < s."startTime"
      OR b."endTime" > s."endTime"
  ) THEN
    RAISE EXCEPTION 'Legacy break-window re-anchor left an invalid break window'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."Break" first_break
    JOIN public."Break" second_break
      ON first_break."shiftId" = second_break."shiftId"
      AND first_break."id" < second_break."id"
    WHERE first_break."startTime" < second_break."endTime"
      AND first_break."endTime" > second_break."startTime"
  ) THEN
    RAISE EXCEPTION 'Legacy break-window re-anchor produced overlapping breaks'
      USING ERRCODE = '23P01';
  END IF;
END
$$;
