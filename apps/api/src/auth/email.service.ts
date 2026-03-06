import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend;
  private readonly from: string;

  constructor(private configService: ConfigService) {
    this.resend = new Resend(this.configService.getOrThrow('RESEND_API_KEY'));
    this.from = this.configService.get('EMAIL_FROM', 'LunchLineup Beta <no-reply@beta.lunchlineup.com>');
  }

  async sendOtp(email: string, code: string): Promise<void> {
    if (process.env.NODE_ENV === 'development') {
      this.logger.log(`[LOCAL DEV START] ================================`);
      this.logger.log(`OTP Code for ${email}: ${code}`);
      this.logger.log(`[LOCAL DEV END] ==================================`);
      return;
    }
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: email,
      subject: `${code} — your LunchLineup login code`,
      html: `
                <!DOCTYPE html>
                <html>
                <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
                <body style="margin:0;padding:0;background:#0a0f1e;font-family:'Inter',system-ui,sans-serif">
                  <div style="max-width:480px;margin:48px auto;padding:0 24px">
                    <!-- Logo -->
                    <div style="margin-bottom:32px">
                      <span style="font-size:24px;font-weight:900;color:#f1f5f9;letter-spacing:-0.02em">🍱 LunchLineup</span>
                    </div>
                    <!-- Card -->
                    <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px">
                      <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#f1f5f9">Your login code</h1>
                      <p style="margin:0 0 32px;font-size:15px;color:#94a3b8;line-height:1.6">
                        Enter this code on the LunchLineup login page. It expires in <strong style="color:#f1f5f9">10 minutes</strong>.
                      </p>
                      <!-- OTP Display -->
                      <div style="background:rgba(92,124,250,0.1);border:1px solid rgba(92,124,250,0.3);border-radius:12px;padding:28px;text-align:center;margin-bottom:32px">
                        <span style="font-size:48px;font-weight:900;letter-spacing:0.2em;color:#748ffc;font-variant-numeric:tabular-nums">${code}</span>
                      </div>
                      <p style="margin:0;font-size:13px;color:#475569;line-height:1.6">
                        If you didn't request this, you can safely ignore this email.<br>
                        This code was requested for <strong style="color:#f1f5f9">${email}</strong>.
                      </p>
                    </div>
                    <!-- Footer -->
                    <p style="margin-top:24px;font-size:12px;color:#334155;text-align:center">
                      LunchLineup · Smart Scheduling for Modern Teams<br>
                      <a href="#" style="color:#475569">Unsubscribe</a>
                    </p>
                  </div>
                </body>
                </html>
            `,
    });

    if (error) {
      this.logger.error(`Failed to send OTP to ${email}: ${JSON.stringify(error)}`);
      throw new Error(`Email delivery failed: ${error.message}`);
    }

    this.logger.log(`OTP sent to ${email}`);
  }
}
