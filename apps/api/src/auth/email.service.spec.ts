import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailService } from './email.service';

const originalNodeEnv = process.env.NODE_ENV;

describe('EmailService', () => {
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it('allows local development OTP logging without a provider key', async () => {
    process.env.NODE_ENV = 'development';
    const service = new EmailService(config({}));

    await expect(service.sendOtp('manager@example.com', '123456')).resolves.toBeUndefined();
  });

  it('allows local development password reset logging without a provider key', async () => {
    process.env.NODE_ENV = 'development';
    const service = new EmailService(config({}));

    await expect(service.sendPasswordReset(
      'manager@example.com',
      'http://localhost:3000/auth/reset-password?token=dev-token',
      new Date(Date.now() + 60_000),
    )).resolves.toBeUndefined();
  });

  it('fails startup outside development when email delivery is not configured', () => {
    process.env.NODE_ENV = 'production';

    expect(() => new EmailService(config({}))).toThrow('RESEND_API_KEY');
  });

  it('masks recipient addresses in provider failure logs', async () => {
    process.env.NODE_ENV = 'production';
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new EmailService(config({
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'LunchLineup <no-reply@example.com>',
    }));
    (service as any).resend = {
      emails: {
        send: vi.fn().mockResolvedValue({
          error: {
            name: 'validation_error',
            message: 'manager@example.com rejected',
          },
        }),
      },
    };

    await expect(service.sendOtp('manager@example.com', '123456')).rejects.toThrow('Email delivery failed');

    const logBody = JSON.stringify(logger.mock.calls);
    expect(logBody).toContain('ma***@example.com');
    expect(logBody).toContain('validation_error');
    expect(logBody).not.toContain('manager@example.com');
    expect(logBody).not.toContain('123456');
  });

  it('escapes dynamic OTP email HTML values before provider handoff', async () => {
    process.env.NODE_ENV = 'production';
    const service = new EmailService(config({
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'LunchLineup <no-reply@example.com>',
    }));
    const send = vi.fn().mockResolvedValue({ error: null });
    (service as any).resend = { emails: { send } };

    await expect(service.sendOtp('manager<script>@example.com', '123&456')).resolves.toBeUndefined();

    const payload = send.mock.calls[0][0];
    expect(payload.html).toContain('manager&lt;script&gt;@example.com');
    expect(payload.html).toContain('123&amp;456');
    expect(payload.html).not.toContain('manager<script>@example.com');
    expect(payload.html).not.toContain('123&456');
  });

  it('escapes dynamic password reset email HTML values before provider handoff', async () => {
    process.env.NODE_ENV = 'production';
    const service = new EmailService(config({
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'LunchLineup <no-reply@example.com>',
    }));
    const send = vi.fn().mockResolvedValue({ error: null });
    (service as any).resend = { emails: { send } };

    const resetUrl = 'https://app.example.com/auth/reset-password?token=abc&next=<script>';
    await expect(service.sendPasswordReset(
      'manager<script>@example.com',
      resetUrl,
      new Date(Date.now() + 60_000),
    )).resolves.toBeUndefined();

    const payload = send.mock.calls[0][0];
    expect(payload.html).toContain('manager&lt;script&gt;@example.com');
    expect(payload.html).toContain('token=abc&amp;next=&lt;script&gt;');
    expect(payload.html).not.toContain('manager<script>@example.com');
    expect(payload.html).not.toContain('token=abc&next=<script>');
    expect(payload.text).toContain(resetUrl);
  });
});

function config(values: Record<string, string>): ConfigService {
  return {
    get: vi.fn((key: string, fallback?: string) => values[key] ?? fallback),
  } as unknown as ConfigService;
}
