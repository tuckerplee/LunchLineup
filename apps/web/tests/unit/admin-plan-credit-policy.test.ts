import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const plansSource = readFileSync(
    resolve(import.meta.dirname, '../../app/admin/plans/PlansClient.tsx'),
    'utf8',
);

test('admin plans define subscription capacity without recurring or unlimited credits', () => {
    expect(plansSource).not.toMatch(/unlimitedCredits|creditsLimit|creditQuotaLimit/);
    expect(plansSource).not.toMatch(/Unlimited credits|credits unlimited|credits included/i);
    expect(plansSource).toMatch(
        /Subscription eligibility only; usage requires separately purchased credits./,
    );
    expect(plansSource).toMatch(/priced subscriptions/);
});
