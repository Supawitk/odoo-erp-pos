import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * Receipt mailer.
 *
 * Production: configure SMTP via env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
 * `SMTP_PASS`, `SMTP_FROM`).
 *
 * Dev / no-config: falls back to a `jsonTransport` which serializes the
 * envelope into the log instead of actually sending. The endpoint still
 * returns 200 so cashiers don't see a failed-send error during development.
 */
@Injectable()
export class ReceiptMailerService {
  private readonly logger = new Logger(ReceiptMailerService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly mode: 'smtp' | 'json-transport';
  private readonly fromAddress: string;

  constructor() {
    const host = process.env.SMTP_HOST;
    this.fromAddress = process.env.SMTP_FROM ?? 'no-reply@erp-pos.local';
    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth:
          process.env.SMTP_USER && process.env.SMTP_PASS
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
      });
      this.mode = 'smtp';
    } else {
      this.transporter = nodemailer.createTransport({ jsonTransport: true });
      this.mode = 'json-transport';
    }
    this.logger.log(`Receipt mailer mode=${this.mode} from=${this.fromAddress}`);
  }

  async sendReceipt(opts: {
    to: string;
    subject: string;
    html: string;
    documentNumber: string | null;
  }): Promise<{ ok: true; messageId?: string; mode: string }> {
    if (!opts.to || !/.+@.+\..+/.test(opts.to)) {
      throw new Error('invalid recipient email');
    }
    const result = await this.transporter.sendMail({
      from: this.fromAddress,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });
    this.logger.log(
      `Receipt sent doc=${opts.documentNumber} to=${opts.to} mode=${this.mode} messageId=${result.messageId}`,
    );
    return { ok: true, messageId: result.messageId, mode: this.mode };
  }
}
