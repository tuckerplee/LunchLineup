import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import amqp from 'amqplib';
import {
  cleanupScheduleSolveFixture,
  createPrisma,
  createScheduleSolveFixture,
  deleteQueues,
  generateSolverProto,
  readSchedulePublishSideEffects,
  readScheduleSolveSideEffects,
  removeGeneratedProto,
  requireEngineGrpcUrl,
  requireServiceUrl,
  reserveTcpPort,
  startPythonEntrypoint,
  stopProcess,
  waitForHttp,
  waitForProcessLog,
  waitForRabbitConsumer,
  waitForTerminalScheduleResult,
} from './schedule-solve-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { ConflictException } = require('@nestjs/common');
const { FeatureAccessService } = require('../../apps/api/src/billing/feature-access.service.ts');
const { MeteringService } = require('../../apps/api/src/billing/metering.service.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');
const { SchedulesController } = require('../../apps/api/src/schedules/schedules.controller.ts');

test('schedule.solve reaches a terminal persisted result through RabbitMQ, protobuf, engine, and worker', { timeout: 90_000 }, async (t) => {
  const databaseUrl = requireServiceUrl('DATABASE_URL').toString();
  const rabbitMqUrl = requireServiceUrl('RABBITMQ_URL').toString();
  const engineGrpcUrl = requireEngineGrpcUrl();
  const prisma = createPrisma(databaseUrl);
  const tenantDb = new TenantPrismaService(prisma);
  const featureAccess = new FeatureAccessService(new MeteringService(tenantDb), tenantDb);
  const schedules = new SchedulesController(
    {
      enqueueInTransaction: async () => { throw new Error('stale publish reached notification enqueue'); },
      deliverPendingNow: async () => { throw new Error('stale publish reached notification delivery'); },
    },
    featureAccess,
    tenantDb,
    new MeteringService(tenantDb),
    {
      enqueueEventInTransaction: async () => { throw new Error('stale publish reached webhook enqueue'); },
    },
  );
  const runId = randomUUID();
  const fixture = {
    tenantId: `tenant-${runId}`,
    tenantSlug: `queue-contract-${runId}`,
    locationId: `loc-${runId}`,
    staffId: `staff-${runId}`,
    scheduleId: `schedule-${runId}`,
    jobId: `job-${runId}`,
    requestKeyHash: `request-key-${runId}`,
    requestHash: `request-${runId}`,
  };
  const staleFixture = {
    tenantId: `tenant-stale-${runId}`,
    tenantSlug: `queue-stale-${runId}`,
    locationId: `loc-stale-${runId}`,
    staffId: `staff-stale-${runId}`,
    scheduleId: `schedule-stale-${runId}`,
    jobId: `job-stale-${runId}`,
    requestKeyHash: `request-key-stale-${runId}`,
    requestHash: `request-stale-${runId}`,
  };
  const queueName = `lunchlineup.integration.${runId}`;
  const dlqName = `${queueName}.dlq`;
  const retryQueueName = `${queueName}.retry.1`;
  const queueMessage = {
    type: 'schedule.solve',
    job_id: fixture.jobId,
    retry_count: 0,
    payload: {
      schedule_id: fixture.scheduleId,
      tenant_id: fixture.tenantId,
      location_id: fixture.locationId,
      start_date: '2026-03-09T00:00:00Z',
      end_date: '2026-03-10T00:00:00Z',
      draft_revision: 0,
      input_shift_snapshot: [],
      staff_ids: [fixture.staffId],
      constraints: {
        max_hours_per_week: 8,
        min_floor_coverage: 1,
        shift_duration_hours: 4,
        solver_time_limit_seconds: 5,
      },
      availability: {
        [fixture.staffId]: [{ day_of_week: 'Monday', start_time: '08:00', end_time: '18:00' }],
      },
      availability_configured: { [fixture.staffId]: true },
      staff_skills: {},
      skill_requirements: {},
      daily_demand: null,
      demand_windows: [],
      timezone: 'UTC',
      existing_weekly_minutes: {},
      existing_shifts: [],
    },
  };
  const staleQueueMessage = {
    ...queueMessage,
    job_id: staleFixture.jobId,
    payload: {
      ...queueMessage.payload,
      schedule_id: staleFixture.scheduleId,
      tenant_id: staleFixture.tenantId,
      location_id: staleFixture.locationId,
      staff_ids: [staleFixture.staffId],
      availability: {
        [staleFixture.staffId]: [{ day_of_week: 'Monday', start_time: '08:00', end_time: '18:00' }],
      },
      availability_configured: { [staleFixture.staffId]: true },
    },
  };
  let fixtureCreated = false;
  let staleFixtureCreated = false;
  const entitlementFixtureCleanup = [];
  let generatedRoot;
  let rabbitConnection;
  let rabbitChannel;
  let engineProcess;
  let workerProcess;

  try {
    generatedRoot = generateSolverProto();
    await createScheduleSolveFixture(prisma, fixture, queueMessage);
    fixtureCreated = true;
    const request = {
      user: { tenantId: fixture.tenantId, sub: fixture.staffId, role: 'MANAGER' },
    };
    const preflight = await schedules.publishPreflight(fixture.scheduleId, request);
    assert.equal(preflight.acceptedContract.version, 0);
    rabbitConnection = await amqp.connect(rabbitMqUrl);

    const engineHttpPort = await reserveTcpPort();
    engineProcess = startPythonEntrypoint('engine', 'apps/engine', generatedRoot, {
      ENGINE_GRPC_BIND: engineGrpcUrl,
      ENGINE_GRPC_REQUIRED: 'true',
      ENGINE_HTTP_HOST: '127.0.0.1',
      ENGINE_HTTP_PORT: String(engineHttpPort),
    });
    await waitForHttp(`http://127.0.0.1:${engineHttpPort}/health`, engineProcess);

    const workerMetricsPort = await reserveTcpPort();
    workerProcess = startPythonEntrypoint('worker', 'apps/worker', generatedRoot, {
      DATABASE_URL: databaseUrl,
      ENGINE_GRPC_TIMEOUT_SECONDS: '8',
      ENGINE_GRPC_URL: engineGrpcUrl,
      RABBITMQ_URL: rabbitMqUrl,
      WORKER_DLQ_NAME: dlqName,
      WORKER_MAX_RETRIES: '0',
      WORKER_METRICS_PORT: String(workerMetricsPort),
      WORKER_QUEUE_NAME: queueName,
      WORKER_RETRY_QUEUE_PREFIX: `${queueName}.retry`,
    });
    await waitForHttp(`http://127.0.0.1:${workerMetricsPort}/metrics`, workerProcess);

    rabbitChannel = await rabbitConnection.createConfirmChannel();
    await waitForRabbitConsumer(rabbitChannel, queueName, workerProcess);
    rabbitChannel.sendToQueue(queueName, Buffer.from(JSON.stringify(queueMessage)), {
      contentType: 'application/json',
      deliveryMode: 2,
      messageId: fixture.jobId,
      type: 'schedule.solve',
    });
    await rabbitChannel.waitForConfirms();

    const result = await waitForTerminalScheduleResult(prisma, fixture);
    assert.equal(result.job.status, 'SUCCEEDED', result.job.statusReason || 'schedule solve did not succeed');
    assert.ok(result.job.completedAt, 'terminal result records completedAt');
    assert.equal(result.job.resultShiftCount, 1);
    assert.deepEqual(result.schedule, { status: 'DRAFT', revision: 1 });
    assert.equal(result.shifts.length, 1);
    assert.equal(result.shifts[0].userId, fixture.staffId);
    assert.equal(result.shifts[0].role, 'STAFF');
    assert.ok(result.shifts[0].endTime > result.shifts[0].startTime);

    const terminalReplayLog = 'Skipping terminal schedule solve job';
    const priorTerminalReplays = workerProcess.logs().split(terminalReplayLog).length - 1;
    rabbitChannel.sendToQueue(queueName, Buffer.from(JSON.stringify(queueMessage)), {
      contentType: 'application/json',
      deliveryMode: 2,
      messageId: `${fixture.jobId}-replay`,
      type: 'schedule.solve',
    });
    await rabbitChannel.waitForConfirms();
    await waitForProcessLog(workerProcess, terminalReplayLog, priorTerminalReplays);
    const replayResult = await waitForTerminalScheduleResult(prisma, fixture);
    assert.deepEqual(replayResult.schedule, { status: 'DRAFT', revision: 1 });
    assert.equal(replayResult.shifts.length, 1);

    const beforeStalePublish = await readSchedulePublishSideEffects(prisma, fixture);
    await assert.rejects(
      schedules.publish(
        fixture.scheduleId,
        request,
        `stale-worker-result-${runId}`,
        { acceptedContract: preflight.acceptedContract },
      ),
      (error) => {
        assert.ok(error instanceof ConflictException);
        assert.equal(error.getStatus(), 409);
        assert.match(
          JSON.stringify(error.getResponse()),
          /Schedule or configured publish cost changed after confirmation/,
        );
        return true;
      },
    );
    assert.deepEqual(
      await readSchedulePublishSideEffects(prisma, fixture),
      beforeStalePublish,
      'stale publish must not debit, audit, enqueue, notify, or change schedule status',
    );

    for (const tenantStatus of ['PAST_DUE', 'CANCELLED']) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_current_tenant(${fixture.tenantId})`;
        await tx.tenant.update({
          where: { id: fixture.tenantId },
          data: {
            status: tenantStatus,
            ...(tenantStatus === 'CANCELLED' ? { stripeSubscriptionId: null } : {}),
            stripeSubscriptionCurrentPeriodEnd: tenantStatus === 'CANCELLED'
              ? null
              : new Date(Date.now() + 60_000),
          },
        });
      });
      const beforeInactiveReplay = await readScheduleSolveSideEffects(prisma, fixture);
      const priorInactiveReplays = workerProcess.logs().split(terminalReplayLog).length - 1;
      const dlqBeforeReplay = await rabbitChannel.checkQueue(dlqName);
      rabbitChannel.sendToQueue(queueName, Buffer.from(JSON.stringify(queueMessage)), {
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: `${fixture.jobId}-${tenantStatus.toLowerCase()}-replay`,
        type: 'schedule.solve',
      });
      await rabbitChannel.waitForConfirms();
      await waitForProcessLog(workerProcess, terminalReplayLog, priorInactiveReplays);
      assert.deepEqual(
        await readScheduleSolveSideEffects(prisma, fixture),
        beforeInactiveReplay,
        `${tenantStatus} terminal replay must not mutate job, schedule, wallet, ledger, audit, webhook, or notification state`,
      );
      const dlqAfterReplay = await rabbitChannel.checkQueue(dlqName);
      assert.equal(dlqAfterReplay.messageCount, dlqBeforeReplay.messageCount);
    }

    for (const entitlementCase of [
      { name: 'free-plan', planTier: 'FREE', periodEnd: new Date(Date.now() + 60_000) },
      { name: 'null-period-end', planTier: 'GROWTH', periodEnd: null },
      { name: 'past-period-end', planTier: 'GROWTH', periodEnd: new Date(Date.now() - 60_000) },
    ]) {
      const deniedFixture = {
        tenantId: `tenant-${entitlementCase.name}-${runId}`,
        tenantSlug: `queue-${entitlementCase.name}-${runId}`,
        locationId: `loc-${entitlementCase.name}-${runId}`,
        staffId: `staff-${entitlementCase.name}-${runId}`,
        scheduleId: `schedule-${entitlementCase.name}-${runId}`,
        jobId: `job-${entitlementCase.name}-${runId}`,
        requestKeyHash: `request-key-${entitlementCase.name}-${runId}`,
        requestHash: `request-${entitlementCase.name}-${runId}`,
      };
      const deniedQueueMessage = {
        ...queueMessage,
        job_id: deniedFixture.jobId,
        payload: {
          ...queueMessage.payload,
          schedule_id: deniedFixture.scheduleId,
          tenant_id: deniedFixture.tenantId,
          location_id: deniedFixture.locationId,
          staff_ids: [deniedFixture.staffId],
          availability: {
            [deniedFixture.staffId]: [{ day_of_week: 'Monday', start_time: '08:00', end_time: '18:00' }],
          },
          availability_configured: { [deniedFixture.staffId]: true },
        },
      };
      await createScheduleSolveFixture(prisma, deniedFixture, deniedQueueMessage);
      entitlementFixtureCleanup.push(deniedFixture);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_current_tenant(${deniedFixture.tenantId})`;
        await tx.tenant.update({
          where: { id: deniedFixture.tenantId },
          data: {
            planTier: entitlementCase.planTier,
            status: 'ACTIVE',
            stripeSubscriptionId: `sub_integration_paid_${deniedFixture.tenantId}`,
            stripeSubscriptionCurrentPeriodEnd: entitlementCase.periodEnd,
          },
        });
      });

      rabbitChannel.sendToQueue(queueName, Buffer.from(JSON.stringify(deniedQueueMessage)), {
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: deniedFixture.jobId,
        type: 'schedule.solve',
      });
      await rabbitChannel.waitForConfirms();
      const deniedResult = await waitForTerminalScheduleResult(prisma, deniedFixture);
      assert.equal(deniedResult.job.status, 'FAILED', `${entitlementCase.name} must fail terminally`);
      assert.deepEqual(deniedResult.schedule, { status: 'DRAFT', revision: 0 });
      assert.equal(deniedResult.shifts.length, 0, `${entitlementCase.name} must fail before shift persistence`);
      const deniedEvidence = await readScheduleSolveSideEffects(prisma, deniedFixture);
      assert.equal(deniedEvidence.tenant.usageCredits, 10);
      assert.deepEqual(
        deniedEvidence.ledger.map(({ id, amount, balanceAfter }) => ({ id, amount, balanceAfter })),
        [
          { id: `schedule-credit-${deniedFixture.jobId}`, amount: -1, balanceAfter: 9 },
          { id: `schedule-credit-refund-${deniedFixture.jobId}`, amount: 1, balanceAfter: 10 },
        ],
      );

      const priorDeniedTerminalReplays = workerProcess.logs().split(terminalReplayLog).length - 1;
      rabbitChannel.sendToQueue(queueName, Buffer.from(JSON.stringify(deniedQueueMessage)), {
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: `${deniedFixture.jobId}-terminal-replay`,
        type: 'schedule.solve',
      });
      await rabbitChannel.waitForConfirms();
      await waitForProcessLog(workerProcess, terminalReplayLog, priorDeniedTerminalReplays);
      assert.deepEqual(
        await readScheduleSolveSideEffects(prisma, deniedFixture),
        deniedEvidence,
        `${entitlementCase.name} terminal replay must preserve immutable settlement`,
      );
    }

    await createScheduleSolveFixture(prisma, staleFixture, staleQueueMessage);
    staleFixtureCreated = true;
    const staleRequest = {
      user: { tenantId: staleFixture.tenantId, sub: staleFixture.staffId, role: 'MANAGER' },
    };
    await schedules.replaceDemandWindows(
      staleFixture.scheduleId,
      {
        windows: [{
          startTime: '2026-03-09T08:00:00Z',
          endTime: '2026-03-09T12:00:00Z',
          requiredStaff: 1,
        }],
      },
      staleRequest,
    );
    const staleDlqLog = 'Non-retryable job routed to DLQ';
    const priorStaleDlqLogs = workerProcess.logs().split(staleDlqLog).length - 1;
    rabbitChannel.sendToQueue(queueName, Buffer.from(JSON.stringify(staleQueueMessage)), {
      contentType: 'application/json',
      deliveryMode: 2,
      messageId: staleFixture.jobId,
      type: 'schedule.solve',
    });
    await rabbitChannel.waitForConfirms();
    const staleResult = await waitForTerminalScheduleResult(prisma, staleFixture);
    await waitForProcessLog(workerProcess, staleDlqLog, priorStaleDlqLogs);
    assert.equal(staleResult.job.status, 'FAILED');
    assert.deepEqual(staleResult.schedule, { status: 'DRAFT', revision: 1 });
    assert.equal(staleResult.shifts.length, 0);
    const staleEvidence = await readScheduleSolveSideEffects(prisma, staleFixture);
    assert.equal(staleEvidence.tenant.usageCredits, 10);
    assert.deepEqual(
      staleEvidence.ledger.map(({ id, amount, reason, balanceAfter }) => ({ id, amount, reason, balanceAfter })),
      [
        {
          id: `schedule-credit-${staleFixture.jobId}`,
          amount: -1,
          reason: `Schedule generation (${staleFixture.jobId})`,
          balanceAfter: 9,
        },
        {
          id: `schedule-credit-refund-${staleFixture.jobId}`,
          amount: 1,
          reason: `Schedule generation refund (${staleFixture.jobId})`,
          balanceAfter: 10,
        },
      ],
    );
    assert.equal(staleEvidence.audits, 0);
    assert.equal(staleEvidence.webhookDeliveries, 0);
    assert.equal(staleEvidence.notificationOutbox, 0);
    assert.equal(staleEvidence.notifications, 0);

    const staleDlqBeforeReplay = await rabbitChannel.checkQueue(dlqName);
    const priorStaleTerminalReplays = workerProcess.logs().split(terminalReplayLog).length - 1;
    rabbitChannel.sendToQueue(queueName, Buffer.from(JSON.stringify(staleQueueMessage)), {
      contentType: 'application/json',
      deliveryMode: 2,
      messageId: `${staleFixture.jobId}-terminal-replay`,
      type: 'schedule.solve',
    });
    await rabbitChannel.waitForConfirms();
    await waitForProcessLog(workerProcess, terminalReplayLog, priorStaleTerminalReplays);
    assert.deepEqual(await readScheduleSolveSideEffects(prisma, staleFixture), staleEvidence);
    const staleDlqAfterReplay = await rabbitChannel.checkQueue(dlqName);
    assert.equal(staleDlqAfterReplay.messageCount, staleDlqBeforeReplay.messageCount);
  } catch (error) {
    for (const processRecord of [engineProcess, workerProcess].filter(Boolean)) {
      t.diagnostic(`${processRecord.name} logs:\n${processRecord.logs() || '(no output)'}`);
    }
    throw error;
  } finally {
    await stopProcess(workerProcess);
    await stopProcess(engineProcess);
    if (rabbitConnection && !rabbitChannel) {
      rabbitChannel = await rabbitConnection.createChannel().catch(() => undefined);
    }
    if (rabbitChannel) {
      await deleteQueues(rabbitChannel, [queueName, dlqName, retryQueueName]);
      await rabbitChannel.close().catch(() => {});
    }
    if (rabbitConnection) await rabbitConnection.close().catch(() => {});
    if (staleFixtureCreated) await cleanupScheduleSolveFixture(prisma, staleFixture);
    for (const deniedFixture of entitlementFixtureCleanup.reverse()) {
      await cleanupScheduleSolveFixture(prisma, deniedFixture);
    }
    if (fixtureCreated) await cleanupScheduleSolveFixture(prisma, fixture);
    removeGeneratedProto(generatedRoot);
    await prisma.$disconnect();
  }
});
