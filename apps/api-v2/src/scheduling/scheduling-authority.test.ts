import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import { schedulingAuthority } from './scheduling-authority.fixture';
import { ScheduleBoardService } from './board.service';
import { ScheduleCreateService } from './schedule-create.service';
import { ScheduleChangeSetService } from './change-set.service';
import { DemandWindowService } from './demand-window.service';
import { ScheduleLifecycleService } from './lifecycle.service';

const scheduleId = '81000000-0000-4000-8000-000000000004';
const locationId = '81000000-0000-4000-8000-000000000002';
const identity: SessionIdentity = {
  sub: 'actor', tenantId: 'tenant', sessionId: 'session',
  publicUserId: '81000000-0000-4000-8000-000000000001',
  role: 'Manager', legacyRole: 'MANAGER', roles: [{ id: 'role', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: ['locations:read', 'schedules:read', 'shifts:read', 'schedules:write', 'shifts:write', 'shifts:delete', 'schedules:publish'],
  mfaRequired: true, mfaVerified: true,
};
const headers = { ifMatch: `"schedule:${scheduleId}:1"`, idempotencyKey: 'workforce-authority-case' };
const enteredDomain = new Error('controlled domain entry');
function fixture(action: string) {
  const domain = vi.fn(async (): Promise<any> => { throw enteredDomain; });
  const transaction: any = { location: { findMany: domain }, auditLog: { findFirst: domain },
    scheduleChangeSet: { findUnique: domain }, schedule: { findFirst: domain } };
  const f = schedulingAuthority(transaction, structuredClone(identity));
  const call = () => {
    const db = f.database as never;
    if (action === 'board') return new ScheduleBoardService(db, f.observer).get(identity, { date: '2026-10-05', view: 'week' });
    if (action === 'create') return new ScheduleCreateService(db, f.observer).create(identity, locationId,
      { startDate: '2026-10-05T00:00:00Z', endDate: '2026-10-12T00:00:00Z' }, headers.idempotencyKey);
    if (action === 'changes') return new ScheduleChangeSetService(db, f.observer).apply(identity, scheduleId,
      { operations: [{ op: 'shift.delete', shiftId: '81000000-0000-4000-8000-000000000003' }] }, headers);
    if (action === 'demand-list') return new DemandWindowService(db, f.observer).list(identity, scheduleId);
    if (action === 'demand-replace') return new DemandWindowService(db, f.observer).replace(identity, scheduleId, { windows: [] }, headers);
    return new ScheduleLifecycleService(db, f.observer).reopen(identity, scheduleId, headers);
  };
  return { ...f, domain, call };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('Workforce current authority source regressions', () => {
  for (const action of ['board', 'create', 'changes', 'demand-list', 'demand-replace', 'reopen']) {
    it(`${action}: real current authority admits a live fixture before domain entry`, async () => {
      const f = fixture(action);
      await expect(f.call()).rejects.toBe(enteredDomain);
      expect(f.domain).toHaveBeenCalledOnce();
      expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
      expect(f.database.withTenant).toHaveBeenCalledTimes(2);
      const queries = f.transaction.$queryRaw.mock.calls.map(([query]: any[]) => query.strings.join(' '));
      expect(queries[0]).toContain('FROM "Tenant"');
    });
    for (const loss of ['session', 'grant', 'tenant', 'pin', 'account']) {
      it(`${action}: refuses ${loss} changed during released observation before domain entry`, async () => {
        const f = fixture(action);
        f.state.observed = () => {
          if (loss === 'session') f.state.session.revokedAt = new Date();
          else if (loss === 'grant') f.state.permissions = [];
          else if (loss === 'tenant') f.state.tenant.status = 'SUSPENDED';
          else if (loss === 'pin') f.state.actor.pinResetRequired = true;
          else f.state.actor.suspendedAt = new Date();
        };
        await expect(f.call()).rejects.toMatchObject({ status: 403 });
        expect(f.domain).not.toHaveBeenCalled();
        expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
      });
    }
    for (const deadline of ['session', 'mfa']) {
      it(`${action}: checks ${deadline} deadline immediately after awaited domain read`, async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const f = fixture(action);
        f.domain.mockImplementationOnce(async () => {
          vi.setSystemTime(Date.now() + (deadline === 'session' ? 60001 : 1001));
          return action === 'board' ? [] : null;
        });
        await expect(f.call()).rejects.toMatchObject({ status: 403 });
        expect(f.domain).toHaveBeenCalledOnce();
        expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
      });
    }
  }

  it('fresh STAFF authority exposes only own published schedule summaries and own staff row', async () => {
    const ownPublished = { id: 'published-own', publicId: scheduleId, status: 'PUBLISHED', revision: 1,
      startDate: new Date('2026-10-05T00:00:00Z'), endDate: new Date('2026-10-12T00:00:00Z'),
      publishedAt: new Date('2026-10-04T00:00:00Z'), owner: identity.sub };
    const rows = [ownPublished, { ...ownPublished, id: 'draft-own', status: 'DRAFT' },
      { ...ownPublished, id: 'published-other', owner: 'other' }];
    const scheduleRead = vi.fn(async ({ where }: any) => {
      expect(where).toMatchObject({ tenantId: identity.tenantId, deletedAt: null, status: 'PUBLISHED',
        shifts: { some: { tenantId: identity.tenantId, userId: identity.sub, deletedAt: null } } });
      return rows.filter(row => row.status === where.status && row.owner === where.shifts.some.userId);
    });
    const staffRead = vi.fn(async ({ where }: any) => {
      expect(where).toMatchObject({ tenantId: identity.tenantId, id: identity.sub });
      return [{ publicId: identity.publicUserId, name: 'Self', role: 'STAFF' }];
    });
    const tx: any = { location: { findMany: vi.fn(async () => [{ id: 'location-internal', publicId: locationId,
      name: 'Location', timezone: 'UTC' }]) }, user: { findMany: staffRead },
      schedule: { findMany: scheduleRead }, shift: { findMany: vi.fn(async ({ where }: any) => {
        expect(where.userId).toBe(identity.sub); return [];
      }) } };
    const f = schedulingAuthority(tx, structuredClone(identity));
    f.state.observed = () => { f.state.legacyRole = 'STAFF'; f.state.actor.role = 'STAFF'; };
    const result = await new ScheduleBoardService(f.database as never, f.observer).get(identity,
      { date: '2026-10-05', view: 'week' });
    expect(result.data.schedules.map(row => row.id)).toEqual([scheduleId]);
    expect(result.data.schedules[0].status).toBe('PUBLISHED');
    expect(result.data.staff).toEqual([{ id: identity.publicUserId, name: 'Self', role: 'STAFF' }]);
    expect(scheduleRead).toHaveBeenCalledOnce();
  });
});
