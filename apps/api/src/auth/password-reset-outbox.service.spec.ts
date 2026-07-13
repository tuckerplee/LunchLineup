import { ServiceUnavailableException } from '@nestjs/common';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PasswordResetOutboxService } from './password-reset-outbox.service';

const encryptionKey = Buffer.alloc(32, 0x42);

function service(values: Record<string, string | undefined>): PasswordResetOutboxService {
    return new PasswordResetOutboxService({
        get: (key: string) => values[key],
    } as any);
}

describe('PasswordResetOutboxService', () => {
    it('falls back from blank APP_ORIGIN and creates a usable encrypted delivery envelope', () => {
        const expiresAt = new Date('2026-07-12T20:00:00.000Z');
        const resetToken = 'reset_token_abcdefghijklmnopqrstuvwxyz123456';
        const outbox = service({
            NODE_ENV: 'production',
            APP_ORIGIN: '   ',
            NEXT_PUBLIC_APP_ORIGIN: 'https://lunchlineup.com',
            PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY: encryptionKey.toString('hex'),
        });

        const envelope = outbox.createEncryptedEnvelope('legacy@example.net', resetToken, expiresAt);
        const payload = decrypt(envelope.encryptedPayload);

        expect(envelope.encryptionKeyRef).toMatch(/^[a-f0-9]{16}$/);
        expect(payload).toEqual({
            email: 'legacy@example.net',
            resetUrl: `https://lunchlineup.com/auth/reset-password?token=${resetToken}`,
            expiresAt: expiresAt.toISOString(),
        });
    });

    it('rejects omitted or blank origin configuration before creating an envelope', () => {
        const outbox = service({
            NODE_ENV: 'production',
            APP_ORIGIN: ' ',
            NEXT_PUBLIC_APP_ORIGIN: '',
            NEXT_PUBLIC_APP_URL: '  ',
            PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY: encryptionKey.toString('base64'),
        });

        expect(() => outbox.validateConfiguration()).toThrow(ServiceUnavailableException);
    });
});

function decrypt(serializedEnvelope: string): Record<string, string> {
    const envelope = JSON.parse(serializedEnvelope) as {
        iv: string;
        tag: string;
        ciphertext: string;
    };
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        encryptionKey,
        Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as Record<string, string>;
}