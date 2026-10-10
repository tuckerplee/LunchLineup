import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { consumePersistentCancellationObserverPermit } from '../admin/persistent-export-consumer';
import type { TenantSubscriptionCancellationResult } from './stripe.service';

const OPERATION_METADATA = 'lunchlineupCancellationOperationId';
const API_VERSION = '2024-04-10';
const MAX_RESPONSE_BYTES = 65536;

export type SelectedCancellationObservationReceipt = {
    tenantId: string; operationId: string; customerId: string | null;
    outcome: TenantSubscriptionCancellationResult;
    providerRequestId: string | null;
    disposition: 'OBSERVED_OWNED_CANCELLATION' | 'OBSERVED_UNOWNED_OR_NOT_CANCELING';
    backendSettlementProved: false; retryAllowed: false;
};

/** Fixed one-GET observer. No mutation method, idempotency key, POST stage, or local billing synchronization. */
export class PersistentCancellationObserver {
    private readonly apiKey: string;
    readonly timeoutMs: number;

    constructor(config: ConfigService) {
        const key = config.get<string>('STRIPE_SECRET_KEY');
        // This private-pilot adapter admits sandbox Stripe only; no live account is guessed.
        if (typeof key !== 'string' || !/^sk_test_[A-Za-z0-9]{16,}$/.test(key)) {
            throw new Error('Explicit selected sandbox Stripe key required.');
        }
        this.apiKey = key;
        const value = config.get<string>('STRIPE_SELECTED_REQUEST_TIMEOUT_MS');
        if (typeof value !== 'string' || !/^[0-9]+$/.test(value)
            || !Number.isSafeInteger(Number(value)) || Number(value) < 1000 || Number(value) > 30000) {
            throw new Error('Explicit bounded selected Stripe timeout required.');
        }
        this.timeoutMs = Number(value);
    }

    async observe(permit: object): Promise<SelectedCancellationObservationReceipt> {
        const selected = consumePersistentCancellationObserverPermit(this, permit);
        const owner = selected.owner;
        const claim = owner.persistentCancellationObservationSelection();
        const guard = () => owner.assertPersistentCancellationObservationOpen(claim);
        guard();
        if (claim.tenantId !== selected.tenantId || claim.operationId !== selected.jobId) {
            throw new Error('Committed selected cancellation provider identity differs.');
        }
        if (!/^sub_[A-Za-z0-9]+$/.test(claim.subscriptionId)
            || typeof claim.customerId !== 'string' || !/^cus_[A-Za-z0-9]+$/.test(claim.customerId)) {
            throw new Error('Exact selected Stripe subscription/customer required.');
        }
        const path = `/v1/subscriptions/${claim.subscriptionId}`;
        let readUsed = false; let closed = false;
        // FetchHttpClient.makeRequest and this async closure reject promises on
        // refusal; never synchronously throw into SDK's detached auth continuation.
        const httpClient = Stripe.createFetchHttpClient(async (input: unknown, init?: RequestInit): Promise<Response> => {
            guard();
            if (typeof input !== 'string') throw new Error('Fixed selected Stripe URL required.');
            const url = new URL(input);
            const headers = new Headers(init?.headers);
            const method = init?.method;
            if (url.origin !== 'https://api.stripe.com' || url.pathname !== path || url.search || url.hash
                || url.username || url.password || headers.get('authorization') !== `Bearer ${this.apiKey}`
                || headers.has('stripe-account') || headers.has('stripe-context')
                || headers.get('stripe-version') !== API_VERSION || !init?.signal) {
                throw new Error('Selected Stripe endpoint/auth/account context differs.');
            }
            const sdkSignal = init.signal;
            if (closed || method !== 'GET' || readUsed || init.body !== undefined || headers.has('idempotency-key')) {
                throw new Error('Only the unused exact GET observation is permitted.');
            }
            // Consumed before network handoff, including SDK implicit retry paths.
            readUsed = true;
            const abort = new AbortController();
            const ownerAbort = () => abort.abort(new Error('Selected Stripe owner closed.'));
            const sdkAbort = () => abort.abort(new Error('Selected Stripe request timed out.'));
            const ownerSignal = owner.persistentCancellationObservationSignal();
            ownerSignal.addEventListener('abort', ownerAbort, { once: true });
            sdkSignal.addEventListener('abort', sdkAbort, { once: true });
            if (ownerSignal.aborted) ownerAbort();
            if (sdkSignal.aborted) sdkAbort();
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            let bodyDone = false;
            try {
                guard();
                if (abort.signal.aborted) throw new Error('Selected Stripe transport closed before handoff.');
                const response = await globalThis.fetch(url.toString(), {
                    method, redirect: 'error', signal: abort.signal,
                    headers: { Authorization: `Bearer ${this.apiKey}`, 'Stripe-Version': API_VERSION },
                });
                if (!response.body) throw new Error('Selected Stripe response body is absent.');
                reader = response.body.getReader();
                guard();
                const chunks: Uint8Array[] = []; let bytes = 0;
                while (true) {
                    guard();
                    const chunk = await reader.read();
                    guard();
                    if (chunk.done) { bodyDone = true; break; }
                    bytes += chunk.value.byteLength;
                    if (bytes > MAX_RESPONSE_BYTES) throw new Error('Selected Stripe response body exceeds bound.');
                    chunks.push(chunk.value);
                }
                const retainedHeaders = new Headers(response.headers);
                retainedHeaders.delete('content-encoding'); retainedHeaders.delete('content-length');
                // SDK receives only bounded, already-consumed memory. Headers alone
                // never end ownership of the actual successful/error response body.
                const retainedBody = new Uint8Array(bytes);
                let offset = 0;
                for (const chunk of chunks) { retainedBody.set(chunk, offset); offset += chunk.byteLength; }
                return new Response(retainedBody, { status: response.status, headers: retainedHeaders });
            } catch {
                // Do not propagate ECONNRESET/EPIPE into SDK's unconditional first
                // retry exception. The consumed stage also independently denies replay.
                throw new Error('Selected Stripe transport outcome is unresolved.');
            } finally {
                try { if (reader && !bodyDone) await reader.cancel(); }
                finally {
                    reader?.releaseLock();
                    ownerSignal.removeEventListener('abort', ownerAbort);
                    sdkSignal.removeEventListener('abort', sdkAbort);
                }
            }
        });
        const stripe = new Stripe(this.apiKey, { apiVersion: API_VERSION as Stripe.LatestApiVersion,
            host: 'api.stripe.com', port: 443, protocol: 'https', maxNetworkRetries: 0,
            timeout: this.timeoutMs, httpClient });
        try {
            guard();
            const current = await stripe.subscriptions.retrieve(claim.subscriptionId, { maxNetworkRetries: 0, timeout: this.timeoutMs });
            guard();
            return this.receipt(current, claim.tenantId, claim.subscriptionId, claim.customerId, claim.operationId);
        } finally { closed = true; }
    }

    private receipt(value: unknown, tenantId: string, subscriptionId: string, customerId: string,
        operationId: string): SelectedCancellationObservationReceipt {
        const row = value as Record<string, any> | null;
        if (!row || row.object !== 'subscription' || row.id !== subscriptionId || row.customer !== customerId
            || row.metadata?.tenantId !== tenantId || row.livemode !== false
            || !['active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'paused', 'trialing', 'unpaid'].includes(row.status)
            || typeof row.cancel_at_period_end !== 'boolean' || typeof row.lastResponse?.requestId !== 'string'
            || row.lastResponse.requestId.length < 1 || row.lastResponse.requestId.length > 255) {
            throw new Error('Exact Stripe response ownership/identity is unavailable.');
        }
        const epoch = (seconds: unknown) => {
            if (seconds === null || seconds === undefined) return null;
            if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0
                || !Number.isFinite(new Date(seconds * 1000).getTime())) throw new Error('Invalid selected Stripe timestamp.');
            return new Date(seconds * 1000).toISOString();
        };
        const terminal = row.status === 'canceled';
        const outcome: TenantSubscriptionCancellationResult = {
            action: terminal ? 'already_canceled' : row.cancel_at_period_end ? 'already_scheduled' : 'none',
            stripeSubscriptionId: subscriptionId, stripeStatus: row.status,
            cancelAtPeriodEnd: row.cancel_at_period_end, currentPeriodEnd: epoch(row.current_period_end),
            cancelAt: epoch(row.cancel_at), canceledAt: epoch(row.canceled_at),
            cancellationBehavior: 'cancel_at_period_end',
            providerMutationOwned: row.metadata?.[OPERATION_METADATA] === operationId,
        };
        if (!terminal && outcome.cancelAtPeriodEnd && !outcome.currentPeriodEnd) {
            throw new Error('Selected Stripe paid-through boundary is absent.');
        }
        return { tenantId, operationId, customerId, outcome, providerRequestId: row.lastResponse.requestId,
            disposition: outcome.providerMutationOwned && (terminal || outcome.cancelAtPeriodEnd)
                ? 'OBSERVED_OWNED_CANCELLATION' : 'OBSERVED_UNOWNED_OR_NOT_CANCELING',
            backendSettlementProved: false, retryAllowed: false };
    }
}
