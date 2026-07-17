import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  cleanupShiftUpdateFixture,
  createShiftUpdateFixture,
  createShiftUpdateHarness,
  readShiftBulkAssignmentState,
  shiftUpdateRequest,
} from './shift-update-harness.mjs';

test('real PostgreSQL keeps bulk assignments no-op safe, exactly-once, tenant isolated, and draft-only', { timeout: 30_000 }, async (t) => {
  const harness = createShiftUpdateHarness();
  let fixture;
  try {
    fixture = await createShiftUpdateFixture(harness.ownerPrisma);
    const { primary, isolated } = fixture;
    const primaryRequest = shiftUpdateRequest(primary.tenantId, primary.managerId);

    await t.test('all-no-op batch preserves balance, ledger, rows, audit, and reusable key', async () => {
      const key = 'integration-bulk-all-no-op';
      const operationId = harness.shiftBulkAssignmentOperationId(primary.tenantId, key);
      const shiftIds = [primary.bulkNoOpShiftId];
      const body = { assignments: [{ shiftId: primary.bulkNoOpShiftId, userId: primary.staffId }] };
      const before = await readShiftBulkAssignmentState(harness.ownerPrisma, primary.tenantId, shiftIds);

      const first = await harness.controller.bulkAssign(body, primaryRequest, key);
      const retry = await harness.controller.bulkAssign(body, primaryRequest, key);
      const after = await readShiftBulkAssignmentState(harness.ownerPrisma, primary.tenantId, shiftIds);

      assert.deepEqual(first, { updated: 0 });
      assert.deepEqual(retry, first);
      assert.deepEqual(after, before);
      assert.equal(await harness.ownerPrisma.creditTransaction.count({
        where: { id: `feature-usage-${operationId}` },
      }), 0);
      assert.equal(await harness.ownerPrisma.auditLog.count({
        where: { tenantId: primary.tenantId, resourceId: operationId },
      }), 0);
    });

    await t.test('mixed batch debits once and writes only the changed row', async () => {
      const key = 'integration-bulk-mixed';
      const operationId = harness.shiftBulkAssignmentOperationId(primary.tenantId, key);
      const shiftIds = [primary.bulkNoOpShiftId, primary.bulkChangedShiftId];
      const before = await readShiftBulkAssignmentState(harness.ownerPrisma, primary.tenantId, shiftIds);

      const response = await harness.controller.bulkAssign({
        assignments: [
          { shiftId: primary.bulkNoOpShiftId, userId: primary.staffId },
          { shiftId: primary.bulkChangedShiftId, userId: primary.staffId },
        ],
      }, primaryRequest, key);
      const after = await readShiftBulkAssignmentState(harness.ownerPrisma, primary.tenantId, shiftIds);
      const beforeById = new Map(before.shifts.map((shift) => [shift.id, shift]));
      const afterById = new Map(after.shifts.map((shift) => [shift.id, shift]));
      const [ledger, audit] = await Promise.all([
        harness.ownerPrisma.creditTransaction.findUnique({ where: { id: `feature-usage-${operationId}` } }),
        harness.ownerPrisma.auditLog.findFirst({
          where: {
            tenantId: primary.tenantId,
            action: 'SHIFT_BULK_ASSIGNED',
            resource: 'ShiftBulkAssignmentRequest',
            resourceId: operationId,
          },
        }),
      ]);

      assert.deepEqual(response, { updated: 1 });
      assert.equal(after.usageCredits, before.usageCredits - 1);
      assert.equal(after.ledgerCount, before.ledgerCount + 1);
      assert.equal(after.auditCount, before.auditCount + 1);
      assert.deepEqual(afterById.get(primary.bulkNoOpShiftId), beforeById.get(primary.bulkNoOpShiftId));
      assert.equal(afterById.get(primary.bulkChangedShiftId)?.userId, primary.staffId);
      assert.notDeepEqual(
        afterById.get(primary.bulkChangedShiftId)?.updatedAt,
        beforeById.get(primary.bulkChangedShiftId)?.updatedAt,
      );
      assert.equal(ledger?.amount, -1);
      assert.ok(audit);
    });

    await t.test('fresh no-op key reevaluates later and replay never debits twice', async () => {
      const key = 'integration-bulk-reusable-lost-response';
      const operationId = harness.shiftBulkAssignmentOperationId(primary.tenantId, key);
      const body = { assignments: [{ shiftId: primary.bulkReplayShiftId, userId: null }] };

      const noOp = await harness.controller.bulkAssign(body, primaryRequest, key);
      assert.deepEqual(noOp, { updated: 0 });
      assert.equal(await harness.ownerPrisma.auditLog.count({
        where: { tenantId: primary.tenantId, resourceId: operationId },
      }), 0);

      await harness.ownerPrisma.shift.update({
        where: { id: primary.bulkReplayShiftId },
        data: { userId: primary.staffId },
      });
      const before = await readShiftBulkAssignmentState(
        harness.ownerPrisma,
        primary.tenantId,
        [primary.bulkReplayShiftId],
      );
      const applied = await harness.controller.bulkAssign(body, primaryRequest, key);
      const recoveredAfterDiscardedResponse = await harness.controller.bulkAssign(body, primaryRequest, key);
      const after = await readShiftBulkAssignmentState(
        harness.ownerPrisma,
        primary.tenantId,
        [primary.bulkReplayShiftId],
      );

      assert.deepEqual(applied, { updated: 1 });
      assert.deepEqual(recoveredAfterDiscardedResponse, applied);
      assert.equal(after.usageCredits, before.usageCredits - 1);
      assert.equal(after.ledgerCount, before.ledgerCount + 1);
      assert.equal(after.auditCount, before.auditCount + 1);
      assert.equal(after.shifts[0]?.userId, null);
      assert.equal(await harness.ownerPrisma.creditTransaction.count({
        where: { id: `feature-usage-${operationId}` },
      }), 1);
      assert.equal(await harness.ownerPrisma.auditLog.count({
        where: { tenantId: primary.tenantId, resourceId: operationId },
      }), 1);
    });

    await t.test('zero-credit distinct change rejects without side effects', async () => {
      const key = 'integration-bulk-zero-credit';
      const operationId = harness.shiftBulkAssignmentOperationId(isolated.tenantId, key);
      const isolatedRequest = shiftUpdateRequest(isolated.tenantId, isolated.managerId);
      const before = await readShiftBulkAssignmentState(
        harness.ownerPrisma,
        isolated.tenantId,
        [isolated.bulkShiftId],
      );

      await assert.rejects(
        harness.controller.bulkAssign({
          assignments: [{ shiftId: isolated.bulkShiftId, userId: isolated.staffId }],
        }, isolatedRequest, key),
        (error) => {
          assert.ok(error instanceof ForbiddenException);
          assert.equal(error.getStatus(), 403);
          return true;
        },
      );

      const after = await readShiftBulkAssignmentState(
        harness.ownerPrisma,
        isolated.tenantId,
        [isolated.bulkShiftId],
      );
      assert.deepEqual(after, before);
      assert.equal(await harness.ownerPrisma.creditTransaction.count({
        where: { id: `feature-usage-${operationId}` },
      }), 0);
      assert.equal(await harness.ownerPrisma.auditLog.count({
        where: { tenantId: isolated.tenantId, resourceId: operationId },
      }), 0);
    });

    await t.test('published and tenant boundaries stay unchanged', async () => {
      const primaryBefore = await readShiftBulkAssignmentState(
        harness.ownerPrisma,
        primary.tenantId,
        [primary.publishedShiftId],
      );
      const isolatedBefore = await readShiftBulkAssignmentState(
        harness.ownerPrisma,
        isolated.tenantId,
        [isolated.bulkShiftId],
      );

      await assert.rejects(
        harness.controller.bulkAssign({
          assignments: [{ shiftId: primary.publishedShiftId, userId: primary.staffId }],
        }, primaryRequest, 'integration-bulk-published'),
        (error) => {
          assert.ok(error instanceof BadRequestException);
          assert.equal(error.getStatus(), 400);
          return true;
        },
      );
      await assert.rejects(
        harness.controller.bulkAssign({
          assignments: [{ shiftId: primary.bulkNoOpShiftId, userId: isolated.staffId }],
        }, shiftUpdateRequest(isolated.tenantId, isolated.managerId), 'integration-bulk-other-tenant'),
        (error) => {
          assert.ok(error instanceof BadRequestException);
          assert.equal(error.getStatus(), 400);
          return true;
        },
      );

      const primaryAfter = await readShiftBulkAssignmentState(
        harness.ownerPrisma,
        primary.tenantId,
        [primary.publishedShiftId],
      );
      const isolatedAfter = await readShiftBulkAssignmentState(
        harness.ownerPrisma,
        isolated.tenantId,
        [isolated.bulkShiftId],
      );
      assert.deepEqual(primaryAfter, primaryBefore);
      assert.deepEqual(isolatedAfter, isolatedBefore);
    });
  } finally {
    await cleanupShiftUpdateFixture(harness.ownerPrisma, fixture);
    await harness.disconnect();
  }
});
