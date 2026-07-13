import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { readFileSync } from "fs";
import { SchedulesController } from "./schedules.controller";
import { NotificationType } from "../notifications/notifications.service";
import { TenantPrismaService } from "../database/tenant-prisma.service";
import { autoScheduleRequestHash } from "./auto-schedule-idempotency";

describe("SchedulesController", () => {
  let controller: SchedulesController;
  let prisma: any;
  let tx: any;
  let notificationsService: any;
  let featureAccessService: any;
  let meteringService: any;
  let webhooksService: any;
  let persistedAvailabilityRows: any[];
  let persistedSkillRows: any[];
  let persistedDemandRows: any[];
  let persistedDraftShiftRows: any[];
  let persistedExistingShiftRows: any[];
  let persistedSolveJobRows: any[];
  let lockedScheduleStatus: string | null;
  let activeLocation: { id: string; timezone: string } | null;
  let autoDemandFallbackEnabled: boolean;

  beforeEach(() => {
    notificationsService = {
      send: vi.fn().mockResolvedValue({ id: "notification-1" }),
      sendMany: vi.fn().mockResolvedValue([]),
    };
    featureAccessService = {
      assertFeatureEnabled: vi.fn().mockResolvedValue(undefined),
      assertFeatureEnabledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: "credits", creditCost: 1, reason: "Billable" }),
      resolveTenantFeatures: vi.fn().mockResolvedValue({
        usageCredits: 1,
        features: {
          scheduling: {
            enabled: true,
            source: "credits",
            creditCost: 1,
            reason: "Credit available",
          },
        },
      }),
      consumeCreditsForFeature: vi
        .fn()
        .mockResolvedValue({ consumedCredits: 1, newBalance: 0 }),
    };
    meteringService = {
      grantCredits: vi.fn().mockResolvedValue(1),
    };
    webhooksService = {
      enqueueEventInTransaction: vi.fn().mockResolvedValue(0),
    };
    persistedAvailabilityRows = [];
    persistedSkillRows = [];
    persistedDemandRows = [];
    persistedDraftShiftRows = [];
    persistedExistingShiftRows = [];
    persistedSolveJobRows = [];
    lockedScheduleStatus = "DRAFT";
    activeLocation = { id: "loc-1", timezone: "America/Los_Angeles" };
    autoDemandFallbackEnabled = true;
    tx = {
      $queryRaw: vi.fn(async (query: any) => {
        const sql = Array.isArray(query) ? query.join(" ") : String(query);
        if (sql.includes('FROM "Location"') && sql.includes("FOR UPDATE")) {
          return activeLocation ? [activeLocation] : [];
        }
        if (sql.includes('FROM "Schedule"') && sql.includes("FOR UPDATE")) {
          return lockedScheduleStatus
            ? [
                {
                  id: "sch-1",
                  status: lockedScheduleStatus,
                  locationId: "loc-1",
                  timezone: "America/Los_Angeles",
                  startDate: new Date("2026-03-10T07:00:00.000Z"),
                  endDate: new Date("2026-03-17T07:00:00.000Z"),
                },
              ]
            : [];
        }
        if (sql.includes('FROM "ScheduleSolveJob"')) {
          return sql.includes('"status" NOT IN')
            ? persistedSolveJobRows.filter(
                (row) =>
                  !["SUCCEEDED", "FAILED", "DEAD_LETTERED"].includes(
                    row.status,
                  ),
              )
            : persistedSolveJobRows;
        }
        if (
          sql.includes('UPDATE "Tenant"') &&
          sql.includes('RETURNING "usageCredits"')
        ) {
          return [{ usageCredits: 0 }];
        }
        if (sql.includes('FROM "StaffAvailability"')) {
          return persistedAvailabilityRows;
        }
        if (sql.includes('FROM "StaffSkill"')) {
          return persistedSkillRows;
        }
        if (sql.includes('FROM "ScheduleDemandWindow"')) {
          const priorSql = tx.$queryRaw.mock.calls
            .slice(0, -1)
            .map((call: any[]) => Array.isArray(call[0]) ? call[0].join(" ") : String(call[0]));
          const isSolveInputRead = priorSql.some((value: string) => value.includes('FROM "StaffSkill"'));
          return persistedDemandRows.length > 0 || !autoDemandFallbackEnabled || !isSolveInputRead
            ? persistedDemandRows
            : [{
                id: "demand-default",
                startTime: new Date("2026-03-10T16:00:00.000Z"),
                endTime: new Date("2026-03-10T20:00:00.000Z"),
                requiredStaff: 1,
                skill: null,
              }];
        }
        if (sql.includes('LEFT JOIN "Schedule" source_schedule')) {
          return persistedExistingShiftRows;
        }
        if (sql.includes('FROM "Shift"')) {
          return persistedDraftShiftRows;
        }
        return [{ set_current_tenant: null }];
      }),
      $executeRaw: vi.fn().mockResolvedValue(1),
      schedule: {
        updateMany: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      scheduleDemandWindow: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      location: {
        findFirst: vi.fn(),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([{ id: "u1" }, { id: "u2" }]),
      },
      shift: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "shift-1" }, { id: "shift-2" }]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      break: {
        deleteMany: vi.fn().mockResolvedValue({ count: 6 }),
      },
      creditTransaction: {
        create: vi.fn().mockResolvedValue({ id: "credit-1" }),
      },
    };
    prisma = {
      schedule: {
        count: vi.fn(),
        updateMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      location: {
        findFirst: vi.fn(),
      },
      user: {
        findMany: vi.fn(),
      },
      shift: {
        findMany: vi.fn(),
      },
      $transaction: vi.fn(
        async (callback: (txClient: any) => Promise<unknown>) => callback(tx),
      ),
    };
    controller = new SchedulesController(
      notificationsService,
      featureAccessService,
      new TenantPrismaService(prisma),
      meteringService,
      webhooksService,
    );
    tx.location.findFirst.mockResolvedValue({
      id: "loc-1",
      timezone: "America/Los_Angeles",
    });
    tx.schedule.count.mockResolvedValue(0);
  });

  it("starts and stops the durable schedule publication recovery loop with the API lifecycle", async () => {
    const start = vi
      .spyOn((controller as any).scheduleOutbox, "start")
      .mockImplementation(() => undefined);
    const stop = vi
      .spyOn((controller as any).scheduleOutbox, "stop")
      .mockResolvedValue(undefined);

    controller.onModuleInit();
    await controller.onModuleDestroy();

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("blocks schedule creation when scheduling is not entitled", async () => {
    featureAccessService.assertFeatureEnabled.mockRejectedValue(
      new ForbiddenException("Upgrade plan or add credits to enable"),
    );

    await expect(
      controller.create(
        {
          locationId: "loc-1",
          startDate: "2026-03-10T00:00:00.000Z",
          endDate: "2026-03-17T00:00:00.000Z",
        },
        { user: { tenantId: "tenant-1" } },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(featureAccessService.assertFeatureEnabled).toHaveBeenCalledWith(
      "tenant-1",
      "scheduling",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.schedule.create).not.toHaveBeenCalled();
  });

  it("blocks schedule deletion and publish when scheduling is not entitled", async () => {
    featureAccessService.assertFeatureEnabled.mockRejectedValue(
      new ForbiddenException("Upgrade plan or add credits to enable"),
    );

    await expect(
      controller.remove("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(featureAccessService.assertFeatureEnabled).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notificationsService.send).not.toHaveBeenCalled();
  });

  it("blocks auto-schedule before queueing when scheduling is not entitled", async () => {
    featureAccessService.assertFeatureEnabledInTransaction.mockRejectedValue(
      new ForbiddenException("Upgrade plan or add credits to enable"),
    );
    const enqueueSolveJob = vi
      .spyOn(controller as any, "enqueueSolveJob")
      .mockResolvedValue(undefined);

    await expect(
      controller.autoSchedule(
        "sch-1",
        { user: { tenantId: "tenant-1" } },
        undefined,
        "request-entitlement",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(featureAccessService.assertFeatureEnabledInTransaction).toHaveBeenCalledWith(
      tx,
      "tenant-1",
      "scheduling",
    );
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(enqueueSolveJob).not.toHaveBeenCalled();
    expect(
      featureAccessService.consumeCreditsForFeature,
    ).not.toHaveBeenCalled();
  });

  it("scopes staff schedule list reads to schedules containing their shifts", async () => {
    tx.schedule.findMany.mockResolvedValue([{ id: "sch-1" }]);

    const result = await controller.findAll({
      user: { tenantId: "tenant-1", sub: "staff-1", legacyRole: "STAFF" },
    });

    expect(tx.schedule.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        deletedAt: null,
        location: { is: { deletedAt: null } },
        status: "PUBLISHED",
        shifts: {
          some: {
            tenantId: "tenant-1",
            userId: "staff-1",
            deletedAt: null,
          },
        },
      },
    });
    expect(result.data).toEqual([{ id: "sch-1" }]);
  });

  it("scopes refreshed staff sessions using the current RBAC role label", async () => {
    tx.schedule.findMany.mockResolvedValue([{ id: "sch-1" }]);

    await controller.findAll({
      user: { tenantId: "tenant-1", sub: "staff-1", role: "Staff" },
    });

    expect(tx.schedule.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: "PUBLISHED",
        shifts: { some: expect.objectContaining({ userId: "staff-1" }) },
      }),
    });
  });

  it("scopes staff single-schedule reads to schedules containing their shifts", async () => {
    tx.schedule.findFirst.mockResolvedValue({ id: "sch-1" });

    await controller.findOne("sch-1", {
      user: { tenantId: "tenant-1", sub: "staff-1", legacyRole: "STAFF" },
    });

    expect(tx.schedule.findFirst).toHaveBeenCalledWith({
      where: {
        id: "sch-1",
        tenantId: "tenant-1",
        deletedAt: null,
        location: { is: { deletedAt: null } },
        status: "PUBLISHED",
        shifts: {
          some: {
            tenantId: "tenant-1",
            userId: "staff-1",
            deletedAt: null,
          },
        },
      },
    });
  });

  it("publishes draft schedule and notifies assigned users", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
      { userId: "u2", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      location: { name: "Downtown Bistro", timezone: "America/Los_Angeles" },
    });
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-1",
        userId: "u1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
      },
      {
        id: "shift-2",
        userId: "u2",
        startTime: new Date("2026-03-10T21:00:00.000Z"),
        endTime: new Date("2026-03-11T01:00:00.000Z"),
      },
    ]);

    const result = await controller.publish("sch-1", {
      user: { tenantId: "tenant-1" },
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(8);
    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sch-1",
        tenantId: "tenant-1",
        status: "DRAFT",
        deletedAt: null,
      },
      data: { status: "PUBLISHED", publishedAt: expect.any(Date) },
    });
    expect(notificationsService.send).toHaveBeenNthCalledWith(
      1,
      "tenant-1",
      "u1",
      NotificationType.SCHEDULE_PUBLISHED,
      "Schedule published",
      "Downtown Bistro: Mar 10, 2026 to Mar 16, 2026",
    );
    expect(notificationsService.send).toHaveBeenNthCalledWith(
      2,
      "tenant-1",
      "u2",
      NotificationType.SCHEDULE_PUBLISHED,
      "Schedule published",
      "Downtown Bistro: Mar 10, 2026 to Mar 16, 2026",
    );
    expect(result.status).toBe("PUBLISHED");
    expect(result.notifications).toEqual({
      status: "DELIVERED",
      delivered: 2,
      failed: 0,
    });
  });

  it("transactionally enqueues schedule.published for entitled tenant endpoints", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    featureAccessService.resolveTenantFeatures.mockResolvedValue({
      usageCredits: 0,
      features: {
        scheduling: {
          enabled: true,
          source: "plan",
          creditCost: 1,
          reason: "included",
        },
        webhooks: {
          enabled: true,
          source: "plan",
          creditCost: null,
          reason: "included",
        },
      },
    });
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      location: { name: "Downtown Bistro", timezone: "America/Los_Angeles" },
    });
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-1",
        userId: "u1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
      },
    ]);

    await controller.publish("sch-1", { user: { tenantId: "tenant-1" } });

    expect(webhooksService.enqueueEventInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: "tenant-1",
        eventId: expect.stringMatching(/^schedule\.published:sch-1:/),
        eventType: "schedule.published",
        data: expect.objectContaining({
          scheduleId: "sch-1",
          locationId: "loc-1",
          assignedShiftCount: 1,
        }),
      }),
    );
  });

  it("rolls back schedule publication when the transactional webhook outbox insert fails", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    featureAccessService.resolveTenantFeatures.mockResolvedValue({
      usageCredits: 0,
      features: {
        scheduling: {
          enabled: true,
          source: "plan",
          creditCost: 1,
          reason: "included",
        },
        webhooks: {
          enabled: true,
          source: "plan",
          creditCost: null,
          reason: "included",
        },
      },
    });
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      location: { name: "Downtown Bistro", timezone: "America/Los_Angeles" },
    });
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-1",
        userId: "u1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
      },
    ]);
    webhooksService.enqueueEventInTransaction.mockRejectedValue(
      new Error("outbox unavailable"),
    );

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow("outbox unavailable");

    expect(tx.schedule.updateMany).toHaveBeenCalledOnce();
    expect(notificationsService.send).not.toHaveBeenCalled();
  });

  it("returns a committed publish with accurate notification failures", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
      { userId: "u2", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      location: { name: "Downtown Bistro", timezone: "America/Los_Angeles" },
    });
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-1",
        userId: "u1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
      },
      {
        id: "shift-2",
        userId: "u2",
        startTime: new Date("2026-03-10T21:00:00.000Z"),
        endTime: new Date("2026-03-11T01:00:00.000Z"),
      },
    ]);
    notificationsService.send
      .mockResolvedValueOnce({ id: "notification-1" })
      .mockRejectedValueOnce(new Error("database unavailable"));

    const result = await controller.publish("sch-1", {
      user: { tenantId: "tenant-1" },
    });

    expect(tx.schedule.updateMany).toHaveBeenCalledOnce();
    expect(result).toEqual(
      expect.objectContaining({
        status: "PUBLISHED",
        notifications: { status: "PARTIAL", delivered: 1, failed: 1 },
      }),
    );
  });

  it("reopens a published schedule as a locked draft correction transaction", async () => {
    tx.$queryRaw.mockImplementation(async (query: any) => {
      const sql = Array.isArray(query) ? query.join(" ") : String(query);
      if (sql.includes('FROM "Schedule"') && sql.includes("FOR UPDATE")) {
        return [{ id: "sch-1", status: "PUBLISHED" }];
      }
      return [{ set_current_tenant: null }];
    });
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      controller.reopen("sch-1", { user: { tenantId: "tenant-1" } }),
    ).resolves.toEqual({
      id: "sch-1",
      status: "DRAFT",
      publishedAt: null,
    });
    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sch-1",
        tenantId: "tenant-1",
        status: "PUBLISHED",
        deletedAt: null,
      },
      data: { status: "DRAFT", publishedAt: null },
    });
    expect(
      Array.from(tx.$queryRaw.mock.calls.at(-1)?.[0] ?? []).join(" "),
    ).toContain("FOR UPDATE");
  });

  it("creates a draft schedule only for a tenant-owned location", async () => {
    tx.schedule.create.mockResolvedValue({
      id: "sch-1",
      tenantId: "tenant-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T00:00:00.000Z"),
      endDate: new Date("2026-03-17T00:00:00.000Z"),
      status: "DRAFT",
    });

    const result = await controller.create(
      {
        locationId: "loc-1",
        startDate: "2026-03-10T00:00:00.000Z",
        endDate: "2026-03-17T00:00:00.000Z",
      },
      { user: { tenantId: "tenant-1" } },
    );

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    const locationLockSql = Array.from(tx.$queryRaw.mock.calls[1][0]).join(" ");
    expect(locationLockSql).toContain('FROM "Location"');
    expect(locationLockSql).toContain('"deletedAt" IS NULL');
    expect(locationLockSql).toContain("FOR UPDATE");
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.schedule.count.mock.invocationCallOrder[0],
    );
    expect(tx.schedule.count.mock.invocationCallOrder[0]).toBeLessThan(
      tx.schedule.create.mock.invocationCallOrder[0],
    );
    expect(tx.schedule.create).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant-1",
        locationId: "loc-1",
        startDate: new Date("2026-03-10T00:00:00.000Z"),
        endDate: new Date("2026-03-17T00:00:00.000Z"),
        status: "DRAFT",
      },
    });
    expect(result.id).toBe("sch-1");
  });

  it("does not create after a concurrent location deletion wins the row lock", async () => {
    activeLocation = null;

    await expect(
      controller.create(
        {
          locationId: "loc-1",
          startDate: "2026-03-10T00:00:00.000Z",
          endDate: "2026-03-17T00:00:00.000Z",
        },
        { user: { tenantId: "tenant-1" } },
      ),
    ).rejects.toThrow("Location is not available for this tenant.");

    expect(tx.schedule.count).not.toHaveBeenCalled();
    expect(tx.schedule.create).not.toHaveBeenCalled();
  });

  it("excludes schedules retained under soft-deleted locations from active reads", async () => {
    tx.schedule.findMany.mockResolvedValue([]);

    await controller.findAll({
      user: { tenantId: "tenant-1", role: "MANAGER" },
    });

    expect(tx.schedule.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        deletedAt: null,
        location: { is: { deletedAt: null } },
      },
    });
  });

  it("stores date-only schedule windows at location-local midnights", async () => {
    tx.schedule.create.mockResolvedValue({
      id: "sch-1",
      tenantId: "tenant-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T00:00:00.000Z"),
      endDate: new Date("2026-03-17T00:00:00.000Z"),
      status: "DRAFT",
    });

    await controller.create(
      {
        locationId: "loc-1",
        startDate: "2026-03-10",
        endDate: "2026-03-17",
      },
      { user: { tenantId: "tenant-1" } },
    );

    expect(tx.schedule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        startDate: new Date("2026-03-10T07:00:00.000Z"),
        endDate: new Date("2026-03-17T07:00:00.000Z"),
      }),
    });
  });

  it("rejects ambiguous schedule dates before tenant database work", async () => {
    await expect(
      controller.create(
        {
          locationId: "loc-1",
          startDate: "03/10/2026",
          endDate: "2026-03-17",
        },
        { user: { tenantId: "tenant-1" } },
      ),
    ).rejects.toThrow("Invalid startDate");

    expect(tx.location.findFirst).not.toHaveBeenCalled();
    expect(tx.schedule.create).not.toHaveBeenCalled();
  });

  it("rejects invalid calendar dates before tenant database work", async () => {
    await expect(
      controller.create(
        {
          locationId: "loc-1",
          startDate: "2026-02-30",
          endDate: "2026-03-17",
        },
        { user: { tenantId: "tenant-1" } },
      ),
    ).rejects.toThrow("Invalid startDate");

    expect(tx.location.findFirst).not.toHaveBeenCalled();
    expect(tx.schedule.create).not.toHaveBeenCalled();
  });

  it("rejects schedule creation for a location outside the tenant", async () => {
    activeLocation = null;

    await expect(
      controller.create(
        {
          locationId: "loc-foreign",
          startDate: "2026-03-10T00:00:00.000Z",
          endDate: "2026-03-17T00:00:00.000Z",
        },
        { user: { tenantId: "tenant-1" } },
      ),
    ).rejects.toThrow("Location is not available for this tenant.");

    expect(tx.schedule.create).not.toHaveBeenCalled();
  });

  it("rejects schedule creation when the end date is not after the start date", async () => {
    await expect(
      controller.create(
        {
          locationId: "loc-1",
          startDate: "2026-03-17T00:00:00.000Z",
          endDate: "2026-03-10T00:00:00.000Z",
        },
        { user: { tenantId: "tenant-1" } },
      ),
    ).rejects.toThrow("Schedule end date must be after start date.");

    expect(tx.schedule.create).not.toHaveBeenCalled();
  });

  it("rejects schedule creation that overlaps the same location window", async () => {
    tx.schedule.count.mockResolvedValue(1);

    await expect(
      controller.create(
        {
          locationId: "loc-1",
          startDate: "2026-03-10T00:00:00.000Z",
          endDate: "2026-03-17T00:00:00.000Z",
        },
        { user: { tenantId: "tenant-1" } },
      ),
    ).rejects.toThrow(
      "A schedule already overlaps this location and date window.",
    );

    expect(tx.schedule.create).not.toHaveBeenCalled();
  });

  it("soft deletes a draft after terminal jobs while preserving shifts, breaks, and job history", async () => {
    persistedSolveJobRows = [{ id: "job-terminal", status: "SUCCEEDED" }];
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });

    await controller.remove("sch-1", { user: { tenantId: "tenant-1" } });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.shift.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", scheduleId: "sch-1", deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sch-1",
        tenantId: "tenant-1",
        status: "DRAFT",
        deletedAt: null,
      },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.break.deleteMany).not.toHaveBeenCalled();
    expect(tx.schedule.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects deleting a draft while an auto-schedule job is active", async () => {
    persistedSolveJobRows = [{ id: "job-1", status: "RUNNING" }];

    await expect(
      controller.remove("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow("Wait for active auto-schedule jobs to finish");

    expect(tx.shift.updateMany).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("does not delete shifts from another tenant when schedule is missing", async () => {
    lockedScheduleStatus = null;

    await expect(
      controller.remove("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow("Schedule not found");

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.shift.updateMany).not.toHaveBeenCalled();
  });

  it("rejects deleting a published schedule", async () => {
    lockedScheduleStatus = "PUBLISHED";

    await expect(
      controller.remove("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow("Published schedules are locked");

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.shift.updateMany).not.toHaveBeenCalled();
  });

  it("rejects publishing an empty schedule", async () => {
    tx.shift.findMany.mockResolvedValue([]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow(
      "Add at least one shift before publishing this schedule.",
    );

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("rejects long shifts missing default break identities", () => {
    expect(() =>
      (controller as any).assertPublishableShifts(
        [
          {
            id: "shift-long",
            userId: "u1",
            startTime: new Date("2026-03-10T17:00:00.000Z"),
            endTime: new Date("2026-03-11T01:00:00.000Z"),
            breaks: [
              {
                type: "LUNCH",
                startTime: new Date("2026-03-10T21:00:00.000Z"),
                endTime: new Date("2026-03-10T21:30:00.000Z"),
              },
            ],
          },
        ],
        {
          startDate: new Date("2026-03-10T07:00:00.000Z"),
          endDate: new Date("2026-03-17T07:00:00.000Z"),
        },
      ),
    ).toThrow(
      "Shift shift-long is missing required break types: BREAK1, BREAK2.",
    );
  });

  it("accepts long shifts with all default break identities", () => {
    expect(() =>
      (controller as any).assertPublishableShifts(
        [
          {
            id: "shift-long",
            userId: "u1",
            startTime: new Date("2026-03-10T17:00:00.000Z"),
            endTime: new Date("2026-03-11T01:00:00.000Z"),
            breaks: [
              {
                type: "BREAK1",
                startTime: new Date("2026-03-10T19:00:00.000Z"),
                endTime: new Date("2026-03-10T19:10:00.000Z"),
              },
              {
                type: "LUNCH",
                startTime: new Date("2026-03-10T21:00:00.000Z"),
                endTime: new Date("2026-03-10T21:30:00.000Z"),
              },
              {
                type: "BREAK2",
                startTime: new Date("2026-03-10T23:00:00.000Z"),
                endTime: new Date("2026-03-10T23:10:00.000Z"),
              },
            ],
          },
        ],
        {
          startDate: new Date("2026-03-10T07:00:00.000Z"),
          endDate: new Date("2026-03-17T07:00:00.000Z"),
        },
      ),
    ).not.toThrow();
  });

  it("locks and rejects publish while an auto-schedule job is active", async () => {
    persistedSolveJobRows = [{ id: "job-active", status: "RUNNING" }];

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow(
      "Wait for active auto-schedule jobs to finish before publishing this draft.",
    );

    const activeJobQueryIndex = tx.$queryRaw.mock.calls.findIndex(
      ([query]: [unknown]) => {
        const sql = Array.isArray(query) ? query.join(" ") : String(query);
        return (
          sql.includes('FROM "ScheduleSolveJob"') &&
          sql.includes('"status" NOT IN')
        );
      },
    );
    expect(activeJobQueryIndex).toBeGreaterThanOrEqual(0);
    const activeJobQuery = tx.$queryRaw.mock.calls[activeJobQueryIndex][0];
    const activeJobSql = Array.isArray(activeJobQuery)
      ? activeJobQuery.join(" ")
      : String(activeJobQuery);
    expect(activeJobSql).toContain("FOR UPDATE");
    expect(tx.shift.findMany).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("rejects publishing a shift assigned to inactive staff", async () => {
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-inactive-user",
        userId: "user-inactive",
        user: { deletedAt: new Date("2026-03-01T00:00:00.000Z") },
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
        breaks: [],
      },
    ]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow(
      "Shift shift-inactive-user is assigned to an inactive staff member.",
    );

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("requires an active location when locking a draft for publication", () => {
    const source = readFileSync(
      __filename.replace(
        /schedules\.controller\.spec\.ts$/,
        "schedules.controller.ts",
      ),
      "utf8",
    );
    expect(source).toMatch(/location\."deletedAt" IS NULL/);
  });

  it("rejects publishing a non-draft schedule before reading shifts", async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ set_current_tenant: null }])
      .mockResolvedValueOnce([{ pg_advisory_xact_lock: null }])
      .mockResolvedValueOnce([
        { id: "sch-1", status: "PUBLISHED", locationId: "loc-1" },
      ]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow("Only draft schedules can be published.");

    expect(tx.shift.findMany).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("rejects publishing assigned shifts that overlap", async () => {
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-1",
        userId: "u1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
      },
      {
        id: "shift-2",
        userId: "u1",
        startTime: new Date("2026-03-10T20:00:00.000Z"),
        endTime: new Date("2026-03-10T23:00:00.000Z"),
      },
    ]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow(
      "Resolve overlapping assigned shifts before publishing this schedule.",
    );

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("rejects publishing a shift outside the locked location-local schedule window", async () => {
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-before-local-day",
        userId: "u1",
        startTime: new Date("2026-03-10T06:59:59.000Z"),
        endTime: new Date("2026-03-10T12:00:00.000Z"),
        breaks: [],
      },
    ]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow(
      "Shift shift-before-local-day must stay within its schedule window before publishing.",
    );

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("rejects publishing when configured demand windows are under-covered", async () => {
    persistedDemandRows = [
      {
        id: "demand-1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
        requiredStaff: 2,
        skill: null,
      },
    ];
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-1",
        userId: "u1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
      },
    ]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow(
      "Demand window demand-1 needs 2 assigned staff before publishing.",
    );

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("does not count an employee on break toward publish demand coverage", async () => {
    persistedDemandRows = [
      {
        id: "demand-break-gap",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
        requiredStaff: 1,
        skill: null,
      },
    ];
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-1",
        userId: "u1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
        breaks: [
          {
            startTime: new Date("2026-03-10T19:00:00.000Z"),
            endTime: new Date("2026-03-10T19:30:00.000Z"),
          },
        ],
      },
    ]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow(
      "Demand window demand-break-gap needs 1 assigned staff before publishing.",
    );

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("rejects publishing when demand requires a skill that assigned staff do not have", async () => {
    persistedDemandRows = [
      {
        id: "demand-1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
        requiredStaff: 1,
        skill: "Expo",
      },
    ];
    persistedSkillRows = [{ userId: "u1", skill: "line" }];
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-1",
        userId: "u1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
      },
    ]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow(
      "Demand window demand-1 needs 1 assigned staff with expo before publishing.",
    );

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("rejects publishing assigned shifts outside configured staff availability", async () => {
    persistedAvailabilityRows = [
      {
        userId: "u1",
        dayOfWeek: 2,
        startTimeMinutes: 9 * 60,
        endTimeMinutes: 12 * 60,
      },
    ];
    tx.shift.findMany.mockResolvedValue([
      {
        id: "shift-1",
        userId: "u1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
      },
    ]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }),
    ).rejects.toThrow(
      "Shift shift-1 is outside configured staff availability.",
    );

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("accepts Monday overnight availability through Tuesday 02:00 during publish validation", async () => {
    persistedAvailabilityRows = [
      {
        userId: "u1",
        dayOfWeek: 1,
        startTimeMinutes: 22 * 60,
        endTimeMinutes: 2 * 60,
      },
    ];

    await expect(
      (controller as any).assertAssignedShiftsWithinAvailability(
        tx,
        "tenant-1",
        "loc-1",
        "America/Los_Angeles",
        [
          {
            id: "overnight-1",
            userId: "u1",
            startTime: new Date("2026-03-10T05:00:00.000Z"),
            endTime: new Date("2026-03-10T09:00:00.000Z"),
            breaks: [],
          },
        ],
      ),
    ).resolves.toBeUndefined();
  });

  it("accepts overnight availability across the DST fallback wall-clock interval", async () => {
    persistedAvailabilityRows = [
      {
        userId: "u1",
        dayOfWeek: 6,
        startTimeMinutes: 22 * 60,
        endTimeMinutes: 2 * 60,
      },
    ];

    await expect(
      (controller as any).assertAssignedShiftsWithinAvailability(
        tx,
        "tenant-1",
        "loc-1",
        "America/Los_Angeles",
        [
          {
            id: "dst-overnight-1",
            userId: "u1",
            startTime: new Date("2026-11-01T05:00:00.000Z"),
            endTime: new Date("2026-11-01T10:00:00.000Z"),
            breaks: [],
          },
        ],
      ),
    ).resolves.toBeUndefined();
  });

  it("queues a real schedule solve job for draft schedules", async () => {
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      tenantId: "tenant-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T00:00:00.000Z"),
      endDate: new Date("2026-03-17T00:00:00.000Z"),
      updatedAt: new Date("2026-03-09T20:00:00.000Z"),
      status: "DRAFT",
      location: { timezone: "America/New_York" },
    });
    tx.user.findMany.mockResolvedValue([{ id: "u1" }, { id: "u2" }]);
    const enqueueSolveJob = vi
      .spyOn(controller as any, "enqueueSolveJob")
      .mockResolvedValue(undefined);

    const result = await controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      { constraints: { min_floor_coverage: 1, shift_duration_hours: 8 } },
      "request-queue-1",
    );

    expect(result.status).toBe("QUEUED");
    expect(result.statusUrl).toBe(
      `/v1/schedules/sch-1/auto-schedule/jobs/${result.jobId}`,
    );
    expect(result.jobId).toMatch(/^schedule-sch-1-/);
    expect(featureAccessService.assertFeatureEnabledInTransaction).toHaveBeenCalledWith(
      tx,
      "tenant-1",
      "scheduling",
    );
    expect(
      featureAccessService.consumeCreditsForFeature,
    ).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: `schedule-credit-${result.jobId}`,
        tenantId: "tenant-1",
        amount: -1,
      }),
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const scheduleLockQueryIndex = tx.$queryRaw.mock.calls.findIndex(
      ([query]: [unknown]) => {
        const sql = Array.isArray(query) ? query.join(" ") : String(query);
        return sql.includes('FROM "Schedule"') && sql.includes("FOR UPDATE");
      },
    );
    expect(scheduleLockQueryIndex).toBeGreaterThanOrEqual(0);
    expect(
      tx.$queryRaw.mock.invocationCallOrder[scheduleLockQueryIndex],
    ).toBeLessThan(tx.$executeRaw.mock.invocationCallOrder[0]);
    expect(enqueueSolveJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "schedule.solve",
        job_id: result.jobId,
        payload: {
          schedule_id: "sch-1",
          tenant_id: "tenant-1",
          location_id: "loc-1",
          start_date: "2026-03-10T00:00:00.000Z",
          end_date: "2026-03-17T00:00:00.000Z",
          draft_revision: 0,
          input_shift_snapshot: [],
          staff_ids: ["u1", "u2"],
          constraints: { min_floor_coverage: 1, shift_duration_hours: 8 },
          availability: { u1: [], u2: [] },
          availability_configured: { u1: false, u2: false },
          staff_skills: { u1: [], u2: [] },
          daily_demand: { Tuesday: 1 },
          skill_requirements: {},
          demand_windows: [{
            id: "demand-default",
            start_time: "2026-03-10T16:00:00.000Z",
            end_time: "2026-03-10T20:00:00.000Z",
            required_staff: 1,
            skill: null,
          }],
          timezone: "America/New_York",
          existing_weekly_minutes: {},
          existing_shifts: [],
        },
      }),
    );
    expect(result.reused).toBe(false);
  });

  it("blocks auto-schedule until persisted demand is configured", async () => {
    persistedDemandRows = [];
    autoDemandFallbackEnabled = false;
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      tenantId: "tenant-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      revision: 0,
      status: "DRAFT",
      location: { timezone: "America/Los_Angeles" },
    });

    await expect(controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      { constraints: {} },
      "request-no-demand",
    )).rejects.toThrow("Configure at least one demand window");
  });

  it("replaces tenant-scoped draft demand windows with bounded exact inputs", async () => {
    tx.scheduleDemandWindow.createMany.mockResolvedValue({ count: 1 });
    persistedDemandRows = [{
      id: "demand-saved",
      startTime: new Date("2026-03-10T16:00:00.000Z"),
      endTime: new Date("2026-03-10T20:00:00.000Z"),
      requiredStaff: 2,
      skill: "cashier",
    }];

    const result = await controller.replaceDemandWindows(
      "sch-1",
      { windows: [{
        startTime: "2026-03-10T16:00:00.000Z",
        endTime: "2026-03-10T20:00:00.000Z",
        requiredStaff: 2,
        skill: " Cashier ",
      }] },
      { user: { tenantId: "tenant-1" } },
    );

    expect(tx.scheduleDemandWindow.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", scheduleId: "sch-1" },
    });
    expect(tx.scheduleDemandWindow.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        tenantId: "tenant-1",
        scheduleId: "sch-1",
        locationId: "loc-1",
        requiredStaff: 2,
        skill: "cashier",
      })],
    });
    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sch-1",
        tenantId: "tenant-1",
        locationId: "loc-1",
        status: "DRAFT",
        deletedAt: null,
      },
      data: { revision: { increment: 1 } },
    });
    expect(result.data).toHaveLength(1);
  });

  it("requires an idempotency key before auto-schedule database or billing work", async () => {
    await expect(
      controller.autoSchedule(
        "sch-1",
        { user: { tenantId: "tenant-1" } },
        { constraints: {} },
      ),
    ).rejects.toThrow("Idempotency-Key header is required");

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(
      featureAccessService.consumeCreditsForFeature,
    ).not.toHaveBeenCalled();
  });

  it("canonicalizes auto-schedule request hashes independent of object key order", () => {
    expect(
      autoScheduleRequestHash(
        {
          break_rules: { paid_break_threshold: 20, break_duration: 30 },
          min_floor_coverage: 2,
        },
        true,
      ),
    ).toBe(
      autoScheduleRequestHash(
        {
          min_floor_coverage: 2,
          break_rules: { break_duration: 30, paid_break_threshold: 20 },
        },
        true,
      ),
    );
  });

  it("reuses the durable job after a lost response without charging or queueing twice", async () => {
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      tenantId: "tenant-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T00:00:00.000Z"),
      endDate: new Date("2026-03-17T00:00:00.000Z"),
      updatedAt: new Date("2026-03-09T20:00:00.000Z"),
      status: "DRAFT",
      location: { timezone: "America/New_York" },
    });
    const enqueueSolveJob = vi
      .spyOn(controller as any, "enqueueSolveJob")
      .mockResolvedValue(undefined);
    const body = { constraints: { min_floor_coverage: 1 } };

    const first = await controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      body,
      "lost-response-request",
    );
    const requestHash = autoScheduleRequestHash(body.constraints, false);
    tx.$queryRaw.mockImplementation(async (query: any) => {
      const sql = Array.isArray(query) ? query.join(" ") : String(query);
      if (sql.includes('FROM "ScheduleSolveJob"')) {
        return [
          {
            id: first.jobId,
            scheduleId: "sch-1",
            locationId: "loc-1",
            requestKeyHash: "stored-key-hash",
            requestHash,
            status: "SUCCEEDED",
            statusReason: null,
            retryCount: 0,
            resultShiftCount: 7,
            requestedConstraints: body.constraints,
            staffSnapshot: { staff: [] },
            demandSnapshot: { demand_windows: [] },
            creditConsumption: first.creditConsumption,
            startedAt: new Date("2026-03-10T00:01:00.000Z"),
            completedAt: new Date("2026-03-10T00:02:00.000Z"),
            createdAt: new Date("2026-03-10T00:00:00.000Z"),
            updatedAt: new Date("2026-03-10T00:02:00.000Z"),
          },
        ];
      }
      return [{ set_current_tenant: null }];
    });

    const retry = await controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      body,
      "lost-response-request",
    );

    expect(retry).toEqual(
      expect.objectContaining({
        jobId: first.jobId,
        status: "SUCCEEDED",
        resultShiftCount: 7,
        reused: true,
      }),
    );
    expect(
      featureAccessService.consumeCreditsForFeature,
    ).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).toHaveBeenCalledOnce();
    expect(enqueueSolveJob).toHaveBeenCalledOnce();

    await expect(
      controller.autoSchedule(
        "sch-1",
        { user: { tenantId: "tenant-1" } },
        { constraints: { min_floor_coverage: 2 } },
        "lost-response-request",
      ),
    ).rejects.toThrow("Idempotency-Key was already used with a different");
    expect(
      featureAccessService.consumeCreditsForFeature,
    ).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).toHaveBeenCalledOnce();
    expect(enqueueSolveJob).toHaveBeenCalledOnce();
  });

  it("requires explicit confirmation before replacing nonblank draft shifts", async () => {
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      tenantId: "tenant-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      status: "DRAFT",
      location: { timezone: "America/Los_Angeles" },
    });
    tx.shift.count.mockResolvedValue(2);
    const enqueueSolveJob = vi
      .spyOn(controller as any, "enqueueSolveJob")
      .mockResolvedValue(undefined);

    await expect(
      controller.autoSchedule(
        "sch-1",
        { user: { tenantId: "tenant-1" } },
        { constraints: {} },
        "request-confirm",
      ),
    ).rejects.toThrow("Confirm replacement");

    expect(enqueueSolveJob).not.toHaveBeenCalled();
    expect(
      featureAccessService.consumeCreditsForFeature,
    ).not.toHaveBeenCalled();
  });

  it("snapshots persisted scheduler inputs and sends availability to the worker", async () => {
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      tenantId: "tenant-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T00:00:00.000Z"),
      endDate: new Date("2026-03-17T00:00:00.000Z"),
      updatedAt: new Date("2026-03-09T20:00:00.000Z"),
      status: "DRAFT",
      location: { timezone: "America/New_York" },
    });
    tx.user.findMany.mockResolvedValue([{ id: "u1" }, { id: "u2" }]);
    persistedAvailabilityRows = [
      {
        userId: "u1",
        dayOfWeek: 1,
        startTimeMinutes: 540,
        endTimeMinutes: 1020,
      },
    ];
    persistedSkillRows = [
      { userId: "u1", skill: "expo" },
      { userId: "u1", skill: "line" },
    ];
    persistedDemandRows = [
      {
        id: "demand-1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
        requiredStaff: 2,
        skill: "expo",
      },
    ];
    persistedDraftShiftRows = [
      {
        id: "manual-shift-1",
        updatedAt: new Date("2026-03-09T21:00:00.000Z"),
      },
    ];
    persistedExistingShiftRows = [{
      id: "other-location-shift",
      userId: "u1",
      locationId: "loc-2",
      startTime: new Date("2026-03-10T18:00:00.000Z"),
      endTime: new Date("2026-03-10T20:00:00.000Z"),
    }];
    const enqueueSolveJob = vi
      .spyOn(controller as any, "enqueueSolveJob")
      .mockResolvedValue(undefined);

    const result = await controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      undefined,
      "request-snapshot",
    );

    expect(enqueueSolveJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          schedule_id: "sch-1",
          staff_ids: ["u1", "u2"],
          draft_revision: 0,
          input_shift_snapshot: [
            {
              id: "manual-shift-1",
              updated_at: "2026-03-09T21:00:00.000Z",
            },
          ],
          availability: {
            u1: [
              { day_of_week: "Monday", start_time: "09:00", end_time: "17:00" },
            ],
            u2: [],
          },
          staff_skills: { u1: ["expo", "line"], u2: [] },
          daily_demand: { Tuesday: 2 },
          skill_requirements: { Tuesday: { expo: 2 } },
          demand_windows: [
            {
              id: "demand-1",
              start_time: "2026-03-10T17:00:00.000Z",
              end_time: "2026-03-10T21:00:00.000Z",
              required_staff: 2,
              skill: "expo",
            },
          ],
          timezone: "America/New_York",
          existing_shifts: [{
            id: "other-location-shift",
            staff_id: "u1",
            location_id: "loc-2",
            start_time: "2026-03-10T18:00:00.000Z",
            end_time: "2026-03-10T20:00:00.000Z",
          }],
          existing_weekly_minutes: { u1: { "2026-03-09": 120 } },
        }),
      }),
    );
    const insertCall = tx.$executeRaw.mock.calls[0];
    expect(Array.from(insertCall[0]).join(" ")).toContain('"staffSnapshot"');
    expect(Array.from(insertCall[0]).join(" ")).toContain('"demandSnapshot"');
    const parsedJsonParams = insertCall
      .slice(1)
      .filter(
        (value: unknown): value is string =>
          typeof value === "string" && value.startsWith("{"),
      )
      .map((value: string) => JSON.parse(value));
    expect(parsedJsonParams).toContainEqual({
      staff: [
        {
          id: "u1",
          skills: ["expo", "line"],
          availabilityConfigured: true,
          availability: [
            { day_of_week: "Monday", start_time: "09:00", end_time: "17:00" },
          ],
        },
        { id: "u2", skills: [], availabilityConfigured: false, availability: [] },
      ],
    });
    expect(parsedJsonParams).toContainEqual({
      demand_windows: [
        {
          id: "demand-1",
          start_time: "2026-03-10T17:00:00.000Z",
          end_time: "2026-03-10T21:00:00.000Z",
          required_staff: 2,
          skill: "expo",
        },
      ],
    });
    expect(result.status).toBe("QUEUED");
  });

  it("sends explicit empty availability so unconfigured staff are not treated as unrestricted", async () => {
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      tenantId: "tenant-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T00:00:00.000Z"),
      endDate: new Date("2026-03-17T00:00:00.000Z"),
      updatedAt: new Date("2026-03-09T20:00:00.000Z"),
      status: "DRAFT",
      location: { timezone: "America/New_York" },
    });
    tx.user.findMany.mockResolvedValue([{ id: "u1" }, { id: "u2" }]);
    persistedAvailabilityRows = [];
    persistedDemandRows = [{
      id: "demand-1",
      startTime: new Date("2026-03-10T17:00:00.000Z"),
      endTime: new Date("2026-03-10T21:00:00.000Z"),
      requiredStaff: 1,
      skill: null,
    }];
    const enqueueSolveJob = vi.spyOn(controller as any, "enqueueSolveJob").mockResolvedValue(undefined);

    await controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      undefined,
      "request-explicit-empty-availability",
    );

    expect(enqueueSolveJob).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        availability: { u1: [], u2: [] },
        availability_configured: { u1: false, u2: false },
      }),
    }));
  });

  it("rejects publishing an assigned shift with no applicable configured availability", async () => {
    persistedAvailabilityRows = [];

    await expect((controller as any).assertAssignedShiftsWithinAvailability(
      tx,
      "tenant-1",
      "loc-1",
      "America/Los_Angeles",
      [{
        id: "shift-no-availability",
        userId: "u1",
        startTime: new Date("2026-03-10T17:00:00.000Z"),
        endTime: new Date("2026-03-10T21:00:00.000Z"),
        breaks: [],
      }],
    )).rejects.toThrow("no applicable configured availability");
  });

  it("rejects publish when active tenant shifts exceed the local Monday weekly limit", async () => {
    persistedExistingShiftRows = [{
      id: "other-active-shift",
      userId: "u1",
      locationId: "loc-2",
      startTime: new Date("2026-03-09T08:00:00.000Z"),
      endTime: new Date("2026-03-10T19:00:00.000Z"),
    }];

    await expect((controller as any).assertMaxWeeklyHoursAtPublish(
      tx,
      "tenant-1",
      "sch-1",
      "America/Los_Angeles",
      [{
        id: "candidate-shift",
        userId: "u1",
        startTime: new Date("2026-03-11T16:00:00.000Z"),
        endTime: new Date("2026-03-11T22:00:00.000Z"),
        breaks: [],
      }],
    )).rejects.toThrow("week starting 2026-03-09");

    const lockedHoursQuery = tx.$queryRaw.mock.calls.find(([query]: [unknown]) => {
      const sql = Array.isArray(query) ? query.join(" ") : String(query);
      return sql.includes('LEFT JOIN "Schedule" source_schedule') && sql.includes("FOR UPDATE OF shift");
    });
    expect(lockedHoursQuery).toBeTruthy();
  });

  it("reuses a different-key nonterminal schedule job before charging", async () => {
    const activeJob = {
      id: "job-active",
      scheduleId: "sch-1",
      locationId: "loc-1",
      requestKeyHash: "other-key",
      requestHash: "other-request",
      status: "RUNNING",
      statusReason: null,
      retryCount: 0,
      resultShiftCount: null,
      requestedConstraints: {},
      staffSnapshot: { staff: [] },
      demandSnapshot: { demand_windows: [] },
      creditConsumption: { consumedCredits: 1, newBalance: 4 },
      publicationStatus: "PUBLISHED",
      publishAttempts: 1,
      nextPublishAt: new Date("2026-03-10T00:00:00.000Z"),
      publishedAt: new Date("2026-03-10T00:00:00.000Z"),
      publishLastError: null,
      startedAt: new Date("2026-03-10T00:00:00.000Z"),
      completedAt: null,
      createdAt: new Date("2026-03-10T00:00:00.000Z"),
      updatedAt: new Date("2026-03-10T00:00:00.000Z"),
    };
    tx.$queryRaw.mockImplementation(async (query: any) => {
      const sql = Array.isArray(query) ? query.join(" ") : String(query);
      if (sql.includes('FROM "Schedule"') && sql.includes("FOR UPDATE")) {
        return [{ id: "sch-1", status: "DRAFT" }];
      }
      if (sql.includes('FROM "ScheduleSolveJob"') && sql.includes('"requestKeyHash" =')) return [];
      if (sql.includes('FROM "ScheduleSolveJob"') && sql.includes('"status" NOT IN')) return [activeJob];
      return [{ set_current_tenant: null }];
    });
    const enqueueSolveJob = vi.spyOn(controller as any, "enqueueSolveJob").mockResolvedValue(undefined);

    const result = await controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      { constraints: {} },
      "new-browser-attempt",
    );

    expect(result).toEqual(expect.objectContaining({
      jobId: "job-active",
      status: "RUNNING",
      reused: true,
    }));
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    expect(enqueueSolveJob).not.toHaveBeenCalled();
  });

  it("includes cross-location existing hours from the full local calendar week for a midweek solve", async () => {
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      tenantId: "tenant-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-11T07:00:00.000Z"),
      endDate: new Date("2026-03-18T07:00:00.000Z"),
      updatedAt: new Date("2026-03-10T20:00:00.000Z"),
      status: "DRAFT",
      location: { timezone: "America/Los_Angeles" },
    });
    tx.user.findMany.mockResolvedValue([{ id: "u1" }, { id: "u2" }]);
    persistedExistingShiftRows = [
      {
        userId: "u1",
        locationId: "loc-2",
        startTime: new Date("2026-03-09T16:00:00.000Z"),
        endTime: new Date("2026-03-09T20:00:00.000Z"),
      },
    ];
    const enqueueSolveJob = vi
      .spyOn(controller as any, "enqueueSolveJob")
      .mockResolvedValue(undefined);

    await controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      undefined,
      "request-existing-hours",
    );

    expect(enqueueSolveJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          timezone: "America/Los_Angeles",
          existing_weekly_minutes: {
            u1: { "2026-03-09": 240 },
          },
        }),
      }),
    );
    const existingHoursQuery = tx.$queryRaw.mock.calls.find(
      ([query]: [unknown]) => {
        const sql = Array.isArray(query) ? query.join(" ") : String(query);
        return sql.includes('LEFT JOIN "Schedule" source_schedule');
      },
    );
    expect(Array.from(existingHoursQuery[0]).join(" ")).toContain(
      'shift."scheduleId" <>',
    );
    expect(Array.from(existingHoursQuery[0]).join(" ")).not.toContain(
      'shift."locationId" =',
    );
  });

  it("returns tenant-scoped auto-schedule job status", async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ set_current_tenant: null }])
      .mockResolvedValueOnce([
        {
          id: "job-1",
          scheduleId: "sch-1",
          locationId: "loc-1",
          status: "SUCCEEDED",
          statusReason: null,
          retryCount: 1,
          resultShiftCount: 12,
          requestedConstraints: { min_floor_coverage: 1 },
          staffSnapshot: {
            staff: [{ id: "u1", skills: ["expo"], availability: [] }],
          },
          demandSnapshot: { demand_windows: [] },
          creditConsumption: { consumedCredits: 1, newBalance: 4 },
          publicationStatus: "PUBLISHED",
          publishAttempts: 1,
          nextPublishAt: new Date("2026-03-10T00:00:00.000Z"),
          publishedAt: new Date("2026-03-10T00:00:01.000Z"),
          publishLastError: null,
          startedAt: new Date("2026-03-10T00:01:00.000Z"),
          completedAt: new Date("2026-03-10T00:02:00.000Z"),
          createdAt: new Date("2026-03-10T00:00:00.000Z"),
          updatedAt: new Date("2026-03-10T00:02:00.000Z"),
        },
      ]);

    const result = await controller.findAutoScheduleJob("sch-1", "job-1", {
      user: { tenantId: "tenant-1" },
    });

    expect(result).toEqual({
      jobId: "job-1",
      scheduleId: "sch-1",
      locationId: "loc-1",
      status: "SUCCEEDED",
      statusReason: null,
      retryCount: 1,
      resultShiftCount: 12,
      requestedConstraints: { min_floor_coverage: 1 },
      staffSnapshot: {
        staff: [{ id: "u1", skills: ["expo"], availability: [] }],
      },
      demandSnapshot: { demand_windows: [] },
      creditConsumption: { consumedCredits: 1, newBalance: 4 },
      publicationStatus: "PUBLISHED",
      publishAttempts: 1,
      nextPublishAt: "2026-03-10T00:00:00.000Z",
      publishedAt: "2026-03-10T00:00:01.000Z",
      publishLastError: null,
      startedAt: "2026-03-10T00:01:00.000Z",
      completedAt: "2026-03-10T00:02:00.000Z",
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: "2026-03-10T00:02:00.000Z",
    });
  });

  it("leaves a committed charged outbox job recoverable when immediate queueing fails", async () => {
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      tenantId: "tenant-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T00:00:00.000Z"),
      endDate: new Date("2026-03-17T00:00:00.000Z"),
      updatedAt: new Date("2026-03-09T20:00:00.000Z"),
      status: "DRAFT",
      location: { timezone: "America/New_York" },
    });
    const publishPendingNow = vi
      .spyOn((controller as any).scheduleOutbox, "publishPendingNow")
      .mockRejectedValue(new Error("rabbitmq down"));

    const result = await controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      undefined,
      "request-queue-failure",
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: "QUEUED",
        publicationStatus: "PENDING",
        creditConsumption: {
          consumedCredits: 1,
          newBalance: 0,
          source: "credits",
        },
      }),
    );
    expect(publishPendingNow).toHaveBeenCalledWith(result.jobId);
    expect(tx.creditTransaction.create).toHaveBeenCalledOnce();
    expect(meteringService.grantCredits).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("publishes schedule solve jobs with RabbitMQ confirms", () => {
    const source = readFileSync(
      __filename.replace(
        /schedules\.controller\.spec\.ts$/,
        "schedule-solve-outbox.publisher.ts",
      ),
      "utf8",
    );

    expect(source).toMatch(/createConfirmChannel\(\)/);
    expect(source).toMatch(/waitForConfirms\(\)/);
    expect(source).toMatch(/persistent: true/);
    expect(source).toMatch(/messageId: publication\.id/);
    expect(source).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(source).toMatch(/"publishLeaseUntil" <=/);
  });

  it("rejects auto-schedule when there is no schedulable staff", async () => {
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T00:00:00.000Z"),
      endDate: new Date("2026-03-17T00:00:00.000Z"),
      status: "DRAFT",
    });
    tx.user.findMany.mockResolvedValue([]);
    const enqueueSolveJob = vi
      .spyOn(controller as any, "enqueueSolveJob")
      .mockResolvedValue(undefined);

    await expect(
      controller.autoSchedule(
        "sch-1",
        { user: { tenantId: "tenant-1" } },
        undefined,
        "request-no-staff",
      ),
    ).rejects.toThrow("Add at least one schedulable staff member");

    expect(enqueueSolveJob).not.toHaveBeenCalled();
    expect(
      featureAccessService.consumeCreditsForFeature,
    ).not.toHaveBeenCalled();
  });

  it("rejects auto-schedule for published schedules before enqueueing", async () => {
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      locationId: "loc-1",
      startDate: new Date("2026-03-10T00:00:00.000Z"),
      endDate: new Date("2026-03-17T00:00:00.000Z"),
      status: "PUBLISHED",
    });
    const enqueueSolveJob = vi
      .spyOn(controller as any, "enqueueSolveJob")
      .mockResolvedValue(undefined);

    await expect(
      controller.autoSchedule(
        "sch-1",
        { user: { tenantId: "tenant-1" } },
        undefined,
        "request-published",
      ),
    ).rejects.toThrow("Only draft schedules can be auto-scheduled.");

    expect(enqueueSolveJob).not.toHaveBeenCalled();
    expect(
      featureAccessService.consumeCreditsForFeature,
    ).not.toHaveBeenCalled();
  });
});
