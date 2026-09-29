import { describe, expect, it } from 'vitest';
import { acknowledgeCorruptInvitationRecovery, clearInvitationRecovery, invitationRecoveryStorageKey, prepareInvitationRecovery, readInvitationRecovery } from '../../app/dashboard/staff/invitation-recovery';

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        values,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
}
const scope = `${'a'.repeat(43)}:${'b'.repeat(43)}`;
const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const payload = { name: 'Employee', username: 'employee', pin: '567812', roleId: 'role' };

describe('staff creation recovery across navigation and reload', () => {
    it('reuses the persisted key without storing PINs or a PIN fingerprint', () => {
        const storage = memoryStorage();
        prepareInvitationRecovery(storage, scope, payload, () => key);
        expect(readInvitationRecovery(storage, scope)).toEqual({ key, details: { name: 'Employee', username: 'employee', roleId: 'role' } });
        expect([...storage.values.values()].join('')).not.toMatch(/567812|pin|payloadFingerprint/i);
        expect(prepareInvitationRecovery(storage, scope, { ...payload, pin: '123456' }, () => { throw new Error('must not allocate another key'); }).key).toBe(key);
        // The server receipt validates the re-entered PIN; browser storage never does.
    });
    it('binds recovery to workspace and session and blocks changed identity details', () => {
        const storage = memoryStorage();
        prepareInvitationRecovery(storage, scope, payload, () => key);
        expect(readInvitationRecovery(storage, `${'c'.repeat(43)}:${'b'.repeat(43)}`)).toBeNull();
        expect(readInvitationRecovery(storage, `${'a'.repeat(43)}:${'c'.repeat(43)}`)).toBeNull();
        for (const changed of [{ name: 'Changed' }, { username: 'other' }, { roleId: 'other' }]) {
            expect(() => prepareInvitationRecovery(storage, scope, { ...payload, ...changed })).toThrow(/earlier creation/);
        }
        expect(readInvitationRecovery(storage, scope)?.key).toBe(key);
    });
    it('normalizes login identity and clears only the acknowledged attempt', () => {
        const storage = memoryStorage();
        prepareInvitationRecovery(storage, scope, { name: ' Employee ', email: 'EMPLOYEE@example.test' }, () => key);
        expect(prepareInvitationRecovery(storage, scope, { name: 'Employee', email: 'employee@example.test' }).key).toBe(key);
        clearInvitationRecovery(storage, scope, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        expect(readInvitationRecovery(storage, scope)).not.toBeNull();
        clearInvitationRecovery(storage, scope, key);
        expect(readInvitationRecovery(storage, scope)).toBeNull();
    });
    it('fails closed for corrupt, secret-bearing, or unavailable storage before submission', () => {
        const storage = memoryStorage();
        for (const raw of ['{', JSON.stringify({ key, details: payload }), JSON.stringify({ key, details: { name: 'Employee' } })]) {
            storage.setItem(invitationRecoveryStorageKey(scope), raw);
            expect(() => prepareInvitationRecovery(storage, scope, payload)).toThrow();
        }
        expect(() => prepareInvitationRecovery({ ...storage, getItem: () => { throw new Error('blocked storage'); } }, scope, payload)).toThrow('blocked storage');
    });
    it('clears only the explicitly reviewed corrupt scoped entry and permits storage reinitialization', () => {
        const storage = memoryStorage();
        const otherScope = `${'c'.repeat(43)}:${'b'.repeat(43)}`;
        prepareInvitationRecovery(storage, otherScope, payload, () => key);
        storage.setItem(invitationRecoveryStorageKey(scope), '{');
        acknowledgeCorruptInvitationRecovery(storage, scope, '{');
        expect(readInvitationRecovery(storage, scope)).toBeNull();
        expect(readInvitationRecovery(storage, otherScope)?.key).toBe(key);
        expect(prepareInvitationRecovery(storage, scope, payload, () => key).key).toBe(key);
    });
    it('never clears a valid attempt or state that changed after directory review', () => {
        const storage = memoryStorage();
        prepareInvitationRecovery(storage, scope, payload, () => key);
        const valid = storage.getItem(invitationRecoveryStorageKey(scope));
        expect(() => acknowledgeCorruptInvitationRecovery(storage, scope, valid)).toThrow(/valid creation/);
        expect(() => acknowledgeCorruptInvitationRecovery(storage, scope, '{')).toThrow(/changed during review/);
        expect(readInvitationRecovery(storage, scope)?.key).toBe(key);
    });
    it('retains corrupt evidence when storage refuses repair', () => {
        const storage = memoryStorage();
        storage.setItem(invitationRecoveryStorageKey(scope), '{');
        expect(() => acknowledgeCorruptInvitationRecovery({ ...storage, removeItem: () => { throw new Error('storage denied'); } }, scope, '{')).toThrow('storage denied');
        expect(storage.getItem(invitationRecoveryStorageKey(scope))).toBe('{');
    });
});
