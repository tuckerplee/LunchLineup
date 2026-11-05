'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StaffLifecycleResponse, StaffMember } from '@lunchlineup/api-contract';
import { Button } from '@/components/ui/button';
import { fetchJsonWithSession } from '@/lib/client-api';

export function StaffLifecyclePanel({ userId, onChanged }: {
    userId: string;
    onChanged: (user: StaffMember) => void;
}) {
    const [record, setRecord] = useState<StaffLifecycleResponse | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [notice, setNotice] = useState('');
    const operation = useRef(0);
    const inFlight = useRef(false);
    const read = useCallback(() => fetchJsonWithSession<StaffLifecycleResponse>(`/users/${userId}/lifecycle`), [userId]);

    const load = useCallback(async () => {
        const token = ++operation.current;
        setBusy(true);
        setConfirm(false);
        try {
            const result = await read();
            if (operation.current !== token) return;
            setRecord(result);
            setNotice('');
        } catch {
            if (operation.current !== token) return;
            setRecord(null);
            setNotice('Unable to read account state. Retry before changing access.');
        } finally {
            if (operation.current === token) setBusy(false);
        }
    }, [read]);

    useEffect(() => {
        void load();
        return () => { operation.current += 1; };
    }, [load]);

    const save = async () => {
        if (!record || inFlight.current) return;
        inFlight.current = true;
        const token = ++operation.current;
        const suspended = !record.user.suspendedAt;
        setBusy(true);
        setConfirm(false);
        setNotice('Saving account state…');
        try {
            const result = await fetchJsonWithSession<StaffLifecycleResponse>(`/users/${userId}/lifecycle`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ suspended, expectedSuspendedAt: record.user.suspendedAt ?? null }),
            });
            if (operation.current !== token) return;
            setRecord(result);
            onChanged(result.user);
            setNotice(suspended ? 'Deactivated. Identity and history are preserved. Review the assignments below.' : 'Reactivated. A fresh sign-in is required.');
        } catch {
            if (operation.current !== token) return;
            // A failed transport does not establish whether the mutation committed.
            setRecord(null);
            setNotice('Outcome unknown. Checking the saved account state…');
            try {
                const result = await read();
                if (operation.current !== token) return;
                setRecord(result);
                onChanged(result.user);
                setNotice(Boolean(result.user.suspendedAt) === suspended
                    ? 'The requested account state is confirmed by a fresh read.'
                    : 'The requested state is not confirmed. Review the current state before another action.');
            } catch {
                if (operation.current === token) setNotice('Outcome unknown. Account actions are disabled until Retry can read the saved state.');
            }
        } finally {
            inFlight.current = false;
            if (operation.current === token) setBusy(false);
        }
    };

    return <section aria-label="Employee account status">
        <h3>Account status</h3>
        {notice ? <p role="status">{notice}</p> : null}
        {!record ? <Button disabled={busy} onClick={() => void load()}>{busy ? 'Checking…' : 'Retry account status'}</Button> : <>
            <p>{record.user.suspendedAt ? 'Inactive — access is suspended.' : 'Active'}</p>
            <p>Deactivation preserves identity, skills, time cards and payroll history. Existing assignments stay in place for manager resolution.</p>
            {confirm ? <div>
                <p>{record.user.suspendedAt
                    ? 'Restore eligibility? Previous sessions will remain revoked; this employee must sign in again.'
                    : 'Revoke access and sessions now? Review and resolve the existing assignments below.'}</p>
                <Button disabled={busy} onClick={() => void save()}>{record.user.suspendedAt ? 'Confirm reactivation' : 'Confirm deactivation'}</Button>
                <Button disabled={busy} variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            </div> : <Button disabled={busy} onClick={() => setConfirm(true)}>{record.user.suspendedAt ? 'Reactivate employee' : 'Deactivate employee'}</Button>}
            <h4>Current and future assignments ({record.futureAssignmentCount})</h4>
            <p>Use the calendar to resolve assignments explicitly. Published schedules retain their existing protection.</p>
            <a href="/dashboard/scheduling">Open calendar</a>
            <ul>{record.futureAssignments.map(shift => <li key={shift.id}>
                {shift.locationName}: {new Date(shift.startTime).toLocaleString(undefined, { timeZone: shift.timezone })}
                {' → '}{new Date(shift.endTime).toLocaleString(undefined, { timeZone: shift.timezone })}
                {' '}({shift.timezone}; {shift.scheduleStatus ?? 'Unpublished shift'})
            </li>)}</ul>
            {record.futureAssignmentCount > record.futureAssignments.length ? <p>Showing the first 100 assignments. Review the remaining assignments in the calendar.</p> : null}
        </>}
    </section>;
}
