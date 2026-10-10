'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchWithSession } from '@/lib/client-api';
import { jsonWriteInit } from '../time-cards/time-card-api';

type Identity = { id: string; name: string; username: string; email: string; identityVersion: string };
function requireSavedIdentity(payload: unknown, userId: string): Identity {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('The saved identity could not be confirmed. Reload the saved identity before continuing.');
  }
  const data = payload as Partial<Identity>;
  if (data.id !== userId || typeof data.name !== 'string' || !data.name.trim()
    || typeof data.username !== 'string' || typeof data.email !== 'string'
    || typeof data.identityVersion !== 'string' || !/^[a-f0-9]{64}$/.test(data.identityVersion)) {
    throw new Error('The saved identity could not be confirmed. Reload the saved identity before continuing.');
  }
  return data as Identity;
}

export function StaffIdentityEditor({ userId, onClose, onSaved }: { userId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [saved, setSaved] = useState<Identity | null>(null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setSaved(null);
    setError(null);
    setNotice(null);
    try {
      const response = await fetchWithSession(`/users/${userId}`);
      if (!response.ok) throw new Error('Unable to load the saved identity. Editing is unavailable.');
      const data = requireSavedIdentity(await response.json(), userId);
      setSaved(data); setName(data.name); setUsername(data.username);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load identity.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { heading.current?.scrollIntoView({ block: 'center' }); heading.current?.focus({ preventScroll: true }); void load(); }, [userId]);

  return <section className="surface-card" role="region" aria-label="Edit staff identity" style={{ padding: '1rem', display: 'grid', gap: '0.8rem' }}>
    <h2 ref={heading} tabIndex={-1}>Edit staff identity</h2>
    <p>Update the employee’s display name or username. Changing a username ends their active sessions.</p>
    <label style={{ display: 'grid', gap: 6 }}>Full name<input style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }} value={name} onChange={(e) => setName(e.target.value)} disabled={busy || !saved} maxLength={200} /></label>
    {saved?.username ? <label style={{ display: 'grid', gap: 6 }}>Username<input style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }} value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} maxLength={32} /></label> : null}
    {saved?.email ? <p>Email sign-in: {saved.email}. Email changes require a verified account recovery flow.</p> : null}
    {error ? <div role="alert">{error}</div> : null}
    {notice ? <div role="status">{notice}</div> : null}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button className="btn btn-primary" disabled={busy || !saved || !name.trim() || Boolean(saved.username && !username.trim())} onClick={async () => {
        if (!saved) return;
        setBusy(true); setError(null); setNotice(null);
        try {
          const response = await fetchWithSession(`/users/${userId}/identity`, jsonWriteInit('PUT', {
            name, username, email: saved.email, expectedVersion: saved.identityVersion,
          }));
          const data = await response.json();
          if (!response.ok) throw new Error(data.message ?? 'Identity save could not be confirmed. Retry unchanged values to reconcile it.');
          const confirmed = requireSavedIdentity(data, userId);
          setSaved(confirmed); setName(confirmed.name); setUsername(confirmed.username); setNotice('Staff identity saved.');
          await onSaved();
        } catch (err) { setError(err instanceof Error ? err.message : 'Identity save could not be confirmed.'); }
        finally { setBusy(false); }
      }}>Save identity</button>
      <button className="btn btn-secondary" disabled={busy} onClick={() => {
        if (!saved || (name === saved.name && username === saved.username) || window.confirm('Discard your edits and reload the saved identity?')) void load();
      }}>Reload saved identity</button>
      <button className="btn btn-secondary" disabled={busy} onClick={() => { if (!saved || (name === saved.name && username === saved.username) || window.confirm('Discard your unsaved identity edits?')) onClose(); }}>Close identity editor</button>
    </div>
  </section>;
}
