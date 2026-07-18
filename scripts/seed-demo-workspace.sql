\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SET CONSTRAINTS ALL DEFERRED;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Tenant"
    WHERE id = 'demo-tenant-v1'
      AND slug = 'demo'
      AND "deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Expected active demo tenant was not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "User"
    WHERE "tenantId" = 'demo-tenant-v1'
      AND lower(email) = 'demo@demo.com'
      AND "deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Expected demo administrator was not found';
  END IF;
END $$;

CREATE TEMP TABLE demo_context ON COMMIT DROP AS
SELECT
  'demo-tenant-v1'::text AS tenant_id,
  (
    SELECT id
    FROM "User"
    WHERE "tenantId" = 'demo-tenant-v1'
      AND lower(email) = 'demo@demo.com'
      AND "deletedAt" IS NULL
    LIMIT 1
  ) AS admin_id,
  (
    timezone('America/Los_Angeles', now())::date
    - (extract(isodow FROM timezone('America/Los_Angeles', now())::date)::int - 1)
  )::date AS week_start,
  (
    '2026-01-05'::date
    + (
      (timezone('America/Los_Angeles', now())::date - '2026-01-05'::date)
      / 14
    ) * 14
  )::date AS payroll_start;

UPDATE "Tenant"
SET name = 'Harbor & Main Demo Cafe',
    "updatedAt" = now()
WHERE id = 'demo-tenant-v1';

UPDATE "Location"
SET name = 'Harbor & Main - Downtown',
    address = '123 Market Street, San Francisco, CA 94105',
    timezone = 'America/Los_Angeles',
    "deletedAt" = NULL,
    "updatedAt" = now()
WHERE id = 'demo-location-v1'
  AND "tenantId" = 'demo-tenant-v1';

INSERT INTO "Location" (
  id, "tenantId", name, address, timezone, "createdAt", "updatedAt", "deletedAt"
) VALUES (
  'demo-location-riverside-v1',
  'demo-tenant-v1',
  'Harbor & Main - Riverside',
  '480 River Walk, Sacramento, CA 95814',
  'America/Los_Angeles',
  now(),
  now(),
  NULL
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    address = EXCLUDED.address,
    timezone = EXCLUDED.timezone,
    "deletedAt" = NULL,
    "updatedAt" = now();

INSERT INTO "User" (
  id, "tenantId", email, username, name, role, "mfaEnabled",
  "mfaBackupCodes", "pinResetRequired", "pinLoginAttempts",
  "loginAttempts", "createdAt", "updatedAt", "deletedAt", "suspendedAt"
) VALUES
  ('demo-user-jamie-v1', 'demo-tenant-v1', NULL, 'jamie.manager', 'Jamie Chen', 'MANAGER', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-morgan-v1', 'demo-tenant-v1', NULL, 'morgan.manager', 'Morgan Reyes', 'MANAGER', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-taylor-v1', 'demo-tenant-v1', NULL, 'taylor.brooks', 'Taylor Brooks', 'STAFF', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-jordan-v1', 'demo-tenant-v1', NULL, 'jordan.kim', 'Jordan Kim', 'STAFF', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-casey-v1', 'demo-tenant-v1', NULL, 'casey.patel', 'Casey Patel', 'STAFF', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-riley-v1', 'demo-tenant-v1', NULL, 'riley.adams', 'Riley Adams', 'STAFF', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-avery-v1', 'demo-tenant-v1', NULL, 'avery.diaz', 'Avery Diaz', 'STAFF', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-quinn-v1', 'demo-tenant-v1', NULL, 'quinn.foster', 'Quinn Foster', 'STAFF', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-cameron-v1', 'demo-tenant-v1', NULL, 'cameron.lee', 'Cameron Lee', 'STAFF', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-skyler-v1', 'demo-tenant-v1', NULL, 'skyler.grant', 'Skyler Grant', 'STAFF', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-dakota-v1', 'demo-tenant-v1', NULL, 'dakota.nguyen', 'Dakota Nguyen', 'STAFF', false, '{}', false, 0, 0, now(), now(), NULL, NULL),
  ('demo-user-rowan-v1', 'demo-tenant-v1', NULL, 'rowan.ellis', 'Rowan Ellis', 'STAFF', false, '{}', false, 0, 0, now(), now(), NULL, NULL)
ON CONFLICT (id) DO UPDATE
SET username = EXCLUDED.username,
    name = EXCLUDED.name,
    role = EXCLUDED.role,
    "deletedAt" = NULL,
    "suspendedAt" = NULL,
    "updatedAt" = now();

DELETE FROM "RoleAssignment"
WHERE "tenantId" = 'demo-tenant-v1'
  AND "userId" LIKE 'demo-user-%';

INSERT INTO "RoleAssignment" ("userId", "roleId", "tenantId", "createdAt")
SELECT u.id, r.id, u."tenantId", now()
FROM "User" u
JOIN "Role" r
  ON r."tenantId" = u."tenantId"
 AND r.slug = CASE WHEN u.role = 'MANAGER' THEN 'manager' ELSE 'staff' END
WHERE u."tenantId" = 'demo-tenant-v1'
  AND u.id LIKE 'demo-user-%'
ON CONFLICT DO NOTHING;

DELETE FROM "RoleAssignment" assignment
USING demo_context c, "Role" r
WHERE assignment."userId" = c.admin_id
  AND assignment."tenantId" = c.tenant_id
  AND assignment."roleId" = r.id
  AND r."tenantId" = c.tenant_id
  AND r.slug = 'admin';

INSERT INTO "RoleAssignment" ("userId", "roleId", "tenantId", "createdAt")
SELECT c.admin_id, r.id, c.tenant_id, now()
FROM demo_context c
JOIN "Role" r
  ON r."tenantId" = c.tenant_id
 AND r.id = 'demo-role-v1'
ON CONFLICT DO NOTHING;

DELETE FROM "TimeCardBreak"
WHERE "tenantId" = 'demo-tenant-v1'
  AND id LIKE 'demo-timecard-break-%';
DELETE FROM "TimeCard"
WHERE "tenantId" = 'demo-tenant-v1'
  AND id LIKE 'demo-timecard-%';
DELETE FROM "Break"
WHERE id LIKE 'demo-break-%'
  AND "shiftId" IN (
    SELECT id FROM "Shift" WHERE "tenantId" = 'demo-tenant-v1'
  );
DELETE FROM "Shift"
WHERE "tenantId" = 'demo-tenant-v1'
  AND id LIKE 'demo-shift-%';
DELETE FROM "ScheduleDemandWindow"
WHERE "tenantId" = 'demo-tenant-v1'
  AND id LIKE 'demo-demand-%';
DELETE FROM "Schedule"
WHERE "tenantId" = 'demo-tenant-v1'
  AND id LIKE 'demo-schedule-%';
DELETE FROM "StaffAvailability"
WHERE "tenantId" = 'demo-tenant-v1'
  AND id LIKE 'demo-availability-%';
DELETE FROM "StaffSkill"
WHERE "tenantId" = 'demo-tenant-v1'
  AND id LIKE 'demo-skill-%';
DELETE FROM "Notification"
WHERE "tenantId" = 'demo-tenant-v1'
  AND id LIKE 'demo-notification-%';

WITH skill_data(user_id, skill) AS (
  VALUES
    ('demo-user-jamie-v1', 'Shift Lead'),
    ('demo-user-jamie-v1', 'Opening'),
    ('demo-user-jamie-v1', 'Barista'),
    ('demo-user-morgan-v1', 'Shift Lead'),
    ('demo-user-morgan-v1', 'Closing'),
    ('demo-user-morgan-v1', 'Kitchen'),
    ('demo-user-taylor-v1', 'Barista'),
    ('demo-user-taylor-v1', 'Register'),
    ('demo-user-jordan-v1', 'Kitchen'),
    ('demo-user-jordan-v1', 'Prep'),
    ('demo-user-casey-v1', 'Barista'),
    ('demo-user-casey-v1', 'Register'),
    ('demo-user-riley-v1', 'Kitchen'),
    ('demo-user-riley-v1', 'Closing'),
    ('demo-user-avery-v1', 'Register'),
    ('demo-user-avery-v1', 'Guest Service'),
    ('demo-user-quinn-v1', 'Barista'),
    ('demo-user-quinn-v1', 'Opening'),
    ('demo-user-cameron-v1', 'Kitchen'),
    ('demo-user-cameron-v1', 'Prep'),
    ('demo-user-skyler-v1', 'Register'),
    ('demo-user-skyler-v1', 'Guest Service'),
    ('demo-user-dakota-v1', 'Barista'),
    ('demo-user-dakota-v1', 'Closing'),
    ('demo-user-rowan-v1', 'Kitchen'),
    ('demo-user-rowan-v1', 'Guest Service')
)
INSERT INTO "StaffSkill" (
  id, "tenantId", "userId", skill, "createdAt", "updatedAt"
)
SELECT
  'demo-skill-' || replace(user_id, 'demo-user-', '') || '-' || lower(replace(skill, ' ', '-')),
  'demo-tenant-v1',
  user_id,
  skill,
  now(),
  now()
FROM skill_data;

WITH workers(user_id, location_id, start_min, end_min) AS (
  VALUES
    ('demo-user-jamie-v1', 'demo-location-v1', 390, 1020),
    ('demo-user-taylor-v1', 'demo-location-v1', 420, 1020),
    ('demo-user-jordan-v1', 'demo-location-v1', 480, 1080),
    ('demo-user-casey-v1', 'demo-location-v1', 540, 1140),
    ('demo-user-riley-v1', 'demo-location-v1', 600, 1200),
    ('demo-user-avery-v1', 'demo-location-v1', 660, 1260),
    ('demo-user-morgan-v1', 'demo-location-riverside-v1', 390, 1020),
    ('demo-user-quinn-v1', 'demo-location-riverside-v1', 420, 1020),
    ('demo-user-cameron-v1', 'demo-location-riverside-v1', 480, 1080),
    ('demo-user-skyler-v1', 'demo-location-riverside-v1', 540, 1140),
    ('demo-user-dakota-v1', 'demo-location-riverside-v1', 600, 1200),
    ('demo-user-rowan-v1', 'demo-location-riverside-v1', 660, 1260)
)
INSERT INTO "StaffAvailability" (
  id, "tenantId", "userId", "locationId", "dayOfWeek",
  "startTimeMinutes", "endTimeMinutes", "createdAt", "updatedAt"
)
SELECT
  'demo-availability-' || replace(w.user_id, 'demo-user-', '') || '-' || d,
  'demo-tenant-v1',
  w.user_id,
  w.location_id,
  d,
  w.start_min,
  w.end_min,
  now(),
  now()
FROM workers w
CROSS JOIN generate_series(0, 6) d;

INSERT INTO "Schedule" (
  id, "tenantId", "locationId", "startDate", "endDate", status,
  "publishedAt", "createdAt", "updatedAt", "deletedAt", revision
)
SELECT
  s.id,
  c.tenant_id,
  s.location_id,
  ((c.week_start + s.week_offset)::timestamp AT TIME ZONE 'America/Los_Angeles'),
  ((c.week_start + s.week_offset + 7)::timestamp AT TIME ZONE 'America/Los_Angeles'),
  s.status::"ScheduleStatus",
  CASE WHEN s.status = 'PUBLISHED' THEN now() ELSE NULL END,
  now(),
  now(),
  NULL,
  1
FROM demo_context c
CROSS JOIN (
  VALUES
    ('demo-schedule-current-downtown-v1', 'demo-location-v1', 0, 'PUBLISHED'),
    ('demo-schedule-next-downtown-v1', 'demo-location-v1', 7, 'DRAFT'),
    ('demo-schedule-current-riverside-v1', 'demo-location-riverside-v1', 0, 'PUBLISHED'),
    ('demo-schedule-next-riverside-v1', 'demo-location-riverside-v1', 7, 'DRAFT')
) s(id, location_id, week_offset, status);

WITH workers(user_id, location_id, worker_index, start_hour, role_name) AS (
  VALUES
    ('demo-user-jamie-v1', 'demo-location-v1', 0, 6, 'Shift Lead'),
    ('demo-user-taylor-v1', 'demo-location-v1', 1, 7, 'Barista'),
    ('demo-user-jordan-v1', 'demo-location-v1', 2, 8, 'Kitchen'),
    ('demo-user-casey-v1', 'demo-location-v1', 3, 9, 'Barista'),
    ('demo-user-riley-v1', 'demo-location-v1', 4, 10, 'Kitchen'),
    ('demo-user-avery-v1', 'demo-location-v1', 5, 11, 'Guest Service'),
    ('demo-user-morgan-v1', 'demo-location-riverside-v1', 0, 6, 'Shift Lead'),
    ('demo-user-quinn-v1', 'demo-location-riverside-v1', 1, 7, 'Barista'),
    ('demo-user-cameron-v1', 'demo-location-riverside-v1', 2, 8, 'Kitchen'),
    ('demo-user-skyler-v1', 'demo-location-riverside-v1', 3, 9, 'Guest Service'),
    ('demo-user-dakota-v1', 'demo-location-riverside-v1', 4, 10, 'Barista'),
    ('demo-user-rowan-v1', 'demo-location-riverside-v1', 5, 11, 'Kitchen')
),
shift_rows AS (
  SELECT
    'demo-shift-' || lpad(day_offset::text, 2, '0') || '-' || replace(w.user_id, 'demo-user-', '') AS id,
    w.location_id,
    w.user_id,
    day_offset,
    w.start_hour,
    w.role_name,
    CASE
      WHEN day_offset < 7 AND w.location_id = 'demo-location-v1'
        THEN 'demo-schedule-current-downtown-v1'
      WHEN day_offset < 7
        THEN 'demo-schedule-current-riverside-v1'
      WHEN w.location_id = 'demo-location-v1'
        THEN 'demo-schedule-next-downtown-v1'
      ELSE 'demo-schedule-next-riverside-v1'
    END AS schedule_id
  FROM workers w
  CROSS JOIN generate_series(0, 13) day_offset
  WHERE w.worker_index = 0
     OR (day_offset + w.worker_index) % 5 <> 0
)
INSERT INTO "Shift" (
  id, "tenantId", "locationId", "scheduleId", "userId", "startTime",
  "endTime", role, notes, "createdAt", "updatedAt", "deletedAt"
)
SELECT
  s.id,
  c.tenant_id,
  s.location_id,
  s.schedule_id,
  s.user_id,
  (
    (c.week_start + s.day_offset)::timestamp
    + make_interval(hours => s.start_hour)
  ) AT TIME ZONE 'America/Los_Angeles',
  (
    (c.week_start + s.day_offset)::timestamp
    + make_interval(
        hours => s.start_hour,
        mins => CASE WHEN s.start_hour = 6 THEN 510 ELSE 480 END
      )
  ) AT TIME ZONE 'America/Los_Angeles',
  s.role_name,
  CASE
    WHEN s.day_offset < 7 THEN 'Published demo schedule'
    ELSE 'Upcoming draft schedule'
  END,
  now(),
  now(),
  NULL
FROM shift_rows s
CROSS JOIN demo_context c;

INSERT INTO "Break" (
  id, "shiftId", "startTime", "endTime", paid, "createdAt", type
)
SELECT
  'demo-break-1-' || s.id,
  s.id,
  s."startTime" + interval '2 hours',
  s."startTime" + interval '2 hours 10 minutes',
  true,
  now(),
  'BREAK1'::"BreakType"
FROM "Shift" s
WHERE s."tenantId" = 'demo-tenant-v1'
  AND s.id LIKE 'demo-shift-%'
UNION ALL
SELECT
  'demo-break-lunch-' || s.id,
  s.id,
  s."startTime" + interval '4 hours',
  s."startTime" + interval '4 hours 30 minutes',
  false,
  now(),
  'LUNCH'::"BreakType"
FROM "Shift" s
WHERE s."tenantId" = 'demo-tenant-v1'
  AND s.id LIKE 'demo-shift-%'
UNION ALL
SELECT
  'demo-break-2-' || s.id,
  s.id,
  s."startTime" + interval '6 hours 30 minutes',
  s."startTime" + interval '6 hours 40 minutes',
  true,
  now(),
  'BREAK2'::"BreakType"
FROM "Shift" s
WHERE s."tenantId" = 'demo-tenant-v1'
  AND s.id LIKE 'demo-shift-%';

WITH windows(offset_hour, duration_hours, required_staff, skill) AS (
  VALUES
    (6, 4, 3, 'Opening'),
    (10, 4, 5, 'Guest Service'),
    (14, 4, 4, 'Barista'),
    (18, 4, 3, 'Closing')
)
INSERT INTO "ScheduleDemandWindow" (
  id, "tenantId", "scheduleId", "locationId", "startTime", "endTime",
  "requiredStaff", skill, "createdAt", "updatedAt"
)
SELECT
  'demo-demand-' || lpad(day_offset::text, 2, '0')
    || '-' || replace(location_id, 'demo-location-', '')
    || '-' || w.offset_hour,
  c.tenant_id,
  CASE
    WHEN day_offset < 7 AND location_id = 'demo-location-v1'
      THEN 'demo-schedule-current-downtown-v1'
    WHEN day_offset < 7
      THEN 'demo-schedule-current-riverside-v1'
    WHEN location_id = 'demo-location-v1'
      THEN 'demo-schedule-next-downtown-v1'
    ELSE 'demo-schedule-next-riverside-v1'
  END,
  location_id,
  (
    (c.week_start + day_offset)::timestamp
    + make_interval(hours => w.offset_hour)
  ) AT TIME ZONE 'America/Los_Angeles',
  (
    (c.week_start + day_offset)::timestamp
    + make_interval(hours => w.offset_hour + w.duration_hours)
  ) AT TIME ZONE 'America/Los_Angeles',
  w.required_staff,
  w.skill,
  now(),
  now()
FROM demo_context c
CROSS JOIN generate_series(0, 13) day_offset
CROSS JOIN (
  VALUES ('demo-location-v1'), ('demo-location-riverside-v1')
) locations(location_id)
CROSS JOIN windows w;

INSERT INTO "PayrollPolicyVersion" (
  id, "tenantId", version, "timeZone", cadence, "anchorDate",
  "effectiveFrom", "operationId", "requestHash", "createdByUserId", "createdAt"
)
SELECT
  'demo-payroll-policy-v1',
  tenant_id,
  1,
  'America/Los_Angeles',
  'BIWEEKLY',
  '2026-01-05',
  '2026-01-05',
  'demo-payroll-policy-operation-v1',
  repeat('a', 64),
  admin_id,
  now()
FROM demo_context
WHERE NOT EXISTS (
  SELECT 1
  FROM "PayrollPolicyVersion"
  WHERE id = 'demo-payroll-policy-v1'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "PayrollPeriod" (
  id, "tenantId", "policyVersionId", "localStartDate",
  "localEndDateExclusive", "startsAt", "endsAt", "timeZone", cadence,
  status, revision, "createdAt", "updatedAt"
)
SELECT
  'demo-payroll-period-current-v1',
  tenant_id,
  'demo-payroll-policy-v1',
  payroll_start,
  payroll_start + 14,
  payroll_start::timestamp AT TIME ZONE 'America/Los_Angeles',
  (payroll_start + 14)::timestamp AT TIME ZONE 'America/Los_Angeles',
  'America/Los_Angeles',
  'BIWEEKLY',
  'OPEN',
  0,
  now(),
  now()
FROM demo_context
WHERE NOT EXISTS (
  SELECT 1
  FROM "PayrollPeriod"
  WHERE id = 'demo-payroll-period-current-v1'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "TimeCard" (
  id, "tenantId", "userId", "locationId", "shiftId", "clockInAt",
  "clockOutAt", "payrollPeriodId", "workTimeZone", revision,
  "breakMinutes", notes, status, "createdAt", "updatedAt", "deletedAt"
)
SELECT
  'demo-timecard-' || replace(s.id, 'demo-shift-', ''),
  c.tenant_id,
  s."userId",
  s."locationId",
  s.id,
  s."startTime" + make_interval(mins => 2 + length(s.id) % 4),
  s."endTime" - make_interval(mins => 1 + length(s.id) % 3),
  'demo-payroll-period-current-v1',
  'America/Los_Angeles',
  1,
  30,
  'Completed demo shift',
  'CLOSED',
  now(),
  now(),
  NULL
FROM "Shift" s
CROSS JOIN demo_context c
WHERE s."tenantId" = 'demo-tenant-v1'
  AND s."scheduleId" IN (
    'demo-schedule-current-downtown-v1',
    'demo-schedule-current-riverside-v1'
  )
  AND (
    s."startTime" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles'
  )::date < timezone('America/Los_Angeles', now())::date;

INSERT INTO "TimeCardBreak" (
  id, "tenantId", "timeCardId", "startAt", "endAt", "createdAt", "updatedAt"
)
SELECT
  'demo-timecard-break-' || replace(tc.id, 'demo-timecard-', ''),
  tc."tenantId",
  tc.id,
  tc."clockInAt" + interval '4 hours',
  tc."clockInAt" + interval '4 hours 30 minutes',
  now(),
  now()
FROM "TimeCard" tc
WHERE tc."tenantId" = 'demo-tenant-v1'
  AND tc.id LIKE 'demo-timecard-%';

INSERT INTO "TenantSetting" (id, "tenantId", key, value, "updatedAt")
VALUES
  (
    'demo-setting-workspace-v1',
    'demo-tenant-v1',
    'workspace_settings',
    '{
      "general": {"timezone": "America/Los_Angeles"},
      "team": {
        "defaultInviteRole": "STAFF",
        "shiftApprovalPolicy": "MANAGER_APPROVAL"
      },
      "security": {
        "requireMfaForAll": false,
        "sessionTimeoutMinutes": 480,
        "ssoOidcOnly": false,
        "oidcIssuerUrl": null
      }
    }'::jsonb,
    now()
  ),
  (
    'demo-setting-break-policy-v1',
    'demo-tenant-v1',
    'lunch_break_policy',
    '{
      "break1OffsetMinutes": 120,
      "lunchOffsetMinutes": 240,
      "break2OffsetMinutes": 390,
      "break1DurationMinutes": 10,
      "lunchDurationMinutes": 30,
      "break2DurationMinutes": 10,
      "timeStepMinutes": 5
    }'::jsonb,
    now()
  )
ON CONFLICT ("tenantId", key) DO UPDATE
SET value = EXCLUDED.value,
    "updatedAt" = now();

INSERT INTO "Notification" (
  id, "tenantId", "userId", type, title, body, "readAt", "createdAt"
)
SELECT
  n.id,
  c.tenant_id,
  c.admin_id,
  n.type::"NotificationType",
  n.title,
  n.body,
  n.read_at,
  n.created_at
FROM demo_context c
CROSS JOIN (
  VALUES
    (
      'demo-notification-welcome-v1',
      'SUCCESS',
      'Demo workspace ready',
      'Your Harbor & Main demo workspace is populated and ready to explore.',
      NULL::timestamp,
      now()
    ),
    (
      'demo-notification-published-v1',
      'SCHEDULE_PUBLISHED',
      'This week is published',
      'Schedules for Downtown and Riverside are published for the current week.',
      NULL::timestamp,
      now() - interval '2 hours'
    ),
    (
      'demo-notification-payroll-v1',
      'INFO',
      'Payroll period in progress',
      'Recent completed shifts are ready for payroll review.',
      now() - interval '1 hour',
      now() - interval '1 day'
    )
) n(id, type, title, body, read_at, created_at);

INSERT INTO "AuditLog" (
  id, "tenantId", "userId", action, resource, "resourceId", "newValue",
  "createdAt", "actorTenantId", "actorUserId"
)
SELECT
  'demo-audit-seeded-v1',
  tenant_id,
  admin_id,
  'DEMO_WORKSPACE_SEEDED',
  'Tenant',
  tenant_id,
  '{"locations": 2, "teamMembers": 13, "scheduleWeeks": 2}'::jsonb,
  now(),
  tenant_id,
  admin_id
FROM demo_context
ON CONFLICT (id) DO NOTHING;

COMMIT;

SELECT 'active_users' AS metric, count(*)::text AS value
FROM "User"
WHERE "tenantId" = 'demo-tenant-v1' AND "deletedAt" IS NULL
UNION ALL
SELECT 'availability_windows', count(*)::text
FROM "StaffAvailability"
WHERE "tenantId" = 'demo-tenant-v1'
UNION ALL
SELECT 'breaks', count(*)::text
FROM "Break" b
JOIN "Shift" s ON s.id = b."shiftId"
WHERE s."tenantId" = 'demo-tenant-v1'
UNION ALL
SELECT 'closed_timecards', count(*)::text
FROM "TimeCard"
WHERE "tenantId" = 'demo-tenant-v1' AND status = 'CLOSED'
UNION ALL
SELECT 'demand_windows', count(*)::text
FROM "ScheduleDemandWindow"
WHERE "tenantId" = 'demo-tenant-v1'
UNION ALL
SELECT 'locations', count(*)::text
FROM "Location"
WHERE "tenantId" = 'demo-tenant-v1' AND "deletedAt" IS NULL
UNION ALL
SELECT 'notifications', count(*)::text
FROM "Notification"
WHERE "tenantId" = 'demo-tenant-v1'
UNION ALL
SELECT 'payroll_periods', count(*)::text
FROM "PayrollPeriod"
WHERE "tenantId" = 'demo-tenant-v1'
UNION ALL
SELECT 'schedules', count(*)::text
FROM "Schedule"
WHERE "tenantId" = 'demo-tenant-v1' AND "deletedAt" IS NULL
UNION ALL
SELECT 'shifts', count(*)::text
FROM "Shift"
WHERE "tenantId" = 'demo-tenant-v1' AND "deletedAt" IS NULL
UNION ALL
SELECT 'skills', count(*)::text
FROM "StaffSkill"
WHERE "tenantId" = 'demo-tenant-v1'
ORDER BY metric;
