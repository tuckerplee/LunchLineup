import { createDecipheriv, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MfaVerificationObservation } from '@lunchlineup/rbac';
import type { TenantTransaction } from '../platform/database';
import { anonymizeDeletedUser } from './deactivation';
import { InvitationOutbox } from './invitation-outbox';
import { assertCurrentMutation, type CurrentMutationAuthority } from './mutation-authority';

// Direct nested-helper proofs. Transaction staging below is a local model,
// not PostgreSQL rollback or an integrated People.remove/invite execution.
const NOW = Date.parse('2026-10-04T12:00:00Z');
const TENANT = 'tenant-1';
const USER = 'user-1';
const DELETED_AT = new Date(NOW);
type Deadline = 'session' | 'mfa';

function authorityGuard(deadline?: Deadline) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const identity = { sub: 'actor', tenantId: TENANT, sessionId: 'session-1' };
  const authority: CurrentMutationAuthority = {
    actor: { id: identity.sub, publicId: 'actor-public', role: 'ADMIN', name: 'Actor',
      email: null, username: 'actor', suspendedAt: null, deletedAt: null,
      lockedUntil: null, pinLockedUntil: null },
    actorAccess: { roles: [], permissions: new Set(['users:delete']), legacyRole: 'ADMIN',
      rank: 3, isSystemAdmin: false },
    identity, expiresAtEpochMs: NOW + (deadline === 'session' ? 100 : 60_000),
    requiresMfa: true,
  };
  const observation: MfaVerificationObservation = {
    ...identity, expiresAtEpochMs: NOW + (deadline === 'mfa' ? 100 : 60_000),
    expiresAtMonotonicMs: performance.now() + 60_000,
  };
  return {
    assertCurrent: () => assertCurrentMutation(authority, observation),
    expire: () => vi.setSystemTime(NOW + 101),
    denial: { status: 403, code: deadline === 'mfa' ? 'mfa_verification_required' : 'permission_denied' },
  };
}

function gate() {
  let arrive!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>(resolve => { arrive = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  return { reached, resume, pause: async () => { arrive(); await released; } };
}

const CLEANUP_EFFECTS = [
  'refund.sql', 'imports.cancel', 'imports.erase-completed', 'shifts.unassign', 'schedule.revise',
  'invitation.cancel', 'user.anonymize', 'imports.erase-requestor', 'refresh.erase', 'session.revoke',
  'reset-outbox.erase', 'reset-token.erase', 'mfa-claims.erase', 'roles.erase', 'signup.erase',
  'notification-outbox.erase', 'notification.erase',
];

function cleanupModel(pauseAt?: string, wait = gate()) {
  const initial = { balance: 5, creditIds: [] as string[], draftUserId: USER as string | null,
    publishedUserId: USER, draftRevision: 4, anonymized: false, effects: [] as string[] };
  let persistent = structuredClone(initial);
  const staged = structuredClone(initial);
  const attempts: string[] = [];
  // Ledger records attempted mutation calls, including a matched-zero cleanup.
  const effect = async (name: string, apply?: () => void, count = 1) => {
    attempts.push(name);
    staged.effects.push(name);
    apply?.();
    if (pauseAt === name) await wait.pause();
    return { count };
  };
  const read = async (name: string) => { if (pauseAt === name) await wait.pause(); };
  const job = {
    id: 'import-1', status: 'RUNNING', storageKey: 'synthetic-only.pdf',
    creditConsumption: { source: 'credits', consumedCredits: 1, newBalance: 5 },
    debitCount: 1, debitTenantId: TENANT, debitAmount: -1, debitDebtAmount: 0,
    debitReason: 'Availability PDF import (import-1)', debitBalanceAfter: 5, debitDebtAfter: 0,
    refundCount: 0, refundTenantId: null, refundAmount: null, refundDebtAmount: null,
    refundReason: null, refundBalanceAfter: null, refundDebtAfter: null,
  };
  const tx = {
    $queryRaw: async (sql: { strings: readonly string[]; values: unknown[] }) => {
      const text = sql.strings.join('?');
      if (text.includes('public.settle_positive_credit_value')) {
        const id = 'feature-refund-availability-import:import-1';
        expect(sql.values).toEqual([TENANT, 1, 'Availability PDF import refund (import-1)', id]);
        await effect('refund.sql', () => { staged.balance += 1; staged.creditIds.push(id); });
        return [{ transactionId: id, creditedValue: 1, spendableAmount: 1, repaidDebt: 0,
          newBalance: 6, debtAfter: 0, replayed: false }];
      }
      if (text.includes('FROM "AvailabilityImportJob" job')) {
        expect(sql.values).toEqual([TENANT, USER]);
        await read('imports.lock');
        return [job];
      }
      if (text.includes('FROM "Schedule" schedule_row')) {
        expect(sql.values).toEqual([TENANT, USER]);
        await read('schedule.lock');
        return [{ id: 'draft-1' }, { id: 'published-1' }];
      }
      if (text.includes('FROM "Shift" shift_row')) {
        expect(sql.values).toEqual([TENANT, USER]);
        await read('shifts.lock');
        return [
          { id: 'shift-draft', scheduleId: 'draft-1', scheduleTenantId: TENANT,
            scheduleStatus: 'DRAFT', scheduleDeletedAt: null },
          { id: 'shift-published', scheduleId: 'published-1', scheduleTenantId: TENANT,
            scheduleStatus: 'PUBLISHED', scheduleDeletedAt: null },
        ];
      }
      if (text.includes('FROM "Tenant"')) {
        expect(sql.values).toEqual([TENANT]);
        return [{ id: TENANT }];
      }
      if (text.includes('FROM "User"')) {
        expect(sql.values).toEqual([USER, TENANT]);
        return [{ id: USER }];
      }
      throw new Error(`Unmodeled cleanup query: ${text}`);
    },
    $executeRaw: async (sql: { strings: readonly string[]; values: unknown[] }) => {
      const text = sql.strings.join('?');
      if (text.includes('pg_advisory_xact_lock')) {
        expect(sql.values).toEqual([`lunchlineup:scheduling:${TENANT}`]);
        return 1;
      }
      expect(text).toContain('UPDATE "Session"');
      expect(sql.values).toEqual([DELETED_AT, USER]);
      await effect('session.revoke');
      return 1;
    },
    availabilityImportJob: { updateMany: async (args: any) => {
      const requestor = args.where.requestedByUserId === USER;
      expect(args.where.tenantId).toBe(TENANT);
      if (requestor) expect(args.data).toEqual({ requestedByUserId: null });
      else {
        expect(args.where.userId).toBe(USER);
        expect(args.data.storageKey).toBeNull();
        expect(args.data.resultErasedAt).toEqual(DELETED_AT);
      }
      return effect(requestor ? 'imports.erase-requestor'
        : args.where.status === 'SUCCEEDED' ? 'imports.erase-completed' : 'imports.cancel',
      undefined, args.where.status === 'SUCCEEDED' ? 0 : 1);
    } },
    shift: { updateMany: async (args: any) => {
      expect(args).toEqual({ where: { id: { in: ['shift-draft'] }, tenantId: TENANT,
        userId: USER, deletedAt: null }, data: { userId: null } });
      return effect('shifts.unassign', () => { staged.draftUserId = null; });
    } },
    schedule: { updateMany: async (args: any) => {
      expect(args).toEqual({ where: { id: { in: ['draft-1'] }, tenantId: TENANT,
        status: 'DRAFT', deletedAt: null }, data: { revision: { increment: 1 } } });
      return effect('schedule.revise', () => { staged.draftRevision += 1; });
    } },
    staffInvitationOutbox: { updateMany: async (args: any) => {
      expect(args.where).toEqual({ tenantId: TENANT, userId: USER,
        status: { in: ['PENDING', 'SENDING', 'FAILED'] } });
      expect(args.data).toMatchObject({ status: 'CANCELLED', encryptedPayload: null });
      return effect('invitation.cancel');
    } },
    user: { updateMany: async (args: any) => {
      expect(args.where).toEqual({ id: USER, tenantId: TENANT, deletedAt: null });
      expect(args.data).toMatchObject({ name: 'Deleted user', deletedAt: DELETED_AT, passwordHash: null });
      return effect('user.anonymize', () => { staged.anonymized = true; });
    } },
    refreshTokenReplay: { deleteMany: async (args: any) => {
      expect(args.where).toEqual({ session: { userId: USER } });
      return effect('refresh.erase');
    } },
    passwordResetEmailOutbox: { deleteMany: scopedDelete('reset-outbox.erase') },
    passwordResetToken: { deleteMany: scopedDelete('reset-token.erase') },
    mfaTotpClaim: { deleteMany: scopedDelete('mfa-claims.erase') },
    roleAssignment: { deleteMany: scopedDelete('roles.erase') },
    onboardingSignupAttempt: { deleteMany: scopedDelete('signup.erase') },
    notificationOutbox: { deleteMany: scopedDelete('notification-outbox.erase') },
    notification: { deleteMany: scopedDelete('notification.erase') },
  };
  function scopedDelete(name: string) {
    return async (args: any) => {
      expect(args.where).toEqual({ tenantId: TENANT, userId: USER });
      return effect(name);
    };
  }
  return { wait, initial, staged, attempts, persistent: () => persistent,
    run: async (assertCurrent: () => void) => {
      const result = await anonymizeDeletedUser(tx as unknown as TenantTransaction,
        TENANT, USER, DELETED_AT, assertCurrent);
      persistent = structuredClone(staged);
      return result;
    } };
}

afterEach(() => { vi.useRealTimers(); });

describe('populated nested cleanup lifetime with actual authority assertions', () => {
  it('refunds once, clears only editable assignment, revises its draft and anonymizes', async () => {
    const guard = authorityGuard();
    const model = cleanupModel();
    await expect(model.run(guard.assertCurrent)).resolves.toEqual({
      availabilityImportStorageKeys: ['synthetic-only.pdf'], refundedAvailabilityImportCredits: 1,
    });
    expect(model.attempts).toEqual(CLEANUP_EFFECTS);
    expect(model.persistent()).toEqual({ balance: 6,
      creditIds: ['feature-refund-availability-import:import-1'], draftUserId: null,
      publishedUserId: USER, draftRevision: 5, anonymized: true, effects: CLEANUP_EFFECTS });
  });

  for (const deadline of ['session', 'mfa'] as const) {
    for (const pauseAt of ['imports.lock', 'refund.sql', 'shifts.lock', 'shifts.unassign', 'schedule.revise']) {
      it(`${deadline} expiry after ${pauseAt} blocks the next nested effect and discards staged state`, async () => {
        const guard = authorityGuard(deadline);
        const model = cleanupModel(pauseAt);
        const outcome = model.run(guard.assertCurrent).then(
          value => ({ value, error: null }), error => ({ value: null, error }));
        try {
          const arrived = await Promise.race([
            model.wait.reached.then(() => 'gate' as const),
            outcome.then(() => 'settled' as const),
          ]);
          expect(arrived).toBe('gate');
          guard.expire();
          model.wait.resume();
          expect((await outcome).error).toMatchObject(guard.denial);
          const prefixLength = pauseAt === 'imports.lock' ? 0
            : pauseAt === 'shifts.lock' ? 3 : CLEANUP_EFFECTS.indexOf(pauseAt) + 1;
          expect(model.attempts).toEqual(CLEANUP_EFFECTS.slice(0, prefixLength));
          expect(model.persistent()).toEqual(model.initial);
          expect(model.staged.effects).toEqual(model.attempts);
        } finally { model.wait.resume(); await outcome; }
      });
    }
  }
});

function invitationModel(existingStatus: string | null, wait = gate(), pauseLookup = false) {
  let row: any = null;
  const effects: string[] = [];
  const oldId = 'outbox-old';
  const tx = { staffInvitationOutbox: {
    findUnique: async (args: any) => {
      expect(args).toEqual({ where: { tenantId_userId_purpose: {
        tenantId: TENANT, userId: USER, purpose: 'STAFF_INVITATION',
      } }, select: { id: true, status: true } });
      if (pauseLookup) await wait.pause();
      return existingStatus ? { id: oldId, status: existingStatus } : null;
    },
    create: async (args: any) => {
      expect(args.data).toMatchObject({ tenantId: TENANT, userId: USER, purpose: 'STAFF_INVITATION' });
      effects.push('create'); row = args.data; return row;
    },
    update: async (args: any) => {
      expect(args.where).toEqual({ id: oldId });
      effects.push('update'); row = { id: oldId, tenantId: TENANT, userId: USER, ...args.data }; return row;
    },
  } };
  return { tx: tx as unknown as TenantTransaction, wait, effects, row: () => row, oldId };
}

describe('encrypted invitation enqueue lifetime with actual authority assertions', () => {
  const key = Buffer.from('11'.repeat(32), 'hex');
  const outbox = new InvitationOutbox({ staffInvitationOutboxEnabled: true,
    staffInvitationOutboxEncryptionKey: key.toString('hex'), staffInvitationMaxAttempts: 8 });
  const input = { tenantId: TENANT, userId: USER, recipient: ' Staff@Example.test ' };
  for (const status of [null, 'PENDING', 'DELIVERED', 'DEAD_LETTERED', 'CANCELLED']) {
    it(`valid ${status ?? 'new'} enqueue preserves its encrypted envelope and ID rules`, async () => {
      const guard = authorityGuard();
      const model = invitationModel(status);
      const result = await outbox.enqueue(model.tx, input, guard.assertCurrent);
      const row = model.row();
      expect(row).toMatchObject({ tenantId: TENANT, userId: USER, purpose: 'STAFF_INVITATION' });
      expect(model.effects).toEqual([status ? 'update' : 'create']);
      expect(result).toMatchObject({ deliveryId: row.id, status: 'PENDING', attempts: 0,
        canRetry: false, canReissue: false });
      if (status === 'PENDING') expect(row.id).toBe(model.oldId);
      else expect(row.id).not.toBe(model.oldId);
      expect(row.recipientHash).toBe(createHmac('sha256', key).update('staff@example.test').digest('hex'));
      expect(row.encryptionNonce).toHaveLength(12);
      expect(row.encryptionTag).toHaveLength(16);
      const decipher = createDecipheriv('aes-256-gcm', key, row.encryptionNonce);
      decipher.setAAD(Buffer.from(JSON.stringify({ tenantId: TENANT, outboxId: row.id,
        userId: USER, recipientHash: row.recipientHash, purpose: 'STAFF_INVITATION', payloadVersion: 1 })));
      decipher.setAuthTag(row.encryptionTag);
      expect(JSON.parse(Buffer.concat([decipher.update(row.encryptedPayload), decipher.final()]).toString()))
        .toEqual({ recipient: 'staff@example.test', template: 'staff_invitation' });
      expect(JSON.stringify(result)).not.toContain('staff@example.test');
      expect(row).not.toHaveProperty('recipient');
    });
    for (const deadline of ['session', 'mfa'] as const) {
      it(`${deadline} expiry during ${status ?? 'new'} lookup refuses enqueue before create/update`, async () => {
        const guard = authorityGuard(deadline);
        const model = invitationModel(status, gate(), true);
        const outcome = outbox.enqueue(model.tx, input, guard.assertCurrent).then(
          value => ({ value, error: null }), error => ({ value: null, error }));
        try {
          const arrived = await Promise.race([
            model.wait.reached.then(() => 'gate' as const),
            outcome.then(() => 'settled' as const),
          ]);
          expect(arrived).toBe('gate');
          guard.expire(); model.wait.resume();
          expect((await outcome).error).toMatchObject(guard.denial);
          expect(model.effects).toEqual([]);
          expect(model.row()).toBeNull();
        } finally { model.wait.resume(); await outcome; }
      });
    }
  }
});
