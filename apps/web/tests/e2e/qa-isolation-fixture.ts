import { test as base, expect, request as requestFactory, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QA_ORIGIN, requireQaBaseUrl, requireQaContextOptions } from './qa-isolation-policy';
import { QaIsolationGuard } from './qa-isolation-controls';
import { qaBrowserLaunchOptions, startQaLoopbackProxy } from './qa-loopback-proxy';

export { expect };
export type { Page, Route } from '@playwright/test';

let proxyEvidence: Awaited<ReturnType<typeof startQaLoopbackProxy>>['evidence'] | undefined;
const workerViolations: string[] = [];
const workerGuard = new QaIsolationGuard(workerViolations);
// Leave the built-in browser fixture completely unchanged outside development QA.
const isolatedBase = process.env.LUNCHLINEUP_DEVELOPMENT_QA === '1' ? base.extend<{}, { qaFactoryOptions: void }>({
    // Worker auto fixtures run before any default test request/context fixture.
    qaFactoryOptions: [async ({ playwright }, use) => {
        const original = playwright.request.newContext.bind(playwright.request);
        playwright.request.newContext = options => workerGuard.createApiContext(original, options);
        try { await use(); }
        finally { playwright.request.newContext = original; }
    }, { scope: 'worker', auto: true }],
    // Validate public project/test.use proxy settings before normal context or
    // API fixture construction. Factory checks below remain authoritative too.
    proxy: async ({ proxy }, use) => {
        workerGuard.enforce(() => requireQaContextOptions({ proxy }));
        await use(undefined);
    },
    browser: [async ({ playwright, browserName, launchOptions }, use, workerInfo) => {
        if (browserName !== 'chromium') throw new Error('Disposable development QA requires the contained Chromium harness.');
        const proxy = await startQaLoopbackProxy();
        proxyEvidence = proxy.evidence;
        let browser;
        try {
            browser = await playwright.chromium.launch(workerGuard.enforce(() => qaBrowserLaunchOptions(launchOptions, proxy.evidence.listenOrigin)));
            const originalContext = browser.newContext.bind(browser);
            const originalPage = browser.newPage.bind(browser);
            browser.newContext = options => workerGuard.createBrowserContext(originalContext, options);
            browser.newPage = options => workerGuard.createBrowserPage(originalPage, options);
            await use(browser);
        } finally {
            try { await browser?.close(); }
            finally {
                try { await proxy.close(); }
                finally {
                    await mkdir(workerInfo.project.outputDir, { recursive: true });
                    await writeFile(join(workerInfo.project.outputDir, `qa-loopback-proxy-${workerInfo.workerIndex}.json`), JSON.stringify({ ...proxy.evidence, policyDenials: workerViolations }, null, 2));
                }
            }
        }
    }, { scope: 'worker' }],
}) : base;

export const test = isolatedBase.extend<{ qaIsolation: void }>({
    qaIsolation: [async ({ browser, context, request, baseURL }, use, testInfo) => {
        if (process.env.LUNCHLINEUP_DEVELOPMENT_QA !== '1') { await use(); return; }
        requireQaBaseUrl(baseURL);
        const violations = workerViolations;
        const guard = workerGuard;
        const extraContexts: BrowserContext[] = [];
        const extraRequests: APIRequestContext[] = [];
        guard.guardApi(request);
        await guard.guardContext(context);
        const newContext = browser.newContext.bind(browser);
        const newPage = browser.newPage.bind(browser);
        const newApiContext = requestFactory.newContext.bind(requestFactory);
        browser.newContext = async (options = {}) => {
            const created = await guard.createBrowserContext(newContext, options);
            extraContexts.push(created);
            await guard.guardContext(created);
            return created;
        };
        browser.newPage = async (options = {}) => {
            const created = await guard.createBrowserPage(newPage, options);
            extraContexts.push(created.context());
            await guard.guardContext(created.context());
            return created;
        };
        requestFactory.newContext = async (options = {}) => {
            const created = await guard.createApiContext(newApiContext, options);
            extraRequests.push(created);
            guard.guardApi(created);
            return created;
        };
        try { await use(); }
        finally {
            const closed = await Promise.allSettled([
                ...extraContexts.map(created => created.close()),
                ...extraRequests.map(created => created.dispose()),
            ]);
            if (closed.some(result => result.status === 'rejected')) violations.push('QA isolation could not close an owned additional context.');
            browser.newContext = newContext;
            browser.newPage = newPage;
            requestFactory.newContext = newApiContext;
            const denials = proxyEvidence?.denials ?? [];
            if (violations.length || denials.length) {
                await testInfo.attach('qa-isolation-violations', { body: JSON.stringify({ approvedOrigin: QA_ORIGIN, violations, proxy: proxyEvidence }, null, 2), contentType: 'application/json' });
                throw new Error(`Disposable QA blocked ${violations.length + denials.length} unapproved request(s); see isolation evidence.`);
            }
        }
    }, { auto: true }],
});
