import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

function clockOutDisabledExpression(source: string): ts.Expression {
    const file = ts.createSourceFile('TimeCardsWorkspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const owners = file.statements.filter((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'TimeCardsWorkspace');
    expect(owners).toHaveLength(1);
    if (!owners[0].body) throw new Error('TimeCardsWorkspace must have a body');
    const returns = owners[0].body.statements.filter(ts.isReturnStatement);
    expect(returns).toHaveLength(1);
    const buttons: ts.JsxOpeningElement[] = [];
    const unwrap = (expression: ts.Expression): ts.Expression =>
        ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression;
    const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) && ts.isIdentifier(node.tagName) && node.tagName.text === 'button') {
            const clicks = node.attributes.properties.filter((attribute): attribute is ts.JsxAttribute =>
                ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'onClick');
            for (const click of clicks) {
                if (click.initializer && ts.isJsxExpression(click.initializer) && click.initializer.expression) {
                    const handler = unwrap(click.initializer.expression);
                    if (ts.isArrowFunction(handler) && handler.parameters.length === 0 && !ts.isBlock(handler.body)) {
                        let call = unwrap(handler.body);
                        if (ts.isVoidExpression(call)) call = unwrap(call.expression);
                        if (ts.isCallExpression(call) && ts.isIdentifier(call.expression)
                            && call.expression.text === 'clockOut' && call.arguments.length === 0) {
                            expect(clicks).toHaveLength(1);
                            buttons.push(node);
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    expect(returns[0].expression).toBeDefined();
    visit(returns[0].expression!);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].attributes.properties.some(ts.isJsxSpreadAttribute)).toBe(false);
    const disabled = buttons[0].attributes.properties.filter((attribute): attribute is ts.JsxAttribute =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'disabled');
    expect(disabled).toHaveLength(1);
    const initializer = disabled[0].initializer;
    if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
        throw new Error('Clock Out must have an explicit disabled expression');
    }
    return initializer.expression;
}

function evaluateDisabled(expression: ts.Expression, flags: Record<string, boolean>): boolean {
    if (ts.isParenthesizedExpression(expression)) return evaluateDisabled(expression.expression, flags);
    if (ts.isIdentifier(expression) && Object.hasOwn(flags, expression.text)) return flags[expression.text];
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
        return !evaluateDisabled(expression.operand, flags);
    }
    if (ts.isBinaryExpression(expression)) {
        const left = evaluateDisabled(expression.left, flags);
        const right = evaluateDisabled(expression.right, flags);
        if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) return left || right;
        if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return left && right;
    }
    throw new Error('Unsupported Clock Out disabled expression');
}

describe('stale request wiring contract', () => {
    it('invalidates and clears time-card state before an employee replacement loads', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'app/dashboard/time-cards/TimeCardsWorkspace.tsx'),
            'utf8',
        );

        expect(source).toContain('cardsRequestGate.current.invalidate();');
        expect(source).toContain('setActiveCard(null);');
        expect(source).toContain('activeCardForSelectedUser');
        const expression = clockOutDisabledExpression(source);
        for (const { disabled, ...flags } of [
            { isSaving: false, isCorrectionOpen: false, canClockOut: false, disabled: true },
            { isSaving: false, isCorrectionOpen: false, canClockOut: true, disabled: false },
            { isSaving: false, isCorrectionOpen: true, canClockOut: false, disabled: true },
            { isSaving: false, isCorrectionOpen: true, canClockOut: true, disabled: true },
            { isSaving: true, isCorrectionOpen: false, canClockOut: false, disabled: true },
            { isSaving: true, isCorrectionOpen: false, canClockOut: true, disabled: true },
            { isSaving: true, isCorrectionOpen: true, canClockOut: false, disabled: true },
            { isSaving: true, isCorrectionOpen: true, canClockOut: true, disabled: true },
        ]) {
            expect(evaluateDisabled(expression, flags), JSON.stringify(flags)).toBe(disabled);
        }
    });

    it('discards stale print loads and gates printing on the loaded scope', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'app/dashboard/scheduling/print/page.tsx'),
            'utf8',
        );

        expect(source).toContain('if (!scheduleRequestGate.current.isLatest(ticket)) return;');
        expect(source).toContain('setLoadedScope(null);');
        expect(source).toContain('isPrintScheduleScopeCurrent(loadedScope, selectedScope)');
        expect(source).toContain('disabled={isLoading || !isCurrentScope || rows.length === 0}');
    });
});
