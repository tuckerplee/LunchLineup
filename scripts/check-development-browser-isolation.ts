// Run in the disposable builder before application containers are started:
// npx tsx scripts/check-development-browser-isolation.ts <task-owned-receipt.json>
// All destinations in this regression are local synthetic HTTP fixtures.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium, request } from '@playwright/test';
import { QA_ORIGIN } from '../apps/web/tests/e2e/qa-isolation-policy';
import { QaIsolationGuard } from '../apps/web/tests/e2e/qa-isolation-controls';
import { qaBrowserLaunchOptions, startQaLoopbackProxy } from '../apps/web/tests/e2e/qa-loopback-proxy';

async function main() {
const output = process.argv[2];
if (!output) throw new Error('A task-owned isolation receipt path is required.');
const runId = process.env.CI_RUN_ID;
const sourceSha = process.env.CI_COMMIT_SHA;
if (!runId || !/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('CI_RUN_ID and an exact CI_COMMIT_SHA are required for the isolation receipt.');
const startedAt = new Date().toISOString();
const expectedCheckpointCount = 10;
let trapHits = 0;
let trapConnections = 0;
const trap = createServer((_req, res) => { trapHits += 1; res.end('DENIED TRAP WAS REACHED'); });
trap.on('connection', () => { trapConnections += 1; });
const listen = (server: Server, port: number) => new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); });
});
const close = (server: Server) => new Promise<void>(accept => { server.close(() => accept()); server.closeAllConnections(); });
await listen(trap, 0);
const trapOrigin = `http://127.0.0.1:${(trap.address() as AddressInfo).port}`;
const target = createServer((req, res) => {
    if (req.url === '/chain') { res.writeHead(302, { location: '/denied' }); res.end(); }
    else if (req.url === '/denied' || req.url === '/custom-continue' || req.url === '/custom-fallback') {
        res.writeHead(302, { location: `${trapOrigin}/trap` }); res.end();
    } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Local isolation fixture</title><p>Approved local response</p>'); }
});
const violations: string[] = [];
const guard = new QaIsolationGuard(violations);
const checkpoints: Array<{ case: string; deniedTrapHits: number; deniedTrapConnections: number }> = [];
const optionOverrideProof = { attempts: 3, rejectedBeforeCreation: 0, factoryCalls: 0, deniedTrapConnections: 0 };
let proxy: Awaited<ReturnType<typeof startQaLoopbackProxy>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let status = 'failed';
const checkpoint = (name: string) => {
    assert.equal(trapHits, 0, `${name}: denied local trap must receive zero requests`);
    assert.equal(trapConnections, 0, `${name}: denied local trap must receive zero TCP connections`);
    checkpoints.push({ case: name, deniedTrapHits: trapHits, deniedTrapConnections: trapConnections });
};
try {
    // Refuse an occupied application port; never test against an existing service.
    await listen(target, 8080);
    proxy = await startQaLoopbackProxy();
    browser = await chromium.launch(qaBrowserLaunchOptions({ headless: true }, proxy.evidence.listenOrigin));
    const context = await browser.newContext({ baseURL: QA_ORIGIN, serviceWorkers: 'block' });
    await guard.guardContext(context);
    const page = await context.newPage();
    await page.goto('/okay');
    assert.equal(await page.title(), 'Local isolation fixture');
    assert.ok(proxy.evidence.approvedConnects > 0, 'Guarded page fetch must prove the exact approved CONNECT transport');
    checkpoint('approved page request');
    await assert.rejects(page.goto('/denied', { timeout: 5000 }));
    checkpoint('terminal page redirect');
    await page.route('**/custom-continue', route => route.continue());
    await assert.rejects(page.goto('/custom-continue', { timeout: 5000 }));
    checkpoint('custom continue redirect');
    await page.route('**/custom-fallback', route => route.fallback());
    await assert.rejects(page.goto('/custom-fallback', { timeout: 5000 }));
    checkpoint('custom fallback redirect');
    const connectsBeforeApi = proxy.evidence.approvedConnects;
    assert.equal((await context.request.get('/okay')).status(), 200);
    assert.ok(proxy.evidence.approvedConnects > connectsBeforeApi, 'Guarded API request must prove the exact approved CONNECT transport');
    await assert.rejects(context.request.get('/denied'));
    await assert.rejects(context.request.get(`${trapOrigin}/trap`));
    checkpoint('context API redirect and direct denied destination');
    const independentApi = await guard.createApiContext(request.newContext.bind(request), { baseURL: QA_ORIGIN });
    try {
        await assert.rejects(independentApi.get('/denied'));
        const localRedirect = await independentApi.get('/chain');
        assert.equal(localRedirect.status(), 302);
        checkpoint('independent API never follows even an approved first redirect');
    } finally { await independentApi.dispose(); }
    const contextsBefore = browser.contexts().length;
    let rejectedFactoryCalls = 0;
    await assert.rejects(guard.createBrowserContext(async options => {
        rejectedFactoryCalls += 1; return browser!.newContext(options);
    }, { baseURL: QA_ORIGIN, proxy: { server: trapOrigin } }), /proxy overrides/);
    await assert.rejects(guard.createBrowserPage(async options => {
        rejectedFactoryCalls += 1; return browser!.newPage(options);
    }, { baseURL: QA_ORIGIN, proxy: { server: trapOrigin } }), /proxy overrides/);
    await assert.rejects(guard.createApiContext(async options => {
        rejectedFactoryCalls += 1; return request.newContext(options);
    }, { baseURL: QA_ORIGIN, proxy: { server: trapOrigin } }), /proxy overrides/);
    assert.equal(rejectedFactoryCalls, 0, 'Proxy overrides must be rejected before any context/page factory is called');
    assert.equal(browser.contexts().length, contextsBefore);
    optionOverrideProof.rejectedBeforeCreation = 3;
    optionOverrideProof.factoryCalls = rejectedFactoryCalls;
    optionOverrideProof.deniedTrapConnections = trapConnections;
    assert.equal(optionOverrideProof.deniedTrapConnections, 0);
    const independentContext = await guard.createBrowserContext(browser.newContext.bind(browser), { baseURL: QA_ORIGIN });
    const independentPage = await independentContext.newPage();
    await assert.rejects(independentPage.goto('/denied', { timeout: 5000 }));
    checkpoint('additional browser context redirect');
    // Intentionally omit route interception: prove the proxy independently stops
    // native multi-hop redirects, including Playwright's documented route gap.
    const nativeContext = await browser.newContext({ baseURL: QA_ORIGIN, serviceWorkers: 'block' });
    const nativePage = await nativeContext.newPage();
    const before = proxy.evidence.denials.length;
    const blocked = await nativePage.goto('/chain');
    assert.equal(blocked?.status(), 403);
    assert.ok(proxy.evidence.denials.length > before, 'Native redirect must be denied by the proxy');
    checkpoint('native multi-hop browser redirect independently blocked by proxy');
    const directBlock = await nativePage.goto(`${trapOrigin}/trap`);
    assert.equal(directBlock?.status(), 403);
    checkpoint('native direct denied destination independently blocked by proxy');
    const proxyUrl = new URL(proxy.evidence.listenOrigin);
    const connectStatus = await new Promise<number>((accept, reject) => {
        const attempt = httpRequest({ hostname: '127.0.0.1', port: proxyUrl.port,
            method: 'CONNECT', path: `127.0.0.1:${(trap.address() as AddressInfo).port}` });
        attempt.once('error', reject);
        attempt.once('connect', (response, socket) => { socket.destroy(); accept(response.statusCode ?? 0); });
        attempt.end();
    });
    assert.equal(connectStatus, 403);
    checkpoint('CONNECT cannot tunnel to the denied local trap');
    await context.close();
    await independentContext.close();
    await nativeContext.close();
    assert.ok(violations.length >= 6, 'Expected route/API denials must be retained as evidence');
    assert.equal(checkpoints.length, expectedCheckpointCount, 'Every isolation regression checkpoint must complete exactly once');
    status = 'passed';
} finally {
    const cleanup = await Promise.allSettled([browser?.close(), proxy?.close(), close(target), close(trap)]);
    const cleanupVerified = cleanup.every(result => result.status === 'fulfilled') && (proxy?.evidence.socketsClosed ?? true);
    if (!cleanupVerified) status = 'failed';
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, kind: 'disposable-development-browser-isolation-selftest',
        runId, sourceSha, status, releaseQualified: false, pid: process.pid, startedAt,
        approvedOrigin: QA_ORIGIN, deniedTrapOrigin: trapOrigin,
        expectedCheckpointCount, completedCheckpointCount: checkpoints.length,
        deniedTrapHits: trapHits, deniedTrapConnections: trapConnections, optionOverrideProof, checkpoints, violations, proxy: proxy?.evidence,
        cleanupVerified, ownedHarness: {
            syntheticTarget: { bindAddress: '127.0.0.1', port: 8080, serverClosed: !target.listening },
            deniedTrap: { bindAddress: '127.0.0.1', port: Number(new URL(trapOrigin).port), serverClosed: !trap.listening },
            browserClosed: browser ? !browser.isConnected() : true,
            proxyStoppedAt: proxy?.evidence.stoppedAt ?? null,
        }, completedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
    if (!cleanupVerified) throw new Error('Browser isolation regression cleanup failed; see retained receipt.');
}
}
void main().catch(failure => { console.error(failure); process.exitCode = 1; });
