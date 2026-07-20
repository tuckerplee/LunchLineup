import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const payroll = new PayrollService(new TenantDatabase(app));

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
    const adminIdentity = identity(tenant.id, admin, 'ADMIN', [
      'payroll:read',
      'payroll:policy_write',
      'payroll:lock',
      'payroll:export',
      'payroll:reconcile',
      'time_cards:approve',
    ]);
    const otherIdentity = identity(otherTenant.id, otherUser, 'ADMIN', ['payroll:read']);
    const approverIdentity = identity(tenant.id, approver, 'ADMIN', ['time_cards:approve']);
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
    const legacyBatch = await owner.payrollExportBatch.create({
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
    const legacyLine = await owner.payrollExportLine.create({
      data: {
        id: legacyLineId,
        tenantId: tenant.id,
        batchId: legacyBatch.id,
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
