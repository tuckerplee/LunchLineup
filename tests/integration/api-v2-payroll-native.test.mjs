import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

import { createPrisma, requireServiceUrl } from './schedule-solve-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api-v2/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { PayrollService } = require('../../apps/api-v2/src/payroll/payroll.service.ts');
const {
  buildPayrollCsv,
  payrollContentSha256,
  payrollExportLineSha256,
  reconciliationPayloadSha256,
} = require('../../apps/api-v2/src/payroll/domain.ts');
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function identity(tenantId, user, role, permissions) {
  return {
    sub: user.id,
    publicUserId: user.publicId,
    tenantId,
    sessionId: `payroll-native-session-${randomUUID()}`,
    role,
    legacyRole: role,
    roles: [{ id: randomUUID(), name: role === 'STAFF' ? 'Staff' : 'Administrator', isSystem: true, legacyRole: role }],
    permissions,
    mfaVerified: true,
    mfaRequired: false,
  };
}

// Explicit synthetic MFA capability: native fixture proves database domain
// behavior, not a physical Redis challenge or marker lifetime qualification.
const mutationObserver = {
  async observeSessionMfa(selected) {
    return { ...selected, expiresAtEpochMs: Date.now() + 60_000,
      expiresAtMonotonicMs: performance.now() + 60_000 };
  },
};

async function seedMutationAuthority(owner, tenantId, user, role, permissions) {
  const actor = identity(tenantId, user, role, permissions);
  const catalog = await owner.permission.findMany({ where: { key: { in: permissions } }, select: { id: true, key: true } });
  assert.deepEqual(catalog.map(row => row.key).sort(), [...permissions].sort(), 'existing permission catalog is required');
  const scopedRole = await owner.role.create({ data: {
    tenantId, name: `Payroll fixture ${user.id}`, slug: `payroll-fixture-${randomUUID()}`,
    isSystem: false, isDefault: false,
    rolePermissions: { create: catalog.map(permission => ({ permissionId: permission.id })) },
  } });
  await owner.roleAssignment.create({ data: { tenantId, userId: user.id, roleId: scopedRole.id } });
  await owner.session.create({ data: { id: actor.sessionId, userId: user.id,
    refreshToken: createHash('sha256').update(randomUUID()).digest('hex'),
    ipAddress: '127.0.0.1', userAgent: 'LunchLineup native payroll integration fixture',
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60_000) } });
  actor.roles = [{ id: scopedRole.publicId, name: scopedRole.name, isSystem: false, legacyRole: null }];
  actor.pinResetRequired = false;
  return actor;
}

function assertPublic(value, internalIds) {
  const body = JSON.stringify(value);
  for (const internalId of internalIds.filter((id) => typeof id === 'string' && id)) {
    assert.equal(body.includes(internalId), false, `public response leaked internal id ${internalId}`);
  }
}

async function cleanup(owner, tenantIds) {
  await owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    for (const table of [
      'PayrollReconciliationLineState',
      'PayrollReconciliationLineEvent',
      'PayrollReconciliationReceipt',
      'PayrollExportLine',
      'PayrollExportBatch',
      'PayrollAmendmentDecision',
      'PayrollAmendment',
      'PayrollLockedEntry',
      'PayrollOperation',
      'PayrollTimeCardApproval',
      'TimeCardBreak',
      'TimeCard',
      'PayrollPeriod',
      'PayrollPolicyVersion',
      'AuditLog',
      'CreditTransaction',
      'TenantSetting',
    ]) {
      await transaction.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, tenantIds);
    }
    await transaction.session.deleteMany({ where: { user: { tenantId: { in: tenantIds } } } });
    await transaction.roleAssignment.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await transaction.rolePermission.deleteMany({ where: { role: { tenantId: { in: tenantIds } } } });
    await transaction.role.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await transaction.location.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await transaction.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await transaction.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  }).catch(() => {});
}

test('native API v2 Payroll uses public IDs, tenant RLS, immutable evidence, exact-once export, and reconciliation', { timeout: 75_000 }, async () => {
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const runId = randomUUID();
  const fixture = {
    tenantId: `api-v2-payroll-${runId}`,
    otherTenantId: `api-v2-payroll-other-${runId}`,
    adminId: `api-v2-payroll-admin-${runId}`,
    approverId: `api-v2-payroll-approver-${runId}`,
    employeeId: `api-v2-payroll-employee-${runId}`,
    locationId: `api-v2-payroll-location-${runId}`,
  };
  const payroll = new PayrollService(new TenantDatabase(app), mutationObserver);

  try {
    const tenant = await owner.tenant.create({
      data: {
        id: fixture.tenantId,
        name: 'API v2 Payroll Integration',
        slug: `api-v2-payroll-${runId}`,
        planTier: 'GROWTH',
        status: 'ACTIVE',
        stripeSubscriptionId: `sub_api_v2_payroll_${runId}`,
        stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        usageCredits: 5,
      },
    });
    const otherTenant = await owner.tenant.create({
      data: {
        id: fixture.otherTenantId,
        name: 'Other API v2 Payroll Integration',
        slug: `api-v2-payroll-other-${runId}`,
        planTier: 'FREE',
        status: 'ACTIVE',
      },
    });
    const [admin, approver, employee, otherUser, location] = await Promise.all([
      owner.user.create({
        data: { id: fixture.adminId, tenantId: tenant.id, name: 'API v2 Payroll Admin', role: 'ADMIN', mfaBackupCodes: [] },
      }),
      owner.user.create({
        data: { id: fixture.approverId, tenantId: tenant.id, name: 'API v2 Payroll Approver', role: 'ADMIN', mfaBackupCodes: [] },
      }),
      owner.user.create({
        data: { id: fixture.employeeId, tenantId: tenant.id, name: 'API v2 Payroll Employee', role: 'STAFF', mfaBackupCodes: [] },
      }),
      owner.user.create({
        data: { tenantId: otherTenant.id, name: 'Other API v2 Payroll User', role: 'ADMIN', mfaBackupCodes: [] },
      }),
      owner.location.create({
        data: { id: fixture.locationId, tenantId: tenant.id, name: 'API v2 Payroll Location', timezone: 'UTC' },
      }),
    ]);
    const adminIdentity = await seedMutationAuthority(owner, tenant.id, admin, 'ADMIN', [
      'payroll:read',
      'payroll:policy_write',
      'payroll:lock',
      'payroll:export',
      'payroll:reconcile',
      'time_cards:approve',
    ]);
    const otherIdentity = await seedMutationAuthority(owner, otherTenant.id, otherUser, 'ADMIN', ['payroll:read']);
    const approverIdentity = await seedMutationAuthority(owner, tenant.id, approver, 'ADMIN', ['time_cards:approve']);
    const policyKey = `api-v2-payroll-policy-${runId}`;
    const policy = await payroll.createPolicy(adminIdentity, {
      timeZone: 'UTC',
      cadence: 'WEEKLY',
      anchorDate: '2020-01-06',
      effectiveFrom: '2020-01-06',
    }, policyKey);
    const policyReplay = await payroll.createPolicy(adminIdentity, {
      timeZone: 'UTC',
      cadence: 'WEEKLY',
      anchorDate: '2020-01-06',
      effectiveFrom: '2020-01-06',
    }, policyKey);
    assert.match(policy.id, UUID);
    assert.equal(policy.id, policyReplay.id);
    assert.equal(policy.createdByUserId, admin.publicId);
    assert.equal((await payroll.latestPolicy(adminIdentity)).data?.id, policy.id);
    assert.equal((await payroll.listPolicies(adminIdentity, { limit: '1' })).data[0]?.id, policy.id);

    const source = await payroll.createPeriod(adminIdentity, { localStartDate: '2020-01-06' }, `api-v2-payroll-source-${runId}`);
    const adjustment = await payroll.createPeriod(adminIdentity, { localStartDate: '2020-01-13' }, `api-v2-payroll-adjustment-${runId}`);
    assert.match(source.id, UUID);
    assert.match(adjustment.id, UUID);
    assert.equal(source.status, 'OPEN');
    assert.equal(adjustment.status, 'OPEN');

    const card = await owner.timeCard.create({
      data: {
        tenantId: tenant.id,
        userId: employee.id,
        locationId: location.id,
        clockInAt: new Date('2020-01-07T09:00:00.000Z'),
        clockOutAt: new Date('2020-01-07T17:00:00.000Z'),
        workTimeZone: 'UTC',
        breakMinutes: 30,
        status: 'CLOSED',
      },
    });
    assert.match(card.publicId, UUID);

    const candidate = await payroll.getPeriod(adminIdentity, source.id, {});
    assert.equal(candidate.cards.length, 1);
    assert.equal(candidate.cards[0]?.id, card.publicId);
    assert.equal(candidate.cards[0]?.adoptionEligible, true);

    const adopted = await payroll.adoptCards(adminIdentity, source.id, {
      cards: [{ id: card.publicId, expectedRevision: card.revision }],
    }, `api-v2-payroll-adopt-${runId}`);
    const adoptedReplay = await payroll.adoptCards(adminIdentity, source.id, {
      cards: [{ id: card.publicId, expectedRevision: card.revision }],
    }, `api-v2-payroll-adopt-${runId}`);
    assert.deepEqual(adoptedReplay, adopted);
    assert.equal(adopted.cards[0]?.id, card.publicId);
    assert.equal(adopted.cards[0]?.revision, card.revision + 1);

    const review = await payroll.startReview(adminIdentity, source.id, { expectedRevision: source.revision }, `api-v2-payroll-review-${runId}`);
    assert.equal(review.status, 'REVIEW');
    const decisions = await payroll.decideCards(adminIdentity, source.id, {
      decisions: [{
        timeCardId: card.publicId,
        expectedRevision: adopted.cards[0]?.revision,
        decision: 'APPROVED',
        reason: 'Payroll card approved.',
      }],
    }, `api-v2-payroll-decision-${runId}`);
    assert.equal(decisions.decisions[0]?.timeCardId, card.publicId);
    assert.equal(decisions.decisions[0]?.decidedByUserId, admin.publicId);

    const lockedSource = await payroll.lockPeriod(adminIdentity, source.id, { expectedRevision: review.revision }, `api-v2-payroll-lock-${runId}`);
    assert.equal(lockedSource.status, 'LOCKED');
    assert.equal(lockedSource.lockedEntryCount, 1);
    assert.equal(lockedSource.totalPayableMinutes, 450);
    const sourceDetail = await payroll.getPeriod(adminIdentity, source.id, {});
    const sourceEntry = sourceDetail.lockedEntries[0];
    assert.ok(sourceEntry);
    assert.match(sourceEntry.id, UUID);
    assert.equal(sourceEntry.sourceId, card.publicId);
    assert.equal(sourceEntry.employeeId, employee.publicId);

    const amendment = await payroll.createAmendment(adminIdentity, sourceEntry.id, {
      adjustmentPeriodId: adjustment.id,
      reason: 'Correct a missed payroll hour.',
      replacementClockInAt: '2020-01-07T09:00:00.000Z',
      replacementClockOutAt: '2020-01-07T18:00:00.000Z',
      replacementBreakMinutes: 30,
    }, `api-v2-payroll-amendment-${runId}`);
    assert.match(amendment.id, UUID);
    assert.equal(amendment.lockedEntryId, sourceEntry.id);
    assert.equal(amendment.minuteDelta, 60);

    const adjustmentReview = await payroll.startReview(adminIdentity, adjustment.id, { expectedRevision: adjustment.revision }, `api-v2-payroll-adjustment-review-${runId}`);
    await assert.rejects(
      () => payroll.decideAmendment(adminIdentity, amendment.id, {
        decision: 'APPROVED',
        reason: 'A requester cannot approve their own amendment.',
      }, `api-v2-payroll-amendment-self-decision-${runId}`),
      (error) => error?.code === 'payroll_self_amendment_decision_denied',
    );
    const amendmentDecision = await payroll.decideAmendment(approverIdentity, amendment.id, {
      decision: 'APPROVED',
      reason: 'Amendment approved.',
    }, `api-v2-payroll-amendment-decision-${runId}`);
    assert.equal(amendmentDecision.amendmentId, amendment.id);
    assert.equal(amendmentDecision.decidedByUserId, approver.publicId);
    const lockedAdjustment = await payroll.lockPeriod(adminIdentity, adjustment.id, { expectedRevision: adjustmentReview.revision }, `api-v2-payroll-adjustment-lock-${runId}`);
    assert.equal(lockedAdjustment.status, 'LOCKED');
    assert.equal(lockedAdjustment.lockedEntryCount, 1);
    assert.equal(lockedAdjustment.totalPayableMinutes, 60);

    // Simulate one immutable batch created by the retired v1 writer. The
    // native owner must verify its original private evidence, then return a
    // public-ID CSV and matching public content hash without rewriting it.
    const adjustmentDetail = await payroll.getPeriod(adminIdentity, adjustment.id, {});
    const adjustmentEntry = adjustmentDetail.lockedEntries[0];
    assert.ok(adjustmentEntry);
    const [persistedAdjustment, persistedAdjustmentEntry] = await Promise.all([
      owner.payrollPeriod.findUniqueOrThrow({ where: { publicId: adjustment.id } }),
      owner.payrollLockedEntry.findUniqueOrThrow({ where: { publicId: adjustmentEntry.id } }),
    ]);
    const legacyBatchId = `api-v2-payroll-legacy-batch-${runId}`;
    const legacyOperationId = `payroll-export:legacy-${runId}`;
    const legacyCreditTransactionId = `feature-usage-payroll-export:${legacyOperationId}`;
    const legacyLineId = `api-v2-payroll-legacy-line-${runId}`;
    const legacyCsvLine = {
      id: legacyLineId,
      lineNumber: 1,
      sourceType: persistedAdjustmentEntry.sourceType,
      sourceId: persistedAdjustmentEntry.sourceId,
      employeeId: persistedAdjustmentEntry.employeeId,
      locationId: persistedAdjustmentEntry.locationId,
      workTimeZone: persistedAdjustmentEntry.workTimeZone,
      clockInAt: persistedAdjustmentEntry.clockInAt,
      clockOutAt: persistedAdjustmentEntry.clockOutAt,
      breakMinutes: persistedAdjustmentEntry.breakMinutes,
      payableMinutes: persistedAdjustmentEntry.payableMinutes,
    };
    const legacyContent = buildPayrollCsv([legacyCsvLine]);
    const legacyLineHash = payrollExportLineSha256({
      tenantId: tenant.id,
      batchId: legacyBatchId,
      lockedEntryId: persistedAdjustmentEntry.id,
      line: legacyCsvLine,
    });
    await owner.tenant.update({ where: { id: tenant.id }, data: { usageCredits: 4 } });
    await owner.creditTransaction.create({
      data: {
        id: legacyCreditTransactionId,
        tenantId: tenant.id,
        amount: -1,
        debtAmount: 0,
        reason: `Payroll export (${persistedAdjustment.id})`,
        balanceAfter: 4,
        debtAfter: 0,
      },
    });
    const { legacyBatch, legacyLine } = await owner.$transaction(async (transaction) => {
      const batch = await transaction.payrollExportBatch.create({
        data: {
          id: legacyBatchId,
          tenantId: tenant.id,
          periodId: persistedAdjustment.id,
          operationId: legacyOperationId,
          requestHash: 'f'.repeat(64),
          creditTransactionId: legacyCreditTransactionId,
          formatVersion: 1,
          contentSha256: payrollContentSha256(legacyContent),
          rowCount: 1,
          totalPayableMinutes: persistedAdjustmentEntry.payableMinutes,
          consumedCredits: 1,
          newBalance: 4,
        },
      });
      const line = await transaction.payrollExportLine.create({
        data: {
          id: legacyLineId,
          tenantId: tenant.id,
          batchId: batch.id,
          lineNumber: 1,
          lockedEntryId: persistedAdjustmentEntry.id,
          sourceType: persistedAdjustmentEntry.sourceType,
          sourceId: persistedAdjustmentEntry.sourceId,
          employeeId: persistedAdjustmentEntry.employeeId,
          locationId: persistedAdjustmentEntry.locationId,
          workTimeZone: persistedAdjustmentEntry.workTimeZone,
          clockInAt: persistedAdjustmentEntry.clockInAt,
          clockOutAt: persistedAdjustmentEntry.clockOutAt,
          breakMinutes: persistedAdjustmentEntry.breakMinutes,
          payableMinutes: persistedAdjustmentEntry.payableMinutes,
          canonicalSha256: legacyLineHash,
        },
      });
      return { legacyBatch: batch, legacyLine: line };
    });
    const legacyExport = await payroll.getExport(adminIdentity, legacyBatch.publicId, {});
    const legacyDownload = await payroll.downloadExport(adminIdentity, legacyBatch.publicId);
    assert.equal(legacyExport.formatVersion, 1);
    assert.equal(legacyExport.lines[0]?.id, legacyLine.publicId);
    assert.equal(payrollContentSha256(legacyDownload.content), legacyExport.contentSha256);
    assert.equal(legacyDownload.content.toString('utf8').includes(legacyLine.id), false);
    assert.equal(legacyDownload.content.toString('utf8').includes(persistedAdjustmentEntry.id), false);
    assertPublic(legacyExport, [
      fixture.tenantId,
      legacyBatch.id,
      legacyLine.id,
      persistedAdjustment.id,
      persistedAdjustmentEntry.id,
      persistedAdjustmentEntry.sourceId,
      persistedAdjustmentEntry.employeeId,
      persistedAdjustmentEntry.locationId,
    ]);

    const entitlement = await payroll.exportEntitlement(adminIdentity);
    assert.equal(entitlement.eligible, true);
    assert.equal(entitlement.creditCost, 1);
    const exported = await payroll.createExport(adminIdentity, source.id, {
      expectedCreditCost: entitlement.creditCost,
    }, `api-v2-payroll-export-${runId}`);
    const exportedReplay = await payroll.createExport(adminIdentity, source.id, {
      expectedCreditCost: entitlement.creditCost,
    }, `api-v2-payroll-export-${runId}`);
    assert.equal(exported.status, 'GENERATED');
    assert.match(exported.id, UUID);
    assert.equal(exported.id, exportedReplay.id);
    assert.equal(exported.periodId, source.id);
    assert.equal(exported.lines.length, 1);
    const exportLine = exported.lines[0];
    assert.ok(exportLine);
    assert.match(exportLine.id, UUID);
    assert.equal(exportLine.lockedEntryId, sourceEntry.id);
    assert.equal(exportLine.employeeId, employee.publicId);

    const download = await payroll.downloadExport(adminIdentity, exported.id);
    const csv = download.content.toString('utf8');
    assert.match(download.filename, new RegExp(`-${exported.id}\\.csv$`));
    assert.match(csv, /payroll_line_id,source_type,source_id,employee_id/);
    assert.match(csv, new RegExp(exportLine.id));
    assert.match(csv, new RegExp(card.publicId));
    assert.match(csv, new RegExp(employee.publicId));
    assert.match(csv, new RegExp(location.publicId));
    for (const internalId of [fixture.tenantId, fixture.adminId, fixture.employeeId, fixture.locationId, card.id]) {
      assert.equal(csv.includes(internalId), false, `CSV leaked internal id ${internalId}`);
    }

    const receipt = await payroll.reconcileExport(adminIdentity, exported.id, {
      provider: 'Native Payroll Test',
      providerEventId: `native-payroll-event-${runId}`,
      providerTotalMinutes: exported.totalPayableMinutes,
      outcomes: [{ lineId: exportLine.id, status: 'ACCEPTED', reason: 'Accepted by provider.' }],
    });
    const receiptReplay = await payroll.reconcileExport(adminIdentity, exported.id, {
      provider: 'Native Payroll Test',
      providerEventId: `native-payroll-event-${runId}`,
      providerTotalMinutes: exported.totalPayableMinutes,
      outcomes: [{ lineId: exportLine.id, status: 'ACCEPTED', reason: 'Accepted by provider.' }],
    });
    assert.match(receipt.id, UUID);
    assert.equal(receipt.id, receiptReplay.id);
    assert.equal(receipt.batchId, exported.id);
    assert.equal(receipt.receivedByUserId, admin.publicId);
    assert.equal(receipt.acceptedCount, 1);

    const reconciled = await payroll.getExport(adminIdentity, exported.id, {});
    assert.equal(reconciled.status, 'RECONCILED');
    assert.equal(reconciled.reconciliation.acceptedCount, 1);
    assert.equal(reconciled.reconciliation.providerTotalMinutes, 450);
    await assert.rejects(
      () => payroll.getPeriod(otherIdentity, source.id, {}),
      (error) => error?.code === 'payroll_period_not_found',
    );

    const [wallet, creditRows, persistedExport, persistedEntry, persistedLine] = await Promise.all([
      owner.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { usageCredits: true } }),
      owner.creditTransaction.findMany({ where: { tenantId: tenant.id }, select: { id: true, amount: true, reason: true } }),
      owner.payrollExportBatch.findUniqueOrThrow({ where: { publicId: exported.id }, select: { id: true, publicId: true } }),
      owner.payrollLockedEntry.findUniqueOrThrow({ where: { publicId: sourceEntry.id }, select: { id: true, publicId: true } }),
      owner.payrollExportLine.findUniqueOrThrow({ where: { publicId: exportLine.id }, select: { id: true, publicId: true } }),
    ]);
    assert.equal(wallet.usageCredits, 3);
    assert.equal(creditRows.length, 2);
    assert.deepEqual(creditRows.map((row) => row.amount).sort(), [-1, -1]);
    assert.notEqual(persistedExport.id, persistedExport.publicId);
    assert.notEqual(persistedEntry.id, persistedEntry.publicId);
    assert.notEqual(persistedLine.id, persistedLine.publicId);
    assert.equal(receipt.payloadSha256, reconciliationPayloadSha256({
      tenantId: tenant.id,
      actorUserId: admin.id,
      batchId: persistedExport.id,
      payload: {
        provider: 'Native Payroll Test',
        providerEventId: `native-payroll-event-${runId}`,
        providerTotalMinutes: exported.totalPayableMinutes,
        outcomes: [{ lineId: persistedLine.id, status: 'ACCEPTED', reason: 'Accepted by provider.' }],
      },
    }));
    assertPublic({ policy, source, adjustment, sourceDetail, amendment, exported, receipt, reconciled }, [
      fixture.tenantId,
      fixture.adminId,
      fixture.approverId,
      fixture.employeeId,
      fixture.locationId,
      card.id,
      persistedExport.id,
      persistedEntry.id,
    ]);
  } finally {
    await cleanup(owner, [fixture.tenantId, fixture.otherTenantId]);
    await Promise.allSettled([app.$disconnect(), owner.$disconnect()]);
  }
});

for (const minuteDelta of [60, -60]) {
  test(`native API v2 Payroll amendment export preserves ${minuteDelta > 0 ? 'positive' : 'negative'} signed minutes and independent decisions`, { timeout: 75_000 }, async () => {
    const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
    const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
    const runId = randomUUID();
    const tenantId = `native-amendment-${runId}`;
    const key = (operation) => `amendment-${runId}-${operation}`;
    const payroll = new PayrollService(new TenantDatabase(app), mutationObserver);
    try {
      await owner.tenant.create({ data: {
        id: tenantId, name: 'Native amendment export fixture', slug: tenantId,
        planTier: 'GROWTH', status: 'ACTIVE', usageCredits: 5,
        stripeSubscriptionId: `sub_amendment_${runId}`,
        stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
      } });
      const users = await Promise.all(['Requester', 'Reviewer', 'Employee'].map(name => owner.user.create({
        data: { tenantId, name, role: 'ADMIN', mfaBackupCodes: [] },
      })));
      const [requester, reviewer, employee] = users;
      const location = await owner.location.create({ data: { tenantId, name: 'Amendment fixture', timezone: 'UTC' } });
      const requesterIdentity = await seedMutationAuthority(owner, tenantId, requester, 'ADMIN', [
        'payroll:read', 'payroll:policy_write', 'payroll:lock', 'payroll:export', 'payroll:reconcile', 'time_cards:approve',
      ]);
      const reviewerIdentity = await seedMutationAuthority(owner, tenantId, reviewer, 'ADMIN', ['time_cards:approve']);
      const employeeIdentity = await seedMutationAuthority(owner, tenantId, employee, 'ADMIN', ['time_cards:approve', 'payroll:reconcile']);
      await payroll.createPolicy(requesterIdentity, {
        timeZone: 'UTC', cadence: 'WEEKLY', anchorDate: '2020-01-06', effectiveFrom: '2020-01-06',
      }, key('policy'));
      const source = await payroll.createPeriod(requesterIdentity, { localStartDate: '2020-01-06' }, key('source'));
      const adjustment = await payroll.createPeriod(requesterIdentity, { localStartDate: '2020-01-13' }, key('adjustment'));
      const card = await owner.timeCard.create({ data: {
        tenantId, userId: employee.id, locationId: location.id,
        clockInAt: new Date('2020-01-07T09:00:00.000Z'), clockOutAt: new Date('2020-01-07T17:00:00.000Z'),
        workTimeZone: 'UTC', breakMinutes: 30, status: 'CLOSED',
      } });
      const adopted = await payroll.adoptCards(requesterIdentity, source.id, {
        cards: [{ id: card.publicId, expectedRevision: card.revision }],
      }, key('adopt'));
      const sourceReview = await payroll.startReview(requesterIdentity, source.id, { expectedRevision: source.revision }, key('source-review'));
      await payroll.decideCards(reviewerIdentity, source.id, { decisions: [{
        timeCardId: card.publicId, expectedRevision: adopted.cards[0].revision, decision: 'APPROVED', reason: 'Verify original worked time.',
      }] }, key('card-approval'));
      await payroll.lockPeriod(requesterIdentity, source.id, { expectedRevision: sourceReview.revision }, key('source-lock'));
      const sourceDetail = await payroll.getPeriod(requesterIdentity, source.id, {});
      assert.equal(sourceDetail.lockedEntries.length, 1);
      const original = sourceDetail.lockedEntries[0];
      assert.equal(original.payableMinutes, 450);
      const sourceSnapshot = await owner.payrollLockedEntry.findUniqueOrThrow({ where: { publicId: original.id } });
      const amendmentBody = {
        adjustmentPeriodId: adjustment.id, reason: 'Correct the original worked time.',
        replacementClockInAt: '2020-01-07T09:00:00.000Z',
        replacementClockOutAt: minuteDelta > 0 ? '2020-01-07T18:00:00.000Z' : '2020-01-07T16:00:00.000Z',
        replacementBreakMinutes: 30,
      };
      await assert.rejects(() => payroll.createAmendment(employeeIdentity, original.id, amendmentBody,
        key('employee-request-denied')), error => error?.code === 'payroll_self_amendment_denied');
      const amendment = await payroll.createAmendment(requesterIdentity, original.id, amendmentBody, key('amendment'));
      assert.equal(amendment.minuteDelta, minuteDelta);
      const rejected = await payroll.createAmendment(requesterIdentity, original.id, {
        ...amendmentBody, reason: 'Alternative correction requiring rejection.',
        replacementClockOutAt: '2020-01-07T19:00:00.000Z',
      }, key('rejected-amendment'));
      assert.equal(rejected.minuteDelta, 120);
      const adjustmentReview = await payroll.startReview(requesterIdentity, adjustment.id, { expectedRevision: adjustment.revision }, key('adjustment-review'));
      const adjustmentRow = await owner.payrollPeriod.findUniqueOrThrow({ where: { publicId: adjustment.id } });
      const pendingState = async () => ({
        period: await owner.payrollPeriod.findUniqueOrThrow({ where: { id: adjustmentRow.id } }),
        entries: await owner.payrollLockedEntry.count({ where: { tenantId, periodId: adjustmentRow.id } }),
        decisions: await owner.payrollAmendmentDecision.count({ where: { tenantId } }),
        batches: await owner.payrollExportBatch.count({ where: { tenantId } }),
        credits: await owner.creditTransaction.count({ where: { tenantId } }),
        wallet: await owner.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { usageCredits: true } }),
      });
      const beforeDenials = await pendingState();
      await assert.rejects(() => payroll.lockPeriod(requesterIdentity, adjustment.id, {
        expectedRevision: adjustmentReview.revision,
      }, key('pending-lock')), error => error?.code === 'payroll_amendment_pending');
      await assert.rejects(() => payroll.createExport(requesterIdentity, adjustment.id, {
        expectedCreditCost: 1,
      }, key('pending-export')), error => error?.code === 'payroll_export_state_invalid');
      for (const [label, actor] of [['requester', requesterIdentity], ['source-employee', employeeIdentity]]) {
        await assert.rejects(() => payroll.decideAmendment(actor, amendment.id, {
          decision: 'APPROVED', reason: 'Attempt a self-interested approval.',
        }, key(`${label}-denied`)), error => error?.code === 'payroll_self_amendment_decision_denied');
      }
      assert.deepEqual(await pendingState(), beforeDenials, 'denied operations must not change decisions, lock, export, or credit state');
      const approved = await payroll.decideAmendment(reviewerIdentity, amendment.id, {
        decision: 'APPROVED', reason: 'Independently verified correction.',
      }, key('approve'));
      assert.equal(approved.decidedByUserId, reviewer.publicId);
      await assert.rejects(() => payroll.lockPeriod(requesterIdentity, adjustment.id, {
        expectedRevision: adjustmentReview.revision,
      }, key('remaining-pending-lock')), error => error?.code === 'payroll_amendment_pending');
      const rejection = await payroll.decideAmendment(reviewerIdentity, rejected.id, {
        decision: 'REJECTED', reason: 'Alternative hours were not worked.',
      }, key('reject'));
      assert.equal(rejection.decision, 'REJECTED');
      const locked = await payroll.lockPeriod(requesterIdentity, adjustment.id, {
        expectedRevision: adjustmentReview.revision,
      }, key('adjustment-lock'));
      assert.equal(locked.lockedEntryCount, 1);
      assert.equal(locked.totalPayableMinutes, minuteDelta);
      const detail = await payroll.getPeriod(requesterIdentity, adjustment.id, {});
      assert.equal(detail.lockedEntries.length, 1);
      assert.equal(detail.lockedEntries[0].sourceType, 'AMENDMENT');
      assert.equal(detail.lockedEntries[0].sourceId, amendment.id);
      assert.equal(detail.lockedEntries[0].payableMinutes, minuteDelta);
      assert.equal(detail.lockedEntries[0].clockInAt, amendmentBody.replacementClockInAt);
      assert.equal(detail.lockedEntries[0].clockOutAt, amendmentBody.replacementClockOutAt);
      assert.equal(detail.lockedEntries[0].breakMinutes, amendmentBody.replacementBreakMinutes);
      assert.equal(detail.lockedEntries[0].locationId, original.locationId);
      assert.equal(detail.lockedEntries[0].workTimeZone, original.workTimeZone);
      const entitlement = await payroll.exportEntitlement(requesterIdentity);
      assert.equal(entitlement.eligible, true);
      assert.equal(entitlement.creditCost, 1);
      const exportBody = { expectedCreditCost: entitlement.creditCost };
      const exported = await payroll.createExport(requesterIdentity, adjustment.id, exportBody, key('export'));
      const replay = await payroll.createExport(requesterIdentity, adjustment.id, exportBody, key('export'));
      assert.deepEqual(replay, exported, 'exact replay must preserve the batch, line identities, and hashes');
      assert.equal(exported.periodId, adjustment.id);
      assert.equal(exported.totalPayableMinutes, minuteDelta);
      assert.deepEqual(exported.settlement, { consumedCredits: 1, newBalance: 4 });
      assert.equal(exported.lines.length, 1);
      const line = exported.lines[0];
      assert.equal(line.employeeId, employee.publicId);
      assert.equal(line.lockedEntryId, detail.lockedEntries[0].id);
      assert.equal(line.payableMinutes, minuteDelta);
      const download = await payroll.downloadExport(requesterIdentity, exported.id);
      const csvRows = download.content.toString('utf8').trimEnd().split('\n').map(row => row.split(','));
      assert.equal(csvRows.length, 2);
      assert.equal(csvRows[1][csvRows[0].indexOf('source_type')], '"AMENDMENT"');
      assert.equal(csvRows[1][csvRows[0].indexOf('source_id')], `"${amendment.id}"`);
      assert.equal(csvRows[1][csvRows[0].indexOf('payable_minutes')], `"${minuteDelta}"`);
      for (const [column, expected] of Object.entries({
        payroll_line_id: line.id, employee_id: employee.publicId, location_id: original.locationId,
        work_time_zone: original.workTimeZone, clock_in_utc: amendmentBody.replacementClockInAt,
        clock_out_utc: amendmentBody.replacementClockOutAt, break_minutes: amendmentBody.replacementBreakMinutes,
      })) {
        assert.equal(csvRows[1][csvRows[0].indexOf(column)], `"${expected}"`, `CSV ${column}`);
      }
      assert.equal(payrollContentSha256(download.content), exported.contentSha256);
      // A separate period containing only a rejected correction locks empty and
      // cannot create a paid export. No fixture inserts payroll-domain records.
      const rejectedPeriod = await payroll.createPeriod(requesterIdentity, { localStartDate: '2020-01-20' }, key('rejected-period'));
      const rejectedOnly = await payroll.createAmendment(requesterIdentity, original.id, {
        ...amendmentBody, adjustmentPeriodId: rejectedPeriod.id, reason: 'Unsubstantiated later correction.',
      }, key('rejected-only'));
      const rejectedReview = await payroll.startReview(requesterIdentity, rejectedPeriod.id, {
        expectedRevision: rejectedPeriod.revision,
      }, key('rejected-review'));
      await payroll.decideAmendment(reviewerIdentity, rejectedOnly.id, {
        decision: 'REJECTED', reason: 'No additional correction is supported.',
      }, key('reject-only'));
      const emptyLock = await payroll.lockPeriod(requesterIdentity, rejectedPeriod.id, {
        expectedRevision: rejectedReview.revision,
      }, key('rejected-lock'));
      assert.equal(emptyLock.status, 'LOCKED');
      assert.equal(emptyLock.lockedEntryCount, 0);
      assert.equal(emptyLock.totalPayableMinutes, 0);
      await assert.rejects(() => payroll.createExport(requesterIdentity, rejectedPeriod.id, exportBody,
        key('rejected-export')), error => error?.code === 'payroll_export_entry_count_invalid');
      const [batches, lines, credits, wallet, unchangedSource, persistedDecisions, persistedAmendment, persistedAdjustmentEntry] = await Promise.all([
        owner.payrollExportBatch.findMany({ where: { tenantId } }),
        owner.payrollExportLine.findMany({ where: { tenantId } }),
        owner.creditTransaction.findMany({ where: { tenantId } }),
        owner.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { usageCredits: true, creditDebt: true } }),
        owner.payrollLockedEntry.findUniqueOrThrow({ where: { id: sourceSnapshot.id } }),
        owner.payrollAmendmentDecision.findMany({ where: { tenantId } }),
        owner.payrollAmendment.findUniqueOrThrow({ where: { publicId: amendment.id } }),
        owner.payrollLockedEntry.findUniqueOrThrow({ where: { publicId: detail.lockedEntries[0].id } }),
      ]);
      assert.equal(batches.length, 1);
      assert.equal(batches[0].publicId, exported.id);
      assert.equal(batches[0].periodId, adjustmentRow.id);
      assert.equal(batches[0].totalPayableMinutes, minuteDelta);
      assert.equal(batches[0].consumedCredits, 1);
      assert.equal(batches[0].newBalance, 4);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].payableMinutes, minuteDelta);
      assert.equal(lines[0].publicId, line.id);
      assert.equal(lines[0].batchId, batches[0].id);
      assert.equal(lines[0].lockedEntryId, persistedAdjustmentEntry.id);
      for (const row of [lines[0], persistedAdjustmentEntry]) {
        assert.equal(row.sourceType, 'AMENDMENT');
        assert.equal(row.sourceId, persistedAmendment.id);
        assert.equal(row.employeeId, employee.id);
        assert.equal(row.locationId, sourceSnapshot.locationId);
        assert.equal(row.workTimeZone, sourceSnapshot.workTimeZone);
        assert.equal(row.clockInAt.toISOString(), amendmentBody.replacementClockInAt);
        assert.equal(row.clockOutAt.toISOString(), amendmentBody.replacementClockOutAt);
        assert.equal(row.breakMinutes, amendmentBody.replacementBreakMinutes);
        assert.equal(row.payableMinutes, minuteDelta);
      }
      assert.equal(persistedAmendment.lockedEntryId, sourceSnapshot.id);
      assert.equal(persistedAmendment.adjustmentPeriodId, adjustmentRow.id);
      assert.equal(credits.length, 1);
      assert.equal(credits[0].id, batches[0].creditTransactionId);
      assert.equal(credits[0].amount, -1);
      assert.equal(credits[0].debtAmount, 0);
      assert.equal(credits[0].balanceAfter, batches[0].newBalance);
      assert.equal(credits[0].debtAfter, 0);
      assert.equal(wallet.usageCredits, 4);
      assert.equal(wallet.creditDebt, 0);
      assert.deepEqual(persistedDecisions.map(row => row.decision).sort(), ['APPROVED', 'REJECTED', 'REJECTED']);
      assert.ok(persistedDecisions.every(row => row.decidedByUserId === reviewer.id));
      assert.deepEqual(unchangedSource, sourceSnapshot, 'future corrections must preserve the original locked snapshot');
    } finally {
      await cleanup(owner, [tenantId]);
      await Promise.allSettled([app.$disconnect(), owner.$disconnect()]);
    }
  });
}
