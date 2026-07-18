import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    NotFoundException,
    type OnModuleDestroy,
    type OnModuleInit,
    Optional,
    Param,
    Post,
    Put,
    Query,
    Req,
    ServiceUnavailableException,
    SetMetadata,
    UseGuards,
} from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import { randomUUID } from "crypto";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RbacGuard } from "../auth/rbac.guard";
import {
    ACTIVE_SCHEDULABLE_USER_FILTER,
    SCHEDULABLE_USER_ROLES,
} from "../common/schedulable-user";
import { FeatureAccessService, type FeatureResolution } from "../billing/feature-access.service";
import { MeteringService } from "../billing/metering.service";
import {
    assertBoundedListWindow,
    buildBoundedListPage,
    decodeBoundedListCursor,
    parseBoundedListLimit,
    parseOptionalBoundedDate,
} from "../common/bounded-pagination";
import {
    formatDateInTimeZone,
    localDateBoundaryUtc,
    normalizeTimeZone,
    splitInstantRangeByLocalDay,
} from "../common/location-timezone";
import {
    TenantPrismaService,
    type TenantPrismaTransaction,
} from "../database/tenant-prisma.service";
import { NotificationsService, NotificationType } from "../notifications/notifications.service";
import {
    WebhooksService,
    type TransactionalWebhookCostPlan,
} from "../webhooks/webhooks.service";
import {
    autoScheduleRequestHash,
    hashAutoScheduleIdempotencyKey,
    normalizeAutoScheduleIdempotencyKey,
} from "./auto-schedule-idempotency";
import {
    normalizeSchedulePublishIdempotencyKey,
    schedulePublishOperationId,
    schedulePublishRequestHash,
} from "./schedule-publish-idempotency";
import {
    assertSchedulePublishCredits,
    buildSchedulePublishPreflight,
    buildSchedulePublishSettlement,
    isSchedulePublishSettlement,
    parseSchedulePublishAcceptedContract,
    schedulePublishContractMatches,
    schedulePublishLedgerId,
    type SchedulePublishAcceptedContract,
    type SchedulePublishPreflight,
    type SchedulePublishSettlement,
} from "./schedule-publish-settlement";
import {
    assertAvailabilityWindow,
    availabilityDayName,
    availabilityTime,
    availabilityWindowsCoverLocalSegment,
    type PersistedAvailabilityWindow,
} from "./schedule-availability";
import {
    ScheduleSolveOutboxPublisher,
    type ScheduleSolveQueueJob,
} from "./schedule-solve-outbox.publisher";
import {
    assertScheduleSolveCreditProvenance,
    ScheduleSolveCreditProvenanceError,
    summarizeScheduleSolveCreditRows,
    type ScheduleSolveCreditRow,
} from "./schedule-solve-credit-provenance";
import {
    aggregateExistingWeeklyMinutes,
    calendarWeekRange,
    type ExistingShiftRange,
    type ExistingWeeklyMinutes,
} from "./schedule-weekly-hours";
type AuthenticatedUser = {
    tenantId: string;
    sub?: string;
    id?: string;
    role?: string;
    legacyRole?: string;
    roles?: string[];
};

type AuthenticatedRequest = {
    user: AuthenticatedUser;
};

type ScheduleListQuery = {
    startDate?: string;
    endDate?: string;
    locationId?: string;
    limit?: string | number;
    cursor?: string | null;
};

type CreateScheduleRequest = {
    locationId: string;
    startDate: string;
    endDate: string;
};

type ReplaceDemandWindowsRequest = {
    windows?: unknown[];
};

type AutoScheduleRequest = {
    constraints?: unknown;
    confirmReplace?: boolean;
};

type SchedulePublishRequest = {
    acceptedContract?: unknown;
};

type AutoScheduleConstraints = Record<string, unknown>;

type CreditConsumption = {
    consumedCredits: number;
    newBalance: number;
    source: "credits";
};

type ScheduleSolveSettlementRow = ScheduleSolveCreditRow & {
    balanceAfter: number | bigint | null;
};

type ScheduleSolveJobRow = {
    id: string;
    scheduleId: string;
    locationId: string;
    requestKeyHash?: string;
    requestHash?: string;
    status: string;
    statusReason: string | null;
    retryCount: number | bigint | null;
    resultShiftCount: number | bigint | null;
    requestedConstraints: Prisma.JsonValue | null;
    staffSnapshot: Prisma.JsonValue | null;
    demandSnapshot: Prisma.JsonValue | null;
    creditConsumption: Prisma.JsonValue | null;
    publicationStatus: string;
    publishAttempts: number | bigint | null;
    nextPublishAt: Date | string | null;
    publishedAt: Date | string | null;
    publishLastError: string | null;
    startedAt: Date | string | null;
    completedAt: Date | string | null;
    createdAt: Date | string | null;
    updatedAt: Date | string | null;
};

type DemandWindowRow = {
    id: string;
    startTime: Date | string;
    endTime: Date | string;
    requiredStaff: number | bigint;
    skill: string | null;
};

type DemandSchedule = {
    id: string;
    status: string;
    locationId: string;
    startDate: Date;
    endDate: Date;
    timezone: string;
};

type CreateScheduleSolveJobArgs = {
    jobId: string;
    tenantId: string;
    scheduleId: string;
    locationId: string;
    requestKeyHash: string;
    requestHash: string;
    constraints: AutoScheduleConstraints;
    staffSnapshot: StaffSnapshot[];
    demandSnapshot: DemandSnapshot[];
    queuePayload: ScheduleSolveQueueJob;
};

type CreditReservationArgs = {
    tenantId: string;
    jobId: string;
    entitlement: FeatureResolution;
};

type StaffAvailabilityPayload = {
    day_of_week: string;
    start_time: string;
    end_time: string;
};

type StaffSnapshot = {
    id: string;
    skills: string[];
    availabilityConfigured: boolean;
    availability: StaffAvailabilityPayload[];
};

type AvailabilityRow = PersistedAvailabilityWindow & {
    userId: string;
};

type StaffSkillRow = {
    userId: string;
    skill: string | null;
};

type DemandSnapshot = {
    id: string;
    start_time: string;
    end_time: string;
    required_staff: number;
    skill: string | null;
};

type ExistingShiftRow = ExistingShiftRange & {
    id: string;
    locationId: string;
};

type ExistingSolveShift = {
    id: string;
    staff_id: string;
    location_id: string;
    start_time: string;
    end_time: string;
};

type PersistedScheduleInputs = {
    staffSnapshot: StaffSnapshot[];
    demandSnapshot: DemandSnapshot[];
    availability: Record<string, StaffAvailabilityPayload[]>;
    availabilityConfigured: Record<string, boolean>;
    staffSkills: Record<string, string[]>;
    dailyDemand: Record<string, number>;
    skillRequirements: Record<string, Record<string, number>>;
    existingWeeklyMinutes: ExistingWeeklyMinutes;
    existingShifts: ExistingSolveShift[];
};

type DraftShiftSnapshotRow = {
    id: string;
    updatedAt: Date | string;
};

type LocationRow = {
    id: string;
    timezone: string | null;
};

type LockedScheduleRow = {
    id: string;
    status: string;
};

type PublishSchedule = {
    id: string;
    status: string;
    locationId: string;
    startDate: Date;
    endDate: Date;
    revision: number;
    timezone: string;
};

type PublishShiftBreak = {
    type: string | null;
    startTime: Date;
    endTime: Date;
};

type PublishShift = {
    id: string;
    userId: string | null;
    startTime: Date;
    endTime: Date;
    user: {
        role?: UserRole | null;
        deletedAt: Date | null;
        suspendedAt?: Date | null;
    } | null;
    breaks: PublishShiftBreak[];
};
const Permission = (perm: string) => SetMetadata("permission", perm);
const SCHEDULE_STATUS = {
    DRAFT: "DRAFT",
    PUBLISHED: "PUBLISHED",
} as const;
const TERMINAL_SCHEDULE_JOB_STATUSES = [
    "SUCCEEDED",
    "FAILED",
    "DEAD_LETTERED",
];
const AUTO_SCHEDULE_CONSTRAINTS = new Set([
    "break_rules",
    "max_hours_per_week",
    "min_floor_coverage",
    "shift_duration_hours",
    "solver_time_limit_seconds",
]);
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
const MAX_AUTO_SCHEDULE_AVAILABILITY_RULES_PER_STAFF = 21;
const MAX_AUTO_SCHEDULE_DEMAND_WINDOWS = 500;
const MAX_AUTO_SCHEDULE_EXISTING_SHIFTS = 10_000;
const DEFAULT_MAX_HOURS_PER_WEEK = 40;
const SCHEDULE_PUBLISH_ACTION = "SCHEDULE_PUBLISH";
const SCHEDULE_PUBLISH_IDEMPOTENCY_RESOURCE = "SchedulePublishRequest";

@Controller({ path: "schedules", version: "1" })
@UseGuards(JwtAuthGuard, RbacGuard)
export class SchedulesController implements OnModuleInit, OnModuleDestroy {
    private readonly tenantDb: TenantPrismaService;
    private readonly scheduleOutbox: ScheduleSolveOutboxPublisher;

    constructor(
        private readonly notificationsService: NotificationsService,
        private readonly featureAccessService: FeatureAccessService,
        @Optional() tenantDb?: TenantPrismaService,
        @Optional() _meteringService?: MeteringService,
        @Optional() private readonly webhooksService?: WebhooksService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
        this.scheduleOutbox = new ScheduleSolveOutboxPublisher(this.tenantDb);
    }
    onModuleInit() {
        this.scheduleOutbox.start();
    }
    async onModuleDestroy() {
        await this.scheduleOutbox.stop();
    }
    @Get()
    @Permission("schedules:read")
    async findAll(@Req() req: AuthenticatedRequest, @Query() query: ScheduleListQuery = {}) {
        const tenantId = req.user.tenantId;
        const listQuery = query ?? {};
        const window = {
            startDate: parseOptionalBoundedDate(listQuery.startDate, "startDate"),
            endDate: parseOptionalBoundedDate(listQuery.endDate, "endDate"),
        };
        assertBoundedListWindow(window);
        const limit = parseBoundedListLimit(listQuery.limit);
        const cursor = decodeBoundedListCursor(listQuery.cursor);
        const where = this.scheduleReadWhere(tenantId, req);
        const and = [];
        if (typeof listQuery.locationId === "string" && listQuery.locationId.trim()) {
            where.locationId = listQuery.locationId.trim();
        }
        if (window.startDate)
            and.push({ endDate: { gt: window.startDate } });
        if (window.endDate)
            and.push({ startDate: { lt: window.endDate } });
        if (cursor) {
            and.push({
                OR: [
                    { startDate: { lt: cursor.timestamp } },
                    { startDate: cursor.timestamp, id: { lt: cursor.id } },
                ],
            });
        }
        if (and.length > 0) {
            where.AND = [...(Array.isArray(where.AND) ? where.AND : []), ...and];
        }
        const rows = await this.tenantDb.withTenant(tenantId, (tx) => tx.schedule.findMany({
            where,
            orderBy: [{ startDate: "desc" }, { id: "desc" }],
            take: limit + 1,
        }));
        return {
            ...buildBoundedListPage(rows, limit, (schedule) => schedule.startDate, window),
            tenantId,
        };
    }
    @Get(":id")
    @Permission("schedules:read")
    async findOne(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
        const tenantId = req.user.tenantId;
        const schedule = await this.tenantDb.withTenant(tenantId, (tx) => tx.schedule.findFirst({
            where: { id, ...this.scheduleReadWhere(tenantId, req) },
        }));
        if (!schedule)
            throw new NotFoundException("Schedule not found");
        return schedule;
    }
    @Get(":id/demand-windows")
    @Permission("schedules:write")
    async findDemandWindows(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
        const tenantId = req.user.tenantId;
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const schedule = await tx.schedule.findFirst({
                where: { id, ...this.scheduleReadWhere(tenantId, req) },
                select: { id: true, locationId: true },
            });
            if (!schedule)
                throw new NotFoundException("Schedule not found");
            const rows = await this.readDemandWindows(tx, tenantId, schedule.id, schedule.locationId);
            return { data: rows.map((row) => this.serializeDemandWindow(row)) };
        });
    }
    @Put(":id/demand-windows")
    @Permission("schedules:write")
    async replaceDemandWindows(@Param("id") id: string, @Body() body: ReplaceDemandWindowsRequest, @Req() req: AuthenticatedRequest) {
        const tenantId = req.user.tenantId;
        const rawWindows = body?.windows;
        if (!Array.isArray(rawWindows)) {
            throw new BadRequestException("windows must be an array");
        }
        if (rawWindows.length > MAX_AUTO_SCHEDULE_DEMAND_WINDOWS) {
            throw new BadRequestException(`Demand windows cannot exceed ${MAX_AUTO_SCHEDULE_DEMAND_WINDOWS} entries.`);
        }
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, "scheduling");
            const schedule = await this.lockDraftScheduleForDemand(tx, id, tenantId);
            const windows = rawWindows.map((value, index) => this.normalizeDemandWindowInput(value, index, tenantId, schedule));
            await tx.scheduleDemandWindow.deleteMany({
                where: { tenantId, scheduleId: schedule.id },
            });
            if (windows.length > 0) {
                await tx.scheduleDemandWindow.createMany({ data: windows });
            }
            await tx.schedule.updateMany({
                where: {
                    id: schedule.id,
                    tenantId,
                    locationId: schedule.locationId,
                    status: SCHEDULE_STATUS.DRAFT,
                    deletedAt: null,
                },
                data: { revision: { increment: 1 } },
            });
            const rows = await this.readDemandWindows(tx, tenantId, schedule.id, schedule.locationId);
            return { data: rows.map((row) => this.serializeDemandWindow(row)) };
        });
    }
    @Get(":id/auto-schedule/jobs/:jobId")
    @Permission("schedules:write")
    async findAutoScheduleJob(@Param("id") id: string, @Param("jobId") jobId: string, @Req() req: AuthenticatedRequest) {
        const tenantId = req.user.tenantId;
        const canReadTeam = !this.isStaffUser(req);
        const actorUserId = this.actorUserId(req);
        const rows = await this.tenantDb.withTenant(tenantId, (tx) => tx.$queryRaw<ScheduleSolveJobRow[]>`
            SELECT
                "id",
                "scheduleId",
                "locationId",
                "status",
                "statusReason",
                "retryCount",
                "resultShiftCount",
                "requestedConstraints",
                "staffSnapshot",
                "demandSnapshot",
                "creditConsumption",
                "publicationStatus",
                "publishAttempts",
                "nextPublishAt",
                "publishedAt",
                "publishLastError",
                "startedAt",
                "completedAt",
                "createdAt",
                "updatedAt"
            FROM "ScheduleSolveJob"
            WHERE "id" = ${jobId}
              AND "scheduleId" = ${id}
              AND "tenantId" = ${tenantId}
              AND (
                ${canReadTeam}
                OR EXISTS (
                    SELECT 1
                    FROM "Shift"
                    JOIN "Schedule" ON "Schedule"."id" = "Shift"."scheduleId"
                    WHERE "Shift"."tenantId" = ${tenantId}
                      AND "Shift"."scheduleId" = ${id}
                      AND "Shift"."userId" = ${actorUserId}
                      AND "Shift"."deletedAt" IS NULL
                      AND "Schedule"."status" = 'PUBLISHED'
                )
              )
            LIMIT 1
        `);
        const job = rows[0];
        if (!job)
            throw new NotFoundException("Auto-schedule job not found");
        return this.serializeScheduleSolveJob(job);
    }
    @Post()
    @Permission("schedules:write")
    async create(@Body() body: CreateScheduleRequest, @Req() req: AuthenticatedRequest) {
        const tenantId = req.user.tenantId;
        const syntaxStart = this.parseScheduleDate(body.startDate, "startDate", "UTC");
        const syntaxEnd = this.parseScheduleDate(body.endDate, "endDate", "UTC");
        this.assertScheduleWindow(syntaxStart, syntaxEnd);
        const schedule = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, "scheduling");
            const location = await this.assertLocationInTenant(tx, body.locationId, tenantId);
            const startDate = this.parseScheduleDate(body.startDate, "startDate", location.timezone);
            const endDate = this.parseScheduleDate(body.endDate, "endDate", location.timezone);
            this.assertScheduleWindow(startDate, endDate);
            await this.assertNoScheduleOverlap(tx, tenantId, body.locationId, startDate, endDate);
            return tx.schedule.create({
                data: {
                    tenantId,
                    locationId: body.locationId,
                    startDate,
                    endDate,
                    status: SCHEDULE_STATUS.DRAFT,
                },
            });
        });
        return schedule;
    }
    @Delete(":id")
    @Permission("schedules:write")
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<void> {
        const tenantId = req.user.tenantId;
        await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, "scheduling");
            const lockedRows = await tx.$queryRaw<LockedScheduleRow[]>`
                SELECT "id", "status"
                FROM "Schedule"
                WHERE "id" = ${id}
                  AND "tenantId" = ${tenantId}
                  AND "deletedAt" IS NULL
                FOR UPDATE
            `;
            if (!lockedRows[0])
                throw new NotFoundException("Schedule not found");
            if (lockedRows[0].status !== SCHEDULE_STATUS.DRAFT) {
                throw new BadRequestException("Published schedules are locked. Reopen the schedule before deleting it.");
            }
            const activeJobs = await tx.$queryRaw<LockedScheduleRow[]>`
                SELECT "id", "status"
                FROM "ScheduleSolveJob"
                WHERE "tenantId" = ${tenantId}
                  AND "scheduleId" = ${id}
                  AND "status" NOT IN (${Prisma.join([...TERMINAL_SCHEDULE_JOB_STATUSES])})
                ORDER BY "id" ASC
                FOR UPDATE
            `;
            if (activeJobs.length > 0) {
                throw new ConflictException("Wait for active auto-schedule jobs to finish before deleting this draft.");
            }
            const deletedAt = new Date();
            await tx.shift.updateMany({
                where: { tenantId, scheduleId: id, deletedAt: null },
                data: { deletedAt },
            });
            const removed = await tx.schedule.updateMany({
                where: { id, tenantId, status: SCHEDULE_STATUS.DRAFT, deletedAt: null },
                data: { deletedAt },
            });
            if (removed.count !== 1)
                throw new ConflictException("Schedule changed before it could be deleted.");
        });
    }
    @Get(":id/publish/preflight")
    @Permission("schedules:publish")
    async publishPreflight(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
        const tenantId = req.user.tenantId;
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const schedule = await tx.schedule.findFirst({
                where: {
                    id,
                    tenantId,
                    status: SCHEDULE_STATUS.DRAFT,
                    deletedAt: null,
                    location: { is: { deletedAt: null } },
                },
                select: { id: true, revision: true },
            });
            if (!schedule) {
                throw new NotFoundException("Draft schedule not found");
            }
            const schedulingEntitlement = await this.featureAccessService.assertFeatureEntitledInTransaction(
                tx,
                tenantId,
                "scheduling",
            );
            const { preflight } = await this.prepareSchedulePublishCost(
                tx,
                tenantId,
                schedulingEntitlement,
                schedule.revision,
            );
            return { scheduleId: id, ...preflight };
        });
    }
    /**
     * Publish a schedule - triggers notification to all affected staff.
     */
    @Post(":id/publish")
    @Permission("schedules:publish")
    @HttpCode(HttpStatus.OK)
    async publish(
        @Param("id") id: string,
        @Req() req: AuthenticatedRequest,
        @Headers("idempotency-key") idempotencyKey?: string,
        @Body() body?: SchedulePublishRequest,
    ) {
        const tenantId = req.user.tenantId;
        const acceptedContract = parseSchedulePublishAcceptedContract(body?.acceptedContract);
        const operationId = schedulePublishOperationId(
            tenantId,
            id,
            normalizeSchedulePublishIdempotencyKey(idempotencyKey),
        );
        const requestHash = schedulePublishRequestHash(tenantId, id, acceptedContract);
        const replay = await this.tenantDb.withTenant(tenantId, (tx) => (
            this.findSchedulePublishReplay(tx, tenantId, operationId, requestHash)
        ));
        if (replay) {
            const notifications = await this.notificationsService.deliverPendingNow(
                tenantId,
                replay.notificationDedupeKeys,
            );
            return { ...replay.response, notifications };
        }
        const now = new Date();
        const published = await this.tenantDb.withTenant(tenantId, async (tx) => {
            const lockedReplay = await this.findSchedulePublishReplay(tx, tenantId, operationId, requestHash);
            if (lockedReplay) return lockedReplay;
            const schedulingEntitlement = await this.featureAccessService.assertFeatureEntitledInTransaction(
                tx,
                tenantId,
                "scheduling",
            );
            const serializedReplay = await this.findSchedulePublishReplay(tx, tenantId, operationId, requestHash);
            if (serializedReplay) return serializedReplay;
            await this.lockTenantSchedulingMutations(tx, tenantId);
            const lockedSchedule = await this.lockDraftScheduleForPublish(tx, id, tenantId);
            const activeSolveJobs = await tx.$queryRaw<LockedScheduleRow[]>`
                SELECT "id", "status"
                FROM "ScheduleSolveJob"
                WHERE "tenantId" = ${tenantId}
                  AND "scheduleId" = ${id}
                  AND "status" NOT IN (${Prisma.join([...TERMINAL_SCHEDULE_JOB_STATUSES])})
                ORDER BY "id" ASC
                FOR UPDATE
            `;
            if (activeSolveJobs.length > 0) {
                throw new ConflictException("Wait for active auto-schedule jobs to finish before publishing this draft.");
            }
            const shiftsForPublish = await tx.shift.findMany({
                where: {
                    tenantId,
                    scheduleId: id,
                    deletedAt: null,
                },
                select: {
                    id: true,
                    userId: true,
                    startTime: true,
                    endTime: true,
                    user: { select: { role: true, deletedAt: true, suspendedAt: true } },
                    breaks: {
                        select: { type: true, startTime: true, endTime: true },
                        orderBy: { startTime: "asc" },
                    },
                },
                orderBy: { startTime: "asc" },
            });
            this.assertPublishableShifts(shiftsForPublish, lockedSchedule);
            await this.assertPublishReadiness(tx, tenantId, id, lockedSchedule.locationId, lockedSchedule.timezone, shiftsForPublish);
            const scheduleForPublish = await tx.schedule.findFirst({
                where: { id, tenantId, deletedAt: null },
                include: {
                    location: { select: { name: true, timezone: true } },
                },
            });
            if (!scheduleForPublish) {
                throw new NotFoundException("Schedule to publish not found");
            }
            const settlement = await this.settleSchedulePublishInTransaction(tx, {
                tenantId,
                scheduleId: id,
                operationId,
                schedulingEntitlement,
                acceptedContract,
                scheduleVersion: lockedSchedule.revision,
                occurredAt: now,
                eventData: {
                    scheduleId: scheduleForPublish.id,
                    locationId: lockedSchedule.locationId,
                    startDate: scheduleForPublish.startDate.toISOString(),
                    endDate: scheduleForPublish.endDate.toISOString(),
                    publishedAt: now.toISOString(),
                    assignedShiftCount: shiftsForPublish.length,
                },
            });
            const schedule = await tx.schedule.updateMany({
                where: {
                    id,
                    tenantId,
                    status: SCHEDULE_STATUS.DRAFT,
                    deletedAt: null,
                },
                data: { status: SCHEDULE_STATUS.PUBLISHED, publishedAt: now },
            });
            if (schedule.count === 0) {
                throw new NotFoundException("Draft schedule not found or already published");
            }
            const assignedUserIds = Array.from(new Set(shiftsForPublish
                .map((shift) => shift.userId)
                .filter((userId): userId is string => Boolean(userId))));
            const notificationBody = `${scheduleForPublish.location.name}: ${formatDateInTimeZone(scheduleForPublish.startDate, scheduleForPublish.location.timezone)} to ${formatDateInTimeZone(new Date(scheduleForPublish.endDate.getTime() - 1), scheduleForPublish.location.timezone)}`;
            const publicationKey = `revision-${lockedSchedule.revision}`;
            const notificationDedupeKeys = assignedUserIds.map((userId) => `schedule-published:${id}:${publicationKey}:${userId}`);
            await this.notificationsService.enqueueInTransaction(tx, assignedUserIds.map((userId, index) => ({
                tenantId,
                userId,
                dedupeKey: notificationDedupeKeys[index],
                type: NotificationType.SCHEDULE_PUBLISHED,
                title: "Schedule published",
                body: notificationBody,
            })));
            const response = {
                id,
                status: SCHEDULE_STATUS.PUBLISHED,
                publishedAt: now.toISOString(),
                settlement,
            };
            const actorUserId = this.actorUserId(req) ?? null;
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: actorUserId,
                    actorUserId,
                    actorTenantId: tenantId,
                    action: SCHEDULE_PUBLISH_ACTION,
                    resource: SCHEDULE_PUBLISH_IDEMPOTENCY_RESOURCE,
                    resourceId: operationId,
                    newValue: {
                        requestHash,
                        acceptedContract,
                        response,
                        notificationDedupeKeys,
                    },
                },
            });
            return { response, notificationDedupeKeys };
        });
        const notificationSummary = await this.notificationsService.deliverPendingNow(
            tenantId,
            published.notificationDedupeKeys,
        );
        return {
            ...published.response,
            notifications: notificationSummary,
        };
    }

    /**
     * Request auto-schedule from the Python engine via gRPC.
     */
    @Post(":id/auto-schedule")
    @Permission("schedules:write")
    @HttpCode(HttpStatus.ACCEPTED)
    async autoSchedule(
        @Param("id") id: string,
        @Req() req: AuthenticatedRequest,
        @Body() body: AutoScheduleRequest | undefined,
        @Headers("idempotency-key") idempotencyKey?: string,
    ) {
        const tenantId = req.user.tenantId;
        const constraints = this.normalizeAutoScheduleConstraints(body?.constraints);
        const requestKeyHash = hashAutoScheduleIdempotencyKey(normalizeAutoScheduleIdempotencyKey(idempotencyKey));
        const requestHash = autoScheduleRequestHash(constraints, body?.confirmReplace === true);
        const jobId = `schedule-${id}-${randomUUID()}`;
        const prepared = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.lockTenantInTransaction(tx, tenantId);
            await this.lockDraftScheduleForAutoSchedule(tx, id, tenantId);
            const activeJobs = await this.lockActiveScheduleSolveJobs(tx, tenantId, id);
            const existingJob = await this.findScheduleSolveJobByRequestKey(tx, tenantId, id, requestKeyHash);
            if (existingJob) {
                this.assertIdempotentRequestMatch(existingJob, requestHash);
                if (!TERMINAL_SCHEDULE_JOB_STATUSES.includes(existingJob.status)) {
                    await this.featureAccessService.assertFeatureEntitledInTransaction(
                        tx,
                        tenantId,
                        "scheduling",
                    );
                    const paidJob = await this.requireExactlyOnePaidActiveScheduleSolveJob(
                        tx,
                        tenantId,
                        activeJobs,
                    );
                    if (paidJob.id !== existingJob.id) {
                        throw new ConflictException("Active auto-schedule recovery ownership is ambiguous.");
                    }
                } else {
                    await this.requireScheduleSolveJobPaidProvenance(tx, tenantId, existingJob);
                }
                return { existingJob };
            }
            if (activeJobs.length > 0) {
                await this.featureAccessService.assertFeatureEntitledInTransaction(
                    tx,
                    tenantId,
                    "scheduling",
                );
                const activeJob = await this.requireExactlyOnePaidActiveScheduleSolveJob(
                    tx,
                    tenantId,
                    activeJobs,
                );
                if (activeJob.requestKeyHash === requestKeyHash) {
                    this.assertIdempotentRequestMatch(activeJob, requestHash);
                }
                return { existingJob: activeJob };
            }
            const schedulingEntitlement =
                await this.featureAccessService.assertFeatureEnabledInTransaction(
                    tx,
                    tenantId,
                    "scheduling",
                );
            this.requirePositiveAutoScheduleCredit(schedulingEntitlement);
            const schedule = await tx.schedule.findFirst({
                where: { id, tenantId, deletedAt: null },
                select: {
                    id: true,
                    locationId: true,
                    startDate: true,
                    endDate: true,
                    revision: true,
                    updatedAt: true,
                    status: true,
                    location: { select: { timezone: true } },
                },
            });
            if (!schedule)
                throw new NotFoundException("Schedule not found");
            if (schedule.status !== SCHEDULE_STATUS.DRAFT) {
                throw new BadRequestException("Only draft schedules can be auto-scheduled.");
            }
            const existingShiftCount = await tx.shift.count({
                where: { tenantId, scheduleId: schedule.id, deletedAt: null },
            });
            if (existingShiftCount > 0 && body?.confirmReplace !== true) {
                throw new BadRequestException("Auto-scheduling will replace existing draft shifts. Confirm replacement to continue.");
            }
            const timeZone = normalizeTimeZone(schedule.location?.timezone);
            const draftShiftRows = await tx.$queryRaw<DraftShiftSnapshotRow[]>`
                SELECT "id", "updatedAt"
                FROM "Shift"
                WHERE "tenantId" = ${tenantId}
                  AND "scheduleId" = ${schedule.id}
                  AND "deletedAt" IS NULL
                ORDER BY "id" ASC
            `;
            const inputShiftSnapshot = draftShiftRows.map((row) => ({
                id: row.id,
                updated_at: this.toRequiredIso(row.updatedAt, "draft shift updatedAt"),
            }));
            const staff = await tx.user.findMany({
                where: {
                    tenantId,
                    ...ACTIVE_SCHEDULABLE_USER_FILTER,
                },
                orderBy: { name: "asc" },
                select: { id: true },
            });
            if (staff.length === 0) {
                throw new BadRequestException("Add at least one schedulable staff member before auto-scheduling.");
            }
            const staffIds = staff.map((user) => user.id);
            const persistedInputs = await this.loadPersistedScheduleInputs(tx, tenantId, schedule.id, schedule.locationId, staffIds, schedule.startDate, schedule.endDate, timeZone);
            const payload = {
                schedule_id: schedule.id,
                tenant_id: tenantId,
                location_id: schedule.locationId,
                start_date: schedule.startDate.toISOString(),
                end_date: schedule.endDate.toISOString(),
                draft_revision: Number(schedule.revision ?? 0),
                input_shift_snapshot: inputShiftSnapshot,
                staff_ids: staffIds,
                constraints,
                availability: persistedInputs.availability,
                availability_configured: persistedInputs.availabilityConfigured,
                staff_skills: persistedInputs.staffSkills,
                daily_demand: persistedInputs.dailyDemand,
                skill_requirements: persistedInputs.skillRequirements,
                demand_windows: persistedInputs.demandSnapshot,
                timezone: timeZone,
                existing_weekly_minutes: persistedInputs.existingWeeklyMinutes,
                existing_shifts: persistedInputs.existingShifts,
            };
            const job: ScheduleSolveQueueJob = {
                type: "schedule.solve",
                job_id: jobId,
                payload,
            };
            const inserted = await this.createScheduleSolveJob(tx, {
                jobId,
                tenantId,
                scheduleId: schedule.id,
                locationId: schedule.locationId,
                requestKeyHash,
                requestHash,
                constraints,
                staffSnapshot: persistedInputs.staffSnapshot,
                demandSnapshot: persistedInputs.demandSnapshot,
                queuePayload: job,
            });
            if (!inserted) {
                const racedJob = await this.findScheduleSolveJobByRequestKey(tx, tenantId, id, requestKeyHash);
                if (!racedJob) {
                    throw new ServiceUnavailableException("Unable to reuse auto-schedule request");
                }
                this.assertIdempotentRequestMatch(racedJob, requestHash);
                if (!TERMINAL_SCHEDULE_JOB_STATUSES.includes(racedJob.status)) {
                    const racedActiveJobs = await this.lockActiveScheduleSolveJobs(tx, tenantId, id);
                    const paidJob = await this.requireExactlyOnePaidActiveScheduleSolveJob(
                        tx,
                        tenantId,
                        racedActiveJobs,
                    );
                    if (paidJob.id !== racedJob.id) {
                        throw new ConflictException("Active auto-schedule recovery ownership is ambiguous.");
                    }
                } else {
                    await this.requireScheduleSolveJobPaidProvenance(tx, tenantId, racedJob);
                }
                return { existingJob: racedJob };
            }
            const creditConsumption = await this.reserveAutoScheduleCredit(tx, {
                tenantId,
                jobId,
                entitlement: schedulingEntitlement,
            });
            await this.recordScheduleSolveJobCreditConsumptionInTransaction(tx, tenantId, jobId, creditConsumption);
            return {
                job,
                creditConsumption,
            };
        });
        if (prepared.existingJob) {
            return this.reusedAutoScheduleResponse(id, prepared.existingJob);
        }
        const job = prepared.job;
        await this.enqueueSolveJob(job);
        return {
            jobId,
            status: "QUEUED",
            statusUrl: `/v1/schedules/${id}/auto-schedule/jobs/${jobId}`,
            creditConsumption: prepared.creditConsumption,
            publicationStatus: "PENDING",
            reused: false,
        };
    }
    @Post(":id/reopen")
    @Permission("schedules:publish")
    @HttpCode(HttpStatus.OK)
    async reopen(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
        const tenantId = req.user.tenantId;
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, "scheduling");
            const rows = await tx.$queryRaw<LockedScheduleRow[]>`
                SELECT "id", "status"
                FROM "Schedule"
                WHERE "id" = ${id}
                  AND "tenantId" = ${tenantId}
                  AND "deletedAt" IS NULL
                FOR UPDATE
            `;
            const schedule = rows[0];
            if (!schedule)
                throw new NotFoundException("Schedule not found");
            if (schedule.status !== SCHEDULE_STATUS.PUBLISHED) {
                throw new BadRequestException("Only published schedules can be reopened.");
            }
            const reopened = await tx.schedule.updateMany({
                where: {
                    id,
                    tenantId,
                    status: SCHEDULE_STATUS.PUBLISHED,
                    deletedAt: null,
                },
                data: {
                    status: SCHEDULE_STATUS.DRAFT,
                    publishedAt: null,
                    revision: { increment: 1 },
                },
            });
            if (reopened.count !== 1) {
                throw new BadRequestException("Schedule changed before it could be reopened.");
            }
            return { id, status: SCHEDULE_STATUS.DRAFT, publishedAt: null };
        });
    }
    private normalizeAutoScheduleConstraints(value: unknown): AutoScheduleConstraints {
        if (value === undefined || value === null)
            return {};
        if (typeof value !== "object" || Array.isArray(value)) {
            throw new BadRequestException("constraints must be an object");
        }
        const constraints = value as AutoScheduleConstraints;
        for (const key of Object.keys(constraints)) {
            if (!AUTO_SCHEDULE_CONSTRAINTS.has(key)) {
                throw new BadRequestException(`Unsupported auto-schedule constraint: ${key}`);
            }
        }
        if (JSON.stringify(constraints).length > 16_384) {
            throw new BadRequestException("constraints payload is too large");
        }
        return constraints;
    }
    private async loadPersistedScheduleInputs(tx: TenantPrismaTransaction, tenantId: string, scheduleId: string, locationId: string, staffIds: string[], scheduleStart: Date, scheduleEnd: Date, timeZone: string): Promise<PersistedScheduleInputs> {
        const staffSnapshot = new Map<string, StaffSnapshot>(staffIds.map((id) => [id, {
                id,
                skills: [],
                availabilityConfigured: false,
                availability: [],
            }]));
        if (staffIds.length === 0) {
            return {
                staffSnapshot: [],
                demandSnapshot: [],
                availability: {},
                availabilityConfigured: {},
                staffSkills: {},
                dailyDemand: {},
                skillRequirements: {},
                existingWeeklyMinutes: {},
                existingShifts: [],
            };
        }
        const availabilityRows = await tx.$queryRaw<AvailabilityRow[]>`
            SELECT "userId", "dayOfWeek", "startTimeMinutes", "endTimeMinutes"
            FROM "StaffAvailability"
            WHERE "tenantId" = ${tenantId}
              AND "userId" IN (${Prisma.join(staffIds)})
              AND ("locationId" IS NULL OR "locationId" = ${locationId})
            ORDER BY "userId" ASC, "dayOfWeek" ASC, "startTimeMinutes" ASC, "locationId" NULLS FIRST
        `;
        for (const row of availabilityRows) {
            const staff = staffSnapshot.get(row.userId);
            if (!staff)
                continue;
            if (staff.availability.length >=
                MAX_AUTO_SCHEDULE_AVAILABILITY_RULES_PER_STAFF) {
                throw new BadRequestException("Availability cannot exceed 21 rules per staff member.");
            }
            assertAvailabilityWindow(row);
            staff.availability.push({
                day_of_week: availabilityDayName(row.dayOfWeek),
                start_time: availabilityTime(row.startTimeMinutes, "availability startTimeMinutes"),
                end_time: availabilityTime(row.endTimeMinutes, "availability endTimeMinutes"),
            });
            staff.availabilityConfigured = true;
        }
        const skillRows = await tx.$queryRaw<StaffSkillRow[]>`
            SELECT "userId", "skill"
            FROM "StaffSkill"
            WHERE "tenantId" = ${tenantId}
              AND "userId" IN (${Prisma.join(staffIds)})
            ORDER BY "userId" ASC, "skill" ASC
        `;
        for (const row of skillRows) {
            const staff = staffSnapshot.get(row.userId);
            const skill = typeof row.skill === "string" ? row.skill.trim() : "";
            if (!staff || !skill || staff.skills.includes(skill))
                continue;
            staff.skills.push(skill);
        }
        const demandRows = await tx.$queryRaw<DemandWindowRow[]>`
            SELECT "id", "startTime", "endTime", "requiredStaff", "skill"
            FROM "ScheduleDemandWindow"
            WHERE "tenantId" = ${tenantId}
              AND "scheduleId" = ${scheduleId}
              AND "locationId" = ${locationId}
            ORDER BY "startTime" ASC, "id" ASC
        `;
        const demandSnapshot = demandRows.map((row) => {
            const startTime = this.toRequiredIso(row.startTime, "demand window startTime");
            const endTime = this.toRequiredIso(row.endTime, "demand window endTime");
            if (new Date(endTime) <= new Date(startTime)) {
                throw new BadRequestException("Invalid demand window. endTime must be after startTime.");
            }
            return {
                id: row.id,
                start_time: startTime,
                end_time: endTime,
                required_staff: this.requiredStaffCount(row.requiredStaff),
                skill: typeof row.skill === "string" && row.skill.trim()
                    ? row.skill.trim()
                    : null,
            };
        });
        if (demandSnapshot.length === 0) {
            throw new BadRequestException("Configure at least one demand window with a date, start/end time, and required staff before auto-scheduling.");
        }
        const calendarWeeks = calendarWeekRange(scheduleStart, scheduleEnd, timeZone);
        const existingShiftRows = await tx.$queryRaw<ExistingShiftRow[]>`
            SELECT shift."id", shift."userId", shift."locationId", shift."startTime", shift."endTime"
            FROM "Shift" shift
            LEFT JOIN "Schedule" source_schedule ON source_schedule."id" = shift."scheduleId"
            WHERE shift."tenantId" = ${tenantId}
              AND shift."userId" IN (${Prisma.join(staffIds)})
              AND shift."deletedAt" IS NULL
              AND (shift."scheduleId" IS NULL OR shift."scheduleId" <> ${scheduleId})
              AND (source_schedule."id" IS NULL OR (source_schedule."deletedAt" IS NULL AND source_schedule."status" <> 'ARCHIVED'))
              AND shift."startTime" < ${calendarWeeks.end}
              AND shift."endTime" > ${calendarWeeks.start}
            ORDER BY shift."userId" ASC, shift."startTime" ASC, shift."id" ASC
        `;
        const existingWeeklyMinutes = aggregateExistingWeeklyMinutes(existingShiftRows, calendarWeeks, staffIds);
        const existingShifts = existingShiftRows
            .filter((row): row is ExistingShiftRow & { userId: string } => Boolean(row.userId) &&
            this.requiredDate(row.startTime, "existing shift startTime") < scheduleEnd &&
            this.requiredDate(row.endTime, "existing shift endTime") > scheduleStart)
            .map((row) => {
            const startTime = this.toRequiredIso(row.startTime, "existing shift startTime");
            const endTime = this.toRequiredIso(row.endTime, "existing shift endTime");
            if (new Date(endTime) <= new Date(startTime)) {
                throw new BadRequestException("Invalid existing shift interval.");
            }
            return {
                id: row.id,
                staff_id: row.userId,
                location_id: row.locationId,
                start_time: startTime,
                end_time: endTime,
            };
        });
        if (existingShifts.length > MAX_AUTO_SCHEDULE_EXISTING_SHIFTS) {
            throw new BadRequestException(`Existing shift intervals cannot exceed ${MAX_AUTO_SCHEDULE_EXISTING_SHIFTS} entries.`);
        }
        const dailyDemand: Record<string, number> = {};
        const skillRequirements: Record<string, Record<string, number>> = {};
        for (const row of demandRows) {
            for (const segment of splitInstantRangeByLocalDay(row.startTime, row.endTime, timeZone)) {
                dailyDemand[segment.weekday] = Math.max(dailyDemand[segment.weekday] ?? 0, this.requiredStaffCount(row.requiredStaff));
                const skill = this.normalizeSkill(row.skill);
                if (skill) {
                    const bySkill = skillRequirements[segment.weekday] ?? {};
                    bySkill[skill] = Math.max(bySkill[skill] ?? 0, this.requiredStaffCount(row.requiredStaff));
                    skillRequirements[segment.weekday] = bySkill;
                }
            }
        }
        const staff = Array.from(staffSnapshot.values());
        const availability = Object.fromEntries(staff.map((entry) => [entry.id, entry.availability]));
        const availabilityConfigured = Object.fromEntries(staff.map((entry) => [entry.id, entry.availabilityConfigured]));
        const staffSkills = Object.fromEntries(staff.map((entry) => [entry.id, entry.skills]));
        return {
            staffSnapshot: staff,
            demandSnapshot,
            availability,
            availabilityConfigured,
            staffSkills,
            dailyDemand,
            skillRequirements,
            existingWeeklyMinutes,
            existingShifts,
        };
    }
    private async readDemandWindows(tx: TenantPrismaTransaction, tenantId: string, scheduleId: string, locationId: string): Promise<DemandWindowRow[]> {
        return tx.$queryRaw `
      SELECT "id", "startTime", "endTime", "requiredStaff", "skill"
      FROM "ScheduleDemandWindow"
      WHERE "tenantId" = ${tenantId}
        AND "scheduleId" = ${scheduleId}
        AND "locationId" = ${locationId}
      ORDER BY "startTime" ASC, "id" ASC
    `;
    }
    private serializeDemandWindow(row: DemandWindowRow) {
        return {
            id: row.id,
            startTime: this.toRequiredIso(row.startTime, "demand window startTime"),
            endTime: this.toRequiredIso(row.endTime, "demand window endTime"),
            requiredStaff: this.requiredStaffCount(row.requiredStaff),
            skill: this.normalizeSkill(row.skill),
        };
    }
    private normalizeDemandWindowInput(value: unknown, index: number, tenantId: string, schedule: DemandSchedule): Prisma.ScheduleDemandWindowCreateManyInput {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new BadRequestException(`windows[${index}] must be an object`);
        }
        const input = value as Record<string, unknown>;
        const startTime = this.parseScheduleDate(typeof input.startTime === "string" ? input.startTime : undefined, `windows[${index}].startTime`, schedule.timezone);
        const endTime = this.parseScheduleDate(typeof input.endTime === "string" ? input.endTime : undefined, `windows[${index}].endTime`, schedule.timezone);
        if (endTime <= startTime) {
            throw new BadRequestException(`windows[${index}].endTime must be after startTime`);
        }
        if (startTime < schedule.startDate || endTime > schedule.endDate) {
            throw new BadRequestException(`windows[${index}] must be inside the schedule window`);
        }
        const requiredStaff = this.requiredStaffCount(Number(input.requiredStaff));
        if (requiredStaff > 200) {
            throw new BadRequestException("Demand window requiredStaff cannot exceed 200.");
        }
        const skill = typeof input.skill === "string" ? input.skill.trim().toLowerCase() : "";
        if (input.skill != null && typeof input.skill !== "string") {
            throw new BadRequestException(`windows[${index}].skill must be a string`);
        }
        if (skill.length > 128) {
            throw new BadRequestException(`windows[${index}].skill cannot exceed 128 characters`);
        }
        return {
            id: randomUUID(),
            tenantId,
            scheduleId: schedule.id,
            locationId: schedule.locationId,
            startTime,
            endTime,
            requiredStaff,
            skill: skill || null,
        };
    }
    private requiredStaffCount(value: unknown): number {
        const requiredStaff = Number(value);
        if (!Number.isInteger(requiredStaff) || requiredStaff <= 0) {
            throw new BadRequestException("Invalid demand window requiredStaff. Use a positive integer.");
        }
        return requiredStaff;
    }
    private async enqueueSolveJob(job: ScheduleSolveQueueJob): Promise<void> {
        try {
            await this.scheduleOutbox.publishPendingNow(job.job_id);
        }
        catch {
            // The committed outbox row remains eligible for the startup/poll recovery loop.
        }
    }
    private async createScheduleSolveJob(tx: TenantPrismaTransaction, args: CreateScheduleSolveJobArgs): Promise<boolean> {
        const constraintsJson = JSON.stringify(args.constraints);
        const staffSnapshotJson = JSON.stringify({ staff: args.staffSnapshot });
        const demandSnapshotJson = JSON.stringify({
            demand_windows: args.demandSnapshot,
        });
        const queuePayloadJson = JSON.stringify(args.queuePayload);
        const inserted = await tx.$executeRaw `
            INSERT INTO "ScheduleSolveJob"
                (
                    "id",
                    "tenantId",
                    "scheduleId",
                    "locationId",
                    "requestKeyHash",
                    "requestHash",
                    "status",
                    "requestedConstraints",
                    "staffSnapshot",
                    "demandSnapshot",
                    "queuePayload",
                    "publicationStatus",
                    "nextPublishAt",
                    "createdAt",
                    "updatedAt"
                )
            VALUES (
                ${args.jobId},
                ${args.tenantId},
                ${args.scheduleId},
                ${args.locationId},
                ${args.requestKeyHash},
                ${args.requestHash},
                'QUEUED',
                CAST(${constraintsJson} AS jsonb),
                CAST(${staffSnapshotJson} AS jsonb),
                CAST(${demandSnapshotJson} AS jsonb),
                CAST(${queuePayloadJson} AS jsonb),
                'PENDING',
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT ("tenantId", "scheduleId", "requestKeyHash") DO NOTHING
        `;
        return Number(inserted) === 1;
    }
    private async findScheduleSolveJobByRequestKey(tx: TenantPrismaTransaction, tenantId: string, scheduleId: string, requestKeyHash: string): Promise<ScheduleSolveJobRow | null> {
        const rows = await tx.$queryRaw<ScheduleSolveJobRow[]>`
            SELECT
                "id",
                "scheduleId",
                "locationId",
                "requestKeyHash",
                "requestHash",
                "status",
                "statusReason",
                "retryCount",
                "resultShiftCount",
                "requestedConstraints",
                "staffSnapshot",
                "demandSnapshot",
                "creditConsumption",
                "publicationStatus",
                "publishAttempts",
                "nextPublishAt",
                "publishedAt",
                "publishLastError",
                "startedAt",
                "completedAt",
                "createdAt",
                "updatedAt"
            FROM "ScheduleSolveJob"
            WHERE "tenantId" = ${tenantId}
              AND "scheduleId" = ${scheduleId}
              AND "requestKeyHash" = ${requestKeyHash}
            FOR UPDATE
        `;
        return rows[0] ?? null;
    }
    private async lockActiveScheduleSolveJobs(tx: TenantPrismaTransaction, tenantId: string, scheduleId: string): Promise<ScheduleSolveJobRow[]> {
        return tx.$queryRaw<ScheduleSolveJobRow[]>`
            SELECT
                "id", "scheduleId", "locationId", "requestKeyHash", "requestHash",
                "status", "statusReason", "retryCount", "resultShiftCount",
                "requestedConstraints", "staffSnapshot", "demandSnapshot",
                "creditConsumption", "publicationStatus", "publishAttempts",
                "nextPublishAt", "publishedAt", "publishLastError", "startedAt",
                "completedAt", "createdAt", "updatedAt"
            FROM "ScheduleSolveJob"
            WHERE "tenantId" = ${tenantId}
              AND "scheduleId" = ${scheduleId}
              AND "status" NOT IN (${Prisma.join([...TERMINAL_SCHEDULE_JOB_STATUSES])})
            ORDER BY "createdAt" ASC, "id" ASC
            FOR UPDATE
        `;
    }
    private async requireExactlyOnePaidActiveScheduleSolveJob(
        tx: TenantPrismaTransaction,
        tenantId: string,
        activeJobs: ScheduleSolveJobRow[],
    ): Promise<ScheduleSolveJobRow> {
        if (activeJobs.length !== 1) {
            throw new ConflictException("Active auto-schedule recovery ownership is ambiguous.");
        }
        const job = activeJobs[0];
        await this.requireScheduleSolveJobPaidProvenance(tx, tenantId, job);
        return job;
    }
    private async requireScheduleSolveJobPaidProvenance(
        tx: TenantPrismaTransaction,
        tenantId: string,
        job: ScheduleSolveJobRow,
    ): Promise<void> {
        const debitId = `schedule-credit-${job.id}`;
        const refundId = `schedule-credit-refund-${job.id}`;
        const creditRows = await tx.$queryRaw<ScheduleSolveSettlementRow[]>`
            SELECT "id", "tenantId", "amount", "debtAmount", "reason", "balanceAfter", "debtAfter"
            FROM "CreditTransaction"
            WHERE "id" IN (${debitId}, ${refundId})
            ORDER BY "id" ASC
            FOR UPDATE
        `;
        try {
            const provenance = assertScheduleSolveCreditProvenance({
                jobId: job.id,
                tenantId,
                status: job.status,
                creditConsumption: job.creditConsumption,
                ...summarizeScheduleSolveCreditRows(job.id, creditRows),
            });
            const debit = creditRows.filter((row) => row.id === debitId);
            const refund = creditRows.filter((row) => row.id === refundId);
            if (debit.length !== 1
                || this.scheduleSolveSettlementBalance(debit[0].balanceAfter) !== provenance.newBalance) {
                throw new ScheduleSolveCreditProvenanceError(
                    "Schedule solve debit settlement balance is invalid.",
                );
            }
            if (["FAILED", "DEAD_LETTERED"].includes(job.status)
                && (refund.length !== 1
                    || this.scheduleSolveSettlementBalance(refund[0].balanceAfter) === null)) {
                throw new ScheduleSolveCreditProvenanceError(
                    "Schedule solve refund settlement balance is invalid.",
                );
            }
        } catch (error) {
            if (!(error instanceof ScheduleSolveCreditProvenanceError)) throw error;
            throw new ConflictException("Active auto-schedule recovery paid reservation is invalid.");
        }
    }
    private assertIdempotentRequestMatch(job: ScheduleSolveJobRow, requestHash: string): void {
        if (job.requestHash !== requestHash) {
            throw new ConflictException("Idempotency-Key was already used with a different auto-schedule request.");
        }
    }
    private reusedAutoScheduleResponse(scheduleId: string, job: ScheduleSolveJobRow) {
        return {
            ...this.serializeScheduleSolveJob(job),
            statusUrl: `/v1/schedules/${scheduleId}/auto-schedule/jobs/${job.id}`,
            reused: true,
        };
    }
    private async recordScheduleSolveJobCreditConsumptionInTransaction(tx: TenantPrismaTransaction, tenantId: string, jobId: string, creditConsumption: CreditConsumption): Promise<void> {
        const creditConsumptionJson = JSON.stringify(creditConsumption);
        await tx.$executeRaw `
            UPDATE "ScheduleSolveJob"
            SET
                "creditConsumption" = CAST(${creditConsumptionJson} AS jsonb),
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${jobId}
              AND "tenantId" = ${tenantId}
        `;
    }
    private async reserveAutoScheduleCredit(tx: TenantPrismaTransaction, args: CreditReservationArgs): Promise<CreditConsumption> {
        const settlement = await this.featureAccessService.recordFeatureUsageInTransaction(
            tx,
            args.tenantId,
            args.entitlement,
            `Schedule generation (${args.jobId})`,
            args.jobId,
            `schedule-credit-${args.jobId}`,
        );
        const newBalance = Number(settlement.newBalance);
        if (!Number.isSafeInteger(newBalance) || newBalance < 0) {
            throw new ConflictException("Auto-schedule credit settlement is invalid.");
        }
        return {
            consumedCredits: settlement.consumedCredits,
            newBalance,
            source: "credits",
        };
    }
    private requirePositiveAutoScheduleCredit(entitlement: FeatureResolution): number {
        const creditCost = entitlement.creditCost;
        if (entitlement.source !== "credits"
            || typeof creditCost !== "number"
            || !Number.isSafeInteger(creditCost)
            || creditCost <= 0) {
            throw new ForbiddenException("Auto-scheduling requires an active paid subscription and separately purchased usage credits.");
        }
        return creditCost;
    }
    private scheduleSolveSettlementBalance(value: number | bigint | null): number | null {
        if (value === null) return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }
    private serializeScheduleSolveJob(row: ScheduleSolveJobRow) {
        return {
            jobId: row.id,
            scheduleId: row.scheduleId,
            locationId: row.locationId,
            status: row.status,
            statusReason: row.statusReason ? "Schedule generation failed" : null,
            retryCount: Number(row.retryCount ?? 0),
            resultShiftCount: row.resultShiftCount === null ? null : Number(row.resultShiftCount),
            requestedConstraints: row.requestedConstraints ?? {},
            staffSnapshot: row.staffSnapshot ?? null,
            demandSnapshot: row.demandSnapshot ?? null,
            creditConsumption: row.creditConsumption ?? null,
            publicationStatus: row.publicationStatus,
            publishAttempts: Number(row.publishAttempts ?? 0),
            nextPublishAt: this.toIsoOrNull(row.nextPublishAt),
            publishedAt: this.toIsoOrNull(row.publishedAt),
            publishLastError: row.publishLastError ? "Schedule publication failed" : null,
            startedAt: this.toIsoOrNull(row.startedAt),
            completedAt: this.toIsoOrNull(row.completedAt),
            createdAt: this.toIsoOrNull(row.createdAt),
            updatedAt: this.toIsoOrNull(row.updatedAt),
        };
    }
    private scheduleReadWhere(tenantId: string, req: AuthenticatedRequest): Prisma.ScheduleWhereInput {
        const where: Prisma.ScheduleWhereInput = {
            tenantId,
            deletedAt: null,
            location: { is: { deletedAt: null } },
        };
        if (this.isStaffUser(req)) {
            where.status = SCHEDULE_STATUS.PUBLISHED;
            where.shifts = {
                some: {
                    tenantId,
                    userId: this.actorUserId(req),
                    deletedAt: null,
                },
            };
        }
        return where;
    }
    private isStaffUser(req: AuthenticatedRequest): boolean {
        const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
        return [req.user?.legacyRole, req.user?.role, ...roles].some((role) => this.isRole(role, UserRole.STAFF));
    }
    private isRole(value: unknown, expected: UserRole): boolean {
        return (typeof value === "string" &&
            value
                .trim()
                .replace(/[\s-]+/g, "_")
                .toUpperCase() === expected);
    }
    private actorUserId(req: AuthenticatedRequest): string | undefined {
        return req.user?.sub ?? req.user?.id;
    }
    private toIsoOrNull(value: unknown): string | null {
        if (!value)
            return null;
        if (value instanceof Date)
            return value.toISOString();
        if (typeof value !== "string" && typeof value !== "number") {
            return null;
        }
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime())
            ? parsed.toISOString()
            : typeof value === "string" ? value : null;
    }
    private toRequiredIso(value: unknown, field: string): string {
        const serialized = this.toIsoOrNull(value);
        if (!serialized) {
            throw new BadRequestException(`Invalid ${field}.`);
        }
        return serialized;
    }
    private async assertLocationInTenant(tx: TenantPrismaTransaction, locationId: string, tenantId: string): Promise<{ id: string; timezone: string }> {
        if (!locationId)
            throw new BadRequestException("locationId is required");
        const rows = await tx.$queryRaw<LocationRow[]>`
            SELECT "id", "timezone"
            FROM "Location"
            WHERE "id" = ${locationId}
              AND "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
            FOR UPDATE
        `;
        const location = rows[0];
        if (!location)
            throw new BadRequestException("Location is not available for this tenant.");
        return { ...location, timezone: normalizeTimeZone(location.timezone) };
    }
    private async assertNoScheduleOverlap(tx: TenantPrismaTransaction, tenantId: string, locationId: string, startDate: Date, endDate: Date): Promise<void> {
        const overlapCount = await tx.schedule.count({
            where: {
                tenantId,
                locationId,
                deletedAt: null,
                startDate: { lt: endDate },
                endDate: { gt: startDate },
            },
        });
        if (overlapCount > 0) {
            throw new BadRequestException("A schedule already overlaps this location and date window.");
        }
    }
    private assertPublishableShifts(shifts: PublishShift[], schedule: PublishSchedule): void {
        if (shifts.length === 0) {
            throw new BadRequestException("Add at least one shift before publishing this schedule.");
        }
        const inactiveAssignment = shifts.find((shift) => shift.userId && shift.user && (
            shift.user.deletedAt
            || shift.user.suspendedAt
            || (shift.user.role && !SCHEDULABLE_USER_ROLES.includes(shift.user.role))
        ));
        if (inactiveAssignment) {
            throw new BadRequestException(`Shift ${inactiveAssignment.id} is assigned to an inactive staff member.`);
        }
        const byUser = new Map<string, Array<{ id: string; startTime: Date; endTime: Date }>>();
        for (const shift of shifts) {
            if (shift.endTime <= shift.startTime) {
                throw new BadRequestException(`Shift ${shift.id} has an invalid time window.`);
            }
            if (shift.startTime < schedule.startDate ||
                shift.endTime > schedule.endDate) {
                throw new BadRequestException(`Shift ${shift.id} must stay within its schedule window before publishing.`);
            }
            this.assertRequiredDefaultBreakTypes(shift);
            if (!shift.userId)
                continue;
            const userShifts = byUser.get(shift.userId) ?? [];
            for (const existing of userShifts) {
                if (shift.startTime < existing.endTime &&
                    shift.endTime > existing.startTime) {
                    throw new BadRequestException("Resolve overlapping assigned shifts before publishing this schedule.");
                }
            }
            userShifts.push({
                id: shift.id,
                startTime: shift.startTime,
                endTime: shift.endTime,
            });
            byUser.set(shift.userId, userShifts);
        }
    }
    private assertRequiredDefaultBreakTypes(shift: PublishShift): void {
        const durationHours = (shift.endTime.getTime() - shift.startTime.getTime()) / 3_600_000;
        const requiredTypes = durationHours >= 8
            ? ["BREAK1", "LUNCH", "BREAK2"]
            : durationHours >= 5
                ? ["LUNCH"]
                : [];
        if (requiredTypes.length === 0)
            return;
        const presentTypes = new Set((shift.breaks ?? []).map((item) => item.type).filter(Boolean));
        const missingTypes = requiredTypes.filter((type) => !presentTypes.has(type));
        if (missingTypes.length > 0) {
            throw new BadRequestException(`Shift ${shift.id} is missing required break types: ${missingTypes.join(", ")}.`);
        }
    }
    private async assertPublishReadiness(tx: TenantPrismaTransaction, tenantId: string, scheduleId: string, locationId: string, timeZone: string, shifts: PublishShift[]): Promise<void> {
        await this.assertDemandWindowsCovered(tx, tenantId, scheduleId, locationId, shifts);
        await this.assertAssignedShiftsWithinAvailability(tx, tenantId, locationId, timeZone, shifts);
        await this.assertMaxWeeklyHoursAtPublish(tx, tenantId, scheduleId, timeZone, shifts);
    }
    private async assertMaxWeeklyHoursAtPublish(tx: TenantPrismaTransaction, tenantId: string, scheduleId: string, timeZone: string, shifts: PublishShift[]): Promise<void> {
        const assigned = shifts.filter((shift): shift is PublishShift & { userId: string } => Boolean(shift.userId));
        if (assigned.length === 0)
            return;
        const staffIds = Array.from(new Set(assigned.map((shift) => shift.userId))).sort();
        const range = calendarWeekRange(new Date(Math.min(...assigned.map((shift) => shift.startTime.getTime()))), new Date(Math.max(...assigned.map((shift) => shift.endTime.getTime()))), timeZone);
        const existing = await tx.$queryRaw<ExistingShiftRow[]>`
            SELECT shift."id", shift."userId", shift."locationId", shift."startTime", shift."endTime"
            FROM "Shift" shift
            LEFT JOIN "Schedule" source_schedule ON source_schedule."id" = shift."scheduleId"
            WHERE shift."tenantId" = ${tenantId}
              AND shift."userId" IN (${Prisma.join(staffIds)})
              AND shift."deletedAt" IS NULL
              AND (shift."scheduleId" IS NULL OR shift."scheduleId" <> ${scheduleId})
              AND (source_schedule."id" IS NULL OR (source_schedule."deletedAt" IS NULL AND source_schedule."status" <> 'ARCHIVED'))
              AND shift."startTime" < ${range.end}
              AND shift."endTime" > ${range.start}
            ORDER BY shift."userId" ASC, shift."startTime" ASC, shift."id" ASC
            FOR UPDATE OF shift
        `;
        const totals = aggregateExistingWeeklyMinutes([
            ...existing,
            ...assigned.map((shift) => ({
                userId: shift.userId,
                startTime: shift.startTime,
                endTime: shift.endTime,
            })),
        ], range, staffIds);
        const maxHours = await this.publishMaxWeeklyHours(tx, tenantId, scheduleId);
        const maxMinutes = Math.round(maxHours * 60);
        for (const staffId of staffIds) {
            for (const [weekStart, minutes] of Object.entries(totals[staffId] ?? {})) {
                if (minutes > maxMinutes) {
                    throw new BadRequestException(`Staff ${staffId} exceeds ${maxHours} weekly hours for the location-local week starting ${weekStart}.`);
                }
            }
        }
    }
    private async publishMaxWeeklyHours(tx: TenantPrismaTransaction, tenantId: string, scheduleId: string): Promise<number> {
        const rows = await tx.$queryRaw<Array<{ requestedConstraints: Prisma.JsonValue | null }>>`
            SELECT "requestedConstraints"
            FROM "ScheduleSolveJob"
            WHERE "tenantId" = ${tenantId}
              AND "scheduleId" = ${scheduleId}
              AND "status" = 'SUCCEEDED'
            ORDER BY "createdAt" DESC, "id" DESC
            LIMIT 1
        `;
        const constraints = rows[0]?.requestedConstraints as Record<string, unknown> | null | undefined;
        const configured = constraints && typeof constraints === "object"
            ? Number(constraints.max_hours_per_week)
            : Number.NaN;
        return Number.isFinite(configured) && configured > 0 && configured <= 168
            ? configured
            : DEFAULT_MAX_HOURS_PER_WEEK;
    }
    private async lockTenantSchedulingMutations(tx: TenantPrismaTransaction, tenantId: string): Promise<void> {
        await tx.$executeRaw `
            SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:scheduling:${tenantId}`}, 0))
        `;
    }
    private async findSchedulePublishReplay(
        tx: TenantPrismaTransaction,
        tenantId: string,
        operationId: string,
        requestHash: string,
    ): Promise<{
        response: {
            id: string;
            status: string;
            publishedAt: string;
            settlement: SchedulePublishSettlement;
        };
        notificationDedupeKeys: string[];
    } | null> {
        const stored = await tx.auditLog.findFirst({
            where: {
                tenantId,
                action: SCHEDULE_PUBLISH_ACTION,
                resource: SCHEDULE_PUBLISH_IDEMPOTENCY_RESOURCE,
                resourceId: operationId,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { newValue: true },
        });
        if (!stored) return null;
        if (!this.isRecord(stored.newValue) || stored.newValue.requestHash !== requestHash) {
            throw new ConflictException("Idempotency-Key was already used with a different schedule publish request.");
        }
        const response = stored.newValue.response;
        const notificationDedupeKeys = stored.newValue.notificationDedupeKeys;
        if (!this.isRecord(response)
            || typeof response.id !== "string"
            || typeof response.status !== "string"
            || typeof response.publishedAt !== "string"
            || !isSchedulePublishSettlement(response.settlement)
            || response.settlement.ledgerIdentities.schedule !== schedulePublishLedgerId(operationId)
            || !this.isStringArray(notificationDedupeKeys)) {
            throw new ConflictException("The stored schedule publication outcome is unavailable. Use a new Idempotency-Key.");
        }
        return {
            response: {
                id: response.id,
                status: response.status,
                publishedAt: response.publishedAt,
                settlement: response.settlement,
            },
            notificationDedupeKeys,
        };
    }
    private isRecord(value: unknown): value is Record<string, unknown> {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }

    private isStringArray(value: unknown): value is string[] {
        return Array.isArray(value) && value.every((entry) => typeof entry === "string");
    }

    private async prepareSchedulePublishCost(
        tx: TenantPrismaTransaction,
        tenantId: string,
        schedulingEntitlement: FeatureResolution,
        scheduleVersion: number,
    ): Promise<{
        preflight: SchedulePublishPreflight;
        webhookCostPlan: TransactionalWebhookCostPlan;
    }> {
        if (!this.webhooksService) {
            throw new ServiceUnavailableException("Schedule publish settlement is unavailable");
        }
        const endpoints = await tx.webhookEndpoint.findMany({
            where: {
                tenantId,
                active: true,
                events: { has: "schedule.published" },
            },
            select: { id: true, url: true },
            orderBy: { createdAt: "asc" },
        });
        const webhookEntitlement = endpoints.length > 0
            ? await this.featureAccessService.assertFeatureEntitledInTransaction(
                tx,
                tenantId,
                "webhooks",
            )
            : null;
        const tenant = await tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { usageCredits: true },
        });
        const preflight = buildSchedulePublishPreflight({
            schedulingEntitlement,
            webhookEntitlement,
            matchingWebhookDeliveryCount: endpoints.length,
            availableCredits: tenant.usageCredits,
            scheduleVersion,
        });
        const webhookCostPlan: TransactionalWebhookCostPlan = {
            tenantId,
            eventType: "schedule.published",
            matchingDeliveryCount: preflight.matchingWebhookDeliveryCount,
            unitCost: preflight.matchingWebhookDeliveryUnitCost,
            totalConfiguredCost: preflight.matchingWebhookDeliveryCost,
            entitlement: webhookEntitlement,
            endpoints,
        };
        return { preflight, webhookCostPlan };
    }

    private async settleSchedulePublishInTransaction(
        tx: TenantPrismaTransaction,
        args: {
            tenantId: string;
            scheduleId: string;
            operationId: string;
            schedulingEntitlement: FeatureResolution;
            acceptedContract: SchedulePublishAcceptedContract;
            scheduleVersion: number;
            occurredAt: Date;
            eventData: Record<string, unknown>;
        },
    ): Promise<SchedulePublishSettlement> {
        const { preflight, webhookCostPlan } = await this.prepareSchedulePublishCost(
            tx,
            args.tenantId,
            args.schedulingEntitlement,
            args.scheduleVersion,
        );
        if (!schedulePublishContractMatches(args.acceptedContract, preflight.acceptedContract)) {
            throw new ConflictException({
                message: "Schedule or configured publish cost changed after confirmation. Review and confirm the current preflight.",
                preflight: { scheduleId: args.scheduleId, ...preflight },
            });
        }
        assertSchedulePublishCredits(preflight);
        const scheduleUsage = await this.featureAccessService.recordFeatureUsageInTransaction(
            tx,
            args.tenantId,
            args.schedulingEntitlement,
            `Schedule publication (${args.scheduleId})`,
            `schedule-publish:${args.operationId}`,
        );
        if (scheduleUsage.consumedCredits !== preflight.scheduleCost
            || scheduleUsage.newBalance === null
            || !Number.isSafeInteger(scheduleUsage.newBalance)
            || scheduleUsage.newBalance < 0) {
            throw new ServiceUnavailableException("Schedule publication credit settlement balance is unavailable");
        }
        const webhookSettlement = await this.webhooksService!.enqueueEventInTransaction(tx, {
            tenantId: args.tenantId,
            eventId: `schedule.published:${args.scheduleId}:${args.operationId}`,
            eventType: "schedule.published",
            occurredAt: args.occurredAt,
            data: args.eventData,
        }, webhookCostPlan);
        const finalWebhookDelivery = webhookSettlement.deliveries[
            webhookSettlement.deliveries.length - 1
        ];
        return buildSchedulePublishSettlement({
            preflight,
            operationId: args.operationId,
            newBalance: finalWebhookDelivery?.newBalance ?? scheduleUsage.newBalance,
            webhookDeliveryIds: webhookSettlement.deliveries.map((delivery) => delivery.deliveryId),
        });
    }

    private async assertDemandWindowsCovered(tx: TenantPrismaTransaction, tenantId: string, scheduleId: string, locationId: string, shifts: PublishShift[]): Promise<void> {
        const demandRows = await tx.$queryRaw<DemandWindowRow[]>`
            SELECT "id", "startTime", "endTime", "requiredStaff", "skill"
            FROM "ScheduleDemandWindow"
            WHERE "tenantId" = ${tenantId}
              AND "scheduleId" = ${scheduleId}
              AND "locationId" = ${locationId}
            ORDER BY "startTime" ASC, "id" ASC
        `;
        if (demandRows.length === 0)
            return;
        const assignedShifts = shifts.filter((shift): shift is PublishShift & { userId: string } => Boolean(shift.userId));
        const neededSkills = Array.from(new Set(demandRows
            .map((row) => this.normalizeSkill(row.skill))
            .filter((skill): skill is string => Boolean(skill))));
        const skillsByUser = neededSkills.length > 0
            ? await this.loadSkillsByUser(tx, tenantId, assignedShifts.map((shift) => shift.userId), neededSkills)
            : new Map<string, Set<string>>();
        for (const row of demandRows) {
            const start = this.requiredDate(row.startTime, "demand window startTime");
            const end = this.requiredDate(row.endTime, "demand window endTime");
            if (end <= start) {
                throw new BadRequestException("Invalid demand window. endTime must be after startTime.");
            }
            const requiredStaff = this.requiredStaffCount(row.requiredStaff);
            const skill = this.normalizeSkill(row.skill);
            const boundaries = this.coverageBoundaries(start, end, assignedShifts);
            for (let index = 0; index < boundaries.length - 1; index += 1) {
                const segmentStart = boundaries[index];
                const segmentEnd = boundaries[index + 1];
                if (segmentEnd <= segmentStart)
                    continue;
                const covered = assignedShifts.filter((shift) => this.isShiftWorkingForSegment(shift, segmentStart, segmentEnd) &&
                    (!skill || skillsByUser.get(shift.userId)?.has(skill))).length;
                if (covered < requiredStaff) {
                    throw new BadRequestException(`Demand window ${row.id} needs ${requiredStaff} assigned staff${skill ? ` with ${skill}` : ""} before publishing.`);
                }
            }
        }
    }
    private async loadSkillsByUser(tx: TenantPrismaTransaction, tenantId: string, userIds: string[], skills: string[]): Promise<Map<string, Set<string>>> {
        const uniqueUserIds = Array.from(new Set(userIds));
        if (uniqueUserIds.length === 0 || skills.length === 0)
            return new Map();
        const rows = await tx.$queryRaw<StaffSkillRow[]>`
            SELECT "userId", "skill"
            FROM "StaffSkill"
            WHERE "tenantId" = ${tenantId}
              AND "userId" IN (${Prisma.join(uniqueUserIds)})
              AND lower(trim("skill")) IN (${Prisma.join(skills)})
        `;
        const byUser = new Map<string, Set<string>>();
        for (const row of rows) {
            const skill = this.normalizeSkill(row.skill);
            if (!skill)
                continue;
            const userSkills = byUser.get(row.userId) ?? new Set();
            userSkills.add(skill);
            byUser.set(row.userId, userSkills);
        }
        return byUser;
    }
    private coverageBoundaries(start: Date, end: Date, shifts: PublishShift[]): Date[] {
        const timestamps = new Set([start.getTime(), end.getTime()]);
        for (const shift of shifts) {
            if (shift.endTime <= start || shift.startTime >= end)
                continue;
            timestamps.add(Math.max(start.getTime(), shift.startTime.getTime()));
            timestamps.add(Math.min(end.getTime(), shift.endTime.getTime()));
            for (const shiftBreak of shift.breaks ?? []) {
                if (shiftBreak.endTime <= start || shiftBreak.startTime >= end)
                    continue;
                timestamps.add(Math.max(start.getTime(), shiftBreak.startTime.getTime()));
                timestamps.add(Math.min(end.getTime(), shiftBreak.endTime.getTime()));
            }
        }
        return Array.from(timestamps)
            .sort((a, b) => a - b)
            .map((value) => new Date(value));
    }
    private isShiftWorkingForSegment(shift: PublishShift, start: Date, end: Date): boolean {
        if (shift.startTime > start || shift.endTime < end)
            return false;
        return !(shift.breaks ?? []).some((shiftBreak) => shiftBreak.startTime < end && shiftBreak.endTime > start);
    }
    private async assertAssignedShiftsWithinAvailability(tx: TenantPrismaTransaction, tenantId: string, locationId: string, timeZone: string, shifts: PublishShift[]): Promise<void> {
        const assignedUserIds = Array.from(new Set(shifts
            .map((shift) => shift.userId)
            .filter((userId): userId is string => Boolean(userId))));
        if (assignedUserIds.length === 0)
            return;
        const availabilityRows = await tx.$queryRaw<AvailabilityRow[]>`
            SELECT "userId", "dayOfWeek", "startTimeMinutes", "endTimeMinutes"
            FROM "StaffAvailability"
            WHERE "tenantId" = ${tenantId}
              AND "userId" IN (${Prisma.join(assignedUserIds)})
              AND ("locationId" IS NULL OR "locationId" = ${locationId})
            ORDER BY "userId" ASC, "dayOfWeek" ASC, "startTimeMinutes" ASC
        `;
        const availabilityByUser = new Map<string, PersistedAvailabilityWindow[]>();
        for (const row of availabilityRows) {
            assertAvailabilityWindow(row);
            const rows = availabilityByUser.get(row.userId) ?? [];
            rows.push(row);
            availabilityByUser.set(row.userId, rows);
        }
        for (const shift of shifts) {
            if (!shift.userId)
                continue;
            const rows = availabilityByUser.get(shift.userId);
            if (!rows?.length) {
                throw new BadRequestException(`Shift ${shift.id} is assigned to staff with no applicable configured availability.`);
            }
            for (const segment of splitInstantRangeByLocalDay(shift.startTime, shift.endTime, timeZone)) {
                const covered = availabilityWindowsCoverLocalSegment(rows, segment.weekday, segment.startMinutes, segment.endMinutes);
                if (!covered) {
                    throw new BadRequestException(`Shift ${shift.id} is outside configured staff availability.`);
                }
            }
        }
    }
    private requiredDate(value: Date | string, field: string): Date {
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) {
            throw new BadRequestException(`Invalid ${field}.`);
        }
        return date;
    }
    private normalizeSkill(value: unknown): string | null {
        const skill = typeof value === "string" ? value.trim().toLowerCase() : "";
        return skill || null;
    }
    private async lockDraftScheduleForPublish(tx: TenantPrismaTransaction, id: string, tenantId: string): Promise<PublishSchedule> {
        const rows = await tx.$queryRaw<PublishSchedule[]>`
            SELECT
                schedule.id,
                schedule.status,
                schedule."locationId",
                schedule."startDate",
                schedule."endDate",
                schedule.revision,
                location.timezone
            FROM "Schedule" schedule
            JOIN "Location" location ON location.id = schedule."locationId" AND location."tenantId" = schedule."tenantId"
            WHERE schedule.id = ${id}
              AND schedule."tenantId" = ${tenantId}
              AND schedule."deletedAt" IS NULL
              AND location."deletedAt" IS NULL
            FOR UPDATE
        `;
        const schedule = rows[0];
        if (!schedule)
            throw new NotFoundException("Schedule not found");
        if (schedule.status !== SCHEDULE_STATUS.DRAFT) {
            throw new BadRequestException("Only draft schedules can be published.");
        }
        return schedule;
    }
    private async lockDraftScheduleForAutoSchedule(tx: TenantPrismaTransaction, id: string, tenantId: string): Promise<void> {
        const rows = await tx.$queryRaw<LockedScheduleRow[]>`
            SELECT "id", "status"
            FROM "Schedule"
            WHERE "id" = ${id}
              AND "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
            FOR UPDATE
        `;
        const schedule = rows[0];
        if (!schedule)
            throw new NotFoundException("Schedule not found");
        if (schedule.status !== SCHEDULE_STATUS.DRAFT) {
            throw new BadRequestException("Only draft schedules can be auto-scheduled.");
        }
    }
    private async lockDraftScheduleForDemand(tx: TenantPrismaTransaction, id: string, tenantId: string): Promise<DemandSchedule> {
        const rows = await tx.$queryRaw<DemandSchedule[]>`
      SELECT schedule."id", schedule."status", schedule."locationId",
             schedule."startDate", schedule."endDate", location."timezone"
      FROM "Schedule" schedule
      JOIN "Location" location
        ON location."id" = schedule."locationId"
       AND location."tenantId" = schedule."tenantId"
      WHERE schedule."id" = ${id}
        AND schedule."tenantId" = ${tenantId}
        AND schedule."deletedAt" IS NULL
        AND location."deletedAt" IS NULL
      FOR UPDATE
    `;
        const schedule = rows[0];
        if (!schedule)
            throw new NotFoundException("Schedule not found");
        if (schedule.status !== SCHEDULE_STATUS.DRAFT) {
            throw new BadRequestException("Demand can only be changed on draft schedules.");
        }
        return {
            ...schedule,
            startDate: this.requiredDate(schedule.startDate, "schedule startDate"),
            endDate: this.requiredDate(schedule.endDate, "schedule endDate"),
            timezone: normalizeTimeZone(schedule.timezone),
        };
    }
    private parseScheduleDate(value: unknown, field: string, timeZone: string): Date {
        if (typeof value !== "string" || !value.trim())
            throw new BadRequestException(`${field} is required`);
        const normalized = value.trim();
        const dateOnly = DATE_ONLY_RE.exec(normalized);
        if (dateOnly) {
            try {
                return localDateBoundaryUtc(normalized, timeZone);
            }
            catch {
                throw new BadRequestException(`Invalid ${field}. Use a real YYYY-MM-DD calendar date.`);
            }
        }
        const utcInstant = UTC_INSTANT_RE.exec(normalized);
        if (!utcInstant) {
            throw new BadRequestException(`Invalid ${field}. Use YYYY-MM-DD or UTC ISO 8601.`);
        }
        const parsed = new Date(normalized);
        this.assertUtcDateParts(parsed, utcInstant, field);
        if (!Number.isFinite(parsed.getTime())) {
            throw new BadRequestException(`Invalid ${field}. Use YYYY-MM-DD or UTC ISO 8601.`);
        }
        return parsed;
    }
    private assertScheduleWindow(startDate: Date, endDate: Date): void {
        if (endDate <= startDate) {
            throw new BadRequestException("Schedule end date must be after start date.");
        }
    }
    private assertUtcDateParts(parsed: Date, match: RegExpExecArray, field: string): void {
        const expectedYear = Number(match[1]);
        const expectedMonth = Number(match[2]) - 1;
        const expectedDate = Number(match[3]);
        if (!Number.isFinite(parsed.getTime()) ||
            parsed.getUTCFullYear() !== expectedYear ||
            parsed.getUTCMonth() !== expectedMonth ||
            parsed.getUTCDate() !== expectedDate) {
            throw new BadRequestException(`Invalid ${field}. Use YYYY-MM-DD or UTC ISO 8601.`);
        }
    }
}
