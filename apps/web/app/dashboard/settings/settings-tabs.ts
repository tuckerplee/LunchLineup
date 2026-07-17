export const SETTINGS_TABS = ['General', 'Team', 'Billing', 'Security', 'Account'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

function tabSlug(tab: SettingsTab): string {
    return tab.toLowerCase();
}

export function settingsTabId(tab: SettingsTab): string {
    return 'settings-tab-' + tabSlug(tab);
}

export function settingsPanelId(tab: SettingsTab): string {
    return 'settings-panel-' + tabSlug(tab);
}

export function resolveSettingsTabKey(
    key: string,
    currentTab: SettingsTab,
    visibleTabs: readonly SettingsTab[],
): SettingsTab | null {
    if (visibleTabs.length === 0) return null;
    if (key === 'Home') return visibleTabs[0] ?? null;
    if (key === 'End') return visibleTabs[visibleTabs.length - 1] ?? null;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;

    const currentIndex = Math.max(0, visibleTabs.indexOf(currentTab));
    const direction = key === 'ArrowRight' ? 1 : -1;
    return visibleTabs[(currentIndex + direction + visibleTabs.length) % visibleTabs.length] ?? null;
}