import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    if (!apiKey && process.env.NODE_ENV !== 'development') {
      throw new Error('RESEND_API_KEY must be configured outside local development.');
    }

    this.resend = apiKey ? new Resend(apiKey) : null;
    this.from = this.configService.get('EMAIL_FROM', 'LunchLineup Beta <no-reply@beta.lunchlineup.com>');
  }

  async sendOtp(email: string, code: string): Promise<void> {
    const maskedEmail = this.maskEmail(email);
    const htmlEmail = this.escapeHtml(email);
    const htmlCode = this.escapeHtml(code);
    if (process.env.NODE_ENV === 'development') {
      this.logger.log('[LOCAL DEV START] ================================');
      this.logger.log(`OTP Code for ${email}: ${code}`);
      this.logger.log('[LOCAL DEV END] ==================================');
      return;
    }

    if (!this.resend) {
      throw new Error('Email delivery is not configured.');
    }

    const { error } = await this.resend.emails.send({
      from: this.from,
      to: email,
      subject: `${code} - your LunchLineup login code`,
      html: `
                <!DOCTYPE html>
                <html>
                <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
                <body style="margin:0;padding:0;background:#0a0f1e;font-family:'Inter',system-ui,sans-serif">
                  <div style="max-width:480px;margin:48px auto;padding:0 24px">
                    <!-- Logo -->
                    <div style="margin-bottom:32px">
                      <span style="font-size:24px;font-weight:900;color:#f1f5f9">LunchLineup</span>
                    </div>
                    <!-- Card -->
                    <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px">
                      <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#f1f5f9">Your login code</h1>
                      <p style="margin:0 0 32px;font-size:15px;color:#94a3b8;line-height:1.6">
                        Enter this code on the LunchLineup login page. It expires in <strong style="color:#f1f5f9">10 minutes</strong>.
                      </p>
                      <!-- OTP Display -->
                      <div style="background:rgba(92,124,250,0.1);border:1px solid rgba(92,124,250,0.3);border-radius:12px;padding:28px;text-align:center;margin-bottom:32px">
                        <span style="font-size:48px;font-weight:900;letter-spacing:0.2em;color:#748ffc;font-variant-numeric:tabular-nums">${htmlCode}</span>
                      </div>
                      <p style="margin:0;font-size:13px;color:#475569;line-height:1.6">
                        If you didn't request this, you can safely ignore this email.<br>
                        This code was requested for <strong style="color:#f1f5f9">${htmlEmail}</strong>.
                      </p>
                    </div>
                    <!-- Footer -->
                    <p style="margin-top:24px;font-size:12px;color:#334155;text-align:center">
                      LunchLineup - Smart Scheduling for Modern Teams<br>
                      <a href="#" style="color:#475569">Unsubscribe</a>
                    </p>
                  </div>
                </body>
                </html>
            `,
    });

    if (error) {
      this.logger.error(`Failed to send OTP to ${maskedEmail}: ${this.providerErrorCode(error)}`);
      throw new Error('Email delivery failed');
    }

    this.logger.log(`OTP sent to ${maskedEmail}`);
  }

  async sendPasswordReset(email: string, resetUrl: string, expiresAt: Date): Promise<void> {
    const maskedEmail = this.maskEmail(email);
    const htmlEmail = this.escapeHtml(email);
    const htmlResetUrl = this.escapeHtml(resetUrl);
    const textResetUrl = resetUrl;
    const expiryMinutes = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60000));

    if (process.env.NODE_ENV === 'development') {
      this.logger.log('[LOCAL DEV START] ================================');
      this.logger.log(`Password reset link for ${email}: ${resetUrl}`);
      this.logger.log('[LOCAL DEV END] ==================================');
      return;
    }

    if (!this.resend) {
      throw new Error('Email delivery is not configured.');
    }

    const { error } = await this.resend.emails.send({
      from: this.from,
      to: email,
      subject: 'Reset your LunchLineup password',
      html: `
                <!DOCTYPE html>
                <html>
                <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
                <body style="margin:0;padding:0;background:#0a0f1e;font-family:'Inter',system-ui,sans-serif">
                  <div style="max-width:480px;margin:48px auto;padding:0 24px">
                    <div style="margin-bottom:32px">
                      <span style="font-size:24px;font-weight:900;color:#f1f5f9">LunchLineup</span>
                    </div>
                    <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px">
                      <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#f1f5f9">Reset your password</h1>
                      <p style="margin:0 0 28px;font-size:15px;color:#94a3b8;line-height:1.6">
                        Use this link to set a new LunchLineup password. It expires in <strong style="color:#f1f5f9">${expiryMinutes} minutes</strong>.
                      </p>
                      <p style="margin:0 0 32px">
                        <a href="${htmlResetUrl}" style="display:inline-block;background:#748ffc;color:#08111f;text-decoration:none;font-size:15px;font-weight:800;border-radius:12px;padding:14px 18px">Reset password</a>
                      </p>
                      <p style="margin:0 0 18px;font-size:13px;color:#64748b;line-height:1.6;word-break:break-all">
                        ${htmlResetUrl}
                      </p>
                      <p style="margin:0;font-size:13px;color:#475569;line-height:1.6">
                        If you did not request this, you can safely ignore this email.<br>
                        This reset was requested for <strong style="color:#f1f5f9">${htmlEmail}</strong>.
                      </p>
                    </div>
                  </div>
                </body>
                </html>
            `,
      text: `Reset your LunchLineup password: ${textResetUrl}\n\nThis link expires in ${expiryMinutes} minutes. If you did not request this, you can ignore this email.`,
    });

    if (error) {
      this.logger.error(`Failed to send password reset to ${maskedEmail}: ${this.providerErrorCode(error)}`);
      throw new Error('Email delivery failed');
    }

    this.logger.log(`Password reset sent to ${maskedEmail}`);
  }

  private maskEmail(email: string): string {
    const [localPart, domain] = email.split('@');
    if (!domain) return 'invalid_email';
    const safeLocal = localPart.length <= 2 ? `${localPart[0] ?? '*'}*` : `${localPart.slice(0, 2)}***`;
    return `${safeLocal}@${domain}`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return char;
      }
    });
  }

  private providerErrorCode(error: unknown): string {
    if (error && typeof error === 'object' && 'name' in error && typeof (error as { name?: unknown }).name === 'string') {
      return (error as { name: string }).name;
    }
    return 'provider_error';
  }
}
