import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';

const source = readFileSync(
    resolve(import.meta.dirname, '../../app/admin/users/AdminUsersWorkspace.tsx'),
    'utf8',
);


// Extract the real reset handler/display predicate; no component mount, browser
// globals or real credential/network/storage operations are used by these tests.
function pinExpression<T>(kind: 'reset' | 'visible', bindings: Record<string, unknown>): T {
    const file = ts.createSourceFile('AdminUsersWorkspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const expressions: ts.Expression[] = [];
    function visit(node: ts.Node) {
        if (kind === 'reset' && ts.isVariableDeclaration(node) && node.name.getText(file) === 'resetPin'
            && node.initializer && ts.isCallExpression(node.initializer)) {
            expressions.push(node.initializer.arguments[0]);
        }
        if (kind === 'visible' && ts.isConditionalExpression(node) && node.condition.getText(file).includes('temporaryPin')
            && node.whenTrue.getText(file).includes('Temporary PIN')) {
            expressions.push(node.condition);
        }
        ts.forEachChild(node, visit);
    }
    visit(file);
    expect(expressions).toHaveLength(1);
    const expression = expressions[0].getText(file);
    const javascript = ts.transpileModule(`const callback = ${kind === 'visible' ? `() => (${expression})` : expression};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return new Function(...Object.keys(bindings), `${javascript}
return callback;`)(...Object.values(bindings)) as T;
}

describe('platform admin user account safety wiring', () => {
    it('keeps tenant assignment read-only and omits tenantId from account updates', () => {
        expect(source).toContain('Tenant assignment (read-only)');
        expect(source).toContain('Cross-tenant reassignment is blocked');
        expect(source).toMatch(/id="admin-user-tenant-assignment"[\s\S]*?disabled[\s\S]*?>/);
        expect(source).not.toMatch(/tenantId:\s*form\.tenantId/);
    });

    it('still submits bounded identity and role fields through the admin endpoint', () => {
        expect(source).toContain("await writeJson(`/admin/users/${selectedUser.id}`, 'PUT', {");
        expect(source).toContain('email: email || null');
        expect(source).toContain('role: form.role');
    });

    it('retains the request target when A responds after the visible selection changes to B', async () => {
        const target = { id: 'user-a', name: 'A', username: 'a', status: 'ACTIVE' };
        let release!: (result: { temporaryPin: string }) => void;
        const response = new Promise<{ temporaryPin: string }>((resolveResponse) => { release = resolveResponse; });
        let temporaryPin: { userId: string; pin: string } | null = null;
        const writeJson = vi.fn(() => response);
        const refreshUsers = vi.fn(async () => undefined);
        const setSavingKey = vi.fn();
        const reset = pinExpression<() => Promise<void>>('reset', {
            selectedUser: target, isSelf: false, window: { confirm: () => true }, writeJson,
            setSavingKey, setMessage: vi.fn(), refreshUsers,
            setTemporaryPin: (value: { userId: string; pin: string } | null) => { temporaryPin = value; },
        });
        const pending = reset();
        const visibleSelection = { id: 'user-b' };
        expect(writeJson).toHaveBeenCalledExactlyOnceWith('/admin/users/user-a/pin/reset', 'POST', {});
        release({ temporaryPin: 'synthetic-pin' });
        await pending;
        expect(temporaryPin).toEqual({ userId: 'user-a', pin: 'synthetic-pin' });
        expect(pinExpression<() => boolean>('visible', { temporaryPin, selectedUser: visibleSelection })()).toBe(false);
        expect(pinExpression<() => boolean>('visible', { temporaryPin, selectedUser: target })()).toBe(true);
        expect(refreshUsers).toHaveBeenCalledTimes(1);
        expect(setSavingKey).toHaveBeenLastCalledWith(null);
    });

    it('clears a previous credential when the successful reset returns no temporary PIN', async () => {
        let temporaryPin: { userId: string; pin: string } | null = { userId: 'user-a', pin: 'old-synthetic-pin' };
        const target = { id: 'user-a', name: 'A', username: 'a', status: 'ACTIVE' };
        await pinExpression<() => Promise<void>>('reset', {
            selectedUser: target, isSelf: false, window: { confirm: () => true },
            writeJson: vi.fn(async () => ({})), setSavingKey: vi.fn(), setMessage: vi.fn(),
            refreshUsers: vi.fn(async () => undefined),
            setTemporaryPin: (value: { userId: string; pin: string } | null) => { temporaryPin = value; },
        })();
        expect(temporaryPin).toBeNull();
        expect(pinExpression<() => boolean>('visible', { temporaryPin, selectedUser: target })()).toBe(false);
    });
});
