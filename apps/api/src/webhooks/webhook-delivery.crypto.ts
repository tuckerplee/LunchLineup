import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'crypto';

export const WEBHOOK_ENCRYPTION_CURRENT_KEY_ENV = 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT';
export const WEBHOOK_ENCRYPTION_PREVIOUS_KEY_ENV = 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const CURRENT_ENCRYPTION_VERSION = 2;

type LegacyEncryptedEnvelope = {
    v: 1;
    alg: 'aes-256-gcm';
    iv: string;
    tag: string;
    ciphertext: string;
};

type CurrentEncryptedEnvelope = Omit<LegacyEncryptedEnvelope, 'v'> & {
    v: 2;
    keyRef: string;
};

type EncryptedEnvelope = LegacyEncryptedEnvelope | CurrentEncryptedEnvelope;

type ParsedEncryptedEnvelope = {
    v?: unknown;
    alg?: unknown;
    keyRef?: unknown;
    iv?: unknown;
    tag?: unknown;
    ciphertext?: unknown;
};

type ManagedKey = {
    ref: string;
    value: Buffer;
};

export class WebhookDeliveryCrypto {
    constructor(private readonly configService: ConfigService) { }

    encryptString(value: string): string {
        const key = this.resolveCurrentKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key.value, iv);
        const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        const envelope: CurrentEncryptedEnvelope = {
            v: CURRENT_ENCRYPTION_VERSION,
            alg: ENCRYPTION_ALGORITHM,
            keyRef: key.ref,
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
        };

        return JSON.stringify(envelope);
    }

    decryptString(encrypted: string): string {
        const envelope = this.parseEnvelope(encrypted);
        const keys = this.resolveKeyring();
        const candidates = envelope.v === CURRENT_ENCRYPTION_VERSION
            ? keys.filter((key) => key.ref === envelope.keyRef)
            : keys;
        if (candidates.length === 0) {
            throw new ServiceUnavailableException('Webhook delivery encryption key is not available');
        }

        for (const key of candidates) {
            try {
                return this.decryptEnvelope(envelope, key.value);
            } catch {
                // Legacy v1 envelopes have no key reference, so overlap reads must try both managed keys.
            }
        }
        throw new ServiceUnavailableException('Webhook delivery encryption envelope could not be decrypted');
    }

    isEncrypted(value: string): boolean {
        try {
            this.parseEnvelope(value);
            return true;
        } catch {
            return false;
        }
    }

    encryptionKeyRef(): string {
        return this.resolveCurrentKey().ref;
    }

    private resolveKeyring(): ManagedKey[] {
        const current = this.resolveCurrentKey();
        const previousValue = String(this.configService.get(WEBHOOK_ENCRYPTION_PREVIOUS_KEY_ENV) ?? '').trim();
        if (!previousValue) return [current];
        const previous = this.decodeManagedKey(previousValue, WEBHOOK_ENCRYPTION_PREVIOUS_KEY_ENV);
        if (previous.ref === current.ref) {
            throw new ServiceUnavailableException('Webhook delivery current and previous encryption keys must differ');
        }
        return [current, previous];
    }

    private resolveCurrentKey(): ManagedKey {
        const configured = String(this.configService.get(WEBHOOK_ENCRYPTION_CURRENT_KEY_ENV) ?? '').trim();
        if (!configured) {
            throw new ServiceUnavailableException(`${WEBHOOK_ENCRYPTION_CURRENT_KEY_ENV} is required for webhook delivery`);
        }
        return this.decodeManagedKey(configured, WEBHOOK_ENCRYPTION_CURRENT_KEY_ENV);
    }

    private decodeManagedKey(configured: string, envName: string): ManagedKey {
        const value = /^[a-f0-9]{64}$/i.test(configured)
            ? Buffer.from(configured, 'hex')
            : Buffer.from(configured.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        if (value.length !== 32) {
            throw new ServiceUnavailableException(`${envName} must decode to 32 bytes`);
        }
        return { value, ref: this.keyRef(value) };
    }

    private keyRef(key: Buffer): string {
        return crypto.createHash('sha256').update(key.toString('base64')).digest('hex').slice(0, 16);
    }

    private decryptEnvelope(envelope: EncryptedEnvelope, key: Buffer): string {
        const decipher = crypto.createDecipheriv(
            ENCRYPTION_ALGORITHM,
            key,
            Buffer.from(envelope.iv, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
            decipher.final(),
        ]).toString('utf8');
    }

    private parseEnvelope(value: string): EncryptedEnvelope {
        let envelope: ParsedEncryptedEnvelope;
        try {
            envelope = JSON.parse(value) as ParsedEncryptedEnvelope;
        } catch {
            throw new ServiceUnavailableException('Unsupported webhook delivery encryption envelope');
        }
        const validVersion = envelope.v === 1
            || (envelope.v === CURRENT_ENCRYPTION_VERSION && typeof envelope.keyRef === 'string' && envelope.keyRef.length === 16);
        if (
            !validVersion
            || envelope.alg !== ENCRYPTION_ALGORITHM
            || typeof envelope.iv !== 'string'
            || typeof envelope.tag !== 'string'
            || typeof envelope.ciphertext !== 'string'
        ) {
            throw new ServiceUnavailableException('Unsupported webhook delivery encryption envelope');
        }
        return envelope as EncryptedEnvelope;
    }
}
