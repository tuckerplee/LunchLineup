import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function requireServiceUrl(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required for integration tests`);
  return new URL(value);
}

export function requireEngineGrpcUrl() {
  const value = process.env.ENGINE_GRPC_URL;
  assert.ok(value, 'ENGINE_GRPC_URL is required for integration tests');
  assert.match(value, /^[A-Za-z0-9.-]+:\d+$/, 'ENGINE_GRPC_URL must use host:port format');
  return value;
}

export function createPrisma(databaseUrl) {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

function pythonExecutable() {
  return process.env.PYTHON || 'python';
}

export function generateSolverProto() {
  const generatedRoot = mkdtempSync(join(tmpdir(), 'lunchlineup-solver-proto-'));
  const protoRoot = join(root, 'packages/shared-types/proto');
  execFileSync(
    pythonExecutable(),
    [
      '-m',
      'grpc_tools.protoc',
      `-I${protoRoot}`,
      `--python_out=${generatedRoot}`,
      `--grpc_python_out=${generatedRoot}`,
      join(protoRoot, 'solver.proto'),
    ],
    { cwd: root, stdio: 'pipe' },
  );
  return generatedRoot;
}

export function removeGeneratedProto(generatedRoot) {
  if (generatedRoot) rmSync(generatedRoot, { recursive: true, force: true });
}

export function startPythonEntrypoint(name, relativeAppRoot, generatedRoot, env) {
  const appRoot = join(root, relativeAppRoot);
  const output = [];
  let outputLength = 0;
  let exited = null;
  const child = spawn(pythonExecutable(), ['main.py'], {
    cwd: appRoot,
    env: {
      ...process.env,
      ENVIRONMENT: 'test',
      OTEL_SDK_DISABLED: 'true',
      PYTHONPATH: [generatedRoot, appRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      PYTHONUNBUFFERED: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      resolveExit(exited);
    });
  });
  const append = (source, chunk) => {
    const line = `${source}: ${chunk.toString()}`;
    output.push(line);
    outputLength += line.length;
    while (outputLength > 40_000 && output.length > 1) {
      outputLength -= output.shift().length;
    }
  };
  child.stdout.on('data', (chunk) => append('stdout', chunk));
  child.stderr.on('data', (chunk) => append('stderr', chunk));

  return {
    name,
    child,
    exit,
    get exited() {
      return exited;
    },
    logs: () => output.join('').trim(),
  };
}

export async function stopProcess(processRecord) {
  if (!processRecord || processRecord.exited) return;
  processRecord.child.kill('SIGTERM');
  await Promise.race([processRecord.exit, delay(3000)]);
  if (!processRecord.exited) {
    processRecord.child.kill('SIGKILL');
    await Promise.race([processRecord.exit, delay(3000)]);
  }
}

export async function reserveTcpPort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

export async function waitForHttp(url, processRecord, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (processRecord.exited) {
      throw new Error(`${processRecord.name} exited before becoming ready`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'no response'}`);
}

export async function waitForRabbitConsumer(channel, queueName, processRecord, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'queue not declared';
  while (Date.now() < deadline) {
    if (processRecord.exited) {
      throw new Error(`${processRecord.name} exited before consuming ${queueName}`);
    }
    if (processRecord.logs().includes(`Worker connected to RabbitMQ queue=${queueName}`)) {
      const state = await channel.checkQueue(queueName);
      lastState = `consumers=${state.consumerCount} messages=${state.messageCount}`;
      if (state.consumerCount > 0) return;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for a RabbitMQ consumer on ${queueName}: ${lastState}`);
}

export async function waitForProcessLog(processRecord, message, priorOccurrences = 0, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processRecord.exited) {
      throw new Error(`${processRecord.name} exited before logging ${message}`);
    }
    const occurrences = processRecord.logs().split(message).length - 1;
    if (occurrences > priorOccurrences) return occurrences;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${processRecord.name} log: ${message}`);
}

export async function createScheduleSolveFixture(prisma, fixture, queueMessage) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_current_tenant(${fixture.tenantId})`;
    await tx.$executeRaw`
      INSERT INTO "Tenant"
        ("id", "name", "slug", "planTier", "status", "stripeSubscriptionId", "stripeSubscriptionCurrentPeriodEnd", "usageCredits", "createdAt", "updatedAt")
      VALUES
        (${fixture.tenantId}, 'Queue Contract Integration', ${fixture.tenantSlug}, 'GROWTH'::"PlanTier", 'ACTIVE'::"TenantStatus", ${`sub_integration_paid_${fixture.tenantId}`}, CURRENT_TIMESTAMP + INTERVAL '1 day', 9, now(), now())
    `;
    await tx.$executeRaw`
      INSERT INTO "Location" ("id", "tenantId", "name", "timezone", "createdAt", "updatedAt")
      VALUES (${fixture.locationId}, ${fixture.tenantId}, 'Queue Contract Location', 'UTC', now(), now())
    `;
    await tx.$executeRaw`
      INSERT INTO "User" ("id", "tenantId", "name", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
      VALUES (${fixture.staffId}, ${fixture.tenantId}, 'Queue Contract Staff', 'STAFF'::"UserRole", false, ARRAY[]::TEXT[], now(), now())
    `;
    await tx.$executeRaw`
      INSERT INTO "StaffAvailability"
        ("id", "tenantId", "userId", "locationId", "dayOfWeek", "startTimeMinutes", "endTimeMinutes", "createdAt", "updatedAt")
      VALUES
        (${`availability-${fixture.staffId}`}, ${fixture.tenantId}, ${fixture.staffId}, ${fixture.locationId}, 1, 0, 1439, now(), now())
    `;
    await tx.$executeRaw`
      INSERT INTO "Schedule" ("id", "tenantId", "locationId", "startDate", "endDate", "status", "revision", "createdAt", "updatedAt")
      VALUES (${fixture.scheduleId}, ${fixture.tenantId}, ${fixture.locationId}, '2026-03-09T00:00:00Z'::timestamptz, '2026-03-10T00:00:00Z'::timestamptz, 'DRAFT'::"ScheduleStatus", 0, now(), now())
    `;
    await tx.$executeRaw`
      INSERT INTO "ScheduleSolveJob"
        ("id", "tenantId", "scheduleId", "locationId", "requestKeyHash", "requestHash", "status", "creditConsumption", "queuePayload", "publicationStatus", "publishedAt", "createdAt", "updatedAt")
      VALUES
        (${fixture.jobId}, ${fixture.tenantId}, ${fixture.scheduleId}, ${fixture.locationId}, ${fixture.requestKeyHash}, ${fixture.requestHash}, 'QUEUED', ${JSON.stringify({ source: 'credits', consumedCredits: 1, newBalance: 9 })}::jsonb, ${JSON.stringify(queueMessage)}::jsonb, 'PUBLISHED', now(), now(), now())
    `;
    await tx.$executeRaw`
      INSERT INTO "CreditTransaction" ("id", "tenantId", "amount", "reason", "balanceAfter", "createdAt")
      VALUES (${`schedule-credit-${fixture.jobId}`}, ${fixture.tenantId}, -1, ${`Schedule generation (${fixture.jobId})`}, 9, now())
    `;
  });
}

async function readScheduleSolveResult(prisma, fixture) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_current_tenant(${fixture.tenantId})`;
    const jobs = await tx.$queryRaw`
      SELECT "status", "statusReason", "resultShiftCount", "completedAt"
      FROM "ScheduleSolveJob"
      WHERE "id" = ${fixture.jobId} AND "tenantId" = ${fixture.tenantId}
    `;
    const shifts = await tx.$queryRaw`
      SELECT "id", "userId", "role", "startTime", "endTime"
      FROM "Shift"
      WHERE "tenantId" = ${fixture.tenantId}
        AND "scheduleId" = ${fixture.scheduleId}
        AND "deletedAt" IS NULL
      ORDER BY "startTime", "id"
    `;
    const schedules = await tx.$queryRaw`
      SELECT "status", "revision"
      FROM "Schedule"
      WHERE "id" = ${fixture.scheduleId} AND "tenantId" = ${fixture.tenantId}
    `;
    return { job: jobs[0], shifts, schedule: schedules[0] };
  });
}

export async function readSchedulePublishSideEffects(prisma, fixture, scheduleIds = [fixture.scheduleId]) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_current_tenant(${fixture.tenantId})`;
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: fixture.tenantId },
      select: { usageCredits: true },
    });
    const schedules = await tx.schedule.findMany({
      where: { tenantId: fixture.tenantId, id: { in: scheduleIds } },
      select: { id: true, status: true, revision: true },
      orderBy: { id: 'asc' },
    });
    return {
      usageCredits: tenant.usageCredits,
      schedules,
      creditTransactions: await tx.creditTransaction.count({ where: { tenantId: fixture.tenantId } }),
      publishAudits: await tx.auditLog.count({
        where: { tenantId: fixture.tenantId, action: 'SCHEDULE_PUBLISHED' },
      }),
      webhookDeliveries: await tx.webhookDelivery.count({ where: { tenantId: fixture.tenantId } }),
      notificationOutbox: await tx.notificationOutbox.count({ where: { tenantId: fixture.tenantId } }),
      notifications: await tx.notification.count({ where: { tenantId: fixture.tenantId } }),
    };
  });
}

export async function readScheduleSolveSideEffects(prisma, fixture) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_current_tenant(${fixture.tenantId})`;
    const tenants = await tx.$queryRaw`
      SELECT "status", "planTier", "stripeSubscriptionId",
             "stripeSubscriptionCurrentPeriodEnd", "usageCredits", "updatedAt"
      FROM "Tenant"
      WHERE "id" = ${fixture.tenantId}
    `;
    const jobs = await tx.$queryRaw`
      SELECT "status", "statusReason", "retryCount", "resultShiftCount",
             "executionToken", "executionLeaseUntil", "startedAt", "completedAt", "updatedAt"
      FROM "ScheduleSolveJob"
      WHERE "id" = ${fixture.jobId} AND "tenantId" = ${fixture.tenantId}
    `;
    const schedules = await tx.$queryRaw`
      SELECT "status", "revision", "publishedAt", "updatedAt"
      FROM "Schedule"
      WHERE "id" = ${fixture.scheduleId} AND "tenantId" = ${fixture.tenantId}
    `;
    const shifts = await tx.$queryRaw`
      SELECT shift."id", shift."userId", shift."startTime", shift."endTime",
             shift."role", shift."deletedAt", shift."updatedAt",
             break_row."id" AS "breakId", break_row."type" AS "breakType",
             break_row."startTime" AS "breakStartTime", break_row."endTime" AS "breakEndTime"
      FROM "Shift" shift
      LEFT JOIN "Break" break_row ON break_row."shiftId" = shift."id"
      WHERE shift."tenantId" = ${fixture.tenantId}
        AND shift."scheduleId" = ${fixture.scheduleId}
      ORDER BY shift."id", break_row."id"
    `;
    const ledger = await tx.$queryRaw`
      SELECT "id", "amount", "reason", "balanceAfter", "createdAt"
      FROM "CreditTransaction"
      WHERE "tenantId" = ${fixture.tenantId}
      ORDER BY "id"
    `;
    return {
      tenant: tenants[0],
      job: jobs[0],
      schedule: schedules[0],
      shifts,
      ledger,
      audits: await tx.auditLog.count({ where: { tenantId: fixture.tenantId } }),
      webhookDeliveries: await tx.webhookDelivery.count({ where: { tenantId: fixture.tenantId } }),
      notificationOutbox: await tx.notificationOutbox.count({ where: { tenantId: fixture.tenantId } }),
      notifications: await tx.notification.count({ where: { tenantId: fixture.tenantId } }),
    };
  });
}

export async function waitForTerminalScheduleResult(prisma, fixture, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await readScheduleSolveResult(prisma, fixture);
    if (['SUCCEEDED', 'FAILED', 'DEAD_LETTERED'].includes(lastResult.job?.status)) {
      return lastResult;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for terminal schedule result; last result=${JSON.stringify(lastResult)}`);
}

export async function cleanupScheduleSolveFixture(prisma, fixture) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_current_tenant(${fixture.tenantId})`;
    await tx.$executeRaw`
      DELETE FROM "Break"
      WHERE "shiftId" IN (
        SELECT "id" FROM "Shift"
        WHERE "tenantId" = ${fixture.tenantId} AND "scheduleId" = ${fixture.scheduleId}
      )
    `;
    await tx.notificationOutbox.deleteMany({ where: { tenantId: fixture.tenantId } });
    await tx.notification.deleteMany({ where: { tenantId: fixture.tenantId } });
    await tx.webhookDelivery.deleteMany({ where: { tenantId: fixture.tenantId } });
    await tx.auditLog.deleteMany({ where: { tenantId: fixture.tenantId } });
    await tx.$executeRaw`DELETE FROM "Shift" WHERE "tenantId" = ${fixture.tenantId} AND "scheduleId" = ${fixture.scheduleId}`;
    await tx.$executeRaw`DELETE FROM "ScheduleSolveJob" WHERE "id" = ${fixture.jobId} AND "tenantId" = ${fixture.tenantId}`;
    await tx.$executeRaw`DELETE FROM "CreditTransaction" WHERE "tenantId" = ${fixture.tenantId}`;
    await tx.$executeRaw`DELETE FROM "ScheduleDemandWindow" WHERE "tenantId" = ${fixture.tenantId} AND "scheduleId" = ${fixture.scheduleId}`;
    await tx.$executeRaw`DELETE FROM "Schedule" WHERE "id" = ${fixture.scheduleId} AND "tenantId" = ${fixture.tenantId}`;
    await tx.$executeRaw`DELETE FROM "StaffAvailability" WHERE "tenantId" = ${fixture.tenantId} AND "userId" = ${fixture.staffId}`;
    await tx.$executeRaw`DELETE FROM "User" WHERE "id" = ${fixture.staffId} AND "tenantId" = ${fixture.tenantId}`;
    await tx.$executeRaw`DELETE FROM "Location" WHERE "id" = ${fixture.locationId} AND "tenantId" = ${fixture.tenantId}`;
    await tx.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${fixture.tenantId}`;
  });
}

export async function deleteQueues(channel, queueNames) {
  for (const queueName of queueNames) {
    try {
      await channel.deleteQueue(queueName);
    } catch {
      // A failed worker startup can leave no queue to remove.
    }
  }
}
