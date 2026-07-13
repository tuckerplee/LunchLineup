import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StripeMeterErrorService } from "./stripe-meter-error.service";

const eventId = "evt_meter_error_123";
const meterId = "mtr_live_123";

function response(event: Record<string, unknown>) {
  return new Response(JSON.stringify(event), { status: 200 });
}

function buildService({
  row,
  rows,
  event,
  updateCount = 1,
}: {
  row?: Record<string, any> | null;
  rows?: Array<Record<string, any>>;
  event?: Record<string, unknown>;
  updateCount?: number;
} = {}) {
  const storedRows = rows ?? (row ? [row] : []);
  const findUnique = vi.fn(async ({ where }: any) => {
    return (
      storedRows.find(
        (candidate) =>
          (where.identifier && where.identifier === candidate.identifier) ||
          (where.idempotencyKey &&
            where.idempotencyKey === candidate.idempotencyKey),
      ) ?? null
    );
  });
  const updateMany = vi.fn(async ({ where, data }: any) => {
    if (updateCount === 0) return { count: 0 };
    const candidate = storedRows.find(
      (item) =>
        item.id === where.id &&
        item.tenantId === where.tenantId &&
        item.status === where.status &&
        item.idempotencyKey === where.idempotencyKey &&
        (!where.submittedAt || item.submittedAt === where.submittedAt),
    );
    if (!candidate) return { count: 0 };
    Object.assign(candidate, data);
    return { count: 1 };
  });
  const inWindow = (candidate: Record<string, any>, where: any) => {
    const submittedAt =
      candidate.submittedAt instanceof Date ? candidate.submittedAt : null;
    return (
      candidate.eventName === where.eventName &&
      submittedAt !== null &&
      submittedAt >= where.submittedAt.gte &&
      submittedAt < where.submittedAt.lt
    );
  };
  const findMany = vi.fn(async ({ where, take }: any) => {
    if (where.metadata) {
      return storedRows
        .filter(
          (candidate) =>
            candidate.metadata?.stripeAsyncError?.eventId ===
            where.metadata.equals,
        )
        .slice(0, take)
        .map(({ id }) => ({ id }));
    }
    return storedRows
      .filter(
        (candidate) =>
          inWindow(candidate, where) &&
          where.status.in.includes(candidate.status),
      )
      .slice(0, take);
  });
  const count = vi.fn(
    async ({ where }: any) =>
      storedRows.filter((candidate) => {
        if (!inWindow(candidate, where)) return false;
        if (where.status && !where.status.in.includes(candidate.status))
          return false;
        if (where.metadata) {
          return (
            candidate.metadata?.stripeAsyncError?.eventId ===
            where.metadata.equals
          );
        }
        return true;
      }).length,
  );
  const tx = { stripeUsageEvent: { findUnique, findMany, count, updateMany } };
  const tenantDb = {
    withPlatformAdmin: vi.fn((operation: any) => operation(tx)),
    withTenant: vi.fn((_tenantId: string, operation: any) => operation(tx)),
  };
  const signed = {
    id: eventId,
    type: event?.type ?? "v1.billing.meter.error_report_triggered",
  };
  const stripe = {
    webhooks: { constructEvent: vi.fn().mockReturnValue(signed) },
  };
  const config = new ConfigService({
    STRIPE_SECRET_KEY: "sk_live_test",
    STRIPE_METER_ERROR_WEBHOOK_SECRET: "whsec_test",
    STRIPE_METER_ID: meterId,
    STRIPE_METER_EVENT_NAME: "active_staff",
    STRIPE_METER_AGGREGATION: "last",
  });
  const fullEvent = event ?? {
    ...signed,
    livemode: true,
    related_object: { id: meterId },
    data: {
      reason: {
        error_count: 1,
        error_types: [
          {
            code: "meter_event_customer_not_found",
            error_count: 1,
            sample_errors: [
              { request: { idempotency_key: "stripe_usage_original" } },
            ],
          },
        ],
      },
      validation_start: "2026-07-11T12:00:00.000Z",
      validation_end: "2026-07-11T12:00:10.000Z",
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => response(fullEvent)),
  );
  return {
    service: new StripeMeterErrorService(
      config,
      tenantDb as any,
      stripe as any,
    ),
    stripe,
    tenantDb,
    findUnique,
    updateMany,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STRIPE_USAGE_MAX_ATTEMPTS;
});

describe("StripeMeterErrorService", () => {
  it("dead-letters a customer-not-found rejection using exact durable correlation", async () => {
    const row = {
      id: "usage-1",
      tenantId: "tenant-1",
      status: "SENT",
      attempts: 1,
      identifier: "ll_active_staff_123",
      idempotencyKey: "stripe_usage_original",
      metadata: { source: "worker" },
    };
    const { service, updateMany } = buildService({ row });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).resolves.toEqual({ matched: 1, transitioned: 1 });

    const mutation = updateMany.mock.calls[0][0];
    expect(mutation.where).toEqual(
      expect.objectContaining({
        id: "usage-1",
        tenantId: "tenant-1",
        status: "SENT",
        idempotencyKey: "stripe_usage_original",
      }),
    );
    expect(mutation.data.status).toBe("DEAD_LETTERED");
    expect(mutation.data.idempotencyKey).toMatch(
      /^stripe_usage_async_[a-f0-9]{64}$/,
    );
    expect(mutation.data.metadata.stripeAsyncError).toEqual(
      expect.objectContaining({
        eventId,
        code: "meter_event_customer_not_found",
        disposition: "explicit_dead_lettered",
      }),
    );
  });

  it("moves retryable async rejection to bounded retry with fresh transport identities", async () => {
    const row = {
      id: "usage-2",
      tenantId: "tenant-2",
      status: "SENT",
      attempts: 2,
      identifier: "ll_active_staff_456",
      idempotencyKey: "stripe_usage_retry",
      metadata: null,
    };
    const event = {
      id: eventId,
      type: "v1.billing.meter.error_report_triggered",
      livemode: true,
      related_object: { id: meterId },
      data: {
        reason: {
          error_types: [
            {
              code: "timestamp_in_future",
              error_count: 1,
              sample_errors: [{ request: { identifier: row.identifier } }],
            },
          ],
          error_count: 1,
        },
        validation_start: "2026-07-11T12:00:00.000Z",
        validation_end: "2026-07-11T12:00:10.000Z",
      },
    };
    const { service, updateMany } = buildService({ row, event });

    await service.handleWebhook(Buffer.from("{}"), "sig");

    expect(updateMany.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        status: "FAILED",
        sentAt: null,
        stripeObjectId: null,
        stripeRequestId: null,
      }),
    );
    const mutation = updateMany.mock.calls[0][0].data;
    expect(mutation.identifier).toMatch(/^ll_async_[a-f0-9]{64}$/);
    expect(mutation.identifier).not.toBe("ll_active_staff_456");
    expect(mutation.idempotencyKey).toMatch(
      /^stripe_usage_async_[a-f0-9]{64}$/,
    );
    expect(mutation.idempotencyKey).not.toBe("stripe_usage_retry");
    expect(mutation.metadata.logicalUsageIdentity).toBe("ll_active_staff_456");
  });

  it("rotates a submitted FAILED timeout, then ignores the exact duplicate after retry", async () => {
    const submittedAt = new Date("2026-07-11T12:00:05.000Z");
    const row = {
      id: "usage-timeout",
      tenantId: "tenant-timeout",
      status: "FAILED",
      attempts: 1,
      submittedAt,
      identifier: "ll_active_staff_timeout",
      idempotencyKey: "stripe_usage_timeout",
      metadata: { source: "worker" },
    };
    const event = {
      id: eventId,
      type: "v1.billing.meter.error_report_triggered",
      livemode: true,
      related_object: { id: meterId },
      data: {
        reason: {
          error_count: 1,
          error_types: [
            {
              code: "timestamp_in_future",
              error_count: 1,
              sample_errors: [{ request: { identifier: row.identifier } }],
            },
          ],
        },
        validation_start: "2026-07-11T12:00:00.000Z",
        validation_end: "2026-07-11T12:00:10.000Z",
      },
    };
    const { service, updateMany } = buildService({ row, event });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).resolves.toEqual({ matched: 1, transitioned: 1 });

    const retryIdentifier = row.identifier;
    const retryIdempotencyKey = row.idempotencyKey;
    expect(retryIdentifier).toMatch(/^ll_async_[a-f0-9]{64}$/);
    expect(retryIdempotencyKey).toMatch(/^stripe_usage_async_[a-f0-9]{64}$/);
    expect((row.metadata as any).stripeAsyncError.eventId).toBe(eventId);
    expect((row.metadata as any).stripeAsyncError.rejectedIdentifier).toBe(
      "ll_active_staff_timeout",
    );
    expect((row.metadata as any).stripeAsyncError.rejectedIdempotencyKey).toBe(
      "stripe_usage_timeout",
    );

    row.status = "SENT";
    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).resolves.toEqual({ matched: 1, transitioned: 0 });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(row.identifier).toBe(retryIdentifier);
    expect(row.idempotencyKey).toBe(retryIdempotencyKey);
  });

  it("reconciles an asynchronously rejected final attempt that crashed while sending", async () => {
    process.env.STRIPE_USAGE_MAX_ATTEMPTS = "5";
    const row = {
      id: "usage-final",
      tenantId: "tenant-final",
      status: "SENDING",
      attempts: 5,
      identifier: "ll_active_staff_final",
      idempotencyKey: "stripe_usage_original",
      metadata: { source: "worker" },
    };
    const { service, updateMany } = buildService({ row });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).resolves.toEqual({ matched: 1, transitioned: 1 });

    const mutation = updateMany.mock.calls[0][0];
    expect(mutation.where).toEqual(
      expect.objectContaining({
        id: row.id,
        tenantId: row.tenantId,
        status: "SENDING",
        idempotencyKey: "stripe_usage_original",
      }),
    );
    expect(mutation.data.status).toBe("DEAD_LETTERED");
    expect(mutation.data.identifier).not.toBe("ll_active_staff_final");
    expect(mutation.data.metadata.logicalUsageIdentity).toBe(
      "ll_active_staff_final",
    );
  });

  it("is idempotent when a duplicate delivery sees an already transitioned row", async () => {
    const row = {
      id: "usage-1",
      tenantId: "tenant-1",
      status: "DEAD_LETTERED",
      attempts: 1,
      identifier: "ll_active_staff_123",
      idempotencyKey: "stripe_usage_original",
      metadata: {},
    };
    const { service, updateMany } = buildService({ row });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).resolves.toEqual({ matched: 1, transitioned: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects a fetched event for another configured meter", async () => {
    const { service } = buildService({
      event: {
        id: eventId,
        type: "v1.billing.meter.error_report_triggered",
        livemode: true,
        related_object: { id: "mtr_other" },
        data: { reason: { error_types: [] } },
      },
    });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("fails closed when identifier and idempotency key resolve to different tenants", async () => {
    const first = {
      id: "usage-1",
      tenantId: "tenant-1",
      status: "SENT",
      attempts: 1,
      identifier: "ll_one",
      idempotencyKey: "key_one",
      metadata: {},
    };
    const second = {
      ...first,
      id: "usage-2",
      tenantId: "tenant-2",
      identifier: "ll_two",
      idempotencyKey: "key_two",
    };
    const event = {
      id: eventId,
      type: "v1.billing.meter.no_meter_found",
      object: "v2.core.event",
      livemode: true,
      related_object: {},
      reason: {
        type: "request",
        request: {
          identifier: first.identifier,
          idempotency_key: second.idempotencyKey,
        },
      },
      data: {
        developer_message_summary:
          "No meter was found for the asynchronous meter event.",
      },
    };
    const { service, findUnique } = buildService({ row: first, event });
    findUnique.mockImplementation(async ({ where }: any) =>
      where.identifier ? first : second,
    );

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ["idempotency key", { idempotency_key: "stripe_usage_original" }],
    ["identifier", { identifier: "ll_active_staff_123" }],
  ])(
    "reconciles realistic no-meter request correlation by %s",
    async (_label, request) => {
      const row = {
        id: "usage-no-meter",
        tenantId: "tenant-1",
        status: "SENT",
        attempts: 1,
        identifier: "ll_active_staff_123",
        idempotencyKey: "stripe_usage_original",
        metadata: {},
      };
      const event = {
        id: eventId,
        object: "v2.core.event",
        created: "2026-07-11T12:00:05.000Z",
        type: "v1.billing.meter.no_meter_found",
        livemode: true,
        related_object: null,
        reason: {
          type: "request",
          request: { id: "req_meter_123", ...request },
        },
        data: {
          developer_message_summary:
            "No meter was found for the asynchronous meter event.",
        },
      };
      const { service, updateMany } = buildService({ row, event });

      await expect(
        service.handleWebhook(Buffer.from("{}"), "sig"),
      ).resolves.toEqual({ matched: 1, transitioned: 1 });

      expect(updateMany.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({
            id: row.id,
            tenantId: row.tenantId,
            status: "SENT",
            identifier: "ll_active_staff_123",
            idempotencyKey: "stripe_usage_original",
          }),
          data: expect.objectContaining({
            status: "DEAD_LETTERED",
            identifier: expect.stringMatching(/^ll_async_[a-f0-9]{64}$/),
            idempotencyKey: expect.stringMatching(
              /^stripe_usage_async_[a-f0-9]{64}$/,
            ),
          }),
        }),
      );

      await expect(
        service.handleWebhook(Buffer.from("{}"), "sig"),
      ).resolves.toEqual({ matched: 1, transitioned: 0 });
      expect(updateMany).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects no-meter payloads that only contain aggregate error samples", async () => {
    const event = {
      id: eventId,
      object: "v2.core.event",
      type: "v1.billing.meter.no_meter_found",
      livemode: true,
      data: {
        reason: {
          error_types: [
            {
              code: "no_meter",
              sample_errors: [
                { request: { idempotency_key: "stripe_usage_original" } },
              ],
            },
          ],
        },
      },
    };
    const { service } = buildService({ event });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("retries a correlatable no-meter event until its exact durable row exists", async () => {
    const event = {
      id: eventId,
      object: "v2.core.event",
      type: "v1.billing.meter.no_meter_found",
      livemode: true,
      reason: {
        type: "request",
        request: { idempotency_key: "stripe_usage_missing" },
      },
      data: {
        developer_message_summary:
          "No meter was found for the asynchronous meter event.",
      },
    };
    const { service } = buildService({ event });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("reconciles every durable row when aggregate errors exceed Stripe sample cap", async () => {
    const submittedAt = new Date("2026-07-11T12:00:05.000Z");
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: `usage-${index}`,
      tenantId: `tenant-${index}`,
      eventName: "active_staff",
      status: index % 2 === 0 ? "SENT" : "SENDING",
      attempts: 1,
      identifier: `ll_active_staff_${index}`,
      idempotencyKey: `stripe_usage_${index}`,
      submittedAt,
      metadata: {},
    }));
    const event = {
      id: eventId,
      type: "v1.billing.meter.error_report_triggered",
      livemode: true,
      related_object: { id: meterId },
      data: {
        reason: {
          error_count: 101,
          error_types: [
            {
              code: "meter_event_customer_not_found",
              error_count: 101,
              sample_errors: rows.slice(0, 100).map((usage) => ({
                request: { identifier: usage.identifier },
              })),
            },
          ],
        },
        validation_start: "2026-07-11T12:00:00.000Z",
        validation_end: "2026-07-11T12:00:10.000Z",
      },
    };
    const { service, tenantDb, updateMany } = buildService({ rows, event });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).resolves.toEqual({ matched: 101, transitioned: 101 });

    expect(updateMany).toHaveBeenCalledTimes(101);
    expect(tenantDb.withTenant).toHaveBeenCalledTimes(101);
    expect(
      new Set(updateMany.mock.calls.map(([call]) => call.where.tenantId)).size,
    ).toBe(101);
    expect(
      rows.slice(0, 100).every((usage) => usage.status === "DEAD_LETTERED"),
    ).toBe(true);
    expect(rows[100].status).toBe("FAILED");
    expect((rows[100].metadata as any).stripeAsyncError.disposition).toBe(
      "ambiguous_bounded_retry",
    );
    expect(
      rows.every((usage) => /^ll_async_[a-f0-9]{64}$/.test(usage.identifier)),
    ).toBe(true);
    expect(
      rows.every((usage) =>
        /^stripe_usage_async_[a-f0-9]{64}$/.test(usage.idempotencyKey),
      ),
    ).toBe(true);

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).resolves.toEqual({ matched: 101, transitioned: 0 });
    expect(updateMany).toHaveBeenCalledTimes(101);
  });

  it("retries every ambiguous candidate for a mixed 101-of-102 last-value report", async () => {
    process.env.STRIPE_USAGE_MAX_ATTEMPTS = "5";
    const submittedAt = new Date("2026-07-11T12:00:05.000Z");
    const rows = Array.from({ length: 102 }, (_, index) => ({
      id: `usage-${index}`,
      tenantId: `tenant-${index}`,
      eventName: "active_staff",
      status: "SENT",
      attempts: 1,
      identifier: `ll_active_staff_${index}`,
      idempotencyKey: `stripe_usage_${index}`,
      submittedAt,
      metadata: {},
    }));
    rows[101].attempts = 5;
    const event = {
      id: eventId,
      type: "v1.billing.meter.error_report_triggered",
      livemode: true,
      related_object: { id: meterId },
      data: {
        reason: {
          error_count: 101,
          error_types: [
            {
              code: "meter_event_customer_not_found",
              error_count: 101,
              sample_errors: rows.slice(0, 100).map((usage) => ({
                request: { identifier: usage.identifier },
              })),
            },
          ],
        },
        validation_start: "2026-07-11T12:00:00.000Z",
        validation_end: "2026-07-11T12:00:10.000Z",
      },
    };
    const { service, updateMany } = buildService({ rows, event });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).resolves.toEqual({ matched: 102, transitioned: 102 });

    expect(updateMany).toHaveBeenCalledTimes(102);
    expect(
      rows.slice(0, 100).every((usage) => usage.status === "DEAD_LETTERED"),
    ).toBe(true);
    expect(rows[100].status).toBe("FAILED");
    expect(rows[101].status).toBe("DEAD_LETTERED");
    expect(
      rows
        .slice(0, 100)
        .every(
          (usage) =>
            (usage.metadata as any).stripeAsyncError.disposition ===
            "explicit_dead_lettered",
        ),
    ).toBe(true);
    expect((rows[100].metadata as any).stripeAsyncError.disposition).toBe(
      "ambiguous_bounded_retry",
    );
    expect((rows[101].metadata as any).stripeAsyncError.disposition).toBe(
      "ambiguous_dead_lettered",
    );
    expect(
      rows.every((usage) =>
        (usage.metadata as any).logicalUsageIdentity.startsWith(
          "ll_active_staff_",
        ),
      ),
    ).toBe(true);
    expect(new Set(rows.map((usage) => usage.identifier)).size).toBe(102);
    expect(new Set(rows.map((usage) => usage.idempotencyKey)).size).toBe(102);

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).resolves.toEqual({ matched: 102, transitioned: 0 });
    expect(updateMany).toHaveBeenCalledTimes(102);
  });

  it("fails closed on ambiguous reconciliation without a configured last-value contract", async () => {
    const submittedAt = new Date("2026-07-11T12:00:05.000Z");
    const rows = Array.from({ length: 2 }, (_, index) => ({
      id: `usage-${index}`,
      tenantId: `tenant-${index}`,
      eventName: "active_staff",
      status: "SENT",
      attempts: 1,
      identifier: `ll_active_staff_${index}`,
      idempotencyKey: `stripe_usage_${index}`,
      submittedAt,
      metadata: {},
    }));
    const event = {
      id: eventId,
      type: "v1.billing.meter.error_report_triggered",
      livemode: true,
      related_object: { id: meterId },
      data: {
        reason: {
          error_count: 2,
          error_types: [
            {
              code: "timestamp_in_future",
              error_count: 2,
              sample_errors: [{ request: { identifier: rows[0].identifier } }],
            },
          ],
        },
        validation_start: "2026-07-11T12:00:00.000Z",
        validation_end: "2026-07-11T12:00:10.000Z",
      },
    };
    const { service, updateMany } = buildService({ rows, event });
    (service as any).configService.set("STRIPE_METER_AGGREGATION", "sum");

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).rejects.toThrow(/last-value aggregation/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not acknowledge an incomplete aggregate when rejected rows are not durably accounted for", async () => {
    const event = {
      id: eventId,
      type: "v1.billing.meter.error_report_triggered",
      livemode: true,
      related_object: { id: meterId },
      data: {
        reason: {
          error_count: 101,
          error_types: [
            {
              code: "meter_event_customer_not_found",
              error_count: 101,
              sample_errors: Array.from({ length: 100 }, (_, index) => ({
                request: { identifier: `missing-${index}` },
              })),
            },
          ],
        },
        validation_start: "2026-07-11T12:00:00.000Z",
        validation_end: "2026-07-11T12:00:10.000Z",
      },
    };
    const { service } = buildService({ event });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).rejects.toThrow("Stripe meter error reconciliation is incomplete");
  });

  it("does not acknowledge a complete sample set when its rejected row is missing", async () => {
    const { service } = buildService();

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).rejects.toThrow("Stripe meter error reconciliation is incomplete");
  });

  it("does not acknowledge a sampled row when its guarded transition loses a race", async () => {
    const row = {
      id: "usage-race",
      tenantId: "tenant-race",
      status: "SENT",
      attempts: 1,
      identifier: "ll_active_staff_race",
      idempotencyKey: "stripe_usage_original",
      metadata: {},
    };
    const { service } = buildService({ row, updateCount: 0 });

    await expect(
      service.handleWebhook(Buffer.from("{}"), "sig"),
    ).rejects.toThrow(
      "Stripe meter error reconciliation lost a concurrent update",
    );
  });
});
