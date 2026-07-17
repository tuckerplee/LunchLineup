import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailService } from './email.service';

const originalNodeEnv = process.env.NODE_ENV;

describe('EmailService', () => {
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never writes OTP secrets to local development logs', async () => {
    process.env.NODE_ENV = 'development';
    const service = new EmailService(config({}));
    const logger = vi.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);

    await expect(service.sendOtp('manager@example.com', '123456')).rejects.toThrow('Email delivery is not configured');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('manager@example.com');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('example.com');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('123456');
  });

  it('never writes password-reset secrets to local development logs', async () => {
    process.env.NODE_ENV = 'development';
    const service = new EmailService(config({}));
    const logger = vi.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);

    await expect(service.sendPasswordReset(
      'manager@example.com',
      'http://localhost:3000/auth/reset-password?token=dev-token',
      new Date(Date.now() + 60_000),
    )).rejects.toThrow('Email delivery is not configured');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('manager@example.com');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('dev-token');
  });

  it('fails startup outside development when email delivery is not configured', () => {
    process.env.NODE_ENV = 'production';

    expect(() => new EmailService(config({}))).toThrow('RESEND_API_KEY');
  });

  it('omits recipient and provider text from failure logs', async () => {
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
            name: 'validation_error\r\nAuthorization: Bearer secret',
            message: 'manager@example.com rejected token=secret',
          },
        }),
      },
    };

    await expect(service.sendOtp('manager@example.com', '123456')).rejects.toThrow('Email delivery failed');

    const logBody = JSON.stringify(logger.mock.calls);
    expect(logBody).toContain('auth.otp_email_delivery_failed');
    expect(logBody).not.toContain('validation_error');
    expect(logBody).not.toContain('manager@example.com');
    expect(logBody).not.toContain('Authorization');
    expect(logBody).not.toContain('secret');
    expect(logBody).not.toContain('123456');
  });

  it('blocks provider handoff for a suppressed recipient without logging the address', async () => {
    process.env.NODE_ENV = 'production';
    const logger = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const deliveryFeedback = { isSuppressed: vi.fn().mockResolvedValue(true) };
    const service = new EmailService(config({
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'LunchLineup <no-reply@example.com>',
    }), deliveryFeedback as any);
    const send = vi.fn();
    (service as any).resend = { emails: { send } };

    await expect(service.sendOtp('manager@example.com', '123456')).rejects.toThrow('Email delivery failed');

    expect(deliveryFeedback.isSuppressed).toHaveBeenCalledWith('manager@example.com');
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.mock.calls)).toContain('reason=provider_feedback');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('manager@example.com');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('123456');
  });

  it('uses one bounded total deadline and aborts the OTP provider request', async () => {
    vi.useFakeTimers();
    process.env.NODE_ENV = 'production';
    const deliveryFeedback = {
      isSuppressed: vi.fn().mockImplementation(
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60)),
      ),
    };
    const service = new EmailService(config({
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'LunchLineup <no-reply@example.com>',
      EMAIL_OTP_DELIVERY_DEADLINE_MS: '100',
    }), deliveryFeedback as any);
    let providerRequestAborted = false;
    const send = vi.fn().mockImplementation((
      _payload: unknown,
      options: { signal: AbortSignal },
    ) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        providerRequestAborted = true;
        reject(options.signal.reason);
      }, { once: true });
    }));
    (service as any).resend = { emails: { send } };

    const delivery = service.sendOtp('manager@example.com', '123456');
    const rejection = expect(delivery).rejects.toThrow('Email delivery deadline exceeded');

    await vi.advanceTimersByTimeAsync(60);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(40);
    await rejection;
    expect(providerRequestAborted).toBe(true);
    expect(send.mock.calls[0][1].signal.aborted).toBe(true);
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
