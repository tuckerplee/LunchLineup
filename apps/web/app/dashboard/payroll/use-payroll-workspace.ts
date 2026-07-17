'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '@/lib/client-api';
import {
  adoptPayrollCards,
  createPayrollAmendment,
  createPayrollExport,
  createPayrollPeriod,
  createPayrollPolicyVersion,
  decidePayrollAmendment,
  decidePayrollCards,
  downloadPayrollExport,
  fetchPayrollExport,
  fetchPayrollExportEntitlement,
  fetchPayrollPeriod,
  fetchPayrollPeriods,
  fetchPayrollPolicies,
  fetchPayrollPolicy,
  lockPayrollPeriod,
  reconcilePayrollExport,
  startPayrollReview,
  type PayrollAmendmentInput,
} from './payroll-api';
import {
  clearPayrollAttempt,
  clearPayrollBrowserSession,
  createReconciliationReplay,
  getOrCreatePayrollAttempt,
  preparePayrollBrowserStorage,
  type PayrollAttemptAction,
  type PayrollAttemptStorage,
  type PayrollMutationAttempt,
  type PayrollReconciliationReplay,
} from './payroll-attempt';
import {
  appendPayrollCards,
  appendPayrollExportLines,
  buildExpectedRevisions,
  classifyPayrollMutationError,
  parsePayrollExportCreditCost,
} from './payroll-contract';
import type {
  PayrollDecision,
  PayrollPeriodDetail,
  PayrollPeriodSummary,
  PayrollPolicyInput,
  PayrollPolicyVersion,
  PayrollReconciliationInput,
} from './payroll-types';

type BusyAction = 'bootstrap' | 'policy' | 'policies' | 'period-create' | 'periods' | 'period'
  | 'cards' | 'export-lines' | 'adopt' | 'review' | 'decisions' | 'lock' | 'amendment-create'
  | 'amendment-decision' | 'export' | 'download' | 'reconcile' | null;

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

function sortPeriods(periods: PayrollPeriodSummary[]): PayrollPeriodSummary[] {
  return periods.slice().sort((left, right) => right.localStartDate.localeCompare(left.localStartDate));
}

function sortPolicies(policies: PayrollPolicyVersion[]): PayrollPolicyVersion[] {
  return policies.slice().sort((left, right) => right.version - left.version);
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function status(error: unknown): number | null {
  return error instanceof ApiRequestError ? error.status : null;
}

function isExportCostMismatch(error: unknown): boolean {
  return error instanceof ApiRequestError
    && error.status === 409
    && /(?:credit cost changed|expectedCreditCost)/i.test(error.message);
}

export function usePayrollWorkspace(canExportPayroll: boolean, currentUserId: string) {
  const [currentPolicy, setCurrentPolicy] = useState<PayrollPolicyVersion | null>(null);
  const [policies, setPolicies] = useState<PayrollPolicyVersion[]>([]);
  const [nextPolicyCursor, setNextPolicyCursor] = useState<string | null>(null);
  const [periods, setPeriods] = useState<PayrollPeriodSummary[]>([]);
  const [nextPeriodCursor, setNextPeriodCursor] = useState<string | null>(null);
  const [selectedPeriodId, setSelectedPeriodId] = useState('');
  const [detail, setDetail] = useState<PayrollPeriodDetail | null>(null);
  const [creditCost, setCreditCost] = useState<number | null>(null);
  const [creditCostError, setCreditCostError] = useState<string | null>(null);
  const [reconciliationReplay, setReconciliationReplay] = useState<PayrollReconciliationReplay | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>('bootstrap');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const attempts = useRef(new Map<string, PayrollMutationAttempt>());
  const storage = useRef<PayrollAttemptStorage | null>(null);

  const upsertPeriod = useCallback((period: PayrollPeriodSummary) => {
    setPeriods((current) => sortPeriods(mergeById(current, [period])));
  }, []);

  const installDetail = useCallback((payload: PayrollPeriodDetail) => {
    setDetail(payload);
    upsertPeriod(payload.period);
    const batchId = payload.period.exportBatch?.id;
    setReconciliationReplay((current) => current?.batchId === batchId ? current : null);
  }, [upsertPeriod]);

  const loadCreditCost = useCallback(async (): Promise<number | null> => {
    try {
      const cost = parsePayrollExportCreditCost(await fetchPayrollExportEntitlement());
      setCreditCost(cost);
      setCreditCostError(null);
      return cost;
    } catch (costError) {
      setCreditCost(null);
      setCreditCostError(message(costError, 'The payroll export credit cost is unavailable.'));
      return null;
    }
  }, []);

  const readBackPeriod = useCallback(async (periodId: string): Promise<PayrollPeriodDetail> => {
    const payload = await fetchPayrollPeriod(periodId);
    installDetail(payload);
    return payload;
  }, [installDetail]);

  const refreshPeriods = useCallback(async () => {
    const page = await fetchPayrollPeriods();
    setPeriods((current) => {
      const selected = current.find((period) => period.id === selectedPeriodId);
      return sortPeriods(mergeById(page.data, selected ? [selected] : []));
    });
    setNextPeriodCursor(page.nextCursor ?? null);
    return page;
  }, [selectedPeriodId]);

  const refreshAfterPeriodMutation = useCallback(async (periodId: string) => {
    await readBackPeriod(periodId);
    await refreshPeriods();
  }, [readBackPeriod, refreshPeriods]);

  const refreshAfterConfirmedPeriodMutation = useCallback(async (periodId: string, operation: string) => {
    try {
      await refreshAfterPeriodMutation(periodId);
    } catch {
      setError(`${operation} succeeded, but the latest payroll state could not be refreshed. Use Refresh; do not repeat the completed command.`);
    }
  }, [refreshAfterPeriodMutation]);

  const loadPeriod = useCallback(async (periodId: string) => {
    if (!periodId) return;
    const requestId = ++detailRequest.current;
    setSelectedPeriodId(periodId);
    setDetail(null);
    setBusyAction('period');
    setError(null);
    setNotice(null);
    try {
      const payload = await fetchPayrollPeriod(periodId);
      if (detailRequest.current === requestId) installDetail(payload);
    } catch (loadError) {
      if (detailRequest.current === requestId) setError(message(loadError, 'Unable to load the payroll period.'));
    } finally {
      if (detailRequest.current === requestId) setBusyAction(null);
    }
  }, [installDetail]);

  const bootstrap = useCallback(async () => {
    setBusyAction('bootstrap');
    setError(null);
    try {
      const [policy, policyPage, periodPage] = await Promise.all([
        fetchPayrollPolicy(),
        fetchPayrollPolicies(),
        fetchPayrollPeriods(),
      ]);
      setCurrentPolicy(policy);
      setPolicies(sortPolicies(mergeById(policyPage.data, policy ? [policy] : [])));
      setNextPolicyCursor(policyPage.nextCursor ?? null);
      setPeriods(sortPeriods(periodPage.data));
      setNextPeriodCursor(periodPage.nextCursor ?? null);
      if (canExportPayroll) void loadCreditCost();
      if (periodPage.data[0]) await loadPeriod(periodPage.data[0].id);
    } catch (loadError) {
      setError(message(loadError, 'Unable to load payroll.'));
    } finally {
      setBusyAction(null);
    }
  }, [canExportPayroll, loadCreditCost, loadPeriod]);

  useEffect(() => {
    let active = true;
    const clearSession = () => {
      clearPayrollBrowserSession(storage.current);
      storage.current = null;
      attempts.current.clear();
      setReconciliationReplay(null);
    };
    const clearOnLogout = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (link && new URL(link.href, window.location.href).pathname === '/auth/logout') clearSession();
    };

    document.addEventListener('click', clearOnLogout, true);
    void preparePayrollBrowserStorage(currentUserId, undefined, () => active).then((prepared) => {
      if (!active) return;
      storage.current = prepared;
      void bootstrap();
    });

    return () => {
      active = false;
      document.removeEventListener('click', clearOnLogout, true);
      clearSession();
    };
  }, [bootstrap, currentUserId]);

  const attemptFor = useCallback(async (action: PayrollAttemptAction, scope: string, payload: unknown) => {
    const mapKey = `${action}:${scope}`;
    const attempt = await getOrCreatePayrollAttempt(storage.current, action, scope, payload, attempts.current.get(mapKey) ?? null);
    attempts.current.set(mapKey, attempt);
    return attempt;
  }, []);

  const completeAttempt = useCallback((attempt: PayrollMutationAttempt) => {
    clearPayrollAttempt(storage.current, attempt);
    attempts.current.delete(`${attempt.action}:${attempt.scope}`);
  }, []);

  const recoverPeriodError = useCallback(async (periodId: string, operation: string, operationError: unknown) => {
    const kind = classifyPayrollMutationError(status(operationError));
    if (kind === 'definitive') {
      setError(message(operationError, `Unable to ${operation}.`));
      return;
    }
    try {
      await refreshAfterPeriodMutation(periodId);
      setError(kind === 'stale'
        ? `Payroll data changed. The latest revision was loaded; review it before trying to ${operation} again.`
        : `The ${operation} outcome is unclear. The latest state was loaded; replay uses the same Idempotency-Key.`);
    } catch {
      setError(`The ${operation} outcome is unknown. Replay uses the same Idempotency-Key.`);
    }
  }, [refreshAfterPeriodMutation]);

  const createPolicy = useCallback(async (input: PayrollPolicyInput) => {
    const attempt = await attemptFor('policy', 'tenant', input);
    setBusyAction('policy'); setError(null); setNotice(null);
    try {
      const created = await createPayrollPolicyVersion(input, attempt.key);
      completeAttempt(attempt);
      setCurrentPolicy(created);
      setPolicies((current) => sortPolicies(mergeById(current, [created])));
      setNotice(`Policy version ${created.version} created for ${created.effectiveFrom}. Existing history was not changed.`);
      return true;
    } catch (policyError) {
      const kind = classifyPayrollMutationError(status(policyError));
      if (kind !== 'definitive') {
        try {
          const page = await fetchPayrollPolicies();
          setPolicies(sortPolicies(page.data));
          setNextPolicyCursor(page.nextCursor ?? null);
          const confirmed = page.data.find((policy) => policy.effectiveFrom === input.effectiveFrom
            && policy.timeZone === input.timeZone && policy.cadence === input.cadence && policy.anchorDate === input.anchorDate);
          if (confirmed) {
            completeAttempt(attempt);
            setNotice(`Policy version ${confirmed.version} was confirmed by readback.`);
            return true;
          }
        } catch { /* Preserve the exact attempt for replay. */ }
      }
      setError(kind === 'definitive' ? message(policyError, 'Unable to create the policy version.') : 'Policy creation is unconfirmed. Submit the unchanged form to replay the same Idempotency-Key.');
      return false;
    } finally { setBusyAction(null); }
  }, [attemptFor, completeAttempt]);

  const loadMorePolicies = useCallback(async () => {
    if (!nextPolicyCursor || busyAction) return;
    setBusyAction('policies'); setError(null);
    try {
      const page = await fetchPayrollPolicies(nextPolicyCursor);
      setPolicies((current) => sortPolicies(mergeById(current, page.data)));
      setNextPolicyCursor(page.nextCursor ?? null);
    } catch (loadError) { setError(message(loadError, 'Unable to load older policy versions.')); }
    finally { setBusyAction(null); }
  }, [busyAction, nextPolicyCursor]);

  const createPeriod = useCallback(async (localStartDate: string) => {
    const payload = { localStartDate };
    const attempt = await attemptFor('period-create', localStartDate, payload);
    setBusyAction('period-create'); setError(null); setNotice(null);
    try {
      const created = await createPayrollPeriod(localStartDate, attempt.key);
      completeAttempt(attempt); upsertPeriod(created); setNotice('Payroll period created.');
      await loadPeriod(created.id);
      try {
        await refreshPeriods();
      } catch {
        setError('Payroll period creation succeeded, but the period list could not be refreshed. Use Refresh; do not repeat the completed command.');
      }
    } catch (createError) {
      const kind = classifyPayrollMutationError(status(createError));
      if (kind !== 'definitive') {
        try {
          const page = await refreshPeriods();
          const confirmed = page.data.find((period) => period.localStartDate === localStartDate);
          if (confirmed) { completeAttempt(attempt); await loadPeriod(confirmed.id); setNotice('Period creation was confirmed by readback.'); return; }
        } catch { /* Preserve the exact attempt for replay. */ }
      }
      setError(kind === 'definitive' ? message(createError, 'Unable to create the payroll period.') : 'Period creation is unconfirmed. Retry the same date to replay the same Idempotency-Key.');
    } finally { setBusyAction(null); }
  }, [attemptFor, completeAttempt, loadPeriod, refreshPeriods, upsertPeriod]);

  const loadMorePeriods = useCallback(async () => {
    if (!nextPeriodCursor || busyAction) return;
    setBusyAction('periods'); setError(null);
    try {
      const page = await fetchPayrollPeriods(nextPeriodCursor);
      setPeriods((current) => sortPeriods(mergeById(current, page.data)));
      setNextPeriodCursor(page.nextCursor ?? null);
    } catch (loadError) { setError(message(loadError, 'Unable to load older periods.')); }
    finally { setBusyAction(null); }
  }, [busyAction, nextPeriodCursor]);

  const loadMoreCards = useCallback(async () => {
    if (!detail?.nextCardCursor || busyAction) return;
    const periodId = detail.period.id;
    const baseRevision = detail.period.revision;
    const cursor = detail.nextCardCursor;
    setBusyAction('cards'); setError(null);
    try {
      const page = await fetchPayrollPeriod(periodId, cursor);
      if (page.period.revision !== baseRevision) {
        await readBackPeriod(periodId);
        setNotice('The period revision changed during paging. The latest first page is shown.');
        return;
      }
      installDetail({ ...page, cards: appendPayrollCards(detail.cards, page.cards) });
    } catch (loadError) { setError(message(loadError, 'Unable to load the next bounded card page.')); }
    finally { setBusyAction(null); }
  }, [busyAction, detail, installDetail, readBackPeriod]);

  const loadMoreExportLines = useCallback(async () => {
    const batch = detail?.period.exportBatch;
    if (!detail || !batch?.nextLineCursor || busyAction) return;
    setBusyAction('export-lines'); setError(null);
    try {
      const page = await fetchPayrollExport(batch.id, batch.nextLineCursor);
      if (page.id !== batch.id) throw new Error('The export line page did not match the selected batch.');
      installDetail({
        ...detail,
        period: {
          ...detail.period,
          exportBatch: { ...page, lines: appendPayrollExportLines(batch.lines, page.lines) },
        },
      });
    } catch (loadError) {
      setError(message(loadError, 'Unable to load the next bounded export-line page.'));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, detail, installDetail]);

  const actOnCards = useCallback(async (action: 'adopt' | 'decisions', cardIds: string[], decision?: PayrollDecision, reason?: string) => {
    if (!detail) return;
    const revisions = buildExpectedRevisions(detail.cards, cardIds);
    const payload = action === 'adopt'
      ? { cards: cardIds.map((id) => ({ id, expectedRevision: revisions[id] })) }
      : { decisions: cardIds.map((timeCardId) => ({
        timeCardId,
        expectedRevision: revisions[timeCardId],
        decision: decision as PayrollDecision,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      })) };
    const attempt = await attemptFor(action, detail.period.id, payload);
    setBusyAction(action); setError(null); setNotice(null);
    try {
      let affectedCount: number;
      if (action === 'adopt') {
        const result = await adoptPayrollCards(detail.period.id, payload as { cards: Array<{ id: string; expectedRevision: number }> }, attempt.key);
        affectedCount = result.adoptedCount;
      } else {
        const result = await decidePayrollCards(detail.period.id, payload as { decisions: Array<{ timeCardId: string; expectedRevision: number; decision: PayrollDecision; reason?: string }> }, attempt.key);
        affectedCount = result.decidedCount;
      }
      completeAttempt(attempt);
      setNotice(`${affectedCount} loaded ${action === 'adopt' ? 'rows adopted' : 'decisions recorded'}.`);
      await refreshAfterConfirmedPeriodMutation(detail.period.id, action === 'adopt' ? 'Row adoption' : 'Decision recording');
    } catch (operationError) { await recoverPeriodError(detail.period.id, action === 'adopt' ? 'adopt rows' : 'record decisions', operationError); }
    finally { setBusyAction(null); }
  }, [attemptFor, completeAttempt, detail, recoverPeriodError, refreshAfterConfirmedPeriodMutation]);

  const startReview = useCallback(async () => {
    if (!detail) return;
    const payload = { expectedRevision: detail.period.revision };
    const attempt = await attemptFor('review', detail.period.id, payload);
    setBusyAction('review'); setError(null); setNotice(null);
    try {
      await startPayrollReview(detail.period.id, detail.period.revision, attempt.key);
      completeAttempt(attempt); setNotice('Review started. Decisions remain bound to exact card versions.');
      await refreshAfterConfirmedPeriodMutation(detail.period.id, 'Review start');
    } catch (operationError) { await recoverPeriodError(detail.period.id, 'start review', operationError); }
    finally { setBusyAction(null); }
  }, [attemptFor, completeAttempt, detail, recoverPeriodError, refreshAfterConfirmedPeriodMutation]);

  const lockPeriod = useCallback(async () => {
    if (!detail) return;
    const payload = { expectedRevision: detail.period.revision };
    const attempt = await attemptFor('lock', detail.period.id, payload);
    setBusyAction('lock'); setError(null); setNotice(null);
    try {
      await lockPayrollPeriod(detail.period.id, detail.period.revision, attempt.key);
      completeAttempt(attempt); setNotice('Terminal lock recorded. The snapshot is immutable and is not payroll-final.');
      await refreshAfterConfirmedPeriodMutation(detail.period.id, 'Terminal lock');
    } catch (operationError) { await recoverPeriodError(detail.period.id, 'lock the period', operationError); }
    finally { setBusyAction(null); }
  }, [attemptFor, completeAttempt, detail, recoverPeriodError, refreshAfterConfirmedPeriodMutation]);

  const createAmendment = useCallback(async (entryId: string, payload: PayrollAmendmentInput) => {
    if (!detail) return;
    const attempt = await attemptFor('amendment-create', entryId, payload);
    setBusyAction('amendment-create'); setError(null); setNotice(null);
    try {
      const amendment = await createPayrollAmendment(entryId, payload, attempt.key);
      completeAttempt(attempt); setNotice(`Amendment created with a ${amendment.minuteDelta >= 0 ? '+' : ''}${amendment.minuteDelta} minute delta in the future period.`);
      await refreshAfterConfirmedPeriodMutation(detail.period.id, 'Amendment creation');
      return true;
    } catch (operationError) {
      const kind = classifyPayrollMutationError(status(operationError));
      if (kind !== 'definitive') {
        try {
          const refreshed = await readBackPeriod(detail.period.id);
          const confirmed = refreshed.amendments.find((amendment) => (
            amendment.lockedEntryId === entryId
            && amendment.adjustmentPeriodId === payload.adjustmentPeriodId
            && amendment.reason === payload.reason
            && amendment.replacementClockInAt === payload.replacementClockInAt
            && amendment.replacementClockOutAt === payload.replacementClockOutAt
            && amendment.replacementBreakMinutes === payload.replacementBreakMinutes
          ));
          try { await refreshPeriods(); } catch { /* Exact period readback is sufficient. */ }
          if (confirmed) {
            completeAttempt(attempt);
            setNotice('Amendment creation was confirmed by readback.');
            return true;
          }
        } catch { /* Preserve the exact attempt and form payload for replay. */ }
      }
      setError(kind === 'definitive'
        ? message(operationError, 'Unable to create amendment.')
        : 'Amendment creation is unconfirmed. Submit the unchanged form to replay the same payload and Idempotency-Key.');
      return false;
    }
    finally { setBusyAction(null); }
  }, [attemptFor, completeAttempt, detail, readBackPeriod, refreshAfterConfirmedPeriodMutation, refreshPeriods]);

  const decideAmendment = useCallback(async (amendmentId: string, decision: PayrollDecision, reason?: string) => {
    if (!detail) return;
    const payload = { decision, ...(reason?.trim() ? { reason: reason.trim() } : {}) };
    const attempt = await attemptFor('amendment-decision', amendmentId, payload);
    setBusyAction('amendment-decision'); setError(null); setNotice(null);
    try {
      await decidePayrollAmendment(amendmentId, payload, attempt.key);
      completeAttempt(attempt); setNotice('Independent amendment decision recorded.');
      await refreshAfterConfirmedPeriodMutation(detail.period.id, 'Amendment decision');
    } catch (operationError) { await recoverPeriodError(detail.period.id, 'decide amendment', operationError); }
    finally { setBusyAction(null); }
  }, [attemptFor, completeAttempt, detail, recoverPeriodError, refreshAfterConfirmedPeriodMutation]);

  const exportPeriod = useCallback(async (confirmedCost: number) => {
    if (!detail) return;
    const authoritativeCost = await loadCreditCost();
    if (authoritativeCost === null) { setError('The configured export cost could not be confirmed. No export was requested.'); return; }
    if (authoritativeCost !== confirmedCost) { setError(`The configured cost changed to ${authoritativeCost}. Confirm the new exact cost.`); return; }
    const payload = { periodId: detail.period.id, expectedCreditCost: authoritativeCost };
    const attempt = await attemptFor('export', detail.period.id, payload);
    setBusyAction('export'); setError(null); setNotice(null);
    try {
      const batch = await createPayrollExport(detail.period.id, payload.expectedCreditCost, attempt.key);
      completeAttempt(attempt);
      installDetail({ ...detail, period: { ...detail.period, exportBatch: batch } });
      setNotice(batch.settlement.consumedCredits === authoritativeCost
        ? `Deterministic batch created for ${authoritativeCost} ${authoritativeCost === 1 ? 'credit' : 'credits'}; balance ${batch.settlement.newBalance}.`
        : 'The batch was created but settlement differs from the confirmed cost. Do not retry the export.');
      await refreshAfterConfirmedPeriodMutation(detail.period.id, 'Deterministic export creation');
    } catch (operationError) {
      if (isExportCostMismatch(operationError)) {
        completeAttempt(attempt);
        await Promise.allSettled([loadCreditCost(), refreshAfterPeriodMutation(detail.period.id)]);
        setError('The configured export cost changed. Review and confirm the refreshed exact cost; the rejected request will not be replayed.');
      } else {
        await recoverPeriodError(detail.period.id, 'create export', operationError);
      }
    }
    finally { setBusyAction(null); }
  }, [attemptFor, completeAttempt, detail, installDetail, loadCreditCost, recoverPeriodError, refreshAfterConfirmedPeriodMutation, refreshAfterPeriodMutation]);

  const downloadExport = useCallback(async () => {
    const batch = detail?.period.exportBatch;
    if (!detail || !batch) return;
    setBusyAction('download'); setError(null); setNotice(null);
    try {
      await downloadPayrollExport(batch.id);
      setNotice('Existing deterministic batch download started. Downloads consume no credits.');
      await refreshAfterConfirmedPeriodMutation(detail.period.id, 'Export download');
    } catch (downloadError) { setError(message(downloadError, 'Unable to download the export.')); }
    finally { setBusyAction(null); }
  }, [detail, refreshAfterConfirmedPeriodMutation]);

  const sendReconciliation = useCallback(async (batchId: string, payload: PayrollReconciliationInput) => {
    if (!detail) return;
    const replay = createReconciliationReplay(batchId, payload);
    setReconciliationReplay(replay);
    setBusyAction('reconcile'); setError(null); setNotice(null);
    try {
      await reconcilePayrollExport(batchId, payload);
      setReconciliationReplay(null);
      try {
        const refreshed = await readBackPeriod(detail.period.id);
        await refreshPeriods();
        setNotice(refreshed.period.exportBatch?.status === 'RECONCILED'
          ? 'Every export line was accepted and provider totals match. Reconciliation is complete.'
          : 'Line outcomes recorded. The batch remains partial, rejected, or pending until every line is accepted and totals match.');
      } catch {
        setNotice('Reconciliation was recorded. Refresh to load the latest batch status; do not replay the completed submission.');
        setError('Reconciliation succeeded, but the latest payroll state could not be refreshed.');
      }
    } catch (reconcileError) {
      const kind = classifyPayrollMutationError(status(reconcileError));
      setError(kind === 'ambiguous'
        ? 'Reconciliation transport was ambiguous. Replay the saved same request without editing it.'
        : message(reconcileError, 'Unable to record reconciliation.'));
      if (kind !== 'ambiguous') setReconciliationReplay(null);
    } finally { setBusyAction(null); }
  }, [detail, readBackPeriod, refreshPeriods]);

  const replaySavedReconciliation = useCallback(async () => {
    if (reconciliationReplay) await sendReconciliation(reconciliationReplay.batchId, reconciliationReplay.payload);
  }, [reconciliationReplay, sendReconciliation]);

  return {
    currentPolicy, policies, nextPolicyCursor, periods, nextPeriodCursor, selectedPeriodId, detail,
    creditCost, creditCostError, reconciliationReplay, busyAction, error, notice,
    createPolicy, loadMorePolicies, createPeriod, loadMorePeriods, loadPeriod, loadMoreCards, loadMoreExportLines,
    adoptCards: (ids: string[]) => actOnCards('adopt', ids),
    decideCards: (ids: string[], decision: PayrollDecision, reason?: string) => actOnCards('decisions', ids, decision, reason),
    startReview, lockPeriod, createAmendment, decideAmendment, exportPeriod, downloadExport,
    reconcileExport: sendReconciliation, replaySavedReconciliation, retryBootstrap: bootstrap,
  };
}
