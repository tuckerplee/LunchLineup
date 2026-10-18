import type {
    AppMessage,
    AppMessagesApi,
    ClientEvent,
    ConfirmRequest,
    MessageLevel,
    MessageOptions,
    PendingDialog,
    PromptRequest,
} from './types';

export const MAX_VISIBLE_MESSAGES = 4;
export const DEFAULT_SUCCESS_DISMISS_MS = 6000;

const CODE_PATTERN = /^[a-z0-9_]+(?:\.[a-z0-9_]+){1,5}$/;
const DETAIL_PATTERN = /^[a-z0-9_.-]{1,48}$/;
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[0-9]+)$/i;

/** Replaces identifiers and unknown characters so a route is safe to track. */
export function trackableRoute(pathname: string): string {
    const path = pathname.split(/[?#]/, 1)[0] ?? '';
    const normalized = path
        .split('/')
        .map((segment) => (segment && ID_SEGMENT.test(segment) ? ':id' : segment.toLowerCase()))
        .join('/')
        .replace(/[^a-z0-9_:/-]/g, '')
        .slice(0, 128);
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/** Codes are developer-chosen literals; anything else is reported as a fixed placeholder. */
export function safeCode(code: string): string {
    return CODE_PATTERN.test(code) && code.length <= 96 ? code : 'ui.invalid_code';
}

function safeDetail(detail: string | undefined): string | undefined {
    return detail !== undefined && DETAIL_PATTERN.test(detail) ? detail : undefined;
}

export type MessageStoreOptions = {
    getRoute: () => string;
    /** Receives allow-listed tracking events. Must never throw into the UI. */
    report?: (event: ClientEvent) => void;
};

export type MessageStoreSnapshot = {
    messages: readonly AppMessage[];
    dialog: PendingDialog | null;
};

type DialogEntry = { dialog: PendingDialog; resolve: (value: unknown) => void };

/**
 * Framework-free state for the message system. The React provider only
 * subscribes to this; tests drive it directly.
 */
export class MessageStore {
    private messages: AppMessage[] = [];
    private queue: DialogEntry[] = [];
    private active: DialogEntry | null = null;
    private nextId = 1;
    private listeners = new Set<() => void>();
    private snapshot: MessageStoreSnapshot = { messages: [], dialog: null };
    private readonly getRoute: () => string;
    private readonly reporter?: (event: ClientEvent) => void;

    constructor(options: MessageStoreOptions) {
        this.getRoute = options.getRoute;
        this.reporter = options.report;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    getSnapshot = (): MessageStoreSnapshot => this.snapshot;

    private publish(): void {
        this.snapshot = { messages: [...this.messages], dialog: this.active?.dialog ?? null };
        for (const listener of this.listeners) listener();
    }

    private track(event: Omit<ClientEvent, 'route'>): void {
        try {
            const detail = safeDetail(event.detail);
            this.reporter?.({
                code: event.code,
                level: event.level,
                kind: event.kind,
                route: trackableRoute(this.getRoute()),
                ...(event.outcome ? { outcome: event.outcome } : {}),
                ...(detail ? { detail } : {}),
            });
        } catch {
            // Tracking is best effort and must never affect the workflow.
        }
    }

    add(level: MessageLevel, code: string, text: string, options: MessageOptions = {}): number {
        const trackedCode = safeCode(code);
        const existing = this.messages.find((message) => message.code === trackedCode && message.text === text);
        const autoDismissMs = level === 'success'
            ? Math.max(0, options.autoDismissMs ?? DEFAULT_SUCCESS_DISMISS_MS)
            : 0;
        const id = existing?.id ?? this.nextId++;
        const message: AppMessage = {
            id,
            code: trackedCode,
            level,
            text,
            route: trackableRoute(this.getRoute()),
            autoDismissMs,
            persistAcrossRoutes: options.persistAcrossRoutes ?? false,
            ...(options.action ? { action: options.action } : {}),
        };
        this.messages = existing
            ? this.messages.map((entry) => (entry.id === id ? message : entry))
            : [...this.messages, message].slice(-MAX_VISIBLE_MESSAGES);
        this.track({ code: trackedCode, level, kind: 'message', detail: options.detail });
        this.publish();
        return id;
    }

    dismiss(id: number): void {
        const next = this.messages.filter((message) => message.id !== id);
        if (next.length === this.messages.length) return;
        this.messages = next;
        this.publish();
    }

    dismissCode(code: string): void {
        const next = this.messages.filter((message) => message.code !== code);
        if (next.length === this.messages.length) return;
        this.messages = next;
        this.publish();
    }

    /** Called on route change: transient messages do not follow the user to another page. */
    clearForNavigation(): void {
        const next = this.messages.filter((message) => message.persistAcrossRoutes);
        if (next.length === this.messages.length) return;
        this.messages = next;
        this.publish();
    }

    private open<T>(dialog: { kind: 'confirm'; request: ConfirmRequest } | { kind: 'prompt'; request: PromptRequest }): Promise<T> {
        return new Promise<T>((resolve) => {
            const entry: DialogEntry = {
                dialog: { ...dialog, id: this.nextId++ } as PendingDialog,
                resolve: resolve as (value: unknown) => void,
            };
            if (this.active) this.queue.push(entry);
            else {
                this.active = entry;
                this.publish();
            }
        });
    }

    private settle(id: number, value: unknown, confirmed: boolean): void {
        const entry = this.active;
        if (!entry || entry.dialog.id !== id) return;
        const { request, kind } = entry.dialog;
        this.track({
            code: safeCode(request.code),
            level: request.tone === 'danger' ? 'warning' : 'info',
            kind,
            outcome: confirmed ? 'confirmed' : 'cancelled',
        });
        this.active = this.queue.shift() ?? null;
        this.publish();
        entry.resolve(value);
    }

    confirmAction(request: ConfirmRequest): Promise<boolean> {
        return this.open<boolean>({ kind: 'confirm', request });
    }

    promptAction(request: PromptRequest): Promise<string | null> {
        return this.open<string | null>({ kind: 'prompt', request });
    }

    /** Resolves the active dialog. Called by the dialog views. */
    resolveConfirm(id: number, confirmed: boolean): void {
        this.settle(id, confirmed, confirmed);
    }

    resolvePrompt(id: number, value: string | null): void {
        this.settle(id, value, value !== null);
    }

    api(): AppMessagesApi {
        return {
            success: (code, text, options) => this.add('success', code, text, options),
            info: (code, text, options) => this.add('info', code, text, options),
            warning: (code, text, options) => this.add('warning', code, text, options),
            error: (code, text, options) => this.add('error', code, text, options),
            dismiss: (id) => this.dismiss(id),
            dismissCode: (code) => this.dismissCode(code),
            confirmAction: (request) => this.confirmAction(request),
            promptAction: (request) => this.promptAction(request),
        };
    }
}
