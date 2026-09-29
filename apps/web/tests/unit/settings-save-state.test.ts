import { describe, expect, it, vi } from 'vitest';
import { reconcileSettingsSave, saveSettingsWithReadback, savedSettingsMatch } from '../../app/dashboard/settings/settings-save-state';

const submitted = { name: 'New name', slug: 'new-name', timezone: 'America/Chicago' };
const saved = { general: submitted };

describe('settings save outcome recovery', () => {
    it('confirms a lost committed response by an independent read without a second write', async () => {
        const write = vi.fn().mockRejectedValue(new TypeError('connection lost'));
        const read = vi.fn().mockResolvedValue(saved);
        expect(await saveSettingsWithReadback('general', submitted, write, read)).toEqual({ kind: 'confirmed', recovered: true });
        expect(write).toHaveBeenCalledOnce();
        expect(read).toHaveBeenCalledOnce();
    });
    it('preserves definite permission/validation rejection without misreporting matching old values as a successful write', async () => {
        const read = vi.fn().mockResolvedValue(saved);
        const error = Object.assign(new Error('Read-only access'), { status: 403 });
        expect(await saveSettingsWithReadback('general', submitted, async () => { throw error; }, read)).toEqual({ kind: 'rejected', message: 'Read-only access' });
        expect(read).not.toHaveBeenCalled();
    });
    it.each([408, 500, 503])('keeps ambiguous HTTP %s unresolved when readback differs', async status => {
        const result = await saveSettingsWithReadback('general', submitted,
            async () => { throw Object.assign(new Error('request failed'), { status }); },
            async () => ({ general: { ...submitted, name: 'Previous name' } }));
        expect(result.kind).toBe('uncertain');
    });
    it('keeps a failed readback unresolved, then permits confirmation using only another read', async () => {
        expect((await reconcileSettingsSave('general', submitted, async () => { throw new Error('offline'); })).kind).toBe('uncertain');
        expect(await reconcileSettingsSave('general', submitted, async () => saved)).toEqual({ kind: 'confirmed', recovered: true });
    });
    it('reconciles an unreadable success body and never accepts incomplete or wrong-section evidence', async () => {
        expect(savedSettingsMatch('general', submitted, { team: submitted })).toBe(false);
        expect(savedSettingsMatch('general', submitted, { general: { name: submitted.name } })).toBe(false);
        expect(await saveSettingsWithReadback('general', submitted, async () => ({}), async () => saved)).toEqual({ kind: 'confirmed', recovered: true });
    });
    it('uses only fields submitted by this operation when checking security settings', () => {
        expect(savedSettingsMatch('security', { requireMfaForAll: true }, { security: { requireMfaForAll: true, oidcIssuerUrl: null } })).toBe(true);
        expect(savedSettingsMatch('security', {}, { security: {} })).toBe(false);
    });
});
