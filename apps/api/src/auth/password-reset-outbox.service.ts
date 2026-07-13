import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { resolvePublicAppOrigin } from '../common/bootstrap-security';

const ENCRYPTION_KEY_ENV = 'PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY';

export class PasswordResetOutboxService {
    constructor(private readonly configService: ConfigService) { }

    validateConfiguration(): void {
        this.appOrigin();
        this.encryptionKey();
    }

    createEncryptedEnvelope(email: string, resetToken: string, expiresAt: Date): { encryptedPayload: string; encryptionKeyRef: string } {
        const resetUrl = new URL('/auth/reset-password', this.appOrigin());
        resetUrl.searchParams.set('token', resetToken);
        const key = this.encryptionKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([
            cipher.update(JSON.stringify({ email, resetUrl: resetUrl.toString(), expiresAt: expiresAt.toISOString() }), 'utf8'),
            cipher.final(),
        ]);
        return {
            encryptedPayload: JSON.stringify({
                v: 1,
                alg: 'aes-256-gcm',
                iv: iv.toString('base64'),
                tag: cipher.getAuthTag().toString('base64'),
                ciphertext: ciphertext.toString('base64'),
            }),
            encryptionKeyRef: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
        };
    }

    private appOrigin(): string {
        try {
            return resolvePublicAppOrigin({
                NODE_ENV: this.configService.get('NODE_ENV'),
                APP_ORIGIN: this.configService.get('APP_ORIGIN'),
                NEXT_PUBLIC_APP_ORIGIN: this.configService.get('NEXT_PUBLIC_APP_ORIGIN'),
                NEXT_PUBLIC_APP_URL: this.configService.get('NEXT_PUBLIC_APP_URL'),
            });
        } catch {
            throw new ServiceUnavailableException('A valid public APP_ORIGIN is required for password reset delivery');
        }
    }

    private encryptionKey(): Buffer {
        const configured = String(this.configService.get(ENCRYPTION_KEY_ENV) ?? '').trim();
        const key = /^[a-f0-9]{64}$/i.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64');
        if (key.length !== 32) {
            throw new ServiceUnavailableException(`${ENCRYPTION_KEY_ENV} must decode to 32 bytes`);
        }
        return key;
    }
}
