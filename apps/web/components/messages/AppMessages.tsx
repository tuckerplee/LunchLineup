'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type FormEvent,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { useDialogFocus } from '@/components/ui/use-dialog-focus';
import { createClientEventReporter } from '@/lib/messages/reporter';
import { MessageStore } from '@/lib/messages/store';
import type {
    AppMessage,
    AppMessagesApi,
    ConfirmRequest,
    MessageLevel,
    MessageOptions,
    PromptRequest,
} from '@/lib/messages/types';

const AppMessagesContext = createContext<{ api: AppMessagesApi; store: MessageStore } | null>(null);

/** THE way to show a user message, confirmation or prompt. See lib/messages/README.md. */
export function useAppMessages(): AppMessagesApi {
    const context = useContext(AppMessagesContext);
    if (!context) throw new Error('useAppMessages must be used inside AppMessagesProvider (mounted by the dashboard and admin layouts).');
    return context.api;
}

/**
 * Bridges an existing piece of component state (an error or notice string) into
 * the message region: the text appears when set and is dismissed when cleared.
 */
export function useStatusMessage(
    level: MessageLevel,
    code: string,
    text: string | null | undefined,
    options?: MessageOptions,
): void {
    const messages = useAppMessages();
    const optionsRef = useRef(options);
    optionsRef.current = options;
    useEffect(() => {
        if (!text) {
            messages.dismissCode(code);
            return;
        }
        messages[level](code, text, optionsRef.current);
    }, [messages, level, code, text]);
}

function MessageItem({ message, onDismiss }: { message: AppMessage; onDismiss: (id: number) => void }) {
    useEffect(() => {
        if (message.autoDismissMs <= 0) return undefined;
        const timer = setTimeout(() => onDismiss(message.id), message.autoDismissMs);
        return () => clearTimeout(timer);
    }, [message, onDismiss]);

    return (
        <div
            className={`app-message app-message--${message.level}`}
            data-message-code={message.code}
        >
            <span className="app-message__text">{message.text}</span>
            {message.action ? (
                <Link className="app-message__action" href={message.action.href}>{message.action.label}</Link>
            ) : null}
            <button
                type="button"
                className="app-message__dismiss"
                aria-label="Dismiss message"
                onClick={() => onDismiss(message.id)}
            >
                <span aria-hidden="true">&times;</span>
            </button>
        </div>
    );
}

/**
 * The one consistent message region. Both live regions are always rendered so
 * assistive technology observes content added later: errors are assertive,
 * everything else is polite.
 */
export function MessageList({ messages, onDismiss }: { messages: readonly AppMessage[]; onDismiss: (id: number) => void }) {
    const errors = messages.filter((message) => message.level === 'error');
    const others = messages.filter((message) => message.level !== 'error');
    return (
        <div className="app-messages" data-app-messages="">
            <div role="status" aria-live="polite" aria-atomic="false" aria-label="Notifications">
                {others.map((message) => <MessageItem key={message.id} message={message} onDismiss={onDismiss} />)}
            </div>
            <div role="alert" aria-live="assertive" aria-atomic="false" aria-label="Errors">
                {errors.map((message) => <MessageItem key={message.id} message={message} onDismiss={onDismiss} />)}
            </div>
        </div>
    );
}

function DialogShell({
    request,
    onCancel,
    children,
}: {
    request: ConfirmRequest | PromptRequest;
    onCancel: () => void;
    children: ReactNode;
}) {
    const titleId = useId();
    const bodyId = useId();
    const { dialogRef, captureTrigger } = useDialogFocus(true);
    useState(() => {
        // The opener still has focus during the first render, before autoFocus runs.
        if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
            captureTrigger(document.activeElement);
        }
        return null;
    });
    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
        }
    };
    const body = request.body;
    return (
        <div className="staff-confirmation-backdrop" role="presentation">
            <div
                ref={dialogRef}
                tabIndex={-1}
                className="staff-confirmation-dialog app-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={body ? bodyId : undefined}
                onKeyDown={onKeyDown}
            >
                <div>
                    <h2 id={titleId}>{request.title}</h2>
                    {body ? <p id={bodyId}>{body}</p> : null}
                </div>
                {children}
            </div>
        </div>
    );
}

export function ConfirmDialogView({ request, onResolve }: { request: ConfirmRequest; onResolve: (confirmed: boolean) => void }) {
    return (
        <DialogShell request={request} onCancel={() => onResolve(false)}>
            <div className="staff-confirmation-actions">
                <Button type="button" variant="outline" onClick={() => onResolve(false)} autoFocus>
                    {request.cancelLabel ?? 'Cancel'}
                </Button>
                <Button
                    type="button"
                    variant={request.tone === 'danger' ? 'destructive' : 'default'}
                    onClick={() => onResolve(true)}
                >
                    {request.confirmLabel ?? 'Confirm'}
                </Button>
            </div>
        </DialogShell>
    );
}

export function PromptDialogView({ request, onResolve }: { request: PromptRequest; onResolve: (value: string | null) => void }) {
    const [value, setValue] = useState(request.defaultValue ?? '');
    const [error, setError] = useState<string | null>(null);
    const inputId = useId();
    const errorId = useId();
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const problem = request.validate?.(value) ?? null;
        if (problem) {
            setError(problem);
            return;
        }
        onResolve(value);
    };
    return (
        <DialogShell request={request} onCancel={() => onResolve(null)}>
            <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 20 }}>
            <label htmlFor={inputId} style={{ display: 'grid', gap: '0.35rem', fontSize: '0.8rem', fontWeight: 700 }}>
                {request.label}
                <input
                    id={inputId}
                    className="app-dialog__input"
                    type={request.inputType ?? 'text'}
                    value={value}
                    autoFocus
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    onChange={(event) => { setValue(event.target.value); setError(null); }}
                />
            </label>
            {error ? <p id={errorId} role="alert" className="app-dialog__error">{error}</p> : null}
            <div className="staff-confirmation-actions">
                <Button type="button" variant="outline" onClick={() => onResolve(null)}>
                    {request.cancelLabel ?? 'Cancel'}
                </Button>
                <Button type="submit" variant={request.tone === 'danger' ? 'destructive' : 'default'}>
                    {request.confirmLabel ?? 'Confirm'}
                </Button>
            </div>
            </form>
        </DialogShell>
    );
}

export function AppMessagesProvider({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const reporterRef = useRef<ReturnType<typeof createClientEventReporter> | null>(null);
    const store = useMemo(() => {
        reporterRef.current ??= createClientEventReporter();
        const reporter = reporterRef.current;
        return new MessageStore({
            getRoute: () => (typeof window === 'undefined' ? '/' : window.location.pathname),
            report: (event) => reporter.report(event),
        });
    }, []);
    const value = useMemo(() => ({ api: store.api(), store }), [store]);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

    const firstPath = useRef(pathname);
    useEffect(() => {
        if (firstPath.current === pathname) return;
        firstPath.current = pathname;
        store.clearForNavigation();
    }, [pathname, store]);

    useEffect(() => {
        const flush = () => reporterRef.current?.flush();
        const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.removeEventListener('pagehide', flush);
            document.removeEventListener('visibilitychange', onVisibility);
            flush();
        };
    }, []);

    const dismiss = useCallback((id: number) => store.dismiss(id), [store]);
    const dialog = snapshot.dialog;

    return (
        <AppMessagesContext.Provider value={value}>
            <MessageList messages={snapshot.messages} onDismiss={dismiss} />
            {children}
            {dialog?.kind === 'confirm' ? (
                <ConfirmDialogView
                    key={dialog.id}
                    request={dialog.request}
                    onResolve={(confirmed) => store.resolveConfirm(dialog.id, confirmed)}
                />
            ) : null}
            {dialog?.kind === 'prompt' ? (
                <PromptDialogView
                    key={dialog.id}
                    request={dialog.request}
                    onResolve={(result) => store.resolvePrompt(dialog.id, result)}
                />
            ) : null}
        </AppMessagesContext.Provider>
    );
}
