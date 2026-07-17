import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  cleanupShiftUpdateFixture,
  createShiftUpdateFixture,
  createShiftUpdateHarness,
  readShiftUpdateState,
  shiftUpdateRequest,
} from './shift-update-harness.mjs';

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('real PostgreSQL keeps billable shift updates atomic, replay-safe, isolated, and draft-only', { timeout: 45_000 }, async (t) => {
  const harness = createShiftUpdateHarness();
  let fixture;
  try {
    fixture = await createShiftUpdateFixture(harness.ownerPrisma);
    const { primary, isolated } = fixture;
    const primaryRequest = shiftUpdateRequest(primary.tenantId, primary.managerId);

    await t.test('bills one configured credit and translates breaks in the same commit', async () => {
      const before = await readShiftUpdateState(
        harness.ownerPrisma,
        primary.tenantId,
        primary.atomicShiftId,
        primary.atomicBreakId,
      );
      const key = 'integration-atomic-shift-update';
      const operationId = harness.shiftUpdateOperationId(primary.tenantId, key);

      const response = await harness.controller.update(
        primary.atomicShiftId,
        {
          startTime: '2026-08-10T10:00:00.000Z',
          endTime: '2026-08-10T18:00:00.000Z',
        },
        primaryRequest,
        key,
      );
      const after = await readShiftUpdateState(
        harness.ownerPrisma,
        primary.tenantId,
        primary.atomicShiftId,
        primary.atomicBreakId,
      );
      const [ledger, audit] = await Promise.all([
        harness.ownerPrisma.creditTransaction.findUnique({ where: { id: `feature-usage-${operationId}` } }),
        harness.ownerPrisma.auditLog.findFirst({
          where: {
            tenantId: primary.tenantId,
            action: 'SHIFT_UPDATED',
            resource: 'ShiftUpdateRequest',
            resourceId: operationId,
          },
        }),
      ]);

      assert.equal(response.id, primary.atomicShiftId);
      assert.equal(response.startTime, '2026-08-10T10:00:00.000Z');
      assert.equal(response.endTime, '2026-08-10T18:00:00.000Z');
      assert.equal(after.usageCredits, before.usageCredits - 1);
      assert.equal(after.ledgerCount, before.ledgerCount + 1);
      assert.equal(after.auditCount, before.auditCount + 1);
      assert.equal(after.shift.startTime.toISOString(), '2026-08-10T10:00:00.000Z');
      assert.equal(after.shift.endTime.toISOString(), '2026-08-10T18:00:00.000Z');
      assert.equal(after.shiftBreak.startTime.toISOString(), '2026-08-10T13:00:00.000Z');
      assert.equal(after.shiftBreak.endTime.toISOString(), '2026-08-10T13:30:00.000Z');
      assert.equal(ledger?.amount, -1);
      assert.ok(audit);
    });

    await t.test('fresh semantic no-ops return current state and never reserve the key', async () => {
      const key = 'integration-semantic-no-op';
      const operationId = harness.shiftUpdateOperationId(primary.tenantId, key);
      const body = {
        userId: primary.staffId,
        startTime: '2026-08-10T10:00:00.000Z',
        endTime: '2026-08-10T18:00:00.000Z',
        role: 'STAFF',
      };
      const before = await readShiftUpdateState(
        harness.ownerPrisma,
        primary.tenantId,
        primary.atomicShiftId,
        primary.atomicBreakId,
      );

      const first = await harness.controller.update(primary.atomicShiftId, body, primaryRequest, key);
      const retry = await harness.controller.update(primary.atomicShiftId, body, primaryRequest, key);
      const after = await readShiftUpdateState(
        harness.ownerPrisma,
        primary.tenantId,
        primary.atomicShiftId,
        primary.atomicBreakId,
      );

      assert.deepEqual(retry, first);
      assert.equal(first.id, primary.atomicShiftId);
      assert.deepEqual(after, before);
      assert.equal(await harness.ownerPrisma.creditTransaction.count({
        where: { id: `feature-usage-${operationId}` },
      }), 0);
      assert.equal(await harness.ownerPrisma.auditLog.count({
        where: { tenantId: primary.tenantId, resourceId: operationId },
      }), 0);
    });

    await t.test('assigned collision returns 409 with wallet, shift, break, and audit unchanged', async () => {
      const before = await readShiftUpdateState(
        harness.ownerPrisma,
        primary.tenantId,
        primary.collisionShiftId,
        primary.collisionBreakId,
      );

      await assert.rejects(
        harness.controller.update(
          primary.collisionShiftId,
          {
            startTime: '2026-08-11T11:30:00.000Z',
            endTime: '2026-08-11T13:30:00.000Z',
          },
          primaryRequest,
          'integration-collision-rollback',
        ),
        (error) => {
          assert.ok(error instanceof ConflictException);
          assert.equal(error.getStatus(), 409);
          return true;
        },
      );

      const after = await readShiftUpdateState(
        harness.ownerPrisma,
        primary.tenantId,
        primary.collisionShiftId,
        primary.collisionBreakId,
      );
      assert.deepEqual(after, before);
    });

    await t.test('a deferred database collision rolls the debit, shift, break, and audit back', async () => {
      const before = await readShiftUpdateState(
        harness.ownerPrisma,
        primary.tenantId,
        primary.rollbackShiftId,
        primary.rollbackBreakId,
      );
      let releaseBlocker;
      let markBlockerInserted;
      const blockerRelease = new Promise((resolveRelease) => {
        releaseBlocker = resolveRelease;
      });
      const blockerInserted = new Promise((resolveInserted) => {
        markBlockerInserted = resolveInserted;
      });
      const blockerTransaction = harness.ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET CONSTRAINTS "Shift_assigned_no_overlap" IMMEDIATE');
        await tx.shift.create({
          data: {
            id: primary.rollbackBlockerShiftId,
            tenantId: primary.tenantId,
            locationId: primary.locationId,
            scheduleId: primary.draftScheduleId,
            userId: primary.staffId,
            startTime: new Date('2026-08-12T21:00:00.000Z'),
            endTime: new Date('2026-08-12T23:00:00.000Z'),
            role: 'STAFF',
          },
        });
        markBlockerInserted();
        await withTimeout(blockerRelease, 5_000, 'Timed out waiting to release deferred collision fixture');
      }, { timeout: 10_000 });

      try {
        await withTimeout(blockerInserted, 3_000, 'Timed out creating deferred collision fixture');
        const updateOutcome = harness.controller.update(
          primary.rollbackShiftId,
          {
            startTime: '2026-08-12T20:00:00.000Z',
            endTime: '2026-08-12T22:00:00.000Z',
          },
          primaryRequest,
          'integration-deferred-collision-rollback',
        ).then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        );

        const lockDeadline = Date.now() + 3_000;
        let blocked = false;
        while (Date.now() < lockDeadline && !blocked) {
          const [row] = await harness.ownerPrisma.$queryRaw`
            SELECT count(*)::int AS count
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND usename <> current_user
              AND wait_event_type = 'Lock'
          `;
          blocked = row.count > 0;
          if (!blocked) await delay(20);
        }
        assert.equal(blocked, true, 'shift update should wait on the uncommitted exclusion row');
        releaseBlocker();
        await blockerTransaction;

        const outcome = await updateOutcome;
        assert.ok(outcome.error instanceof ConflictException);
        assert.equal(outcome.error.getStatus(), 409);
      } finally {
        releaseBlocker();
        await blockerTransaction.catch(() => {});
      }

      const after = await readShiftUpdateState(
        harness.ownerPrisma,
        primary.tenantId,
        primary.rollbackShiftId,
        primary.rollbackBreakId,
      );
      assert.deepEqual(after, before);
    });

    await t.test('same-key concurrency and lost-response retry commit once', async () => {
      const key = 'integration-concurrent-lost-response';
      const operationId = harness.shiftUpdateOperationId(primary.tenantId, key);
      const body = { role: 'LEAD' };
      const before = await readShiftUpdateState(
        harness.ownerPrisma,
        primary.tenantId,
        primary.concurrentShiftId,
        null,
      );

      const responses = await Promise.all([
        harness.controller.update(primary.concurrentShiftId, body, primaryRequest, key),
        harness.controller.update(primary.concurrentShiftId, body, primaryRequest, key),
      ]);
      assert.deepEqual(responses[1], responses[0]);

      const recoveredAfterDiscardedResponse = await harness.controller.update(
        primary.concurrentShiftId,
        body,
        primaryRequest,
        key,
      );
      const after = await readShiftUpdateState(
        harness.ownerPrisma,
        primary.tenantId,
        primary.concurrentShiftId,
        null,
      );

      assert.deepEqual(recoveredAfterDiscardedResponse, responses[0]);
      assert.equal(after.shift.role, 'LEAD');
      assert.equal(after.usageCredits, before.usageCredits - 1);
      assert.equal(after.ledgerCount, before.ledgerCount + 1);
      assert.equal(after.auditCount, before.auditCount + 1);
      assert.equal(await harness.ownerPrisma.creditTransaction.count({
        where: { id: `feature-usage-${operationId}` },
      }), 1);
      assert.equal(await harness.ownerPrisma.auditLog.count({
        where: { tenantId: primary.tenantId, resourceId: operationId },
      }), 1);
    });

    await t.test('tenant-scoped key and RLS do not expose or charge another tenant', async () => {
      const key = 'integration-concurrent-lost-response';
      const before = await readShiftUpdateState(harness.ownerPrisma, isolated.tenantId, null, null);

      await assert.rejects(
        harness.controller.update(
          primary.concurrentShiftId,
          { role: 'LEAD' },
          shiftUpdateRequest(isolated.tenantId, isolated.managerId),
          key,
        ),
        (error) => {
          assert.equal(error.getStatus(), 404);
          return true;
        },
      );

      const after = await readShiftUpdateState(harness.ownerPrisma, isolated.tenantId, null, null);
      const isolatedOperationId = harness.shiftUpdateOperationId(isolated.tenantId, key);
      assert.deepEqual(after, before);
      assert.equal(await harness.ownerPrisma.auditLog.count({
        where: { tenantId: isolated.tenantId, resourceId: isolatedOperationId },
      }), 0);
    });

    await t.test('published and archived shifts are immutable without billing side effects', async () => {
      const before = await readShiftUpdateState(harness.ownerPrisma, primary.tenantId, null, null);
      for (const [label, shiftId] of [
        ['published', primary.publishedShiftId],
        ['archived', primary.archivedShiftId],
      ]) {
        await assert.rejects(
          harness.controller.update(
            shiftId,
            { role: 'LEAD' },
            primaryRequest,
            `integration-${label}-immutable`,
          ),
          (error) => {
            assert.ok(error instanceof BadRequestException);
            assert.equal(error.getStatus(), 400);
            return true;
          },
        );
      }
      const after = await readShiftUpdateState(harness.ownerPrisma, primary.tenantId, null, null);
      assert.deepEqual(after, before);
      assert.equal((await harness.ownerPrisma.shift.findUniqueOrThrow({
        where: { id: primary.publishedShiftId },
        select: { role: true },
      })).role, 'STAFF');
      assert.equal((await harness.ownerPrisma.shift.findUniqueOrThrow({
        where: { id: primary.archivedShiftId },
        select: { role: true },
      })).role, 'STAFF');
    });
  } finally {
    await cleanupShiftUpdateFixture(harness.ownerPrisma, fixture);
    await harness.disconnect();
  }
});
