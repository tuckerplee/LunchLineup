'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    buildStaffInvitationPayload,
    generateTemporaryPin,
    type StaffInvitationPayload,
    type StaffOnboardingMethod,
} from './staff-onboarding';

type InvitableRole = {
    id: string;
    name: string;
};

export type AddTeamMemberResult = {
    temporaryPin: string | null;
};

type AddTeamMemberFormProps = {
    roles: InvitableRole[];
    defaultRoleId: string;
    canChooseRole: boolean;
    emailInvitationAvailable: boolean;
    isLoading: boolean;
    invitationDelivery?: ReactNode;
    onSubmit: (
        payload: StaffInvitationPayload,
        method: StaffOnboardingMethod,
    ) => Promise<AddTeamMemberResult>;
};

type TemporaryCredentials = {
    name: string;
    username: string;
    pin: string;
};

const fieldStyle = {
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '0.55rem 0.6rem',
    background: '#fff',
    color: 'var(--text-primary)',
} as const;

export function AddTeamMemberForm({
    roles,
    defaultRoleId,
    canChooseRole,
    emailInvitationAvailable,
    isLoading,
    invitationDelivery,
    onSubmit,
}: AddTeamMemberFormProps) {
    const [method, setMethod] = useState<StaffOnboardingMethod>('pin');
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    const [pin, setPin] = useState('');
    const [roleId, setRoleId] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [credentials, setCredentials] = useState<TemporaryCredentials | null>(null);
    const [credentialsCopied, setCredentialsCopied] = useState(false);
    const [credentialsAcknowledged, setCredentialsAcknowledged] = useState(false);

    useEffect(() => {
        if (!roleId && defaultRoleId) setRoleId(defaultRoleId);
    }, [defaultRoleId, roleId]);

    useEffect(() => {
        if (!emailInvitationAvailable && method === 'email') {
            setMethod('pin');
            setEmail('');
            setError('Email invitations are unavailable. Use username and a temporary PIN.');
        }
    }, [emailInvitationAvailable, method]);

    const chooseMethod = (nextMethod: StaffOnboardingMethod) => {
        if (nextMethod === 'email' && !emailInvitationAvailable) return;
        setMethod(nextMethod);
        setError(null);
        setNotice(null);
        if (nextMethod === 'email') {
            setUsername('');
            setPin('');
        } else {
            setEmail('');
        }
    };

    const submit = async () => {
        if (!name.trim()) {
            setError('Full name is required.');
            return;
        }
        if (canChooseRole && !roleId) {
            setError('Choose a role.');
            return;
        }
        if (method === 'email') {
            if (!emailInvitationAvailable) {
                setError('Email invitations are unavailable. Use username and a temporary PIN.');
                return;
            }
            if (!email.trim()) {
                setError('Work email is required.');
                return;
            }
        } else {
            if (!/^[a-z0-9._-]{3,32}$/.test(username.trim())) {
                setError('Username must be 3–32 lowercase letters, numbers, dots, underscores, or hyphens.');
                return;
            }
            if (!/^\d{4,8}$/.test(pin)) {
                setError('Enter or generate a 4–8 digit temporary PIN.');
                return;
            }
        }

        const payload = buildStaffInvitationPayload({ method, name, email, username, pin, roleId });
        setIsSubmitting(true);
        setError(null);
        setNotice(null);
        try {
            const result = await onSubmit(payload, method);
            const submittedName = name.trim();
            const submittedUsername = username.trim();
            setName('');
            setEmail('');
            setUsername('');
            setPin('');

            if (method === 'pin' && result.temporaryPin) {
                setCredentials({
                    name: submittedName,
                    username: submittedUsername,
                    pin: result.temporaryPin,
                });
                setCredentialsCopied(false);
                setCredentialsAcknowledged(false);
            } else if (method === 'pin') {
                setNotice('Team member created, but no temporary PIN was returned. Reset the PIN from the member record before sharing access.');
            } else {
                setNotice('Email invitation created. Delivery status is shown below.');
            }
        } catch (submitError) {
            setError((submitError as Error).message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const copyTemporaryPin = async () => {
        if (!credentials) return;
        try {
            await navigator.clipboard.writeText(credentials.pin);
            setCredentialsCopied(true);
            setError(null);
        } catch {
            setCredentialsCopied(false);
            setError('The PIN could not be copied automatically. Select and copy it before continuing.');
        }
    };

    return (
        <div className="surface-muted staff-onboarding" style={{ padding: '0.9rem', display: 'grid', gap: '0.8rem' }}>
            <div>
                <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>Add team member</div>
                <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    Choose how this person will receive their first sign-in credentials.
                </p>
            </div>

            {credentials ? (
                <section className="staff-onboarding__credentials" role="dialog" aria-label="Save temporary credentials">
                    <div>
                        <strong>Save these temporary credentials</strong>
                        <p>{credentials.name} must change this PIN after signing in.</p>
                    </div>
                    <dl>
                        <div><dt>Username</dt><dd>{credentials.username}</dd></div>
                        <div><dt>Temporary PIN</dt><dd aria-label="Created temporary PIN">{credentials.pin}</dd></div>
                    </dl>
                    <Button type="button" variant="outline" size="sm" onClick={() => void copyTemporaryPin()}>
                        {credentialsCopied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
                        {credentialsCopied ? 'PIN copied' : 'Copy temporary PIN'}
                    </Button>
                    <label className="staff-onboarding__acknowledgement">
                        <input
                            type="checkbox"
                            checked={credentialsAcknowledged}
                            onChange={(event) => setCredentialsAcknowledged(event.target.checked)}
                        />
                        <span>I have copied and stored these credentials securely.</span>
                    </label>
                    <Button
                        type="button"
                        size="sm"
                        disabled={!credentialsAcknowledged}
                        onClick={() => {
                            setCredentials(null);
                            setNotice('Team member created. Temporary credentials were acknowledged.');
                        }}
                    >
                        Done
                    </Button>
                </section>
            ) : (
                <form
                    className="staff-invite-form"
                    aria-label="Add team member"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <fieldset className="staff-onboarding__methods">
                        <legend>Sign-in method</legend>
                        <label>
                            <input
                                type="radio"
                                name="staff-onboarding-method"
                                value="email"
                                checked={method === 'email'}
                                disabled={!emailInvitationAvailable}
                                onChange={() => chooseMethod('email')}
                            />
                            <span>
                                <strong>Email invitation</strong>
                                <small>{emailInvitationAvailable ? 'Send a one-time-password invitation.' : 'Unavailable in this environment.'}</small>
                            </span>
                        </label>
                        <label>
                            <input
                                type="radio"
                                name="staff-onboarding-method"
                                value="pin"
                                checked={method === 'pin'}
                                onChange={() => chooseMethod('pin')}
                            />
                            <span>
                                <strong>Username + temporary PIN</strong>
                                <small>Create credentials to share through a secure channel.</small>
                            </span>
                        </label>
                    </fieldset>

                    <div
                        className={emailInvitationAvailable ? 'staff-onboarding__availability staff-onboarding__availability--ready' : 'staff-onboarding__availability'}
                        role="status"
                        aria-label="Email invitation availability"
                    >
                        <strong>Email delivery: {emailInvitationAvailable ? 'Available' : 'Unavailable'}</strong>
                        <span>
                            {emailInvitationAvailable
                                ? 'Email invitations will be queued for delivery; confirm the delivery status after sending.'
                                : 'Email delivery is off or unconfirmed. Use username and a temporary PIN.'}
                        </span>
                    </div>

                    <div className="staff-onboarding__fields">
                        <label>
                            <span>Full name</span>
                            <input
                                type="text"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                aria-label="Full name"
                                autoComplete="name"
                                maxLength={200}
                                style={fieldStyle}
                            />
                        </label>
                        {canChooseRole ? (
                            <label>
                                <span>Access role</span>
                                <select
                                    aria-label="Role"
                                    value={roleId}
                                    onChange={(event) => setRoleId(event.target.value)}
                                    style={fieldStyle}
                                >
                                    {roles.map((role) => (
                                        <option key={role.id} value={role.id}>{role.name}</option>
                                    ))}
                                </select>
                            </label>
                        ) : null}
                        {method === 'email' ? (
                            <label className="staff-onboarding__wide-field">
                                <span>Work email</span>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(event) => setEmail(event.target.value)}
                                    aria-label="Work email"
                                    autoComplete="email"
                                    maxLength={320}
                                    style={fieldStyle}
                                />
                            </label>
                        ) : (
                            <>
                                <label>
                                    <span>Username</span>
                                    <input
                                        type="text"
                                        value={username}
                                        onChange={(event) => setUsername(event.target.value.toLowerCase())}
                                        aria-label="Username"
                                        autoComplete="off"
                                        minLength={3}
                                        maxLength={32}
                                        pattern="[a-z0-9._-]+"
                                        style={fieldStyle}
                                    />
                                </label>
                                <label>
                                    <span>Temporary PIN</span>
                                    <div className="staff-onboarding__pin-field">
                                        <input
                                            type="text"
                                            value={pin}
                                            onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                                            aria-label="Temporary PIN"
                                            autoComplete="off"
                                            inputMode="numeric"
                                            minLength={4}
                                            maxLength={8}
                                            pattern="\d{4,8}"
                                            style={fieldStyle}
                                        />
                                        <Button type="button" size="sm" variant="outline" onClick={() => setPin(generateTemporaryPin())}>
                                            <RefreshCw aria-hidden="true" size={14} />
                                            Generate PIN
                                        </Button>
                                    </div>
                                </label>
                            </>
                        )}
                    </div>

                    <div className="staff-onboarding__submit-row">
                        <Button type="submit" size="sm" disabled={isSubmitting || isLoading || roles.length === 0 && canChooseRole}>
                            {isSubmitting
                                ? (method === 'email' ? 'Sending...' : 'Creating...')
                                : (method === 'email' ? 'Send email invitation' : 'Create team member')}
                        </Button>
                    </div>
                </form>
            )}

            {error ? <div className="staff-onboarding__message staff-onboarding__message--error" role="alert">{error}</div> : null}
            {notice ? <div className="staff-onboarding__message" role="status">{notice}</div> : null}
            {invitationDelivery}
        </div>
    );
}
