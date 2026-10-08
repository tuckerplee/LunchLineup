import type { APIRequest, APIRequestContext, APIResponse, Browser, BrowserContext, Page, Route } from '@playwright/test';
import { QA_ORIGIN, requireQaBaseUrl, requireQaContextOptions, requireQaResponse, requireQaUrl } from './qa-isolation-policy';

type RouteLifecycle = { closing: boolean; pending: Set<Promise<unknown>>; failures: unknown[] };
const ROUTE_DRAIN_TIMEOUT_MS = 5_000;

export class QaIsolationGuard {
    private readonly contexts = new WeakSet<BrowserContext>();
    private readonly pages = new WeakSet<Page>();
    private readonly apis = new WeakSet<APIRequestContext>();
    private readonly isolationFailures = new WeakSet<object>();
    private readonly lifecycles = new WeakMap<BrowserContext | Page, RouteLifecycle>();
    constructor(readonly violations: string[]) {}

    private lifecycle(owner: BrowserContext | Page): RouteLifecycle {
        let state = this.lifecycles.get(owner);
        if (!state) {
            state = { closing: false, pending: new Set(), failures: [] };
            this.lifecycles.set(owner, state);
        }
        return state;
    }
    private async drain(owner: BrowserContext | Page): Promise<void> {
        const state = this.lifecycle(owner);
        state.closing = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                (async () => {
                    // Include authorized late arrivals being aborted after the
                    // closing flag, rather than only the initial snapshot.
                    while (state.pending.size) await Promise.allSettled([...state.pending]);
                })(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('QA isolation route drain exceeded its 5-second deadline.')), ROUTE_DRAIN_TIMEOUT_MS);
                }),
            ]);
        } finally { clearTimeout(timer); }
        if (state.failures.length) throw new AggregateError(state.failures, 'QA isolation route handler failed.');
    }
    async drainContext(context: BrowserContext): Promise<void> {
        await this.drain(context);
    }
    private guardClose(owner: BrowserContext | Page): void {
        const original = owner.close.bind(owner);
        Object.defineProperty(owner, 'close', { configurable: true, value: async (...args: Parameters<typeof original>) => {
            const failures: unknown[] = [];
            try { await this.drain(owner); } catch (failure) { failures.push(failure); }
            try { await original(...args); } catch (failure) { failures.push(failure); }
            if (failures.length) throw new AggregateError(failures, 'QA isolation could not drain and close an owned context or page.');
        } });
    }

    async createBrowserContext(create: Browser['newContext'], options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
        this.enforce(() => requireQaContextOptions(options));
        this.enforce(() => requireQaBaseUrl(options.baseURL ?? QA_ORIGIN));
        const context = await create({ ...options, baseURL: QA_ORIGIN, serviceWorkers: 'block' });
        await this.guardContext(context);
        return context;
    }
    async createApiContext(create: APIRequest['newContext'], options: Parameters<APIRequest['newContext']>[0] = {}): Promise<APIRequestContext> {
        this.enforce(() => requireQaContextOptions(options));
        this.enforce(() => requireQaBaseUrl(options.baseURL ?? QA_ORIGIN));
        const context = await create({ ...options, baseURL: QA_ORIGIN, maxRedirects: 0 });
        this.guardApi(context);
        return context;
    }
    async createBrowserPage(create: Browser['newPage'], options: Parameters<Browser['newPage']>[0] = {}): Promise<Page> {
        this.enforce(() => requireQaContextOptions(options));
        this.enforce(() => requireQaBaseUrl(options.baseURL ?? QA_ORIGIN));
        const page = await create({ ...options, baseURL: QA_ORIGIN, serviceWorkers: 'block' });
        await this.guardContext(page.context());
        return page;
    }

    enforce<T>(action: () => T): T {
        try { return action(); }
        catch (failure) {
            if (failure !== null && typeof failure === 'object') this.isolationFailures.add(failure);
            this.violations.push(failure instanceof Error ? failure.message : 'QA isolation denied a request.');
            throw failure;
        }
    }
    private response(response: APIResponse): APIResponse {
        this.enforce(() => requireQaResponse(response.url(), response.status(), response.headers().location));
        return response;
    }
    guardApi(api: APIRequestContext): void {
        if (this.apis.has(api)) return;
        this.apis.add(api);
        for (const verb of ['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head'] as const) {
            const original = api[verb].bind(api);
            Object.defineProperty(api, verb, { configurable: true, value: async (input: string | { url(): string }, options: Record<string, unknown> = {}) => {
                const url = typeof input === 'string' ? input : input.url();
                this.enforce(() => requireQaUrl(url));
                return this.response(await original(input as string, { ...options, maxRedirects: 0 }));
            } });
        }
    }
    private route(route: Route): Route {
        const thisGuard = this;
        const checkedFetch = async (options: Parameters<Route['fetch']>[0] = {}) => {
            this.enforce(() => requireQaUrl(options.url ?? route.request().url()));
            return this.response(await route.fetch({ ...options, maxRedirects: 0 }));
        };
        return new Proxy(route, {
            get(target, property) {
                if (property === 'fetch') return checkedFetch;
                // Native continue can follow redirects without another route
                // callback. Interpose a checked fetch before delivering anything.
                if (property === 'continue') return async (options: Parameters<Route['continue']>[0] = {}) => {
                    const response = await checkedFetch(options);
                    await target.fulfill({ response });
                };
                if (property === 'fallback') return async (options: Parameters<Route['fallback']>[0] = {}) => {
                    thisGuard.enforce(() => requireQaUrl(options.url ?? target.request().url()));
                    return target.fallback(options);
                };
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    }
    private guardRoutes(owner: BrowserContext | Page): void {
        const originalRoute = owner.route.bind(owner);
        const originalUnroute = owner.unroute.bind(owner);
        const handlers = new WeakMap<(...args: any[]) => unknown, (...args: any[]) => unknown>();
        Object.defineProperty(owner, 'route', { configurable: true, value: async (pattern: any, handler: any, options?: any) => {
            const wrapped = (route: Route, request: any) => {
                const states = [this.lifecycle(owner)];
                // Context routes also belong to the requesting page. Draining a
                // page must not close admission for other pages in that context.
                try {
                    const page = route.request().frame().page();
                    const context = page.context();
                    for (const state of [this.lifecycle(page), this.lifecycle(context)]) {
                        if (!states.includes(state)) states.push(state);
                    }
                } catch { /* Frameless requests still belong to the guarded owner. */ }
                const task = (async () => {
                    try {
                        this.enforce(() => requireQaUrl(route.request().url()));
                        if (states.some(state => state.closing)) {
                            // An approved request cancelled by owned teardown is
                            // a lifecycle abort, not a security-policy denial.
                            // URL checks and denied-request handling stay active.
                            await route.abort('aborted');
                            return;
                        }
                        return await handler(this.route(route), request);
                    } catch (failure) {
                        await route.abort('blockedbyclient').catch(() => undefined);
                        // Only isolation violations are handled through retained
                        // teardown evidence. Genuine test/assertion failures propagate.
                        if (failure === null || typeof failure !== 'object' || !this.isolationFailures.has(failure)) throw failure;
                    }
                })();
                for (const state of states) state.pending.add(task);
                void task.then(
                    () => { for (const state of states) state.pending.delete(task); },
                    failure => { for (const state of states) { state.pending.delete(task); state.failures.push(failure); } },
                );
                return task;
            };
            handlers.set(handler, wrapped);
            return originalRoute(pattern, wrapped, options);
        } });
        Object.defineProperty(owner, 'unroute', { configurable: true, value: (pattern: any, handler?: any) => originalUnroute(pattern, handler ? handlers.get(handler) ?? handler : undefined) });
    }
    private guardPage(page: Page): void {
        if (this.pages.has(page)) return;
        this.pages.add(page);
        this.guardClose(page);
        this.guardRoutes(page);
        this.guardApi(page.request);
    }
    async guardContext(context: BrowserContext): Promise<void> {
        if (this.contexts.has(context)) return;
        this.contexts.add(context);
        this.guardClose(context);
        this.guardApi(context.request);
        this.guardRoutes(context);
        context.on('page', page => this.guardPage(page));
        context.pages().forEach(page => this.guardPage(page));
        // This is the terminal network handler; custom fallback chains reach it.
        await context.route('**/*', route => route.continue());
        await context.routeWebSocket('**/*', socket => {
            this.violations.push('QA isolation denied unexpected WebSocket traffic.');
            socket.close({ code: 1008, reason: 'Disposable QA forbids WebSockets' });
        });
    }
}
