import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { WebhookDeliveryCrypto } from './webhook-delivery.crypto';

const current = Buffer.alloc(32, 11);
const previous = Buffer.alloc(32, 12);

function config(values: Record<string, string | undefined>) {
    return { get: vi.fn((key: string) => values[key]) } as any;
}

function legacyEnvelope(value: string, key: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return JSON.stringify({
        v: 1,
        alg: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    });
}

describe('WebhookDeliveryCrypto managed key rotation', () => {
    it('writes key-referenced v2 envelopes with the current key', () => {
        const cryptoService = new WebhookDeliveryCrypto(config({
            WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: current.toString('base64'),
        }));
        const encrypted = cryptoService.encryptString('payload');
        const envelope = JSON.parse(encrypted);

        expect(envelope.v).toBe(2);
        expect(envelope.keyRef).toBe(cryptoService.encryptionKeyRef());
        expect(cryptoService.decryptString(encrypted)).toBe('payload');
    });

    it('reads previous-key v2 and legacy v1 envelopes only during overlap', () => {
        const previousWriter = new WebhookDeliveryCrypto(config({
            WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: previous.toString('base64'),
        }));
        const overlapReader = new WebhookDeliveryCrypto(config({
            WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: current.toString('base64'),
            WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS: previous.toString('base64'),
        }));
        const currentOnlyReader = new WebhookDeliveryCrypto(config({
            WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: current.toString('base64'),
        }));

        expect(overlapReader.decryptString(previousWriter.encryptString('v2'))).toBe('v2');
        expect(overlapReader.decryptString(legacyEnvelope('v1', previous))).toBe('v1');
        expect(() => currentOnlyReader.decryptString(previousWriter.encryptString('blocked'))).toThrow();
        expect(() => currentOnlyReader.decryptString(legacyEnvelope('blocked', previous))).toThrow();
    });

    it('rejects duplicate current and previous keys', () => {
        const cryptoService = new WebhookDeliveryCrypto(config({
            WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: current.toString('base64'),
            WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS: current.toString('base64'),
        }));
        expect(() => cryptoService.decryptString(legacyEnvelope('payload', current))).toThrow(/must differ/);
    });
});
