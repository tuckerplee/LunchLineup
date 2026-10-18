import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(__dirname, '../..');
const sourceRoots = ['app', 'components', 'lib'];
const nativeDialog = /(?<![\w$])(?:(?:window|globalThis|self)\s*\.\s*)?(?:alert|confirm|prompt)\s*\(/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === 'node_modules' || name === '.next') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.(?:test|spec)\./.test(name) ? [path] : [];
  });
}

describe('single message system', () => {
  it('uses no browser-native alert, confirm or prompt dialogs in app source', () => {
    const offenders = sourceRoots
      .flatMap((root) => sourceFiles(join(webRoot, root)))
      .flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, index) => (
        nativeDialog.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')
          ? [`${relative(webRoot, file)}:${index + 1}: ${line.trim().slice(0, 100)}`]
          : []
      )));
    expect(offenders).toEqual([]);
  });

  it('mounts the provider in both the dashboard and admin layouts', () => {
    for (const layout of ['app/dashboard/layout.tsx', 'app/admin/layout.tsx']) {
      const source = readFileSync(join(webRoot, layout), 'utf8');
      expect(source).toContain('<AppMessagesProvider>');
    }
  });

  it('keeps the confirm dialog accessible: alertdialog, labelled, Escape cancels, focus trapped', () => {
    const source = readFileSync(join(webRoot, 'components/messages/AppMessages.tsx'), 'utf8');
    expect(source).toContain('role="alertdialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('useDialogFocus(true)');
  });

  it('removes per-action credit cost wording from the everyday workflow pages', () => {
    const pages = [
      'app/dashboard/lunch-breaks/page.tsx',
      'app/dashboard/lunch-breaks/setup-shifts-recovery.ts',
      'app/dashboard/lunch-breaks/shift-break-update-recovery.ts',
      'app/dashboard/scheduling/page.tsx',
      'app/dashboard/scheduling/publish-settlement.ts',
      'app/dashboard/staff/AvailabilityPdfImport.tsx',
      'app/dashboard/staff/availability-pdf-import.ts',
      'app/dashboard/payroll/PayrollPeriodDetail.tsx',
    ];
    const forbidden = /usage credit|separately purchased|exactly \$\{|exactly 1|paid credit|credit cost\/run|will remain|Configured total/i;
    for (const page of pages) {
      const source = readFileSync(join(webRoot, page), 'utf8');
      expect(source.match(forbidden), page).toBeNull();
    }
  });
});
