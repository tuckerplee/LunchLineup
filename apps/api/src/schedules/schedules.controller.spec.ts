import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { readFileSync } from "fs";
import { SchedulesController } from "./schedules.controller";
import { NotificationType } from "../notifications/notifications.service";
import { TenantPrismaService } from "../database/tenant-prisma.service";
import { autoScheduleRequestHash } from "./auto-schedule-idempotency";
import { schedulePublishOperationId, schedulePublishRequestHash } from "./schedule-publish-idempotency";
import { decodeBoundedListCursor } from "../common/bounded-pagination";

const publishBody = (overrides: Record<string, number> = {}) => ({
  acceptedContract: {
    version: 0,
    totalConfiguredCost: 1,
    scheduleCost: 1,
    matchingWebhookDeliveryCount: 0,
    matchingWebhookDeliveryUnitCost: 0,
    matchingWebhookDeliveryCost: 0,
    ...overrides,
  },
});

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
  let persistedSolveDebitRows: any[];
  let lockedScheduleStatus: string | null;
  let lockedScheduleRevision: number;
  let activeLocation: { id: string; timezone: string } | null;
  let autoDemandFallbackEnabled: boolean;

  beforeEach(() => {
    notificationsService = {
      enqueueInTransaction: vi.fn().mockResolvedValue(undefined),
      deliverPendingNow: vi.fn().mockResolvedValue({
        status: "DELIVERED",
        delivered: 2,
        pending: 0,
        failed: 0,
      }),
      send: vi.fn().mockResolvedValue({ id: "notification-1" }),
      sendMany: vi.fn().mockResolvedValue([]),
    };
    featureAccessService = {
      assertFeatureEnabled: vi.fn().mockResolvedValue(undefined),
      assertFeatureEnabledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: "credits", creditCost: 1, reason: "Billable" }),
      assertFeatureEntitledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: "credits", creditCost: 1, reason: "Billable" }),
      lockTenantInTransaction: vi.fn().mockResolvedValue(undefined),
      recordFeatureUsageInTransaction: vi.fn().mockResolvedValue({ consumedCredits: 1, newBalance: 0 }),
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
    };
    meteringService = {
      grantCredits: vi.fn().mockResolvedValue(1),
    };
    webhooksService = {
      preflightEventInTransaction: vi.fn().mockResolvedValue({
        tenantId: "tenant-1",
        eventType: "schedule.published",
        matchingDeliveryCount: 0,
        unitCost: 0,
        totalConfiguredCost: 0,
        entitlement: null,
        endpoints: [],
      }),
      enqueueEventInTransaction: vi.fn().mockResolvedValue({
        matchingDeliveryCount: 0,
        unitCost: 0,
        totalConfiguredCost: 0,
        deliveries: [],
      }),
    };
    persistedAvailabilityRows = [];
    persistedSkillRows = [];
    persistedDemandRows = [];
    persistedDraftShiftRows = [];
    persistedExistingShiftRows = [];
    persistedSolveJobRows = [];
    persistedSolveDebitRows = [];
    lockedScheduleStatus = "DRAFT";
    lockedScheduleRevision = 0;
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
                  revision: lockedScheduleRevision,
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
        if (sql.includes('FROM "CreditTransaction"') && sql.includes("FOR UPDATE")) {
          return persistedSolveDebitRows;
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
      tenant: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ usageCredits: 1 }),
      },
      webhookEndpoint: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      auditLog: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "audit-1" }),
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

  it.each([
    {
      name: "schedule creation",
      mutate: () => controller.create({
        locationId: "loc-1",
        startDate: "2026-03-10T00:00:00.000Z",
        endDate: "2026-03-17T00:00:00.000Z",
      }, { user: { tenantId: "tenant-1" } }),
    },
    {
      name: "demand-window replacement",
      mutate: () => controller.replaceDemandWindows("sch-1", { windows: [] }, { user: { tenantId: "tenant-1" } }),
    },
    {
      name: "schedule deletion",
      mutate: () => controller.remove("sch-1", { user: { tenantId: "tenant-1" } }),
    },
    {
      name: "schedule publication",
      mutate: () => controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
    },
    {
      name: "schedule reopen",
      mutate: () => controller.reopen("sch-1", { user: { tenantId: "tenant-1" } }),
    },
  ])("denies $name from inside its write transaction when entitlement changes", async ({ name, mutate }) => {
    const rejection = new ForbiddenException("Subscription inactive or credits exhausted");
    featureAccessService.assertFeatureEnabledInTransaction.mockRejectedValue(rejection);
    featureAccessService.assertFeatureEntitledInTransaction.mockRejectedValue(rejection);

    await expect(mutate()).rejects.toBeInstanceOf(ForbiddenException);

    expect(featureAccessService.assertFeatureEntitledInTransaction).toHaveBeenCalledWith(
      tx,
      "tenant-1",
      "scheduling",
    );
    expect(featureAccessService.assertFeatureEnabled).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(name === "schedule publication" ? 2 : 1);
    expect(tx.schedule.create).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    expect(tx.schedule.deleteMany).not.toHaveBeenCalled();
    expect(tx.scheduleDemandWindow.deleteMany).not.toHaveBeenCalled();
    expect(notificationsService.enqueueInTransaction).not.toHaveBeenCalled();
  });

  it("allows a zero-credit paid tenant to reopen a schedule without ledger mutation", async () => {
    lockedScheduleStatus = "PUBLISHED";
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });
    featureAccessService.assertFeatureEnabledInTransaction.mockRejectedValue(
      new ForbiddenException("Insufficient usage credits balance."),
    );

    await expect(controller.reopen(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
    )).resolves.toEqual({ id: "sch-1", status: "DRAFT", publishedAt: null });

    expect(featureAccessService.assertFeatureEntitledInTransaction).toHaveBeenCalledWith(
      tx,
      "tenant-1",
      "scheduling",
    );
    expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
    expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
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
    expect(tx.schedule.findFirst).not.toHaveBeenCalled();
    expect(tx.shift.count).not.toHaveBeenCalled();
    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(enqueueSolveJob).not.toHaveBeenCalled();
  });

  it("rejects 'zero-cost credit entitlement' before creating billable auto-schedule work", async () => {
    featureAccessService.assertFeatureEnabledInTransaction.mockResolvedValue({
      enabled: true, source: "credits", creditCost: 0, reason: "invalid",
    });
    const enqueueSolveJob = vi.spyOn(controller as any, "enqueueSolveJob");
    await expect(controller.autoSchedule(
      "sch-1", { user: { tenantId: "tenant-1" } }, undefined, "request-zero-cost",
    )).rejects.toThrow(
      "Auto-scheduling requires an active paid subscription and separately purchased usage credits.",
    );
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    expect(enqueueSolveJob).not.toHaveBeenCalled();
  });

  it("rejects 'missing-cost credit entitlement' before creating billable auto-schedule work", async () => {
    featureAccessService.assertFeatureEnabledInTransaction.mockResolvedValue({
      enabled: true, source: "credits", reason: "invalid",
    });
    const enqueueSolveJob = vi.spyOn(controller as any, "enqueueSolveJob");
    await expect(controller.autoSchedule(
      "sch-1", { user: { tenantId: "tenant-1" } }, undefined, "request-missing-cost",
    )).rejects.toThrow(
      "Auto-scheduling requires an active paid subscription and separately purchased usage credits.",
    );
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    expect(enqueueSolveJob).not.toHaveBeenCalled();
  });

  it("scopes staff schedule list reads to schedules containing their shifts", async () => {
    tx.schedule.findMany.mockResolvedValue([{ id: "sch-1" }]);

    const result = await controller.findAll({
      user: { tenantId: "tenant-1", sub: "staff-1", legacyRole: "STAFF" },
    });

    expect(tx.schedule.findMany).toHaveBeenCalledWith({
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      take: 101,
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
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      take: 101,
      where: expect.objectContaining({
        status: "PUBLISHED",
        shifts: { some: expect.objectContaining({ userId: "staff-1" }) },
      }),
    });
  });

  it("bounds overlapping schedule windows and continues with a descending keyset cursor", async () => {
    const rows = [
      { id: "sch-3", startDate: new Date("2026-03-11T07:00:00.000Z") },
      { id: "sch-2", startDate: new Date("2026-03-10T07:00:00.000Z") },
      { id: "sch-1", startDate: new Date("2026-03-09T07:00:00.000Z") },
    ];
    tx.schedule.findMany.mockResolvedValueOnce(rows);

    const firstPage = await controller.findAll(
      { user: { tenantId: "tenant-1", role: "MANAGER" } },
      {
        locationId: "loc-1",
        startDate: "2026-03-09T07:00:00.000Z",
        endDate: "2026-03-17T07:00:00.000Z",
        limit: "2",
      },
    );

    expect(tx.schedule.findMany).toHaveBeenLastCalledWith({
      where: {
        tenantId: "tenant-1",
        deletedAt: null,
        location: { is: { deletedAt: null } },
        locationId: "loc-1",
        AND: [
          { endDate: { gt: new Date("2026-03-09T07:00:00.000Z") } },
          { startDate: { lt: new Date("2026-03-17T07:00:00.000Z") } },
        ],
      },
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      take: 3,
    });
    expect(firstPage.data.map((schedule: any) => schedule.id)).toEqual(["sch-3", "sch-2"]);
    expect(firstPage.pagination).toEqual(expect.objectContaining({
      limit: 2,
      maxLimit: 200,
      returned: 2,
      hasMore: true,
      nextCursor: expect.any(String),
    }));
    expect(decodeBoundedListCursor(firstPage.pagination.nextCursor)).toEqual({
      timestamp: rows[1].startDate,
      id: "sch-2",
    });

    tx.schedule.findMany.mockResolvedValueOnce([]);
    await controller.findAll(
      { user: { tenantId: "tenant-1", role: "MANAGER" } },
      {
        startDate: "2026-03-09T07:00:00.000Z",
        endDate: "2026-03-17T07:00:00.000Z",
        limit: "2",
        cursor: firstPage.pagination.nextCursor,
      },
    );
    expect(tx.schedule.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([{
          OR: [
            { startDate: { lt: rows[1].startDate } },
            { startDate: rows[1].startDate, id: { lt: "sch-2" } },
          ],
        }]),
      }),
      take: 3,
    }));
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
    }, "schedule-publish-test", publishBody());

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(6);
    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sch-1",
        tenantId: "tenant-1",
        status: "DRAFT",
        deletedAt: null,
      },
      data: { status: "PUBLISHED", publishedAt: expect.any(Date) },
    });
    expect(notificationsService.enqueueInTransaction).toHaveBeenCalledWith(
      tx,
      [
        {
          tenantId: "tenant-1",
          userId: "u1",
          dedupeKey: "schedule-published:sch-1:revision-0:u1",
          type: NotificationType.SCHEDULE_PUBLISHED,
          title: "Schedule published",
          body: "Downtown Bistro: Mar 10, 2026 to Mar 16, 2026",
        },
        {
          tenantId: "tenant-1",
          userId: "u2",
          dedupeKey: "schedule-published:sch-1:revision-0:u2",
          type: NotificationType.SCHEDULE_PUBLISHED,
          title: "Schedule published",
          body: "Downtown Bistro: Mar 10, 2026 to Mar 16, 2026",
        },
      ],
    );
    expect(notificationsService.deliverPendingNow).toHaveBeenCalledWith(
      "tenant-1",
      [
        "schedule-published:sch-1:revision-0:u1",
        "schedule-published:sch-1:revision-0:u2",
      ],
    );
    expect(notificationsService.send).not.toHaveBeenCalled();
    expect(result.status).toBe("PUBLISHED");
    expect(result.settlement).toEqual({
      totalConfiguredCost: 1,
      scheduleCost: 1,
      matchingWebhookDeliveryCount: 0,
      matchingWebhookDeliveryUnitCost: 0,
      matchingWebhookDeliveryCost: 0,
      acceptedContract: publishBody().acceptedContract,
      creditsConsumed: 1,
      newBalance: 0,
      ledgerIdentities: {
        schedule: expect.stringMatching(/^feature-usage-schedule-publish:/),
        webhookDeliveries: [],
      },
    });
    expect(result.notifications).toEqual({
      status: "DELIVERED",
      delivered: 2,
      pending: 0,
      failed: 0,
    });
  });

  it("requires Idempotency-Key before opening a publish transaction", async () => {
    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, undefined, publishBody()),
    ).rejects.toThrow("Idempotency-Key header is required");

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
  });

  it("binds the accepted schedule version and aggregate cost plan into the request hash", () => {
    const original = publishBody().acceptedContract;
    const originalHash = schedulePublishRequestHash("tenant-1", "sch-1", original);

    for (const changed of [
      { ...original, version: 1 },
      {
        ...original,
        totalConfiguredCost: 2,
        matchingWebhookDeliveryCount: 1,
        matchingWebhookDeliveryUnitCost: 1,
        matchingWebhookDeliveryCost: 1,
      },
    ]) {
      expect(schedulePublishRequestHash("tenant-1", "sch-1", changed)).not.toBe(originalHash);
    }
  });

  it("replays a committed schedule publish without another debit or durable enqueue", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      revision: 0,
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      location: { name: "Downtown Bistro", timezone: "America/Los_Angeles" },
    });
    tx.shift.findMany.mockResolvedValue([{
      id: "shift-1",
      userId: "u1",
      startTime: new Date("2026-03-10T17:00:00.000Z"),
      endTime: new Date("2026-03-10T21:00:00.000Z"),
    }]);
    const req = { user: { tenantId: "tenant-1", sub: "manager-1" } };
    const key = "schedule-publish-retry-1";

    const first = await controller.publish("sch-1", req, key, publishBody());
    const stored = tx.auditLog.create.mock.calls[0][0].data.newValue;
    tx.auditLog.findFirst.mockResolvedValue({ newValue: stored });

    const replay = await controller.publish("sch-1", req, key, publishBody());

    expect(replay).toEqual(first);
    expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
    expect(webhooksService.enqueueEventInTransaction).toHaveBeenCalledOnce();
    expect(notificationsService.enqueueInTransaction).toHaveBeenCalledOnce();
    expect(tx.schedule.updateMany).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SCHEDULE_PUBLISH",
        resource: "SchedulePublishRequest",
        resourceId: schedulePublishOperationId("tenant-1", "sch-1", key),
        newValue: expect.objectContaining({
          requestHash: schedulePublishRequestHash("tenant-1", "sch-1", publishBody().acceptedContract),
          acceptedContract: publishBody().acceptedContract,
          response: expect.objectContaining({
            settlement: first.settlement,
          }),
        }),
      }),
    });
  });

  it("does not enqueue webhook, notification, or audit records when the publish debit fails", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      revision: 0,
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      location: { name: "Downtown Bistro", timezone: "America/Los_Angeles" },
    });
    tx.shift.findMany.mockResolvedValue([{
      id: "shift-1",
      userId: "u1",
      startTime: new Date("2026-03-10T17:00:00.000Z"),
      endTime: new Date("2026-03-10T21:00:00.000Z"),
    }]);
    featureAccessService.recordFeatureUsageInTransaction.mockRejectedValue(new Error("debit failed"));

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-debit-failure", publishBody()),
    ).rejects.toThrow("debit failed");

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    expect(webhooksService.enqueueEventInTransaction).not.toHaveBeenCalled();
    expect(notificationsService.enqueueInTransaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("uses a new notification identity when a corrected schedule is reopened and republished", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      location: { name: "Downtown Bistro", timezone: "America/Los_Angeles" },
    });
    tx.shift.findMany.mockResolvedValue([{
      id: "shift-1",
      userId: "u1",
      startTime: new Date("2026-03-10T17:00:00.000Z"),
      endTime: new Date("2026-03-10T21:00:00.000Z"),
    }]);
    await controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody());
    lockedScheduleStatus = "PUBLISHED";
    await controller.reopen("sch-1", { user: { tenantId: "tenant-1" } });
    lockedScheduleStatus = "DRAFT";
    lockedScheduleRevision = 1;
    await controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody({ version: 1 }));
    const publicationKeys = notificationsService.enqueueInTransaction.mock.calls
      .map((call: any[]) => call[1][0].dedupeKey);
    expect(publicationKeys).toEqual([
      "schedule-published:sch-1:revision-0:u1",
      "schedule-published:sch-1:revision-1:u1",
    ]);
    expect(new Set(publicationKeys).size).toBe(2);
  });

  it("transactionally enqueues schedule.published for entitled tenant endpoints", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    const webhookEntitlement = {
      enabled: true,
      source: "credits",
      creditCost: 1,
      reason: "Credit available",
    };
    const webhookCostPlan = {
      tenantId: "tenant-1",
      eventType: "schedule.published",
      matchingDeliveryCount: 2,
      unitCost: 1,
      totalConfiguredCost: 2,
      entitlement: webhookEntitlement,
      endpoints: [
        { id: "endpoint-1", url: "https://one.example.com/events" },
        { id: "endpoint-2", url: "https://two.example.com/events" },
      ],
    };
    featureAccessService.assertFeatureEntitledInTransaction.mockResolvedValue(webhookEntitlement);
    tx.webhookEndpoint.findMany.mockResolvedValue(webhookCostPlan.endpoints);
    webhooksService.enqueueEventInTransaction.mockResolvedValue({
      matchingDeliveryCount: 2,
      unitCost: 1,
      totalConfiguredCost: 2,
      deliveries: [
        { deliveryId: "delivery-1", consumedCredits: 1, newBalance: 3 },
        { deliveryId: "delivery-2", consumedCredits: 1, newBalance: 2 },
      ],
    });
    tx.tenant.findUniqueOrThrow.mockResolvedValue({ usageCredits: 5 });
    featureAccessService.recordFeatureUsageInTransaction.mockResolvedValue({ consumedCredits: 1, newBalance: 4 });
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      revision: 0,
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

    const preflight = await controller.publishPreflight("sch-1", { user: { tenantId: "tenant-1" } });
    const result = await controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody({
      totalConfiguredCost: 3,
      matchingWebhookDeliveryCount: 2,
      matchingWebhookDeliveryUnitCost: 1,
      matchingWebhookDeliveryCost: 2,
    }));

    expect(preflight).toEqual({
      scheduleId: "sch-1",
      totalConfiguredCost: 3,
      scheduleCost: 1,
      matchingWebhookDeliveryCount: 2,
      matchingWebhookDeliveryUnitCost: 1,
      matchingWebhookDeliveryCost: 2,
      acceptedContract: publishBody({
        totalConfiguredCost: 3,
        matchingWebhookDeliveryCount: 2,
        matchingWebhookDeliveryUnitCost: 1,
        matchingWebhookDeliveryCost: 2,
      }).acceptedContract,
      availableCredits: 5,
      sufficientCredits: true,
    });

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
      webhookCostPlan,
    );
    expect(result.settlement).toEqual({
      totalConfiguredCost: 3,
      scheduleCost: 1,
      matchingWebhookDeliveryCount: 2,
      matchingWebhookDeliveryUnitCost: 1,
      matchingWebhookDeliveryCost: 2,
      acceptedContract: publishBody({
        totalConfiguredCost: 3,
        matchingWebhookDeliveryCount: 2,
        matchingWebhookDeliveryUnitCost: 1,
        matchingWebhookDeliveryCost: 2,
      }).acceptedContract,
      creditsConsumed: 3,
      newBalance: 2,
      ledgerIdentities: {
        schedule: expect.stringMatching(/^feature-usage-schedule-publish:/),
        webhookDeliveries: [
          { deliveryId: "delivery-1", ledgerId: "feature-usage-webhook-delivery:delivery-1" },
          { deliveryId: "delivery-2", ledgerId: "feature-usage-webhook-delivery:delivery-2" },
        ],
      },
    });
  });

  it("returns a complete publish preflight for a zero-credit paid tenant", async () => {
    tx.schedule.findFirst.mockResolvedValue({ id: "sch-1", revision: 7 });
    tx.tenant.findUniqueOrThrow.mockResolvedValue({ usageCredits: 0 });

    await expect(controller.publishPreflight("sch-1", {
      user: { tenantId: "tenant-1" },
    })).resolves.toEqual({
      scheduleId: "sch-1",
      totalConfiguredCost: 1,
      scheduleCost: 1,
      matchingWebhookDeliveryCount: 0,
      matchingWebhookDeliveryUnitCost: 0,
      matchingWebhookDeliveryCost: 0,
      acceptedContract: publishBody({ version: 7 }).acceptedContract,
      availableCredits: 0,
      sufficientCredits: false,
    });

    expect(featureAccessService.assertFeatureEntitledInTransaction).toHaveBeenCalledWith(
      tx,
      "tenant-1",
      "scheduling",
    );
    expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("requires reconfirmation on version or aggregate-cost drift before any debit or write", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    lockedScheduleRevision = 1;
    tx.tenant.findUniqueOrThrow.mockResolvedValue({ usageCredits: 10 });
    tx.webhookEndpoint.findMany.mockResolvedValue([
      { id: "endpoint-1", url: "https://one.example.com/events" },
    ]);
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      revision: 1,
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      location: { name: "Downtown Bistro", timezone: "America/Los_Angeles" },
    });
    tx.shift.findMany.mockResolvedValue([{
      id: "shift-1",
      userId: "u1",
      startTime: new Date("2026-03-10T17:00:00.000Z"),
      endTime: new Date("2026-03-10T21:00:00.000Z"),
    }]);

    await expect(controller.publish(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      "schedule-publish-stale-contract",
      publishBody(),
    )).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining("changed after confirmation"),
        preflight: expect.objectContaining({
          scheduleId: "sch-1",
          acceptedContract: expect.objectContaining({
            version: 1,
            totalConfiguredCost: 2,
            matchingWebhookDeliveryCount: 1,
          }),
        }),
      }),
    });

    expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    expect(webhooksService.enqueueEventInTransaction).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    expect(notificationsService.enqueueInTransaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects insufficient aggregate publish credits before mutation or settlement", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    tx.tenant.findUniqueOrThrow.mockResolvedValue({ usageCredits: 2 });
    tx.webhookEndpoint.findMany.mockResolvedValue([
      { id: "endpoint-1", url: "https://one.example.com/events" },
      { id: "endpoint-2", url: "https://two.example.com/events" },
    ]);
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      revision: 0,
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      location: { name: "Downtown Bistro", timezone: "America/Los_Angeles" },
    });
    tx.shift.findMany.mockResolvedValue([{
      id: "shift-1",
      userId: "u1",
      startTime: new Date("2026-03-10T17:00:00.000Z"),
      endTime: new Date("2026-03-10T21:00:00.000Z"),
    }]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "stacked-cost-insufficient", publishBody({
        totalConfiguredCost: 3,
        matchingWebhookDeliveryCount: 2,
        matchingWebhookDeliveryUnitCost: 1,
        matchingWebhookDeliveryCost: 2,
      })),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        preflight: expect.objectContaining({
          totalConfiguredCost: 3,
          availableCredits: 2,
          sufficientCredits: false,
        }),
      }),
    });

    expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    expect(webhooksService.enqueueEventInTransaction).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    expect(notificationsService.enqueueInTransaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rolls back schedule publication when the transactional webhook outbox insert fails", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    featureAccessService.resolveTenantFeatures.mockResolvedValue({
      usageCredits: 5,
      features: {
        scheduling: {
          enabled: true,
          source: "credits",
          creditCost: 1,
          reason: "Credit available",
        },
        webhooks: {
          enabled: true,
          source: "credits",
          creditCost: 1,
          reason: "Credit available",
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
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
    ).rejects.toThrow("outbox unavailable");

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
    expect(notificationsService.send).not.toHaveBeenCalled();
  });

  it("rolls back publication when notification intents cannot commit", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 2, startTimeMinutes: 0, endTimeMinutes: 1439 },
    ];
    tx.schedule.updateMany.mockResolvedValue({ count: 1 });
    tx.schedule.findFirst.mockResolvedValue({
      id: "sch-1",
      startDate: new Date("2026-03-10T07:00:00.000Z"),
      endDate: new Date("2026-03-17T07:00:00.000Z"),
      location: { name: "Downtown Bistro", timezone: "America/Los_Angeles" },
    });
    tx.shift.findMany.mockResolvedValue([{
      id: "shift-1",
      userId: "u1",
      startTime: new Date("2026-03-10T17:00:00.000Z"),
      endTime: new Date("2026-03-10T21:00:00.000Z"),
    }]);
    notificationsService.enqueueInTransaction.mockRejectedValue(
      new Error("notification outbox unavailable"),
    );
    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
    ).rejects.toThrow("notification outbox unavailable");
    expect(tx.schedule.updateMany).toHaveBeenCalledOnce();
    expect(notificationsService.deliverPendingNow).not.toHaveBeenCalled();
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
    notificationsService.deliverPendingNow.mockResolvedValue({
      status: "PARTIAL",
      delivered: 1,
      pending: 0,
      failed: 1,
    });

    const result = await controller.publish("sch-1", {
      user: { tenantId: "tenant-1" },
    }, "schedule-publish-test", publishBody());

    expect(tx.schedule.updateMany).toHaveBeenCalledOnce();
    expect(result).toEqual(
      expect.objectContaining({
        status: "PUBLISHED",
        notifications: { status: "PARTIAL", delivered: 1, pending: 0, failed: 1 },
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
      data: {
        status: "DRAFT",
        publishedAt: null,
        revision: { increment: 1 },
      },
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
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    const locationLockSql = Array.from(tx.$queryRaw.mock.calls[0][0]).join(" ");
    expect(locationLockSql).toContain('FROM "Location"');
    expect(locationLockSql).toContain('"deletedAt" IS NULL');
    expect(locationLockSql).toContain("FOR UPDATE");
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
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
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      take: 101,
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
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
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
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
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
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
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
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
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
    tx.$queryRaw.mockResolvedValueOnce([
        { id: "sch-1", status: "PUBLISHED", locationId: "loc-1" },
      ]);

    await expect(
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
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
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
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
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
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
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
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
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
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
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
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
      controller.publish("sch-1", { user: { tenantId: "tenant-1" } }, "schedule-publish-test", publishBody()),
    ).rejects.toThrow(
      "Shift shift-1 is outside configured staff availability.",
    );

    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("accepts touching and overlapping availability windows as continuous publish coverage", async () => {
    persistedAvailabilityRows = [
      { userId: "u1", dayOfWeek: 1, startTimeMinutes: 9 * 60, endTimeMinutes: 12 * 60 },
      { userId: "u1", dayOfWeek: 1, startTimeMinutes: 12 * 60, endTimeMinutes: 14 * 60 },
      { userId: "u1", dayOfWeek: 1, startTimeMinutes: 13 * 60, endTimeMinutes: 17 * 60 },
    ];
    await expect((controller as any).assertAssignedShiftsWithinAvailability(
      tx, "tenant-1", "loc-1", "America/Los_Angeles",
      [{
        id: "continuous-availability-1",
        userId: "u1",
        startTime: new Date("2026-03-09T16:00:00.000Z"),
        endTime: new Date("2026-03-10T00:00:00.000Z"),
        breaks: [],
      }],
    )).resolves.toBeUndefined();
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
    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: `schedule-credit-${result.jobId}`,
        tenantId: "tenant-1",
        amount: -1,
        balanceAfter: 0,
      }),
    });
    const scheduleLockQueryIndex = tx.$queryRaw.mock.calls.findIndex(
      ([query]: [unknown]) => {
        const sql = Array.isArray(query) ? query.join(" ") : String(query);
        return sql.includes('FROM "Schedule"') && sql.includes("FOR UPDATE");
      },
    );
    const solveJobInsertIndex = tx.$executeRaw.mock.calls.findIndex(
      ([query]: [unknown]) => {
        const sql = Array.isArray(query) ? query.join(" ") : String(query);
        return sql.includes('INSERT INTO "ScheduleSolveJob"');
      },
    );
    const creditConsumptionUpdateIndex = tx.$executeRaw.mock.calls.findIndex(
      ([query]: [unknown]) => {
        const sql = Array.isArray(query) ? query.join(" ") : String(query);
        return sql.includes('UPDATE "ScheduleSolveJob"')
          && sql.includes('"creditConsumption"');
      },
    );
    expect(scheduleLockQueryIndex).toBeGreaterThanOrEqual(0);
    expect(solveJobInsertIndex).toBeGreaterThanOrEqual(0);
    expect(creditConsumptionUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(
      tx.$queryRaw.mock.invocationCallOrder[scheduleLockQueryIndex],
    ).toBeLessThan(tx.$executeRaw.mock.invocationCallOrder[solveJobInsertIndex]);
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
      if (sql.includes('FROM "Schedule"') && sql.includes("FOR UPDATE")) {
        return [{ id: "sch-1", status: "DRAFT" }];
      }
      if (sql.includes('FROM "ScheduleSolveJob"') && sql.includes('"status" NOT IN')) {
        return [];
      }
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
      if (sql.includes('FROM "CreditTransaction"')) {
        return [{
          id: `schedule-credit-${first.jobId}`,
          tenantId: "tenant-1",
          amount: -1,
          reason: `Schedule generation (${first.jobId})`,
          balanceAfter: 0,
        }];
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
    const insertCall = tx.$executeRaw.mock.calls.find(([query]: [unknown]) =>
      Array.from(query as readonly string[]).join(" ").includes('"staffSnapshot"'),
    );
    expect(insertCall).toBeTruthy();
    expect(Array.from(insertCall![0]).join(" ")).toContain('"demandSnapshot"');
    const parsedJsonParams = insertCall!
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

  it("reuses a different-key nonterminal job with an exact reserved debit after paid entitlement revalidation", async () => {
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
      creditConsumption: { consumedCredits: 1, newBalance: 4, source: "credits" },
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
      if (sql.includes('FROM "CreditTransaction"')) {
        return [{
          id: "schedule-credit-job-active",
          tenantId: "tenant-1",
          amount: -1,
          reason: "Schedule generation (job-active)",
          balanceAfter: 4,
        }];
      }
      return [{ set_current_tenant: null }];
    });
    featureAccessService.assertFeatureEnabledInTransaction.mockRejectedValue(
      new ForbiddenException("Insufficient usage credits balance."),
    );
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
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(featureAccessService.lockTenantInTransaction).toHaveBeenCalledWith(tx, "tenant-1");
    const scheduleLockQueryIndex = tx.$queryRaw.mock.calls.findIndex(([query]: [unknown]) => {
      const sql = Array.isArray(query) ? query.join(" ") : String(query);
      return sql.includes('FROM "Schedule"') && sql.includes("FOR UPDATE");
    });
    const activeJobQueryIndex = tx.$queryRaw.mock.calls.findIndex(([query]: [unknown]) => {
      const sql = Array.isArray(query) ? query.join(" ") : String(query);
      return sql.includes('FROM "ScheduleSolveJob"') && sql.includes('"status" NOT IN');
    });
    const debitQueryIndex = tx.$queryRaw.mock.calls.findIndex(([query]: [unknown]) => {
      const sql = Array.isArray(query) ? query.join(" ") : String(query);
      return sql.includes('FROM "CreditTransaction"') && sql.includes("FOR UPDATE");
    });
    expect(scheduleLockQueryIndex).toBeGreaterThanOrEqual(0);
    expect(featureAccessService.lockTenantInTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[scheduleLockQueryIndex]);
    expect(activeJobQueryIndex).toBeGreaterThan(scheduleLockQueryIndex);
    expect(debitQueryIndex).toBeGreaterThan(activeJobQueryIndex);
    const activeJobQuery = tx.$queryRaw.mock.calls[activeJobQueryIndex][0];
    const activeJobSql = Array.isArray(activeJobQuery) ? activeJobQuery.join(" ") : String(activeJobQuery);
    expect(activeJobSql).not.toContain("LIMIT 1");
    expect(featureAccessService.assertFeatureEntitledInTransaction).toHaveBeenCalledWith(
      tx,
      "tenant-1",
      "scheduling",
    );
    expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
    expect(tx.schedule.findFirst).not.toHaveBeenCalled();
    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    expect(enqueueSolveJob).not.toHaveBeenCalled();
  });

  it.each(["FREE plan", "null paid-through", "past paid-through"])(
    "rejects a nonterminal paid reservation after %s entitlement loss",
    async () => {
      persistedSolveJobRows = [{
        id: "job-active",
        scheduleId: "sch-1",
        locationId: "loc-1",
        requestKeyHash: "other-key",
        requestHash: "other-request",
        status: "RUNNING",
        creditConsumption: { consumedCredits: 1, newBalance: 0, source: "credits" },
      }];
      vi.spyOn(controller as any, "findScheduleSolveJobByRequestKey").mockResolvedValue(null);
      featureAccessService.assertFeatureEntitledInTransaction.mockRejectedValue(
        new ForbiddenException("Billable features require a current active paid subscription."),
      );

      await expect(controller.autoSchedule(
        "sch-1",
        { user: { tenantId: "tenant-1" } },
        { constraints: {} },
        "recovery-after-entitlement-loss",
      )).rejects.toBeInstanceOf(ForbiddenException);

      expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
      expect(tx.schedule.findFirst).not.toHaveBeenCalled();
      expect(tx.shift.count).not.toHaveBeenCalled();
      expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing debit", []],
    ["mismatched debit", [{
      id: "schedule-credit-job-active",
      tenantId: "tenant-1",
      amount: -2,
      reason: "Schedule generation (job-active)",
      balanceAfter: 0,
    }]],
    ["duplicate debit", [{
      id: "schedule-credit-job-active",
      tenantId: "tenant-1",
      amount: -1,
      reason: "Schedule generation (job-active)",
      balanceAfter: 0,
    }, {
      id: "schedule-credit-job-active",
      tenantId: "tenant-1",
      amount: -1,
      reason: "Schedule generation (job-active)",
      balanceAfter: 0,
    }]],
    ["wrong debit reason", [{
      id: "schedule-credit-job-active",
      tenantId: "tenant-1",
      amount: -1,
      reason: "Schedule generation",
      balanceAfter: 0,
    }]],
    ["mismatched debit settlement balance", [{
      id: "schedule-credit-job-active",
      tenantId: "tenant-1",
      amount: -1,
      reason: "Schedule generation (job-active)",
      balanceAfter: 1,
    }]],
    ["debit and deterministic refund", [{
      id: "schedule-credit-job-active",
      tenantId: "tenant-1",
      amount: -1,
      reason: "Schedule generation (job-active)",
      balanceAfter: 0,
    }, {
      id: "schedule-credit-refund-job-active",
      tenantId: "tenant-1",
      amount: 1,
      reason: "Schedule generation refund (job-active)",
      balanceAfter: 1,
    }]],
  ])("fails closed when active recovery has a %s", async (_label, debitRows) => {
    persistedSolveJobRows = [{
      id: "job-active",
      scheduleId: "sch-1",
      locationId: "loc-1",
      requestKeyHash: "other-key",
      requestHash: "other-request",
      status: "QUEUED",
      statusReason: null,
      retryCount: 0,
      resultShiftCount: null,
      requestedConstraints: {},
      staffSnapshot: { staff: [] },
      demandSnapshot: { demand_windows: [] },
      creditConsumption: { consumedCredits: 1, newBalance: 0, source: "credits" },
      publicationStatus: "PENDING",
      publishAttempts: 0,
      nextPublishAt: new Date(),
      publishedAt: null,
      publishLastError: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }];
    persistedSolveDebitRows = debitRows;
    vi.spyOn(controller as any, "findScheduleSolveJobByRequestKey").mockResolvedValue(null);

    await expect(controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      { constraints: {} },
      "recovery-attempt",
    )).rejects.toThrow(/paid reservation is invalid/i);

    expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
  });

  it("rejects malformed active recovery balance metadata", async () => {
    persistedSolveJobRows = [{
      id: "job-active",
      scheduleId: "sch-1",
      locationId: "loc-1",
      requestKeyHash: "other-key",
      requestHash: "other-request",
      status: "RUNNING",
      creditConsumption: { consumedCredits: 1, newBalance: -1, source: "credits" },
    }];
    persistedSolveDebitRows = [{
      id: "schedule-credit-job-active",
      tenantId: "tenant-1",
      amount: -1,
      reason: "Schedule generation (job-active)",
      balanceAfter: 0,
    }];
    vi.spyOn(controller as any, "findScheduleSolveJobByRequestKey").mockResolvedValue(null);

    await expect(controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      { constraints: {} },
      "recovery-attempt",
    )).rejects.toThrow(/paid reservation is invalid/i);

    expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
  });

  it("validates exact terminal provenance before replaying a completed request", async () => {
    const terminalJob = {
      id: "job-terminal",
      scheduleId: "sch-1",
      locationId: "loc-1",
      requestKeyHash: "terminal-key",
      requestHash: autoScheduleRequestHash({}, false),
      status: "FAILED",
      creditConsumption: { consumedCredits: 1, newBalance: 0, source: "credits" },
    };
    vi.spyOn(controller as any, "findScheduleSolveJobByRequestKey").mockResolvedValue(terminalJob);
    featureAccessService.assertFeatureEntitledInTransaction.mockRejectedValue(
      new ForbiddenException("Paid entitlement was lost."),
    );
    persistedSolveDebitRows = [{
      id: "schedule-credit-job-terminal",
      tenantId: "tenant-1",
      amount: -1,
      reason: "Schedule generation (job-terminal)",
      balanceAfter: 0,
    }, {
      id: "schedule-credit-refund-job-terminal",
      tenantId: "tenant-1",
      amount: 1,
      reason: "Schedule generation refund (job-terminal)",
      balanceAfter: 1,
    }];

    await expect(controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      { constraints: {} },
      "terminal-replay",
    )).resolves.toEqual(expect.objectContaining({ jobId: "job-terminal", status: "FAILED", reused: true }));
    expect(featureAccessService.assertFeatureEntitledInTransaction).not.toHaveBeenCalled();

    persistedSolveDebitRows[1] = {
      ...persistedSolveDebitRows[1],
      reason: "Wrong refund reason",
    };
    await expect(controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      { constraints: {} },
      "terminal-replay",
    )).rejects.toThrow(/paid reservation is invalid/i);

    persistedSolveDebitRows[1] = {
      ...persistedSolveDebitRows[1],
      reason: "Schedule generation refund (job-terminal)",
      balanceAfter: 9,
    };
    await expect(controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      { constraints: {} },
      "terminal-replay-after-intervening-grant",
    )).resolves.toEqual(expect.objectContaining({ jobId: "job-terminal", status: "FAILED", reused: true }));

    persistedSolveDebitRows[1] = {
      ...persistedSolveDebitRows[1],
      balanceAfter: null,
    };
    await expect(controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      { constraints: {} },
      "terminal-replay",
    )).rejects.toThrow(/paid reservation is invalid/i);
  });

  it("fails closed after locking every duplicate active recovery candidate", async () => {
    persistedSolveJobRows = [
      { id: "job-active-1", status: "QUEUED" },
      { id: "job-active-2", status: "RUNNING" },
    ];
    vi.spyOn(controller as any, "findScheduleSolveJobByRequestKey").mockResolvedValue(null);

    await expect(controller.autoSchedule(
      "sch-1",
      { user: { tenantId: "tenant-1" } },
      { constraints: {} },
      "duplicate-active-attempt",
    )).rejects.toThrow(/ownership is ambiguous/i);

    const activeQuery = tx.$queryRaw.mock.calls.find(([query]: [unknown]) => {
      const sql = Array.isArray(query) ? query.join(" ") : String(query);
      return sql.includes('FROM "ScheduleSolveJob"') && sql.includes('"status" NOT IN');
    });
    const sql = Array.isArray(activeQuery?.[0]) ? activeQuery[0].join(" ") : String(activeQuery?.[0]);
    expect(sql).toContain("FOR UPDATE");
    expect(sql).not.toContain("LIMIT 1");
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
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

  it("returns tenant-scoped job status without persisted failure details", async () => {
    tx.$queryRaw.mockResolvedValueOnce([
        {
          id: "job-1",
          scheduleId: "sch-1",
          locationId: "loc-1",
          status: "FAILED",
          statusReason: "DATABASE_URL=postgresql://user:db-secret@private-db/app",
          retryCount: 1,
          resultShiftCount: 12,
          requestedConstraints: { min_floor_coverage: 1 },
          staffSnapshot: {
            staff: [{ id: "u1", skills: ["expo"], availability: [] }],
          },
          demandSnapshot: { demand_windows: [] },
          creditConsumption: { consumedCredits: 1, newBalance: 4 },
          publicationStatus: "FAILED",
          publishAttempts: 1,
          nextPublishAt: new Date("2026-03-10T00:00:00.000Z"),
          publishedAt: new Date("2026-03-10T00:00:01.000Z"),
          publishLastError: "Authorization: Bearer publication-secret",
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
      status: "FAILED",
      statusReason: "Schedule generation failed",
      retryCount: 1,
      resultShiftCount: 12,
      requestedConstraints: { min_floor_coverage: 1 },
      staffSnapshot: {
        staff: [{ id: "u1", skills: ["expo"], availability: [] }],
      },
      demandSnapshot: { demand_windows: [] },
      creditConsumption: { consumedCredits: 1, newBalance: 4 },
      publicationStatus: "FAILED",
      publishAttempts: 1,
      nextPublishAt: "2026-03-10T00:00:00.000Z",
      publishedAt: "2026-03-10T00:00:01.000Z",
      publishLastError: "Schedule publication failed",
      startedAt: "2026-03-10T00:01:00.000Z",
      completedAt: "2026-03-10T00:02:00.000Z",
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: "2026-03-10T00:02:00.000Z",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("db-secret");
    expect(serialized).not.toContain("publication-secret");
    expect(serialized).not.toContain("DATABASE_URL");
    expect(serialized).not.toContain("Authorization");
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
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
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
    expect(source).toMatch(/FOR UPDATE OF job SKIP LOCKED/);
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
  });

  it("requires schedule write permission to read persisted demand inputs", () => {
    const source = readFileSync(
      __filename.replace(/schedules\.controller\.spec\.ts$/, "schedules.controller.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /@Get\(":id\/demand-windows"\)\s+@Permission\("schedules:write"\)/,
    );
  });

  it("requires schedule write permission to read auto-schedule job state", () => {
    const source = readFileSync(
      __filename.replace(/schedules\.controller\.spec\.ts$/, "schedules.controller.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /@Get\(":id\/auto-schedule\/jobs\/:jobId"\)\s+@Permission\("schedules:write"\)/,
    );
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
  });
});
