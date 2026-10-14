-- Local drill only: deterministic multi-tenant data on top of the real
-- migrations, so a restore can be compared table by table with the source.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO "Tenant" (id, name, slug, status, "planTier", "updatedAt")
SELECT 'drill-tenant-' || n, 'Drill Cafe ' || n, 'drill-' || n, 'ACTIVE', 'STARTER', now()
FROM generate_series(1, 3) AS n;

INSERT INTO "Location" (id, "tenantId", name, timezone, "updatedAt")
SELECT 'drill-loc-' || t || '-' || l, 'drill-tenant-' || t, 'Location ' || t || '.' || l, 'America/Los_Angeles', now()
FROM generate_series(1, 3) AS t, generate_series(1, 2) AS l;

INSERT INTO "User" (id, "tenantId", name, role, "updatedAt")
SELECT 'drill-user-' || t || '-' || u, 'drill-tenant-' || t,
       'Staff ' || t || '-' || u || ' ' || md5(t || ':' || u),
       CASE WHEN u = 1 THEN 'ADMIN' WHEN u <= 5 THEN 'MANAGER' ELSE 'STAFF' END::"UserRole",
       now()
FROM generate_series(1, 3) AS t, generate_series(1, 200) AS u;

INSERT INTO "Schedule" (id, "tenantId", "locationId", "startDate", "endDate", "updatedAt")
SELECT 'drill-sched-' || t || '-' || l || '-' || w, 'drill-tenant-' || t, 'drill-loc-' || t || '-' || l,
       date '2026-09-01' + (w * 7), date '2026-09-01' + (w * 7) + 6, now()
FROM generate_series(1, 3) AS t, generate_series(1, 2) AS l, generate_series(0, 7) AS w;

INSERT INTO "Shift" (id, "tenantId", "locationId", "startTime", "endTime", "updatedAt")
SELECT 'drill-shift-' || t || '-' || s, 'drill-tenant-' || t, 'drill-loc-' || t || '-' || (1 + s % 2),
       timestamp '2026-09-01 08:00' + (s % 56) * interval '1 day' + (s % 8) * interval '1 hour',
       timestamp '2026-09-01 14:00' + (s % 56) * interval '1 day' + (s % 8) * interval '1 hour', now()
FROM generate_series(1, 3) AS t, generate_series(1, 4000) AS s;

INSERT INTO "TimeCard" (id, "tenantId", "userId", "clockInAt", "clockOutAt", status, "updatedAt")
SELECT 'drill-tc-' || t || '-' || c, 'drill-tenant-' || t, 'drill-user-' || t || '-' || (1 + c % 200),
       timestamp '2026-09-01 08:00' + c * interval '30 minutes', timestamp '2026-09-01 08:00' + c * interval '30 minutes' + interval '4 hours', 'CLOSED', now()
FROM generate_series(1, 3) AS t, generate_series(1, 2000) AS c;

INSERT INTO "AuditLog" (id, "tenantId", action, resource)
SELECT 'drill-audit-' || t || '-' || a, 'drill-tenant-' || t,
       (ARRAY['shift.create','shift.update','user.invite','schedule.publish'])[1 + a % 4],
       'resource-' || md5(t || ':' || a) || repeat('x', 200)
FROM generate_series(1, 3) AS t, generate_series(1, 5000) AS a;

COMMIT;
