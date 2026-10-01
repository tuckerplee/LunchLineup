import { scrypt, scryptSync } from 'node:crypto';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeopleService } from './people.service';

const cryptoWork = vi.hoisted(() => ({
  paused: false,
  pending: [] as Array<() => void>,
  onStart: undefined as ((pin: string) => void) | undefined,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    scrypt: vi.fn((pin: string, salt: string, length: number, callback: (error: Error | null, key: Buffer) => void) => {
      cryptoWork.onStart?.(pin);
      const run = () => actual.scrypt(pin, salt, length, callback);
      if (cryptoWork.paused) cryptoWork.pending.push(run);
      else run();
    }),
  };
});

const originalPin = '246810';
const nextPin = '135790';
const fixtureSalt = '0123456789abcdef0123456789abcdef';
const fixtureHash = `${fixtureSalt}:${scryptSync(originalPin, fixtureSalt, 64).toString('hex')}`;

type PinUser = {
  id: string;
  publicId: string;
  tenantId: string;
  role: 'STAFF' | 'MANAGER';
  name: string;
  email: null;
  username: string;
  pinHash: string;
  pinResetRequired: boolean;
  pinLoginAttempts: number;
  pinLockedUntil: Date | null;
  lockedUntil: Date | null;
  suspendedAt: Date | null;
  deletedAt: Date | null;
};
type PinSession = { id: string; userId: string; expiresAt: Date; revokedAt: Date | null };
type State = { users: PinUser[]; sessions: PinSession[]; permissions: string[]; audits: Array<Record<string, unknown>> };

const identity: SessionIdentity = {
  sub: 'actor-1', publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238', tenantId: 'tenant-1',
  sessionId: 'session-1', role: 'STAFF', legacyRole: 'STAFF',
  roles: [], permissions: ['auth:login_pin'], mfaVerified: false, mfaRequired: false, pinResetRequired: true,
};

function user(id: string, tenantId = 'tenant-1'): PinUser {
  return {
    id, tenantId, publicId: identity.publicUserId, role: 'STAFF', name: id, email: null, username: id,
    pinHash: fixtureHash, pinResetRequired: true, pinLoginAttempts: 0, pinLockedUntil: null,
    lockedUntil: null, suspendedAt: null, deletedAt: null,
  };
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && 'in' in expected) {
      return (expected.in as unknown[]).includes(row[key]);
    }
    return row[key] === expected;
  });
}

/** This fake commits only resolved callbacks; exceptions discard all writes. */
function rollbackDatabase() {
  let state: State = {
    users: [user('actor-1'), user('other-user'), user('foreign-user', 'tenant-2')],
    sessions: [
      { id: 'session-1', userId: 'actor-1', expiresAt: new Date(Date.now() + 60_000), revokedAt: null },
      { id: 'session-2', userId: 'actor-1', expiresAt: new Date(Date.now() + 60_000), revokedAt: null },
      { id: 'other-session', userId: 'other-user', expiresAt: new Date(Date.now() + 60_000), revokedAt: null },
    ],
    permissions: ['auth:login_pin'], audits: [],
  };
  let tail = Promise.resolve();
  let transactionNumber = 0;
  const controls = { activeTransactions: 0, failCommitNumber: 0, failAudit: false, rejectCredentialUpdate: false };
  const withTenant = vi.fn(async (tenantId: string, operation: (tx: unknown) => Promise<unknown>, options: unknown) => {
    expect(options).toEqual({ isolationLevel: 'Serializable' });
    const prior = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    const draft = structuredClone(state);
    const number = ++transactionNumber;
    controls.activeTransactions += 1;
    const transaction = {
      $queryRaw: vi.fn(async (query: { strings: string[]; values: unknown[] }) => {
        const sql = query.strings.join('');
        expect(sql).toContain('FOR UPDATE');
        if (sql.includes('FROM "Tenant"')) return [{ id: tenantId }];
        if (sql.includes('FROM "User"')) {
          return draft.users.filter((entry) => entry.tenantId === tenantId && query.values.includes(entry.id));
        }
        if (sql.includes('FROM "Session"')) {
          return draft.sessions.filter((entry) => query.values.includes(entry.id) && query.values.includes(entry.userId));
        }
        if (sql.includes('FROM "RolePermission"') || sql.includes('FROM "Role"')) return [];
        throw new Error('Unexpected authorization query');
      }),
      roleAssignment: {
        findMany: vi.fn(async ({ where }: { where: { tenantId: string; userId: { in: string[] } } }) => (
          draft.users.filter((entry) => entry.tenantId === where.tenantId && where.userId.in.includes(entry.id))
            .map((entry) => ({ userId: entry.id, roleId: 'role-staff' }))
        )),
      },
      role: {
        findMany: vi.fn(async () => [{
          id: 'role-staff', publicId: '2680ed8d-a36a-43ea-b83a-5f4ebf9bea4f', name: 'Staff', slug: 'staff',
          description: null, isSystem: true, isDefault: true, legacyRole: 'STAFF',
          rolePermissions: draft.permissions.map((key) => ({ permission: { key } })),
        }]),
      },
      user: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (
          draft.users.find((entry) => matches(entry, where)) ?? null
        )),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (controls.rejectCredentialUpdate) return { count: 0 };
          const rows = draft.users.filter((entry) => matches(entry, where));
          rows.forEach((entry) => Object.assign(entry, data));
          return { count: rows.length };
        }),
      },
      session: {
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const rows = draft.sessions.filter((entry) => matches(entry, where));
          rows.forEach((entry) => Object.assign(entry, data));
          return { count: rows.length };
        }),
      },
      auditLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (controls.failAudit) throw new Error('Audit write failed');
          draft.audits.push(data);
          return data;
        }),
      },
    };
    try {
      const outcome = await operation(transaction);
      if (controls.failCommitNumber === number) throw { code: '40001' };
      state = draft;
      return outcome;
    } finally {
      controls.activeTransactions -= 1;
      release();
    }
  });
  const service = new PeopleService({ withTenant } as never, {
    staffInvitationOutboxEnabled: false, staffInvitationOutboxEncryptionKey: '', staffInvitationMaxAttempts: 8,
  });
  return { service, controls, withTenant, get state() { return state; } };
}

function resumeCrypto() {
  cryptoWork.paused = false;
  cryptoWork.pending.splice(0).forEach((run) => run());
}

beforeEach(() => {
  vi.mocked(scrypt).mockClear();
  cryptoWork.paused = false;
  cryptoWork.onStart = undefined;
});
afterEach(() => {
  resumeCrypto();
  cryptoWork.onStart = undefined;
});

describe('native PIN rotation guessing budget', () => {
  it('commits five wrong attempts before rejecting, locks for 15 minutes, and skips crypto while locked', async () => {
    const db = rollbackDatabase();
    cryptoWork.onStart = () => expect(db.controls.activeTransactions).toBe(0);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(db.service.replaceOwnPin(identity, '111111', nextPin))
        .rejects.toMatchObject({ status: 401, code: 'invalid_current_pin' });
      expect(db.state.users[0].pinLoginAttempts).toBe(attempt);
    }
    const lockedUntil = db.state.users[0].pinLockedUntil!;
    expect(lockedUntil.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(lockedUntil.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    await expect(db.service.replaceOwnPin(identity, originalPin, nextPin)).rejects.toMatchObject({ status: 403 });
    expect(scrypt).toHaveBeenCalledTimes(5); // No new-PIN hash on a wrong guess.
    expect(db.state.users[0].pinHash).toBe(fixtureHash);
    expect(db.state.users[0].pinResetRequired).toBe(true);
    expect(db.state.sessions.every((entry) => entry.revokedAt === null)).toBe(true);
    expect(db.state.audits).toEqual([]);
    expect(db.state.users.slice(1).map((entry) => entry.pinLoginAttempts)).toEqual([0, 0]);
  });

  it('shares prior login failures and relocks on a wrong guess after lock expiry', async () => {
    const db = rollbackDatabase();
    db.state.users[0].pinLoginAttempts = 4;
    await expect(db.service.replaceOwnPin(identity, '111111', nextPin)).rejects.toMatchObject({ status: 401 });
    db.state.users[0].pinLockedUntil = new Date(Date.now() - 1);
    await expect(db.service.replaceOwnPin(identity, '111111', nextPin)).rejects.toMatchObject({ status: 401 });
    expect(db.state.users[0].pinLoginAttempts).toBe(6);
    expect(db.state.users[0].pinLockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('allows required temporary-PIN rotation after expiry, clears counters, revokes actor sessions and audits', async () => {
    const db = rollbackDatabase();
    db.state.users[0].pinLoginAttempts = 5;
    db.state.users[0].pinLockedUntil = new Date(Date.now() - 1);
    cryptoWork.onStart = () => expect(db.controls.activeTransactions).toBe(0);
    await db.service.replaceOwnPin(identity, originalPin, nextPin);
    const actor = db.state.users[0];
    expect(actor).toMatchObject({ pinLoginAttempts: 0, pinLockedUntil: null, pinResetRequired: false });
    const [salt, hash] = actor.pinHash.split(':');
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toBe(scryptSync(nextPin, salt, 64).toString('hex'));
    expect(db.state.sessions.slice(0, 2).every((entry) => entry.revokedAt instanceof Date)).toBe(true);
    expect(db.state.sessions[2].revokedAt).toBeNull();
    expect(db.state.audits).toEqual([expect.objectContaining({
      tenantId: 'tenant-1', userId: 'actor-1', resourceId: 'actor-1', action: 'USER_PIN_ROTATED',
      newValue: { pinResetRequired: false, sessionsRevoked: 2 },
    })]);
    expect(scrypt).toHaveBeenCalledTimes(2);
  });

  it('rolls back a failed commit instead of reporting a charged invalid PIN', async () => {
    const db = rollbackDatabase();
    db.controls.failCommitNumber = 2;
    await expect(db.service.replaceOwnPin(identity, '111111', nextPin)).rejects.toMatchObject({ status: 409 });
    expect(db.state.users[0].pinLoginAttempts).toBe(0);
    expect(db.state.users[0].pinLockedUntil).toBeNull();
  });

  it('rolls back successful rotation, counters and revocation when audit persistence fails', async () => {
    const db = rollbackDatabase();
    db.state.users[0].pinLoginAttempts = 3;
    db.controls.failAudit = true;
    await expect(db.service.replaceOwnPin(identity, originalPin, nextPin)).rejects.toThrow('Audit write failed');
    expect(db.state.users[0]).toMatchObject({ pinHash: fixtureHash, pinLoginAttempts: 3, pinResetRequired: true });
    expect(db.state.sessions.every((entry) => entry.revokedAt === null)).toBe(true);
    expect(db.state.audits).toEqual([]);
  });

  it.each(['permission', 'session', 'tenant', 'account-lock', 'suspension'] as const)(
    'rejects initial %s denial before crypto or failure charging', async (denial) => {
      const db = rollbackDatabase();
      let requestIdentity = identity;
      if (denial === 'permission') db.state.permissions = [];
      if (denial === 'session') db.state.sessions[0].revokedAt = new Date();
      if (denial === 'tenant') requestIdentity = { ...identity, tenantId: 'tenant-2' };
      if (denial === 'account-lock') db.state.users[0].lockedUntil = new Date(Date.now() + 60_000);
      if (denial === 'suspension') db.state.users[0].suspendedAt = new Date();
      await expect(db.service.replaceOwnPin(requestIdentity, '111111', nextPin)).rejects.toMatchObject({ status: 403 });
      expect(scrypt).not.toHaveBeenCalled();
      expect(db.state.users.every((entry) => entry.pinLoginAttempts === 0)).toBe(true);
    },
  );

  it.each(['hash', 'username', 'role', 'session', 'permission', 'tenant', 'pin-lock'] as const)(
    'rejects stale %s proof without charging any account', async (change) => {
      const db = rollbackDatabase();
      cryptoWork.paused = true;
      const rejection = expect(db.service.replaceOwnPin(identity, '111111', nextPin)).rejects.toMatchObject({
        status: ['hash', 'username', 'role'].includes(change) ? 409 : 403,
      });
      await vi.waitFor(() => expect(cryptoWork.pending).toHaveLength(1));
      if (change === 'hash') db.state.users[0].pinHash = 'replacement-salt:replacement-hash';
      if (change === 'username') db.state.users[0].username = 'replacement-username';
      if (change === 'role') db.state.users[0].role = 'MANAGER';
      if (change === 'session') db.state.sessions[0].revokedAt = new Date();
      if (change === 'permission') db.state.permissions = [];
      if (change === 'tenant') db.state.users[0].tenantId = 'tenant-2';
      if (change === 'pin-lock') db.state.users[0].pinLockedUntil = new Date(Date.now() + 60_000);
      resumeCrypto();
      await rejection;
      expect(db.state.users.every((entry) => entry.pinLoginAttempts === 0)).toBe(true);
      expect(db.state.audits).toEqual([]);
    },
  );

  it('rejects a lost credential update without revoking sessions or auditing', async () => {
    const db = rollbackDatabase();
    db.controls.rejectCredentialUpdate = true;
    await expect(db.service.replaceOwnPin(identity, originalPin, nextPin)).rejects.toMatchObject({ status: 409 });
    expect(db.state.sessions.every((entry) => entry.revokedAt === null)).toBe(true);
    expect(db.state.users[0].pinHash).toBe(fixtureHash);
    expect(db.state.audits).toEqual([]);
  });

  it('rejects a correct but stale proof rather than replacing the reset credential', async () => {
    const db = rollbackDatabase();
    cryptoWork.paused = true;
    const rejection = expect(db.service.replaceOwnPin(identity, originalPin, nextPin))
      .rejects.toMatchObject({ status: 409, code: 'pin_rotation_changed' });
    await vi.waitFor(() => expect(cryptoWork.pending).toHaveLength(1));
    const replacement = `reset-${fixtureHash}`;
    db.state.users[0].pinHash = replacement;
    db.state.users[0].pinLoginAttempts = 2;
    resumeCrypto();
    await rejection;
    expect(db.state.users[0]).toMatchObject({ pinHash: replacement, pinLoginAttempts: 2, pinResetRequired: true });
    expect(db.state.sessions.every((entry) => entry.revokedAt === null)).toBe(true);
    expect(db.state.audits).toEqual([]);
  });

  it('permits only one competing correct rotation and rejects the revoked session without charging', async () => {
    const db = rollbackDatabase();
    cryptoWork.paused = true;
    const running = Promise.allSettled(Array.from({ length: 2 }, () => db.service.replaceOwnPin(identity, originalPin, nextPin)));
    await vi.waitFor(() => expect(cryptoWork.pending).toHaveLength(2));
    resumeCrypto();
    const results = await running;
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((entry) => entry.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ status: 403 }) }),
    ]);
    expect(db.state.users[0].pinLoginAttempts).toBe(0);
    expect(db.state.audits).toHaveLength(1);
  });

  it('bounds async verification admission without queuing excess KDF work', async () => {
    cryptoWork.paused = true;
    const databases = Array.from({ length: 5 }, rollbackDatabase);
    const running = Promise.allSettled(databases.slice(0, 4).map((db) => db.service.replaceOwnPin(identity, '111111', nextPin)));
    await vi.waitFor(() => expect(cryptoWork.pending).toHaveLength(4));
    await expect(databases[4].service.replaceOwnPin(identity, '111111', nextPin))
      .rejects.toMatchObject({ status: 503, code: 'pin_rotation_busy' });
    expect(scrypt).toHaveBeenCalledTimes(4);
    expect(databases[4].state.users[0].pinLoginAttempts).toBe(0);
    resumeCrypto();
    const results = await running;
    expect(results.every((entry) => entry.status === 'rejected')).toBe(true);
    expect(databases.slice(0, 4).every((db) => db.state.users[0].pinLoginAttempts === 1)).toBe(true);
  });

  it('serializes concurrent guesses against the same account without lost increments', async () => {
    const db = rollbackDatabase();
    cryptoWork.paused = true;
    const running = Promise.allSettled(Array.from({ length: 4 }, () => db.service.replaceOwnPin(identity, '111111', nextPin)));
    await vi.waitFor(() => expect(cryptoWork.pending).toHaveLength(4));
    resumeCrypto();
    const results = await running;
    expect(results.every((entry) => entry.status === 'rejected')).toBe(true);
    expect(db.state.users[0].pinLoginAttempts).toBe(4);
    await expect(db.service.replaceOwnPin(identity, '111111', nextPin)).rejects.toMatchObject({ status: 401 });
    expect(db.state.users[0].pinLoginAttempts).toBe(5);
    expect(db.state.users[0].pinLockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('bounds new-PIN hashing with the same admission budget', async () => {
    const databases = Array.from({ length: 5 }, rollbackDatabase);
    cryptoWork.onStart = (pin) => {
      if (pin === nextPin) cryptoWork.paused = true;
    };
    const running = Promise.allSettled(databases.slice(0, 4).map((db) => db.service.replaceOwnPin(identity, originalPin, nextPin)));
    await vi.waitFor(() => expect(cryptoWork.pending).toHaveLength(4));
    expect(scrypt).toHaveBeenCalledTimes(8);
    await expect(databases[4].service.replaceOwnPin(identity, '111111', nextPin))
      .rejects.toMatchObject({ status: 503, code: 'pin_rotation_busy' });
    expect(databases[4].state.users[0].pinLoginAttempts).toBe(0);
    resumeCrypto();
    const results = await running;
    expect(results.every((entry) => entry.status === 'fulfilled')).toBe(true);
    expect(databases.slice(0, 4).every((db) => !db.state.users[0].pinResetRequired)).toBe(true);
  });
});
