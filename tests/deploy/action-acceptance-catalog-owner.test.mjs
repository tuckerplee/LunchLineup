import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyActionAcceptance } from '../../scripts/verify-action-acceptance.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const plan = JSON.parse(readFileSync(new URL('../../docs/runbooks/2.0-action-acceptance.json', import.meta.url), 'utf8'));
const catalogPath = 'packages/api-contract/src/application.ts';
const action = (manifest,id) => manifest.actions.find(row => row.id === id);
const catalogAnchor = row => row.sourceAnchors.find(anchor => anchor.path === catalogPath);

test('accepts the current pending inventory with every catalog operation bound to its own declaration', () => {
  const result = verifyActionAcceptance(plan,root);
  assert.equal(result.catalogOperations,128); assert.equal(result.pendingActions,266);
  assert.equal(result.selectedBrowserCases,47); assert.equal(result.originalWorkflows,84);
  assert.equal(result.acceptanceExecuted,false); assert.equal(result.releaseQualified,false);
});
test('rejects an existing literal email-login anchor assigned to PIN login', () => {
  const wrong = structuredClone(plan);
  Object.assign(catalogAnchor(action(wrong,'verifyPinLogin')),catalogAnchor(action(wrong,'verifyEmailLoginCode')));
  assert.throws(() => verifyActionAcceptance(wrong,root),/catalog operation anchor drift verifyPinLogin/);
});
test('rejects a missing operation declaration even when controller and service anchors remain valid', () => {
  const wrong = structuredClone(plan), row = action(wrong,'verifyPinLogin');
  row.sourceAnchors = row.sourceAnchors.filter(anchor => anchor.path !== catalogPath);
  assert.throws(() => verifyActionAcceptance(wrong,root),/catalog operation anchor drift verifyPinLogin/);
});
test('rejects duplicate catalog declarations for a single action', () => {
  const wrong = structuredClone(plan), row = action(wrong,'verifyPinLogin');
  row.sourceAnchors.push(structuredClone(catalogAnchor(row)));
  assert.throws(() => verifyActionAcceptance(wrong,root),/catalog operation anchor drift verifyPinLogin/);
});
