import { readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(__dirname, '../../');
const readWebFile = (path: string) => readFileSync(resolve(webRoot, path), 'utf8');
const sourceExtensions = new Set(['.css', '.js', '.jsx', '.less', '.sass', '.scss', '.ts', '.tsx']);
const ignoredDirectories = new Set(['.next', '.turbo', 'coverage', 'node_modules', 'playwright-report', 'test-results']);

const collectWebSourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : collectWebSourceFiles(path);
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
});

describe('public-launch frontend accessibility contracts', () => {
    it('uses a real onboarding form and moves focus to assertive errors', () => {
        const source = readWebFile('app/onboarding/page.tsx');

        expect(source).toContain('<form onSubmit={handleStepSubmit} noValidate>');
        expect(source).toContain('const handleStepSubmit = (event: FormEvent<HTMLFormElement>)');
        expect(source.match(/type="submit"/g)).toHaveLength(4);
        expect(source).toContain('role="alert" aria-live="assertive" tabIndex={-1}');
        expect(source).toContain('if (error) errorRef.current?.focus();');
    });

    it('keeps the mobile sign-out control icon-only and fixed at 32 pixels', () => {
        const layoutSource = readWebFile('app/dashboard/layout.tsx');
        const styles = readWebFile('styles/globals.css');
        const mobileClassIndex = layoutSource.indexOf('className="workspace-mobile-signout');
        const mobileLinkStart = layoutSource.lastIndexOf('<Link', mobileClassIndex);
        const mobileLinkEnd = layoutSource.indexOf('</Link>', mobileClassIndex);
        const mobileSignOut = layoutSource.slice(mobileLinkStart, mobileLinkEnd + '</Link>'.length);
        const styleStart = styles.indexOf('.workspace-mobile-signout {');
        const mobileSignOutStyles = styles.slice(styleStart, styles.indexOf('}', styleStart) + 1);

        expect(mobileClassIndex).toBeGreaterThan(-1);
        expect(mobileSignOut).toContain('aria-label="Sign out"');
        expect(mobileSignOut).toContain('title="Sign out"');
        expect(mobileSignOut).toContain('<LogOut size={16} aria-hidden="true" />');
        expect(mobileSignOut).not.toContain('<LogOut size={16} />');
        expect(mobileSignOutStyles).toContain('width: 32px;');
        expect(mobileSignOutStyles).toContain('height: 32px;');
    });

    it('provides a focus-managed, escapable notification dialog', () => {
        const source = readWebFile('app/dashboard/NotificationsMenu.tsx');

        expect(source).toContain('ref={triggerRef}');
        expect(source).toContain('ref={dialogRef}');
        expect(source).toContain('aria-modal="true"');
        expect(source).toContain("if (event.key === 'Escape')");
        expect(source).toContain("if (event.key !== 'Tab') return;");
        expect(source).toContain('triggerRef.current?.focus()');
        expect(source).toContain('aria-label="Close notifications"');
    });

    it('wires roving settings tabs to stable tab panels', () => {
        const source = readWebFile('app/dashboard/settings/SettingsWorkspace.tsx');

        expect(source).toContain('tabIndex={activeTab === tab ? 0 : -1}');
        expect(source).toContain('onKeyDown={(event) => handleTabKeyDown(event, tab)}');
        expect(source).toContain('aria-controls={settingsPanelId(tab)}');
        expect(source).toContain("'aria-labelledby': settingsTabId(tab)");
        expect(source).toContain("role: 'tabpanel' as const");
    });

    it('names every credit-pack purchase action with its quantity', () => {
        const source = readWebFile('app/dashboard/settings/BillingSettingsPanel.tsx');

        expect(source).toContain("return option.configured ? 'Purchase ' + quantity + ' credits'");
        expect(source).toContain('aria-label={creditPackActionLabel(option, isSaving)}');
    });
    it('renders the bounded loaded-result summary with an accessible icon and encoding-safe separators', () => {
        const source = readWebFile('app/admin/users/AdminUsersWorkspace.tsx');

        expect(source).toContain("import { Users } from 'lucide-react';");
        expect(source).toContain('<Users size={18} aria-hidden="true" />');
        expect(source).toContain('<strong>{users.length} matching users loaded</strong>');
        expect(source).not.toContain('\u00c2');
        expect(source).not.toContain('\uFFFD');
        expect(source).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
        expect(source).toContain("{selectedUser.tenant ? `${selectedUser.tenant.name} - ${selectedUser.tenant.slug}` : 'No tenant assigned'}");
        expect(source).toContain("{tenant.name} - {tenant.slug}{tenant.planTier ? ' - ' + tenant.planTier : ''}");
    });
    it('does not use negative letter spacing in web source files', () => {
        const negativeSign = String.fromCharCode(45);
        const negativeLetterSpacing = new RegExp(
            '[\\x22\\x27\\x60]?(?:letterSpacing|letter-spacing)[\\x22\\x27\\x60]?\\s*:\\s*[\\x22\\x27\\x60]?\\s*' + negativeSign,
        );
        const offenders = collectWebSourceFiles(webRoot)
            .filter((sourcePath) => negativeLetterSpacing.test(readFileSync(sourcePath, 'utf8')))
            .map((sourcePath) => relative(webRoot, sourcePath).replaceAll('\\', '/'));

        expect(offenders).toEqual([]);
    });
});
