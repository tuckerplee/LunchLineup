import { describe, expect, it } from 'vitest';

import {
    SETTINGS_TABS,
    resolveSettingsTabKey,
    settingsPanelId,
    settingsTabId,
} from '../../app/dashboard/settings/settings-tabs';

describe('settings tab accessibility', () => {
    it('wraps arrow navigation across only the visible tabs', () => {
        const visibleTabs = SETTINGS_TABS.filter((tab) => tab !== 'Billing' && tab !== 'Account');

        expect(resolveSettingsTabKey('ArrowRight', 'General', visibleTabs)).toBe('Team');
        expect(resolveSettingsTabKey('ArrowRight', 'Security', visibleTabs)).toBe('General');
        expect(resolveSettingsTabKey('ArrowLeft', 'General', visibleTabs)).toBe('Security');
        expect(resolveSettingsTabKey('ArrowLeft', 'Team', visibleTabs)).toBe('General');
    });

    it('supports Home and End without consuming unrelated keys', () => {
        expect(resolveSettingsTabKey('Home', 'Security', SETTINGS_TABS)).toBe('General');
        expect(resolveSettingsTabKey('End', 'General', SETTINGS_TABS)).toBe('Account');
        expect(resolveSettingsTabKey('Enter', 'General', SETTINGS_TABS)).toBeNull();
    });

    it('creates stable one-to-one tab and panel ids', () => {
        expect(settingsTabId('Billing')).toBe('settings-tab-billing');
        expect(settingsPanelId('Billing')).toBe('settings-panel-billing');
    });
});