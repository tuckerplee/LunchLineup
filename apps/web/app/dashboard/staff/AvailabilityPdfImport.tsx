'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import { AlertCircle, CheckCircle2, Clock3, FileUp, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { fetchJsonWithSession, withIdempotencyKey } from '@/lib/client-api';

import {
    AVAILABILITY_IMPORT_POLL_INTERVAL_MS,
    MAX_AVAILABILITY_IMPORT_POLLS,
    assertAvailabilityImportAcceptedCost,
    availabilityImportRequestFields,
    availabilityImportStatusView,
    createAvailabilityPdfImportAttempt,
    isAvailabilityImportTerminal,
    parseAvailabilityImportJob,
    parseSchedulingCreditCost,
    updateAvailabilityPdfImportAttemptIdentity,
    validateAvailabilityImportStaffIdentity,
    validateAvailabilityPdfFile,
    type AvailabilityImportJob,
    type AvailabilityImportStatusView,
    type AvailabilityPdfImportAttempt,
    type ImportedAvailabilityWindow,
} from './availability-pdf-import';

type AvailabilityPdfImportProps = {
    userId: string;
    suggestedStaffIdentity: string;
    disabled: boolean;
    onApply: (availability: ImportedAvailabilityWindow[]) => Promise<boolean>;
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const STATUS_TONE_STYLES: Record<AvailabilityImportStatusView['tone'], CSSProperties> = {
    neutral: { borderColor: '#cbd5e1', background: '#f8fafc', color: '#334155' },
    progress: { borderColor: '#93c5fd', background: '#eff6ff', color: '#1e40af' },
    success: { borderColor: '#86c79a', background: '#f0fdf4', color: '#166534' },
    danger: { borderColor: '#f0b4ae', background: '#fff5f4', color: '#8f231a' },
};

function displayTime(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const displayHours = hours % 12 || 12;
    const suffix = hours < 12 ? 'AM' : 'PM';
    return `${displayHours}:${String(minutes % 60).padStart(2, '0')} ${suffix}`;
}

function displayFileSize(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function StatusIcon({ tone }: { tone: AvailabilityImportStatusView['tone'] }) {
    if (tone === 'success') return <CheckCircle2 aria-hidden="true" size={18} />;
    if (tone === 'danger') return <AlertCircle aria-hidden="true" size={18} />;
    return <Clock3 aria-hidden="true" size={18} />;
}

export function AvailabilityPdfImport({ userId, suggestedStaffIdentity, disabled, onApply }: AvailabilityPdfImportProps) {
    const [attempt, setAttempt] = useState<AvailabilityPdfImportAttempt | null>(null);
    const [staffIdentity, setStaffIdentity] = useState(suggestedStaffIdentity);
    const [identityError, setIdentityError] = useState<string | null>(() => (
        validateAvailabilityImportStaffIdentity(suggestedStaffIdentity)
    ));
    const [job, setJob] = useState<AvailabilityImportJob | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [creditCost, setCreditCost] = useState<number | null>(null);
    const [costError, setCostError] = useState<string | null>(null);
    const [isCostLoading, setIsCostLoading] = useState(true);
    const [isChecking, setIsChecking] = useState(false);
    const [isApplying, setIsApplying] = useState(false);
    const [applyComplete, setApplyComplete] = useState(false);
    const [pollCount, setPollCount] = useState(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const timerRef = useRef<number | null>(null);
    const requestAbortRef = useRef<AbortController | null>(null);
    const costAbortRef = useRef<AbortController | null>(null);
    const lifecycleRef = useRef(0);
    const submitInFlightRef = useRef(false);
    const checkInFlightRef = useRef(false);
    const applyInFlightRef = useRef(false);

    const clearPollTimer = useCallback(() => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);
    const loadCreditCost = useCallback(async (): Promise<number | null> => {
        costAbortRef.current?.abort();
        const controller = new AbortController();
        costAbortRef.current = controller;
        setIsCostLoading(true);
        setCostError(null);
        try {
            const payload = await fetchJsonWithSession<unknown>('/billing/features', {
                signal: controller.signal,
            });
            if (controller.signal.aborted) return null;
            const nextCreditCost = parseSchedulingCreditCost(payload);
            setCreditCost(nextCreditCost);
            return nextCreditCost;
        } catch {
            if (controller.signal.aborted) return null;
            setCreditCost(null);
            setCostError('The availability import credit cost is unavailable. Upload is disabled.');
            return null;
        } finally {
            if (!controller.signal.aborted) setIsCostLoading(false);
            if (costAbortRef.current === controller) costAbortRef.current = null;
        }
    }, []);

    useEffect(() => {
        lifecycleRef.current += 1;
        return () => {
            lifecycleRef.current += 1;
            clearPollTimer();
            requestAbortRef.current?.abort();
            costAbortRef.current?.abort();
        };
    }, [clearPollTimer, userId]);

    useEffect(() => {
        setCreditCost(null);
        void loadCreditCost();
        return () => costAbortRef.current?.abort();
    }, [loadCreditCost, userId]);

    const checkStatus = useCallback(async (importId: string, generation: number) => {
        if (checkInFlightRef.current) return;
        checkInFlightRef.current = true;
        setIsChecking(true);
        const controller = new AbortController();
        requestAbortRef.current = controller;
        try {
            const payload = await fetchJsonWithSession<unknown>(
                `/availability-imports/${encodeURIComponent(importId)}`,
                { signal: controller.signal },
            );
            if (generation !== lifecycleRef.current) return;
            const nextJob = parseAvailabilityImportJob(payload);
            if (nextJob.userId !== userId || nextJob.id !== importId) {
                throw new Error('The availability import returned an invalid response.');
            }
            setJob(nextJob);
            setError(null);
        } catch (statusError) {
            if (generation !== lifecycleRef.current) return;
            setError((statusError as Error).message);
        } finally {
            if (generation === lifecycleRef.current) {
                setPollCount((current) => current + 1);
                setIsChecking(false);
            }
            if (requestAbortRef.current === controller) requestAbortRef.current = null;
            checkInFlightRef.current = false;
        }
    }, [userId]);

    const jobId = job?.id ?? null;
    const jobStatus = job?.status ?? null;
    const pollingExhausted = Boolean(
        jobStatus
        && !isAvailabilityImportTerminal(jobStatus)
        && pollCount >= MAX_AVAILABILITY_IMPORT_POLLS,
    );

    useEffect(() => {
        clearPollTimer();
        if (!jobId || !jobStatus || isAvailabilityImportTerminal(jobStatus) || pollingExhausted) return;
        const generation = lifecycleRef.current;
        timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            if (generation === lifecycleRef.current) void checkStatus(jobId, generation);
        }, AVAILABILITY_IMPORT_POLL_INTERVAL_MS);
        return clearPollTimer;
    }, [checkStatus, clearPollTimer, jobId, jobStatus, pollCount, pollingExhausted]);

    const activeJob = Boolean(jobStatus && !isAvailabilityImportTerminal(jobStatus));
    const parsedAvailability = useMemo(() => (
        jobStatus === 'SUCCEEDED' ? job?.parsedAvailability ?? null : null
    ), [job?.parsedAvailability, jobStatus]);

    const selectFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
        const file = event.currentTarget.files?.[0] ?? null;
        const validationError = validateAvailabilityPdfFile(file);
        const nextIdentityError = validateAvailabilityImportStaffIdentity(staffIdentity);
        clearPollTimer();
        setError(validationError);
        setIdentityError(nextIdentityError);
        setJob(null);
        setPollCount(0);
        setApplyComplete(false);
        if (validationError || nextIdentityError || !file) {
            setAttempt(null);
            event.currentTarget.value = '';
            return;
        }
        try {
            setAttempt(createAvailabilityPdfImportAttempt(file, staffIdentity));
        } catch (selectionError) {
            setAttempt(null);
            setError((selectionError as Error).message);
            event.currentTarget.value = '';
        }
    }, [clearPollTimer, staffIdentity]);

    const changeStaffIdentity = useCallback((event: ChangeEvent<HTMLInputElement>) => {
        const value = event.currentTarget.value;
        const validationError = validateAvailabilityImportStaffIdentity(value);
        setStaffIdentity(value);
        setIdentityError(validationError);
        if (!validationError) {
            setAttempt((current) => current
                ? updateAvailabilityPdfImportAttemptIdentity(current, value)
                : null);
        }
    }, []);

    const submit = useCallback(async () => {
        if (
            !attempt
            || identityError
            || submitInFlightRef.current
            || activeJob
            || disabled
            || creditCost === null
            || isCostLoading
        ) return;
        submitInFlightRef.current = true;
        setIsSubmitting(true);
        setError(null);
        setApplyComplete(false);
        const generation = lifecycleRef.current;
        const controller = new AbortController();
        requestAbortRef.current = controller;
        try {
            const confirmedCreditCost = await loadCreditCost();
            if (confirmedCreditCost === null || generation !== lifecycleRef.current) return;
            const formData = new FormData();
            formData.set('file', attempt.file, attempt.file.name);
            const requestFields = availabilityImportRequestFields(attempt);
            formData.set('staffIdentity', requestFields.staffIdentity);
            const payload = await fetchJsonWithSession<unknown>(
                `/availability-imports/users/${encodeURIComponent(userId)}`,
                withIdempotencyKey({ method: 'POST', body: formData, signal: controller.signal }, attempt.idempotencyKey),
            );
            if (generation !== lifecycleRef.current) return;
            const nextJob = parseAvailabilityImportJob(payload);
            if (nextJob.userId !== userId) {
                throw new Error('The availability import returned an invalid response.');
            }
            assertAvailabilityImportAcceptedCost(nextJob, confirmedCreditCost);
            setJob(nextJob);
            setPollCount(0);
            setAttempt(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
        } catch (submitError) {
            if (generation !== lifecycleRef.current) return;
            setError((submitError as Error).message);
        } finally {
            if (generation === lifecycleRef.current) setIsSubmitting(false);
            if (requestAbortRef.current === controller) requestAbortRef.current = null;
            submitInFlightRef.current = false;
        }
    }, [activeJob, attempt, creditCost, disabled, identityError, isCostLoading, loadCreditCost, userId]);

    const resumePolling = useCallback(() => {
        if (!job || isChecking) return;
        clearPollTimer();
        setPollCount(0);
        setError(null);
        void checkStatus(job.id, lifecycleRef.current);
    }, [checkStatus, clearPollTimer, isChecking, job]);

    const applyAvailability = useCallback(async () => {
        if (!parsedAvailability || applyInFlightRef.current || disabled) return;
        applyInFlightRef.current = true;
        setIsApplying(true);
        try {
            const applied = await onApply(parsedAvailability);
            if (applied) setApplyComplete(true);
        } finally {
            setIsApplying(false);
            applyInFlightRef.current = false;
        }
    }, [disabled, onApply, parsedAvailability]);

    const statusView = job ? availabilityImportStatusView(job.status, job.settlement) : null;

    return (
        <section aria-labelledby="availability-pdf-import-title" style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem', display: 'grid', gap: '0.8rem' }}>
            <div style={{ display: 'grid', gap: '0.25rem' }}>
                <h3 id="availability-pdf-import-title" style={{ fontSize: '0.84rem', margin: 0 }}>Import availability PDF</h3>
                <p id="availability-pdf-import-cost" style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.78rem', lineHeight: 1.45 }}>
                    PDF only, up to 5 MiB. {creditCost === null ? 'Checking paid credit cost...' : <>This import costs {creditCost} paid {creditCost === 1 ? 'credit' : 'credits'}.</>}
                </p>
            </div>

            {costError ? (
                <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#b42318', fontSize: '0.78rem' }}>
                    <span>{costError}</span>
                    <Button type="button" size="sm" variant="outline" onClick={() => void loadCreditCost()} disabled={isCostLoading}>
                        <RefreshCw aria-hidden="true" size={14} /> Check cost
                    </Button>
                </div>
            ) : null}

            <div style={{ display: 'grid', gap: '0.3rem' }}>
                <label htmlFor="availability-pdf-staff-identity" style={{ fontSize: '0.72rem', fontWeight: 700 }}>
                    Employee or staff ID (required)
                </label>
                <input
                    id="availability-pdf-staff-identity"
                    type="text"
                    value={staffIdentity}
                    required
                    maxLength={128}
                    autoComplete="off"
                    aria-describedby="availability-pdf-staff-identity-help availability-pdf-staff-identity-error"
                    aria-invalid={Boolean(identityError)}
                    disabled={disabled || isSubmitting || activeJob}
                    onChange={changeStaffIdentity}
                    style={{ width: '100%', maxWidth: 360, border: '1px solid var(--border)', borderRadius: 6, padding: '0.5rem 0.6rem', background: '#fff', fontSize: '0.78rem' }}
                />
                <span id="availability-pdf-staff-identity-help" style={{ color: 'var(--text-muted)', fontSize: '0.74rem', lineHeight: 1.4 }}>
                    This manager-visible identifier must match the Employee ID or Staff ID printed in the PDF. It is never an internal database ID.
                </span>
                {identityError ? <span id="availability-pdf-staff-identity-error" role="alert" style={{ color: '#b42318', fontSize: '0.74rem' }}>{identityError}</span> : null}
            </div>

            <div style={{ display: 'flex', alignItems: 'end', gap: '0.65rem', flexWrap: 'wrap' }}>
                <label htmlFor="availability-pdf-file" style={{ display: 'grid', gap: '0.3rem', minWidth: 0, flex: '1 1 260px', fontSize: '0.72rem', fontWeight: 700 }}>
                    Availability PDF
                    <input
                        ref={fileInputRef}
                        id="availability-pdf-file"
                        type="file"
                        accept="application/pdf,.pdf"
                        aria-describedby="availability-pdf-import-cost"
                        disabled={disabled || isSubmitting || activeJob}
                        onChange={selectFile}
                        style={{ width: '100%', maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 6, padding: '0.45rem', background: '#fff', fontSize: '0.78rem' }}
                    />
                </label>
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => void submit()}
                    disabled={!attempt || Boolean(identityError) || disabled || isSubmitting || activeJob || isCostLoading || creditCost === null}
                    aria-describedby="availability-pdf-import-cost"
                >
                    <FileUp aria-hidden="true" size={16} />
                    {isSubmitting ? 'Uploading...' : error && attempt ? 'Retry upload' : 'Upload PDF'}
                </Button>
            </div>

            {attempt ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem', overflowWrap: 'anywhere' }}>
                    Selected: {attempt.file.name} ({displayFileSize(attempt.file.size)})
                </div>
            ) : null}

            {error ? <div role="alert" style={{ color: '#b42318', fontSize: '0.78rem' }}>{error}</div> : null}

            {job && statusView ? (
                <div
                    role="status"
                    aria-live="polite"
                    aria-busy={activeJob}
                    style={{ ...STATUS_TONE_STYLES[statusView.tone], borderStyle: 'solid', borderWidth: 1, borderRadius: 6, padding: '0.75rem', display: 'grid', gap: '0.35rem' }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.82rem' }}>
                        <StatusIcon tone={statusView.tone} />
                        <strong>{statusView.label}</strong>
                        {isChecking ? <span style={{ fontSize: '0.74rem' }}>Checking status...</span> : null}
                    </div>
                    <div style={{ fontSize: '0.77rem', lineHeight: 1.4 }}>{statusView.detail}</div>
                    <strong style={{ fontSize: '0.77rem', lineHeight: 1.4 }}>{statusView.creditDetail}</strong>
                    {pollingExhausted ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.65rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                            <span style={{ fontSize: '0.76rem' }}>Automatic status checks paused after one minute.</span>
                            <Button type="button" size="sm" variant="outline" onClick={resumePolling} disabled={isChecking}>
                                <RefreshCw aria-hidden="true" size={14} /> Check status
                            </Button>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {jobStatus === 'SUCCEEDED' && !parsedAvailability ? (
                <div role="alert" style={{ border: '1px solid #e8b04d', background: '#fff8e8', color: '#6f4a00', padding: '0.75rem', borderRadius: 6, fontSize: '0.78rem' }}>
                    The parsed result is no longer available. Select the PDF again to start a new import.
                </div>
            ) : null}

            {parsedAvailability ? (
                <div style={{ display: 'grid', gap: '0.65rem' }}>
                    <div style={{ display: 'grid', gap: '0.2rem' }}>
                        <h4 id="parsed-availability-title" style={{ margin: 0, fontSize: '0.8rem' }}>
                            Review parsed availability ({parsedAvailability.length})
                        </h4>
                        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.76rem', lineHeight: 1.4 }}>
                            Applying replaces the current weekly availability and saves the profile. Skills are preserved.
                        </p>
                    </div>
                    <ul aria-labelledby="parsed-availability-title" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', borderTop: '1px solid var(--border)' }}>
                        {parsedAvailability.map((window, index) => (
                            <li
                                key={`${window.locationId ?? 'all'}-${window.dayOfWeek}-${window.startTimeMinutes}-${window.endTimeMinutes}`}
                                style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.4rem 0.75rem', padding: '0.6rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.78rem' }}
                            >
                                <strong>{index + 1}. {DAYS[window.dayOfWeek]}</strong>
                                <span>{displayTime(window.startTimeMinutes)} to {displayTime(window.endTimeMinutes)}{window.startTimeMinutes > window.endTimeMinutes ? ' (overnight)' : ''}</span>
                                <span>{window.locationId ? `Location ${window.locationId}` : 'All locations'}</span>
                            </li>
                        ))}
                    </ul>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <Button type="button" onClick={() => void applyAvailability()} disabled={disabled || isApplying || applyComplete}>
                            <CheckCircle2 aria-hidden="true" size={16} />
                            {isApplying ? 'Applying...' : applyComplete ? 'Availability applied' : 'Apply imported availability'}
                        </Button>
                    </div>
                </div>
            ) : null}
        </section>
    );
}
