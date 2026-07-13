import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import Stripe from "stripe";
import { TenantPrismaService } from "../database/tenant-prisma.service";

const METER_ERROR_EVENT_TYPES = new Set([
  "v1.billing.meter.error_report_triggered",
  "v1.billing.meter.no_meter_found",
]);
const RETRYABLE_ASYNC_ERROR_CODES = new Set([
  "meter_event_dimension_count_too_high",
  "timestamp_in_future",
]);
const MAX_EVENT_BYTES = 1_048_576;
const MAX_SAMPLE_ERRORS = 100;
const RECONCILIATION_BATCH_SIZE = 200;
const MAX_VALIDATION_WINDOW_MS = 24 * 60 * 60_000;

type MeterErrorSample = {
  code: string;
  identifier: string | null;
  idempotencyKey: string | null;
};

type MeterErrorReport = {
  errorCount: number;
  samples: MeterErrorSample[];
  samplesIncomplete: boolean;
  validationStart: Date;
  validationEnd: Date;
  aggregateCode: string;
};

type ErrorCorrelation = "explicit" | "ambiguous";

type ThinMeterEvent = {
  id?: unknown;
  type?: unknown;
  livemode?: unknown;
  related_object?: { id?: unknown } | null;
  reason?: {
    type?: unknown;
    request?: {
      id?: unknown;
      identifier?: unknown;
      idempotency_key?: unknown;
    } | null;
  } | null;
  data?: {
    reason?: {
      error_count?: unknown;
      error_types?: Array<{
        code?: unknown;
        error_count?: unknown;
        sample_errors?: Array<{
          request?: { identifier?: unknown; idempotency_key?: unknown } | null;
        }>;
      }>;
    };
    validation_start?: unknown;
    validation_end?: unknown;
  };
};

@Injectable()
export class StripeMeterErrorService {
  private readonly logger = new Logger(StripeMeterErrorService.name);
  private readonly stripe: Stripe | null;

  constructor(
    private readonly configService: ConfigService,
    private readonly tenantDb: TenantPrismaService,
    @Optional() stripe?: Stripe,
  ) {
    const apiKey = this.configService.get<string>("STRIPE_SECRET_KEY")?.trim();
    this.stripe =
      stripe ??
      (apiKey ? new Stripe(apiKey, { apiVersion: "2024-04-10" as any }) : null);
  }

  async handleWebhook(
    payload: Buffer,
    signature?: string,
  ): Promise<{ matched: number; transitioned: number }> {
    if (!signature)
      throw new BadRequestException("Missing stripe-signature header");
    if (!Buffer.isBuffer(payload))
      throw new BadRequestException(
        "Missing raw Stripe meter error webhook body",
      );

    const endpointSecret = this.configService
      .get<string>("STRIPE_METER_ERROR_WEBHOOK_SECRET")
      ?.trim();
    if (!endpointSecret) {
      throw new ServiceUnavailableException(
        "Stripe meter error webhook is not configured",
      );
    }

    let signedEvent: ThinMeterEvent;
    try {
      signedEvent = this.getStripe().webhooks.constructEvent(
        payload,
        signature,
        endpointSecret,
      ) as unknown as ThinMeterEvent;
    } catch (error) {
      this.logger.warn(
        `Stripe meter error signature verification failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        "Invalid Stripe meter error webhook signature",
      );
    }

    const eventId = this.requireEventIdentifier(signedEvent.id, "event id");
    const signedType = this.requireEventType(signedEvent.type);
    const event = await this.retrieveEvent(eventId);
    const eventType = this.requireEventType(event.type);
    if (eventType !== signedType || event.id !== eventId) {
      throw new BadRequestException(
        "Stripe meter error event identity mismatch",
      );
    }
    if (process.env.NODE_ENV === "production" && event.livemode !== true) {
      throw new BadRequestException(
        "Stripe meter error event must be live mode",
      );
    }
    this.assertConfiguredMeter(event, eventType);

    const report =
      eventType === "v1.billing.meter.error_report_triggered"
        ? this.extractAggregateReport(event)
        : null;
    const samples = report?.samples ?? [this.extractNoMeterSample(event)];
    const alreadyHandled = await this.findPreviouslyHandled(
      eventId,
      (report?.errorCount ?? 1) + RECONCILIATION_BATCH_SIZE + 1,
    );
    if (
      (!report && alreadyHandled.length === 1) ||
      (report && alreadyHandled.length >= report.errorCount)
    ) {
      return { matched: alreadyHandled.length, transitioned: 0 };
    }
    let matched = 0;
    let transitioned = 0;
    if (report?.samplesIncomplete) {
      const result = await this.reconcileIncompleteReport(
        eventId,
        eventType,
        report,
      );
      matched = result.matched;
      transitioned = result.transitioned;
    } else {
      for (const sample of samples) {
        const result = await this.reconcileSample(eventId, eventType, sample);
        matched += result.matched;
        transitioned += result.transitioned;
      }
      if (report && matched < report.errorCount) {
        throw new ServiceUnavailableException(
          "Stripe meter error reconciliation is incomplete",
        );
      }
      if (!report && matched !== 1) {
        throw new ServiceUnavailableException(
          "Stripe no-meter event did not match one durable usage event",
        );
      }
    }

    if (samples.length === 0) {
      this.logger.warn(
        `Stripe meter error event ${eventId} contained no correlatable samples`,
      );
    } else if (matched === 0) {
      this.logger.warn(
        `Stripe meter error event ${eventId} did not match a durable usage event`,
      );
    }
    this.logger.log(
      `Stripe meter error reconciled event=${eventId} errors=${report?.errorCount ?? samples.length} samples=${samples.length} matched=${matched} transitioned=${transitioned}`,
    );
    return { matched, transitioned };
  }

  private async retrieveEvent(eventId: string): Promise<ThinMeterEvent> {
    const secretKey = this.configService
      .get<string>("STRIPE_SECRET_KEY")
      ?.trim();
    if (!secretKey)
      throw new ServiceUnavailableException(
        "Stripe meter error retrieval is not configured",
      );

    let response: Response;
    try {
      response = await fetch(
        `https://api.stripe.com/v2/core/events/${encodeURIComponent(eventId)}`,
        {
          headers: {
            Authorization: `Bearer ${secretKey}`,
            Accept: "application/json",
            "Stripe-Version": "2026-01-28.preview",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      throw new ServiceUnavailableException(
        `Unable to retrieve Stripe meter error event: ${(error as Error).message}`,
      );
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Stripe meter error event retrieval failed with HTTP ${response.status}`,
      );
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_EVENT_BYTES) {
      throw new BadRequestException(
        "Stripe meter error event response is too large",
      );
    }
    try {
      return JSON.parse(body) as ThinMeterEvent;
    } catch {
      throw new ServiceUnavailableException(
        "Stripe meter error event response was not valid JSON",
      );
    }
  }

  private extractNoMeterSample(event: ThinMeterEvent): MeterErrorSample {
    if (this.safeString(event.reason?.type, 50) !== "request") {
      throw new BadRequestException(
        "Stripe no-meter event reason must identify a request",
      );
    }
    const identifier = this.safeString(event.reason?.request?.identifier, 255);
    const idempotencyKey = this.safeString(
      event.reason?.request?.idempotency_key,
      255,
    );
    if (!identifier && !idempotencyKey) {
      throw new BadRequestException(
        "Stripe no-meter event request is not correlatable",
      );
    }
    return { code: "no_meter", identifier, idempotencyKey };
  }

  private extractAggregateReport(event: ThinMeterEvent): MeterErrorReport {
    const reason = event.data?.reason;
    const errorCount = this.requireCount(
      reason?.error_count,
      "aggregate error_count",
    );
    const validationStart = this.requireTimestamp(
      event.data?.validation_start,
      "validation_start",
    );
    const validationEnd = this.requireTimestamp(
      event.data?.validation_end,
      "validation_end",
    );
    if (
      validationEnd <= validationStart ||
      validationEnd.getTime() - validationStart.getTime() >
        MAX_VALIDATION_WINDOW_MS
    ) {
      throw new BadRequestException(
        "Invalid Stripe meter error validation window",
      );
    }

    const samples: MeterErrorSample[] = [];
    const codes: string[] = [];
    let samplesIncomplete = false;
    let typedErrorCount = 0;
    for (const errorType of reason?.error_types ?? []) {
      const code = this.safeString(errorType.code, 100);
      if (!code)
        throw new BadRequestException("Invalid Stripe meter error code");
      const typeErrorCount = this.requireCount(
        errorType.error_count,
        "error type error_count",
      );
      typedErrorCount += typeErrorCount;
      codes.push(code);
      let correlatableSamples = 0;
      for (const sample of errorType.sample_errors ?? []) {
        const identifier = this.safeString(sample.request?.identifier, 255);
        const idempotencyKey = this.safeString(
          sample.request?.idempotency_key,
          255,
        );
        if (!identifier && !idempotencyKey) continue;
        correlatableSamples += 1;
        if (samples.length < MAX_SAMPLE_ERRORS) {
          samples.push({ code, identifier, idempotencyKey });
        }
      }
      if (typeErrorCount > correlatableSamples) samplesIncomplete = true;
    }
    if (typedErrorCount !== errorCount || errorCount === 0) {
      throw new BadRequestException(
        "Stripe meter error counts are inconsistent",
      );
    }
    if (errorCount > samples.length) samplesIncomplete = true;

    const uniqueCodes = [...new Set(codes)].sort();
    return {
      errorCount,
      samples,
      samplesIncomplete,
      validationStart,
      validationEnd,
      aggregateCode: `aggregate:${uniqueCodes.join(",")}`.slice(0, 500),
    };
  }

  private async reconcileIncompleteReport(
    eventId: string,
    eventType: string,
    report: MeterErrorReport,
  ): Promise<{ matched: number; transitioned: number }> {
    this.assertLastValueAggregation();
    const eventName = this.configService
      .get<string>("STRIPE_METER_EVENT_NAME")
      ?.trim();
    if (!eventName) {
      throw new ServiceUnavailableException(
        "Stripe meter event name is not configured",
      );
    }
    const windowWhere = {
      eventName,
      submittedAt: { gte: report.validationStart, lt: report.validationEnd },
    };
    const accountedIds = new Set<string>();
    let transitioned = 0;

    for (const sample of report.samples) {
      const result = await this.reconcileSample(eventId, eventType, sample);
      if (result.usageEventId) accountedIds.add(result.usageEventId);
      transitioned += result.transitioned;
    }

    const previouslyHandled = await this.findPreviouslyHandled(
      eventId,
      report.errorCount + RECONCILIATION_BATCH_SIZE + 1,
    );
    for (const row of previouslyHandled) accountedIds.add(row.id);

    const remainingErrorCount = report.errorCount - accountedIds.size;
    if (
      remainingErrorCount > 0 &&
      remainingErrorCount <= RECONCILIATION_BATCH_SIZE
    ) {
      const candidates = (await this.tenantDb.withPlatformAdmin((tx: any) =>
        tx.stripeUsageEvent.findMany({
          where: {
            ...windowWhere,
            status: { in: ["SENT", "SENDING", "FAILED"] },
          },
          orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
          take: RECONCILIATION_BATCH_SIZE + 1,
        }),
      )) as any[];
      if (
        candidates.length >= remainingErrorCount &&
        candidates.length <= RECONCILIATION_BATCH_SIZE
      ) {
        for (const row of candidates) {
          const rowTransitioned = await this.transitionUsageEvent(
            row,
            eventId,
            eventType,
            report.aggregateCode,
            true,
            report,
            "ambiguous",
          );
          if (rowTransitioned === 0) {
            throw new ServiceUnavailableException(
              "Stripe meter error reconciliation lost a concurrent update",
            );
          }
          accountedIds.add(row.id);
          transitioned += rowTransitioned;
        }
      }
    }

    if (accountedIds.size < report.errorCount) {
      throw new ServiceUnavailableException(
        "Stripe meter error reconciliation is incomplete",
      );
    }
    return { matched: accountedIds.size, transitioned };
  }

  private async reconcileSample(
    eventId: string,
    eventType: string,
    sample: MeterErrorSample,
  ): Promise<{ matched: number; transitioned: number; usageEventId?: string }> {
    const usageEvent = await this.tenantDb.withPlatformAdmin(
      async (tx: any) => {
        const byIdentifier = sample.identifier
          ? await tx.stripeUsageEvent.findUnique({
              where: { identifier: sample.identifier },
            })
          : null;
        const byIdempotencyKey = sample.idempotencyKey
          ? await tx.stripeUsageEvent.findUnique({
              where: { idempotencyKey: sample.idempotencyKey },
            })
          : null;
        if (
          byIdentifier &&
          byIdempotencyKey &&
          byIdentifier.id !== byIdempotencyKey.id
        ) {
          throw new BadRequestException(
            "Stripe meter error correlations identify different usage events",
          );
        }
        return byIdentifier ?? byIdempotencyKey;
      },
    );
    if (!usageEvent) return { matched: 0, transitioned: 0 };
    const submittedFailedEvent =
      usageEvent.status === "FAILED" && usageEvent.submittedAt;
    if (
      usageEvent.status !== "SENT" &&
      usageEvent.status !== "SENDING" &&
      !submittedFailedEvent
    ) {
      return { matched: 1, transitioned: 0, usageEventId: usageEvent.id };
    }
    const transitioned = await this.transitionUsageEvent(
      usageEvent,
      eventId,
      eventType,
      sample.code,
      RETRYABLE_ASYNC_ERROR_CODES.has(sample.code),
      undefined,
      "explicit",
    );
    if (transitioned === 0) {
      throw new ServiceUnavailableException(
        "Stripe meter error reconciliation lost a concurrent update",
      );
    }
    return { matched: 1, transitioned, usageEventId: usageEvent.id };
  }

  private async transitionUsageEvent(
    usageEvent: any,
    eventId: string,
    eventType: string,
    code: string,
    codeRetryable: boolean,
    report?: MeterErrorReport,
    correlation: ErrorCorrelation = "explicit",
  ): Promise<number> {
    const maxAttempts = this.boundedInteger(
      process.env.STRIPE_USAGE_MAX_ATTEMPTS,
      5,
      1,
      20,
    );
    const retryable = codeRetryable && usageEvent.attempts < maxAttempts;
    const status = retryable ? "FAILED" : "DEAD_LETTERED";
    const now = new Date();
    const nextAttemptAt = retryable
      ? new Date(now.getTime() + 5 * 60_000)
      : now;
    const nextIdentity = this.rotatedTransportIdentity(
      usageEvent,
      eventId,
      code,
      correlation,
    );
    const priorMetadata = this.asRecord(usageEvent.metadata);
    const logicalUsageIdentity =
      this.safeString(priorMetadata.logicalUsageIdentity, 255) ??
      usageEvent.identifier;
    return this.tenantDb.withTenant(usageEvent.tenantId, async (tx: any) => {
      const update = await tx.stripeUsageEvent.updateMany({
        where: {
          id: usageEvent.id,
          tenantId: usageEvent.tenantId,
          status: usageEvent.status,
          identifier: usageEvent.identifier,
          idempotencyKey: usageEvent.idempotencyKey,
          ...(usageEvent.submittedAt
            ? { submittedAt: usageEvent.submittedAt }
            : {}),
        },
        data: {
          status,
          identifier: nextIdentity.identifier,
          idempotencyKey: nextIdentity.idempotencyKey,
          nextAttemptAt,
          sentAt: null,
          stripeObjectId: null,
          stripeRequestId: null,
          lastError:
            `Stripe asynchronously rejected meter event: ${code}`.slice(
              0,
              1000,
            ),
          metadata: {
            ...priorMetadata,
            logicalUsageIdentity,
            stripeAsyncError: {
              eventId,
              eventType,
              code,
              disposition: `${correlation}_${retryable ? "bounded_retry" : "dead_lettered"}`,
              rejectedIdentifier: usageEvent.identifier,
              rejectedIdempotencyKey: usageEvent.idempotencyKey,
              retryIdentifier: nextIdentity.identifier,
              retryIdempotencyKey: nextIdentity.idempotencyKey,
              receivedAt: now.toISOString(),
              ...(report
                ? {
                    declaredErrorCount: report.errorCount,
                    validationStart: report.validationStart.toISOString(),
                    validationEnd: report.validationEnd.toISOString(),
                  }
                : {}),
            },
          },
        },
      });
      return update.count === 1 ? 1 : 0;
    });
  }

  private assertConfiguredMeter(
    event: ThinMeterEvent,
    eventType: string,
  ): void {
    if (eventType !== "v1.billing.meter.error_report_triggered") return;
    const configuredMeterId = this.configService
      .get<string>("STRIPE_METER_ID")
      ?.trim();
    const relatedMeterId = this.safeString(event.related_object?.id, 255);
    if (!configuredMeterId || relatedMeterId !== configuredMeterId) {
      throw new BadRequestException(
        "Stripe meter error event does not match STRIPE_METER_ID",
      );
    }
  }

  private assertLastValueAggregation(): void {
    const aggregation = this.configService
      .get<string>("STRIPE_METER_AGGREGATION")
      ?.trim()
      .toLowerCase();
    if (aggregation !== "last") {
      throw new ServiceUnavailableException(
        "Ambiguous Stripe meter reconciliation requires last-value aggregation",
      );
    }
  }

  private findPreviouslyHandled(
    eventId: string,
    take: number,
  ): Promise<Array<{ id: string }>> {
    return this.tenantDb.withPlatformAdmin((tx: any) =>
      tx.stripeUsageEvent.findMany({
        where: {
          metadata: { path: ["stripeAsyncError", "eventId"], equals: eventId },
        },
        select: { id: true },
        take,
      }),
    ) as Promise<Array<{ id: string }>>;
  }

  private requireEventType(value: unknown): string {
    const eventType = this.safeString(value, 100);
    if (!eventType || !METER_ERROR_EVENT_TYPES.has(eventType)) {
      throw new BadRequestException(
        "Unsupported Stripe meter error event type",
      );
    }
    return eventType;
  }

  private requireEventIdentifier(value: unknown, label: string): string {
    const normalized = this.safeString(value, 255);
    if (!normalized || !/^evt_[A-Za-z0-9_]+$/.test(normalized)) {
      throw new BadRequestException(`Invalid Stripe meter error ${label}`);
    }
    return normalized;
  }

  private requireCount(value: unknown, label: string): number {
    if (
      !Number.isSafeInteger(value) ||
      Number(value) < 0 ||
      Number(value) > 1_000_000
    ) {
      throw new BadRequestException(`Invalid Stripe meter error ${label}`);
    }
    return Number(value);
  }

  private requireTimestamp(value: unknown, label: string): Date {
    const normalized = this.safeString(value, 100);
    const timestamp = normalized ? new Date(normalized) : new Date(Number.NaN);
    if (!normalized || Number.isNaN(timestamp.getTime())) {
      throw new BadRequestException(`Invalid Stripe meter error ${label}`);
    }
    return timestamp;
  }

  private safeString(value: unknown, maxLength: number): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    if (
      !normalized ||
      normalized.length > maxLength ||
      /[\u0000-\u001f\u007f]/.test(normalized)
    )
      return null;
    return normalized;
  }

  private rotatedTransportIdentity(
    usageEvent: any,
    eventId: string,
    code: string,
    correlation: ErrorCorrelation,
  ): { identifier: string; idempotencyKey: string } {
    const seed = `${usageEvent.id}:${usageEvent.identifier}:${usageEvent.idempotencyKey}:${eventId}:${code}:${correlation}`;
    const identifierDigest = createHash("sha256")
      .update(`identifier:${seed}`)
      .digest("hex");
    const idempotencyDigest = createHash("sha256")
      .update(`idempotency:${seed}`)
      .digest("hex");
    return {
      identifier: `ll_async_${identifierDigest}`,
      idempotencyKey: `stripe_usage_async_${idempotencyDigest}`,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private boundedInteger(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
      ? parsed
      : fallback;
  }

  private getStripe(): Stripe {
    if (!this.stripe)
      throw new ServiceUnavailableException(
        "Stripe meter error webhook is not configured",
      );
    return this.stripe;
  }
}
