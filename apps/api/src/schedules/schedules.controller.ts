// @ts-nocheck
"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchedulesController = void 0;
const common_1 = require("@nestjs/common");
import * as jwt_auth_guard_1 from "../auth/jwt-auth.guard";
import * as rbac_guard_1 from "../auth/rbac.guard";
import * as notifications_service_1 from "../notifications/notifications.service";
import * as feature_access_service_1 from "../billing/feature-access.service";
import * as metering_service_1 from "../billing/metering.service";
import * as tenant_prisma_service_1 from "../database/tenant-prisma.service";
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
import * as location_timezone_1 from "../common/location-timezone";
import * as auto_schedule_idempotency_1 from "./auto-schedule-idempotency";
import * as schedule_solve_outbox_publisher_1 from "./schedule-solve-outbox.publisher";
import * as schedule_availability_1 from "./schedule-availability";
import * as webhooks_service_1 from "../webhooks/webhooks.service";
import * as schedule_weekly_hours_1 from "./schedule-weekly-hours";
const Permission = (perm) => (0, common_1.SetMetadata)("permission", perm);
const SCHEDULE_STATUS = {
    DRAFT: "DRAFT",
    PUBLISHED: "PUBLISHED",
};
const TERMINAL_SCHEDULE_JOB_STATUSES = [
    "SUCCEEDED",
    "FAILED",
    "DEAD_LETTERED",
];
const SCHEDULABLE_USER_ROLES = [client_1.UserRole.MANAGER, client_1.UserRole.STAFF];
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
let SchedulesController = class SchedulesController {
    notificationsService;
    featureAccessService;
    webhooksService;
    tenantDb;
    scheduleOutbox;
    constructor(notificationsService, featureAccessService, tenantDb, _meteringService, webhooksService) {
        this.notificationsService = notificationsService;
        this.featureAccessService = featureAccessService;
        this.webhooksService = webhooksService;
        this.tenantDb = tenantDb ?? new tenant_prisma_service_1.TenantPrismaService();
        this.scheduleOutbox = new schedule_solve_outbox_publisher_1.ScheduleSolveOutboxPublisher(this.tenantDb);
    }
    onModuleInit() {
        this.scheduleOutbox.start();
    }
    async onModuleDestroy() {
        await this.scheduleOutbox.stop();
    }
    async findAll(req) {
        const tenantId = req.user.tenantId;
        const schedules = await this.tenantDb.withTenant(tenantId, (tx) => tx.schedule.findMany({
            where: this.scheduleReadWhere(tenantId, req),
        }));
        return { data: schedules, tenantId };
    }
    async findOne(id, req) {
        const tenantId = req.user.tenantId;
        const schedule = await this.tenantDb.withTenant(tenantId, (tx) => tx.schedule.findFirst({
            where: { id, ...this.scheduleReadWhere(tenantId, req) },
        }));
        if (!schedule)
            throw new common_1.NotFoundException("Schedule not found");
        return schedule;
    }
    async findDemandWindows(id, req) {
        const tenantId = req.user.tenantId;
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const schedule = await tx.schedule.findFirst({
                where: { id, ...this.scheduleReadWhere(tenantId, req) },
                select: { id: true, locationId: true },
            });
            if (!schedule)
                throw new common_1.NotFoundException("Schedule not found");
            const rows = await this.readDemandWindows(tx, tenantId, schedule.id, schedule.locationId);
            return { data: rows.map((row) => this.serializeDemandWindow(row)) };
        });
    }
    async replaceDemandWindows(id, body, req) {
        const tenantId = req.user.tenantId;
        await this.assertSchedulingFeature(tenantId);
        const rawWindows = body?.windows;
        if (!Array.isArray(rawWindows)) {
            throw new common_1.BadRequestException("windows must be an array");
        }
        if (rawWindows.length > MAX_AUTO_SCHEDULE_DEMAND_WINDOWS) {
            throw new common_1.BadRequestException(`Demand windows cannot exceed ${MAX_AUTO_SCHEDULE_DEMAND_WINDOWS} entries.`);
        }
        return this.tenantDb.withTenant(tenantId, async (tx) => {
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
    async findAutoScheduleJob(id, jobId, req) {
        const tenantId = req.user.tenantId;
        const canReadTeam = !this.isStaffUser(req);
        const actorUserId = this.actorUserId(req);
        const rows = await this.tenantDb.withTenant(tenantId, (tx) => tx.$queryRaw `
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
            throw new common_1.NotFoundException("Auto-schedule job not found");
        return this.serializeScheduleSolveJob(job);
    }
    async create(body, req) {
        const tenantId = req.user.tenantId;
        const syntaxStart = this.parseScheduleDate(body.startDate, "startDate", "UTC");
        const syntaxEnd = this.parseScheduleDate(body.endDate, "endDate", "UTC");
        this.assertScheduleWindow(syntaxStart, syntaxEnd);
        await this.assertSchedulingFeature(tenantId);
        const schedule = await this.tenantDb.withTenant(tenantId, async (tx) => {
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
    async remove(id, req) {
        const tenantId = req.user.tenantId;
        await this.assertSchedulingFeature(tenantId);
        await this.tenantDb.withTenant(tenantId, async (tx) => {
            const lockedRows = await tx.$queryRaw `
                SELECT "id", "status"
                FROM "Schedule"
                WHERE "id" = ${id}
                  AND "tenantId" = ${tenantId}
                  AND "deletedAt" IS NULL
                FOR UPDATE
            `;
            if (!lockedRows[0])
                throw new common_1.NotFoundException("Schedule not found");
            if (lockedRows[0].status !== SCHEDULE_STATUS.DRAFT) {
                throw new common_1.BadRequestException("Published schedules are locked. Reopen the schedule before deleting it.");
            }
            const activeJobs = await tx.$queryRaw `
                SELECT "id", "status"
                FROM "ScheduleSolveJob"
                WHERE "tenantId" = ${tenantId}
                  AND "scheduleId" = ${id}
                  AND "status" NOT IN (${client_1.Prisma.join([...TERMINAL_SCHEDULE_JOB_STATUSES])})
                ORDER BY "id" ASC
                FOR UPDATE
            `;
            if (activeJobs.length > 0) {
                throw new common_1.ConflictException("Wait for active auto-schedule jobs to finish before deleting this draft.");
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
                throw new common_1.ConflictException("Schedule changed before it could be deleted.");
        });
    }
    /**
     * Publish a schedule â€” triggers notification to all affected staff.
     */
    async publish(id, req) {
        const tenantId = req.user.tenantId;
        const now = new Date();
        await this.assertSchedulingFeature(tenantId);
        const webhookFeatureEnabled = (await this.featureAccessService.resolveTenantFeatures(tenantId)).features
            .webhooks?.enabled === true;
        const { publishedSchedule, assignedUserIds } = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantSchedulingMutations(tx, tenantId);
            const lockedSchedule = await this.lockDraftScheduleForPublish(tx, id, tenantId);
            const activeSolveJobs = await tx.$queryRaw `
                SELECT "id", "status"
                FROM "ScheduleSolveJob"
                WHERE "tenantId" = ${tenantId}
                  AND "scheduleId" = ${id}
                  AND "status" NOT IN (${client_1.Prisma.join([...TERMINAL_SCHEDULE_JOB_STATUSES])})
                ORDER BY "id" ASC
                FOR UPDATE
            `;
            if (activeSolveJobs.length > 0) {
                throw new common_1.ConflictException("Wait for active auto-schedule jobs to finish before publishing this draft.");
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
                    user: { select: { deletedAt: true } },
                    breaks: {
                        select: { type: true, startTime: true, endTime: true },
                        orderBy: { startTime: "asc" },
                    },
                },
                orderBy: { startTime: "asc" },
            });
            this.assertPublishableShifts(shiftsForPublish, lockedSchedule);
            await this.assertPublishReadiness(tx, tenantId, id, lockedSchedule.locationId, lockedSchedule.timezone, shiftsForPublish);
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
                throw new common_1.NotFoundException("Draft schedule not found or already published");
            }
            const scheduleAfterPublish = await tx.schedule.findFirst({
                where: { id, tenantId, deletedAt: null },
                include: {
                    location: { select: { name: true, timezone: true } },
                },
            });
            if (!scheduleAfterPublish) {
                throw new common_1.NotFoundException("Published schedule not found");
            }
            if (webhookFeatureEnabled) {
                if (!this.webhooksService) {
                    throw new common_1.ServiceUnavailableException("Webhook event producer is unavailable");
                }
                await this.webhooksService.enqueueEventInTransaction(tx, {
                    tenantId,
                    eventId: `schedule.published:${id}:${now.toISOString()}`,
                    eventType: "schedule.published",
                    occurredAt: now,
                    data: {
                        scheduleId: scheduleAfterPublish.id,
                        locationId: lockedSchedule.locationId,
                        startDate: scheduleAfterPublish.startDate.toISOString(),
                        endDate: scheduleAfterPublish.endDate.toISOString(),
                        publishedAt: now.toISOString(),
                        assignedShiftCount: shiftsForPublish.length,
                    },
                });
            }
            return {
                publishedSchedule: scheduleAfterPublish,
                assignedUserIds: Array.from(new Set(shiftsForPublish
                    .map((shift) => shift.userId)
                    .filter((userId) => Boolean(userId)))),
            };
        });
        const notificationBody = `${publishedSchedule.location.name}: ${(0, location_timezone_1.formatDateInTimeZone)(publishedSchedule.startDate, publishedSchedule.location.timezone)} to ${(0, location_timezone_1.formatDateInTimeZone)(new Date(publishedSchedule.endDate.getTime() - 1), publishedSchedule.location.timezone)}`;
        const notificationResults = await Promise.allSettled(assignedUserIds.map((userId) => this.notificationsService.send(tenantId, userId, notifications_service_1.NotificationType.SCHEDULE_PUBLISHED, "Schedule published", notificationBody)));
        const deliveredNotifications = notificationResults.filter((result) => result.status === "fulfilled").length;
        const failedNotifications = notificationResults.length - deliveredNotifications;
        const notificationStatus = failedNotifications === 0
            ? deliveredNotifications === 0
                ? "NOT_REQUIRED"
                : "DELIVERED"
            : deliveredNotifications === 0
                ? "FAILED"
                : "PARTIAL";
        return {
            id,
            status: SCHEDULE_STATUS.PUBLISHED,
            publishedAt: now.toISOString(),
            notifications: {
                status: notificationStatus,
                delivered: deliveredNotifications,
                failed: failedNotifications,
            },
        };
    }
    /**
     * Request auto-schedule from the Python engine via gRPC.
     */
    async autoSchedule(id, req, body, idempotencyKey) {
        const tenantId = req.user.tenantId;
        const constraints = this.normalizeAutoScheduleConstraints(body?.constraints);
        const requestKeyHash = (0, auto_schedule_idempotency_1.hashAutoScheduleIdempotencyKey)((0, auto_schedule_idempotency_1.normalizeAutoScheduleIdempotencyKey)(idempotencyKey));
        const requestHash = (0, auto_schedule_idempotency_1.autoScheduleRequestHash)(constraints, body?.confirmReplace === true);
        const jobId = `schedule-${id}-${(0, crypto_1.randomUUID)()}`;
        const prepared = await this.tenantDb.withTenant(tenantId, async (tx) => {
            const existingJob = await this.findScheduleSolveJobByRequestKey(tx, tenantId, id, requestKeyHash);
            if (existingJob) {
                this.assertIdempotentRequestMatch(existingJob, requestHash);
                return { existingJob };
            }
            const schedulingEntitlement =
                await this.featureAccessService.assertFeatureEnabledInTransaction(
                    tx,
                    tenantId,
                    "scheduling",
                );
            await this.lockDraftScheduleForAutoSchedule(tx, id, tenantId);
            const activeJob = await this.findActiveScheduleSolveJob(tx, tenantId, id);
            if (activeJob) {
                if (activeJob.requestKeyHash === requestKeyHash) {
                    this.assertIdempotentRequestMatch(activeJob, requestHash);
                }
                return { existingJob: activeJob };
            }
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
                throw new common_1.NotFoundException("Schedule not found");
            if (schedule.status !== SCHEDULE_STATUS.DRAFT) {
                throw new common_1.BadRequestException("Only draft schedules can be auto-scheduled.");
            }
            const existingShiftCount = await tx.shift.count({
                where: { tenantId, scheduleId: schedule.id, deletedAt: null },
            });
            if (existingShiftCount > 0 && body?.confirmReplace !== true) {
                throw new common_1.BadRequestException("Auto-scheduling will replace existing draft shifts. Confirm replacement to continue.");
            }
            const timeZone = (0, location_timezone_1.normalizeTimeZone)(schedule.location?.timezone);
            const draftShiftRows = await tx.$queryRaw `
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
                    deletedAt: null,
                    role: { in: SCHEDULABLE_USER_ROLES },
                },
                orderBy: { name: "asc" },
                select: { id: true },
            });
            if (staff.length === 0) {
                throw new common_1.BadRequestException("Add at least one schedulable staff member before auto-scheduling.");
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
            const job = {
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
                    throw new common_1.ServiceUnavailableException("Unable to reuse auto-schedule request");
                }
                this.assertIdempotentRequestMatch(racedJob, requestHash);
                return { existingJob: racedJob };
            }
            const creditConsumption = await this.reserveAutoScheduleCredit(tx, {
                tenantId,
                jobId,
                source: schedulingEntitlement.source,
                cost: schedulingEntitlement.creditCost ?? 0,
                fallbackBalance: 0,
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
    async reopen(id, req) {
        const tenantId = req.user.tenantId;
        await this.assertSchedulingFeature(tenantId);
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const rows = await tx.$queryRaw `
                SELECT "id", "status"
                FROM "Schedule"
                WHERE "id" = ${id}
                  AND "tenantId" = ${tenantId}
                  AND "deletedAt" IS NULL
                FOR UPDATE
            `;
            const schedule = rows[0];
            if (!schedule)
                throw new common_1.NotFoundException("Schedule not found");
            if (schedule.status !== SCHEDULE_STATUS.PUBLISHED) {
                throw new common_1.BadRequestException("Only published schedules can be reopened.");
            }
            const reopened = await tx.schedule.updateMany({
                where: {
                    id,
                    tenantId,
                    status: SCHEDULE_STATUS.PUBLISHED,
                    deletedAt: null,
                },
                data: { status: SCHEDULE_STATUS.DRAFT, publishedAt: null },
            });
            if (reopened.count !== 1) {
                throw new common_1.BadRequestException("Schedule changed before it could be reopened.");
            }
            return { id, status: SCHEDULE_STATUS.DRAFT, publishedAt: null };
        });
    }
    async assertSchedulingFeature(tenantId) {
        await this.featureAccessService.assertFeatureEnabled(tenantId, "scheduling");
    }
    normalizeAutoScheduleConstraints(value) {
        if (value === undefined || value === null)
            return {};
        if (typeof value !== "object" || Array.isArray(value)) {
            throw new common_1.BadRequestException("constraints must be an object");
        }
        const constraints = value;
        for (const key of Object.keys(constraints)) {
            if (!AUTO_SCHEDULE_CONSTRAINTS.has(key)) {
                throw new common_1.BadRequestException(`Unsupported auto-schedule constraint: ${key}`);
            }
        }
        if (JSON.stringify(constraints).length > 16_384) {
            throw new common_1.BadRequestException("constraints payload is too large");
        }
        return constraints;
    }
    async loadPersistedScheduleInputs(tx, tenantId, scheduleId, locationId, staffIds, scheduleStart, scheduleEnd, timeZone) {
        const staffSnapshot = new Map(staffIds.map((id) => [id, {
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
        const availabilityRows = await tx.$queryRaw `
            SELECT "userId", "dayOfWeek", "startTimeMinutes", "endTimeMinutes"
            FROM "StaffAvailability"
            WHERE "tenantId" = ${tenantId}
              AND "userId" IN (${client_1.Prisma.join(staffIds)})
              AND ("locationId" IS NULL OR "locationId" = ${locationId})
            ORDER BY "userId" ASC, "dayOfWeek" ASC, "startTimeMinutes" ASC, "locationId" NULLS FIRST
        `;
        for (const row of availabilityRows) {
            const staff = staffSnapshot.get(row.userId);
            if (!staff)
                continue;
            if (staff.availability.length >=
                MAX_AUTO_SCHEDULE_AVAILABILITY_RULES_PER_STAFF) {
                throw new common_1.BadRequestException("Availability cannot exceed 21 rules per staff member.");
            }
            (0, schedule_availability_1.assertAvailabilityWindow)(row);
            staff.availability.push({
                day_of_week: (0, schedule_availability_1.availabilityDayName)(row.dayOfWeek),
                start_time: (0, schedule_availability_1.availabilityTime)(row.startTimeMinutes, "availability startTimeMinutes"),
                end_time: (0, schedule_availability_1.availabilityTime)(row.endTimeMinutes, "availability endTimeMinutes"),
            });
            staff.availabilityConfigured = true;
        }
        const skillRows = await tx.$queryRaw `
            SELECT "userId", "skill"
            FROM "StaffSkill"
            WHERE "tenantId" = ${tenantId}
              AND "userId" IN (${client_1.Prisma.join(staffIds)})
            ORDER BY "userId" ASC, "skill" ASC
        `;
        for (const row of skillRows) {
            const staff = staffSnapshot.get(row.userId);
            const skill = typeof row.skill === "string" ? row.skill.trim() : "";
            if (!staff || !skill || staff.skills.includes(skill))
                continue;
            staff.skills.push(skill);
        }
        const demandRows = await tx.$queryRaw `
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
                throw new common_1.BadRequestException("Invalid demand window. endTime must be after startTime.");
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
            throw new common_1.BadRequestException("Configure at least one demand window with a date, start/end time, and required staff before auto-scheduling.");
        }
        const calendarWeeks = (0, schedule_weekly_hours_1.calendarWeekRange)(scheduleStart, scheduleEnd, timeZone);
        const existingShiftRows = await tx.$queryRaw `
            SELECT shift."id", shift."userId", shift."locationId", shift."startTime", shift."endTime"
            FROM "Shift" shift
            LEFT JOIN "Schedule" source_schedule ON source_schedule."id" = shift."scheduleId"
            WHERE shift."tenantId" = ${tenantId}
              AND shift."userId" IN (${client_1.Prisma.join(staffIds)})
              AND shift."deletedAt" IS NULL
              AND (shift."scheduleId" IS NULL OR shift."scheduleId" <> ${scheduleId})
              AND (source_schedule."id" IS NULL OR (source_schedule."deletedAt" IS NULL AND source_schedule."status" <> 'ARCHIVED'))
              AND shift."startTime" < ${calendarWeeks.end}
              AND shift."endTime" > ${calendarWeeks.start}
            ORDER BY shift."userId" ASC, shift."startTime" ASC, shift."id" ASC
        `;
        const existingWeeklyMinutes = (0, schedule_weekly_hours_1.aggregateExistingWeeklyMinutes)(existingShiftRows, calendarWeeks, staffIds);
        const existingShifts = existingShiftRows
            .filter((row) => Boolean(row.userId) &&
            this.requiredDate(row.startTime, "existing shift startTime") < scheduleEnd &&
            this.requiredDate(row.endTime, "existing shift endTime") > scheduleStart)
            .map((row) => {
            const startTime = this.toRequiredIso(row.startTime, "existing shift startTime");
            const endTime = this.toRequiredIso(row.endTime, "existing shift endTime");
            if (new Date(endTime) <= new Date(startTime)) {
                throw new common_1.BadRequestException("Invalid existing shift interval.");
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
            throw new common_1.BadRequestException(`Existing shift intervals cannot exceed ${MAX_AUTO_SCHEDULE_EXISTING_SHIFTS} entries.`);
        }
        const dailyDemand = {};
        const skillRequirements = {};
        for (const row of demandRows) {
            for (const segment of (0, location_timezone_1.splitInstantRangeByLocalDay)(row.startTime, row.endTime, timeZone)) {
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
    async readDemandWindows(tx, tenantId, scheduleId, locationId) {
        return tx.$queryRaw `
      SELECT "id", "startTime", "endTime", "requiredStaff", "skill"
      FROM "ScheduleDemandWindow"
      WHERE "tenantId" = ${tenantId}
        AND "scheduleId" = ${scheduleId}
        AND "locationId" = ${locationId}
      ORDER BY "startTime" ASC, "id" ASC
    `;
    }
    serializeDemandWindow(row) {
        return {
            id: row.id,
            startTime: this.toRequiredIso(row.startTime, "demand window startTime"),
            endTime: this.toRequiredIso(row.endTime, "demand window endTime"),
            requiredStaff: this.requiredStaffCount(row.requiredStaff),
            skill: this.normalizeSkill(row.skill),
        };
    }
    normalizeDemandWindowInput(value, index, tenantId, schedule) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new common_1.BadRequestException(`windows[${index}] must be an object`);
        }
        const input = value;
        const startTime = this.parseScheduleDate(typeof input.startTime === "string" ? input.startTime : undefined, `windows[${index}].startTime`, schedule.timezone);
        const endTime = this.parseScheduleDate(typeof input.endTime === "string" ? input.endTime : undefined, `windows[${index}].endTime`, schedule.timezone);
        if (endTime <= startTime) {
            throw new common_1.BadRequestException(`windows[${index}].endTime must be after startTime`);
        }
        if (startTime < schedule.startDate || endTime > schedule.endDate) {
            throw new common_1.BadRequestException(`windows[${index}] must be inside the schedule window`);
        }
        const requiredStaff = this.requiredStaffCount(Number(input.requiredStaff));
        if (requiredStaff > 200) {
            throw new common_1.BadRequestException("Demand window requiredStaff cannot exceed 200.");
        }
        const skill = typeof input.skill === "string" ? input.skill.trim().toLowerCase() : "";
        if (input.skill != null && typeof input.skill !== "string") {
            throw new common_1.BadRequestException(`windows[${index}].skill must be a string`);
        }
        if (skill.length > 128) {
            throw new common_1.BadRequestException(`windows[${index}].skill cannot exceed 128 characters`);
        }
        return {
            id: (0, crypto_1.randomUUID)(),
            tenantId,
            scheduleId: schedule.id,
            locationId: schedule.locationId,
            startTime,
            endTime,
            requiredStaff,
            skill: skill || null,
        };
    }
    requiredStaffCount(value) {
        const requiredStaff = Number(value);
        if (!Number.isInteger(requiredStaff) || requiredStaff <= 0) {
            throw new common_1.BadRequestException("Invalid demand window requiredStaff. Use a positive integer.");
        }
        return requiredStaff;
    }
    async enqueueSolveJob(job) {
        try {
            await this.scheduleOutbox.publishPendingNow(job.job_id);
        }
        catch {
            // The committed outbox row remains eligible for the startup/poll recovery loop.
        }
    }
    async createScheduleSolveJob(tx, args) {
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
    async findScheduleSolveJobByRequestKey(tx, tenantId, scheduleId, requestKeyHash) {
        const rows = await tx.$queryRaw `
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
    async findActiveScheduleSolveJob(tx, tenantId, scheduleId) {
        const rows = await tx.$queryRaw `
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
              AND "status" NOT IN (${client_1.Prisma.join([...TERMINAL_SCHEDULE_JOB_STATUSES])})
            ORDER BY "createdAt" ASC, "id" ASC
            LIMIT 1
            FOR UPDATE
        `;
        return rows[0] ?? null;
    }
    assertIdempotentRequestMatch(job, requestHash) {
        if (job.requestHash !== requestHash) {
            throw new common_1.ConflictException("Idempotency-Key was already used with a different auto-schedule request.");
        }
    }
    reusedAutoScheduleResponse(scheduleId, job) {
        return {
            ...this.serializeScheduleSolveJob(job),
            statusUrl: `/v1/schedules/${scheduleId}/auto-schedule/jobs/${job.id}`,
            reused: true,
        };
    }
    async recordScheduleSolveJobCreditConsumptionInTransaction(tx, tenantId, jobId, creditConsumption) {
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
    async reserveAutoScheduleCredit(tx, args) {
        if (args.cost > 0) {
            const rows = await tx.$queryRaw `
                UPDATE "Tenant"
                SET
                    "usageCredits" = "usageCredits" - ${args.cost},
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = ${args.tenantId}
                  AND "usageCredits" >= ${args.cost}
                RETURNING "usageCredits"
            `;
            if (!rows[0]) {
                throw new common_1.ForbiddenException("Insufficient usage credits balance.");
            }
            await tx.creditTransaction.create({
                data: {
                    id: `schedule-credit-${args.jobId}`,
                    tenantId: args.tenantId,
                    amount: -args.cost,
                    reason: `Schedule generation (${args.jobId})`,
                },
            });
            return {
                consumedCredits: args.cost,
                newBalance: Number(rows[0].usageCredits),
                source: args.source,
            };
        }
        return {
            consumedCredits: args.source === "plan" || args.source === "stripe" ? args.cost : 0,
            newBalance: args.fallbackBalance,
            source: args.source,
        };
    }
    serializeScheduleSolveJob(row) {
        return {
            jobId: row.id,
            scheduleId: row.scheduleId,
            locationId: row.locationId,
            status: row.status,
            statusReason: row.statusReason,
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
            publishLastError: row.publishLastError,
            startedAt: this.toIsoOrNull(row.startedAt),
            completedAt: this.toIsoOrNull(row.completedAt),
            createdAt: this.toIsoOrNull(row.createdAt),
            updatedAt: this.toIsoOrNull(row.updatedAt),
        };
    }
    scheduleReadWhere(tenantId, req) {
        const where = {
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
    isStaffUser(req) {
        const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
        return [req.user?.legacyRole, req.user?.role, ...roles].some((role) => this.isRole(role, client_1.UserRole.STAFF));
    }
    isRole(value, expected) {
        return (typeof value === "string" &&
            value
                .trim()
                .replace(/[\s-]+/g, "_")
                .toUpperCase() === expected);
    }
    actorUserId(req) {
        return req.user?.sub ?? req.user?.id;
    }
    toIsoOrNull(value) {
        if (!value)
            return null;
        if (value instanceof Date)
            return value.toISOString();
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
    }
    toRequiredIso(value, field) {
        const serialized = this.toIsoOrNull(value);
        if (!serialized) {
            throw new common_1.BadRequestException(`Invalid ${field}.`);
        }
        return serialized;
    }
    async assertLocationInTenant(tx, locationId, tenantId) {
        if (!locationId)
            throw new common_1.BadRequestException("locationId is required");
        const rows = await tx.$queryRaw `
            SELECT "id", "timezone"
            FROM "Location"
            WHERE "id" = ${locationId}
              AND "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
            FOR UPDATE
        `;
        const location = rows[0];
        if (!location)
            throw new common_1.BadRequestException("Location is not available for this tenant.");
        return { ...location, timezone: (0, location_timezone_1.normalizeTimeZone)(location.timezone) };
    }
    async assertNoScheduleOverlap(tx, tenantId, locationId, startDate, endDate) {
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
            throw new common_1.BadRequestException("A schedule already overlaps this location and date window.");
        }
    }
    assertPublishableShifts(shifts, schedule) {
        if (shifts.length === 0) {
            throw new common_1.BadRequestException("Add at least one shift before publishing this schedule.");
        }
        const inactiveAssignment = shifts.find((shift) => shift.userId && shift.user?.deletedAt);
        if (inactiveAssignment) {
            throw new common_1.BadRequestException(`Shift ${inactiveAssignment.id} is assigned to an inactive staff member.`);
        }
        const byUser = new Map();
        for (const shift of shifts) {
            if (shift.endTime <= shift.startTime) {
                throw new common_1.BadRequestException(`Shift ${shift.id} has an invalid time window.`);
            }
            if (shift.startTime < schedule.startDate ||
                shift.endTime > schedule.endDate) {
                throw new common_1.BadRequestException(`Shift ${shift.id} must stay within its schedule window before publishing.`);
            }
            this.assertRequiredDefaultBreakTypes(shift);
            if (!shift.userId)
                continue;
            const userShifts = byUser.get(shift.userId) ?? [];
            for (const existing of userShifts) {
                if (shift.startTime < existing.endTime &&
                    shift.endTime > existing.startTime) {
                    throw new common_1.BadRequestException("Resolve overlapping assigned shifts before publishing this schedule.");
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
    assertRequiredDefaultBreakTypes(shift) {
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
            throw new common_1.BadRequestException(`Shift ${shift.id} is missing required break types: ${missingTypes.join(", ")}.`);
        }
    }
    async assertPublishReadiness(tx, tenantId, scheduleId, locationId, timeZone, shifts) {
        await this.assertDemandWindowsCovered(tx, tenantId, scheduleId, locationId, shifts);
        await this.assertAssignedShiftsWithinAvailability(tx, tenantId, locationId, timeZone, shifts);
        await this.assertMaxWeeklyHoursAtPublish(tx, tenantId, scheduleId, timeZone, shifts);
    }
    async assertMaxWeeklyHoursAtPublish(tx, tenantId, scheduleId, timeZone, shifts) {
        const assigned = shifts.filter((shift) => Boolean(shift.userId));
        if (assigned.length === 0)
            return;
        const staffIds = Array.from(new Set(assigned.map((shift) => shift.userId))).sort();
        const range = (0, schedule_weekly_hours_1.calendarWeekRange)(new Date(Math.min(...assigned.map((shift) => shift.startTime.getTime()))), new Date(Math.max(...assigned.map((shift) => shift.endTime.getTime()))), timeZone);
        const existing = await tx.$queryRaw `
            SELECT shift."id", shift."userId", shift."locationId", shift."startTime", shift."endTime"
            FROM "Shift" shift
            LEFT JOIN "Schedule" source_schedule ON source_schedule."id" = shift."scheduleId"
            WHERE shift."tenantId" = ${tenantId}
              AND shift."userId" IN (${client_1.Prisma.join(staffIds)})
              AND shift."deletedAt" IS NULL
              AND (shift."scheduleId" IS NULL OR shift."scheduleId" <> ${scheduleId})
              AND (source_schedule."id" IS NULL OR (source_schedule."deletedAt" IS NULL AND source_schedule."status" <> 'ARCHIVED'))
              AND shift."startTime" < ${range.end}
              AND shift."endTime" > ${range.start}
            ORDER BY shift."userId" ASC, shift."startTime" ASC, shift."id" ASC
            FOR UPDATE OF shift
        `;
        const totals = (0, schedule_weekly_hours_1.aggregateExistingWeeklyMinutes)([
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
                    throw new common_1.BadRequestException(`Staff ${staffId} exceeds ${maxHours} weekly hours for the location-local week starting ${weekStart}.`);
                }
            }
        }
    }
    async publishMaxWeeklyHours(tx, tenantId, scheduleId) {
        const rows = await tx.$queryRaw `
            SELECT "requestedConstraints"
            FROM "ScheduleSolveJob"
            WHERE "tenantId" = ${tenantId}
              AND "scheduleId" = ${scheduleId}
              AND "status" = 'SUCCEEDED'
            ORDER BY "createdAt" DESC, "id" DESC
            LIMIT 1
        `;
        const constraints = rows[0]?.requestedConstraints;
        const configured = constraints && typeof constraints === "object"
            ? Number(constraints.max_hours_per_week)
            : Number.NaN;
        return Number.isFinite(configured) && configured > 0 && configured <= 168
            ? configured
            : DEFAULT_MAX_HOURS_PER_WEEK;
    }
    async lockTenantSchedulingMutations(tx, tenantId) {
        await tx.$queryRaw `
            SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:scheduling:${tenantId}`}, 0))
        `;
    }
    async assertDemandWindowsCovered(tx, tenantId, scheduleId, locationId, shifts) {
        const demandRows = await tx.$queryRaw `
            SELECT "id", "startTime", "endTime", "requiredStaff", "skill"
            FROM "ScheduleDemandWindow"
            WHERE "tenantId" = ${tenantId}
              AND "scheduleId" = ${scheduleId}
              AND "locationId" = ${locationId}
            ORDER BY "startTime" ASC, "id" ASC
        `;
        if (demandRows.length === 0)
            return;
        const assignedShifts = shifts.filter((shift) => Boolean(shift.userId));
        const neededSkills = Array.from(new Set(demandRows
            .map((row) => this.normalizeSkill(row.skill))
            .filter((skill) => Boolean(skill))));
        const skillsByUser = neededSkills.length > 0
            ? await this.loadSkillsByUser(tx, tenantId, assignedShifts.map((shift) => shift.userId), neededSkills)
            : new Map();
        for (const row of demandRows) {
            const start = this.requiredDate(row.startTime, "demand window startTime");
            const end = this.requiredDate(row.endTime, "demand window endTime");
            if (end <= start) {
                throw new common_1.BadRequestException("Invalid demand window. endTime must be after startTime.");
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
                    throw new common_1.BadRequestException(`Demand window ${row.id} needs ${requiredStaff} assigned staff${skill ? ` with ${skill}` : ""} before publishing.`);
                }
            }
        }
    }
    async loadSkillsByUser(tx, tenantId, userIds, skills) {
        const uniqueUserIds = Array.from(new Set(userIds));
        if (uniqueUserIds.length === 0 || skills.length === 0)
            return new Map();
        const rows = await tx.$queryRaw `
            SELECT "userId", "skill"
            FROM "StaffSkill"
            WHERE "tenantId" = ${tenantId}
              AND "userId" IN (${client_1.Prisma.join(uniqueUserIds)})
              AND lower(trim("skill")) IN (${client_1.Prisma.join(skills)})
        `;
        const byUser = new Map();
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
    coverageBoundaries(start, end, shifts) {
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
    isShiftWorkingForSegment(shift, start, end) {
        if (shift.startTime > start || shift.endTime < end)
            return false;
        return !(shift.breaks ?? []).some((shiftBreak) => shiftBreak.startTime < end && shiftBreak.endTime > start);
    }
    async assertAssignedShiftsWithinAvailability(tx, tenantId, locationId, timeZone, shifts) {
        const assignedUserIds = Array.from(new Set(shifts
            .map((shift) => shift.userId)
            .filter((userId) => Boolean(userId))));
        if (assignedUserIds.length === 0)
            return;
        const availabilityRows = await tx.$queryRaw `
            SELECT "userId", "dayOfWeek", "startTimeMinutes", "endTimeMinutes"
            FROM "StaffAvailability"
            WHERE "tenantId" = ${tenantId}
              AND "userId" IN (${client_1.Prisma.join(assignedUserIds)})
              AND ("locationId" IS NULL OR "locationId" = ${locationId})
            ORDER BY "userId" ASC, "dayOfWeek" ASC, "startTimeMinutes" ASC
        `;
        const availabilityByUser = new Map();
        for (const row of availabilityRows) {
            (0, schedule_availability_1.assertAvailabilityWindow)(row);
            const rows = availabilityByUser.get(row.userId) ?? [];
            rows.push(row);
            availabilityByUser.set(row.userId, rows);
        }
        for (const shift of shifts) {
            if (!shift.userId)
                continue;
            const rows = availabilityByUser.get(shift.userId);
            if (!rows?.length) {
                throw new common_1.BadRequestException(`Shift ${shift.id} is assigned to staff with no applicable configured availability.`);
            }
            for (const segment of (0, location_timezone_1.splitInstantRangeByLocalDay)(shift.startTime, shift.endTime, timeZone)) {
                const covered = rows.some((row) => (0, schedule_availability_1.availabilityWindowCoversLocalSegment)(row, segment.weekday, segment.startMinutes, segment.endMinutes));
                if (!covered) {
                    throw new common_1.BadRequestException(`Shift ${shift.id} is outside configured staff availability.`);
                }
            }
        }
    }
    requiredDate(value, field) {
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) {
            throw new common_1.BadRequestException(`Invalid ${field}.`);
        }
        return date;
    }
    normalizeSkill(value) {
        const skill = typeof value === "string" ? value.trim().toLowerCase() : "";
        return skill || null;
    }
    async lockDraftScheduleForPublish(tx, id, tenantId) {
        const rows = await tx.$queryRaw `
            SELECT
                schedule.id,
                schedule.status,
                schedule."locationId",
                schedule."startDate",
                schedule."endDate",
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
            throw new common_1.NotFoundException("Schedule not found");
        if (schedule.status !== SCHEDULE_STATUS.DRAFT) {
            throw new common_1.BadRequestException("Only draft schedules can be published.");
        }
        return schedule;
    }
    async lockDraftScheduleForAutoSchedule(tx, id, tenantId) {
        const rows = await tx.$queryRaw `
            SELECT "id", "status"
            FROM "Schedule"
            WHERE "id" = ${id}
              AND "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
            FOR UPDATE
        `;
        const schedule = rows[0];
        if (!schedule)
            throw new common_1.NotFoundException("Schedule not found");
        if (schedule.status !== SCHEDULE_STATUS.DRAFT) {
            throw new common_1.BadRequestException("Only draft schedules can be auto-scheduled.");
        }
    }
    async lockDraftScheduleForDemand(tx, id, tenantId) {
        const rows = await tx.$queryRaw `
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
            throw new common_1.NotFoundException("Schedule not found");
        if (schedule.status !== SCHEDULE_STATUS.DRAFT) {
            throw new common_1.BadRequestException("Demand can only be changed on draft schedules.");
        }
        return {
            ...schedule,
            startDate: this.requiredDate(schedule.startDate, "schedule startDate"),
            endDate: this.requiredDate(schedule.endDate, "schedule endDate"),
            timezone: (0, location_timezone_1.normalizeTimeZone)(schedule.timezone),
        };
    }
    parseScheduleDate(value, field, timeZone) {
        if (typeof value !== "string" || !value.trim())
            throw new common_1.BadRequestException(`${field} is required`);
        const normalized = value.trim();
        const dateOnly = DATE_ONLY_RE.exec(normalized);
        if (dateOnly) {
            try {
                return (0, location_timezone_1.localDateBoundaryUtc)(normalized, timeZone);
            }
            catch {
                throw new common_1.BadRequestException(`Invalid ${field}. Use a real YYYY-MM-DD calendar date.`);
            }
        }
        const utcInstant = UTC_INSTANT_RE.exec(normalized);
        if (!utcInstant) {
            throw new common_1.BadRequestException(`Invalid ${field}. Use YYYY-MM-DD or UTC ISO 8601.`);
        }
        const parsed = new Date(normalized);
        this.assertUtcDateParts(parsed, utcInstant, field);
        if (!Number.isFinite(parsed.getTime())) {
            throw new common_1.BadRequestException(`Invalid ${field}. Use YYYY-MM-DD or UTC ISO 8601.`);
        }
        return parsed;
    }
    assertScheduleWindow(startDate, endDate) {
        if (endDate <= startDate) {
            throw new common_1.BadRequestException("Schedule end date must be after start date.");
        }
    }
    assertUtcDateParts(parsed, match, field) {
        const expectedYear = Number(match[1]);
        const expectedMonth = Number(match[2]) - 1;
        const expectedDate = Number(match[3]);
        if (!Number.isFinite(parsed.getTime()) ||
            parsed.getUTCFullYear() !== expectedYear ||
            parsed.getUTCMonth() !== expectedMonth ||
            parsed.getUTCDate() !== expectedDate) {
            throw new common_1.BadRequestException(`Invalid ${field}. Use YYYY-MM-DD or UTC ISO 8601.`);
        }
    }
};
exports.SchedulesController = SchedulesController;
__decorate([
    (0, common_1.Get)(),
    Permission("schedules:read"),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SchedulesController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(":id"),
    Permission("schedules:read"),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], SchedulesController.prototype, "findOne", null);
__decorate([
    (0, common_1.Get)(":id/demand-windows"),
    Permission("schedules:read"),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], SchedulesController.prototype, "findDemandWindows", null);
__decorate([
    (0, common_1.Put)(":id/demand-windows"),
    Permission("schedules:write"),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], SchedulesController.prototype, "replaceDemandWindows", null);
__decorate([
    (0, common_1.Get)(":id/auto-schedule/jobs/:jobId"),
    Permission("schedules:read"),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, common_1.Param)("jobId")),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], SchedulesController.prototype, "findAutoScheduleJob", null);
__decorate([
    (0, common_1.Post)(),
    Permission("schedules:write"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], SchedulesController.prototype, "create", null);
__decorate([
    (0, common_1.Delete)(":id"),
    Permission("schedules:write"),
    (0, common_1.HttpCode)(common_1.HttpStatus.NO_CONTENT),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], SchedulesController.prototype, "remove", null);
__decorate([
    (0, common_1.Post)(":id/publish"),
    Permission("schedules:publish"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], SchedulesController.prototype, "publish", null);
__decorate([
    (0, common_1.Post)(":id/auto-schedule"),
    Permission("schedules:write"),
    (0, common_1.HttpCode)(common_1.HttpStatus.ACCEPTED),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Headers)("idempotency-key")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, String]),
    __metadata("design:returntype", Promise)
], SchedulesController.prototype, "autoSchedule", null);
__decorate([
    (0, common_1.Post)(":id/reopen"),
    Permission("schedules:publish"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], SchedulesController.prototype, "reopen", null);
exports.SchedulesController = SchedulesController = __decorate([
    (0, common_1.Controller)({ path: "schedules", version: "1" }),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, rbac_guard_1.RbacGuard),
    __param(2, (0, common_1.Optional)()),
    __param(3, (0, common_1.Optional)()),
    __param(4, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [notifications_service_1.NotificationsService,
        feature_access_service_1.FeatureAccessService,
        tenant_prisma_service_1.TenantPrismaService,
        metering_service_1.MeteringService,
        webhooks_service_1.WebhooksService])
], SchedulesController);
export type SchedulesController = any;
export { SchedulesController };
