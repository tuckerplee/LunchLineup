/** Shared types for the single app message system. See lib/messages/README.md. */

export type MessageLevel = 'success' | 'info' | 'warning' | 'error';
export type MessageKind = 'message' | 'confirm' | 'prompt';
export type MessageOutcome = 'confirmed' | 'cancelled';

export type MessageAction = {
    label: string;
    /** Same-origin path only (for example the Billing settings link). */
    href: string;
};

export type MessageOptions = {
    /** Short non-PII reason key for tracking, for example `payment_required`. Never free text. */
    detail?: string;
    /** Optional inline link, such as the Billing link on a real payment-required block. */
    action?: MessageAction;
    /** Success messages auto-dismiss by default; pass 0 to keep one, or a number of ms. Ignored for other levels. */
    autoDismissMs?: number;
    /** Keep the message when the route changes. */
    persistAcrossRoutes?: boolean;
};

export type AppMessage = {
    id: number;
    code: string;
    level: MessageLevel;
    text: string;
    route: string;
    action?: MessageAction;
    autoDismissMs: number;
    persistAcrossRoutes: boolean;
};

export type ConfirmRequest = {
    /** Stable tracking code, for example `staff.remove.confirm`. */
    code: string;
    title: string;
    body: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'default' | 'danger';
};

export type PromptRequest = {
    code: string;
    title: string;
    body?: string;
    label: string;
    defaultValue?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    inputType?: 'text' | 'password' | 'number';
    tone?: 'default' | 'danger';
    /** Returns an inline error string, or null when the value is acceptable. */
    validate?: (value: string) => string | null;
};

export type PendingDialog =
    | { id: number; kind: 'confirm'; request: ConfirmRequest }
    | { id: number; kind: 'prompt'; request: PromptRequest };

/** The bounded, allow-listed tracking record. It never carries message text. */
export type ClientEvent = {
    code: string;
    level: MessageLevel;
    kind: MessageKind;
    route: string;
    outcome?: MessageOutcome;
    detail?: string;
};

export type AppMessagesApi = {
    success(code: string, text: string, options?: MessageOptions): number;
    info(code: string, text: string, options?: MessageOptions): number;
    warning(code: string, text: string, options?: MessageOptions): number;
    error(code: string, text: string, options?: MessageOptions): number;
    dismiss(id: number): void;
    /** Removes every message for a code (for example when a retry succeeds). */
    dismissCode(code: string): void;
    confirmAction(request: ConfirmRequest): Promise<boolean>;
    /** Resolves to the entered value, or null when cancelled. */
    promptAction(request: PromptRequest): Promise<string | null>;
};
