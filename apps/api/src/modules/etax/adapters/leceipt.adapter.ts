import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  type EtaxSubmissionInput,
  type EtaxSubmissionResult,
} from '../dtos/leceipt-response.dto';

/**
 * 🇹🇭 Leceipt ASP REST adapter (Phase 4B primary path).
 *
 * Two modes:
 *
 *   MOCK   — when LECEIPT_API_KEY is unset or LECEIPT_MODE=mock. Returns a
 *            success ack with a fake rdReference so the entire pipeline
 *            (build XML → submit → persist ack) can run end-to-end without
 *            credentials. Used for CI + smoke tests + early development.
 *
 *   LIVE   — POSTs to the real Leceipt API. Authentication is API-key in the
 *            Authorization header. The response includes the RD acknowledgement
 *            id once the document is forwarded.
 *
 * Retry strategy lives in EtaxSubmissionService (this adapter is stateless;
 * each call is one HTTP attempt). Error classification: 4xx → permanent
 * (don't retry), 5xx + network → transient.
 */
@Injectable()
export class LeceiptAdapter {
  private readonly logger = new Logger(LeceiptAdapter.name);
  private readonly apiBase = process.env.LECEIPT_API_BASE ?? 'https://api.leceipt.com/v1';
  private readonly apiKey = process.env.LECEIPT_API_KEY;
  private readonly mode: 'mock' | 'live';

  constructor() {
    this.mode = (process.env.LECEIPT_MODE as 'mock' | 'live')
      ?? (this.apiKey ? 'live' : 'mock');
    this.logger.log(`Leceipt adapter mode=${this.mode}`);
  }

  isMock(): boolean {
    return this.mode === 'mock';
  }

  async submit(input: EtaxSubmissionInput): Promise<EtaxSubmissionResult> {
    if (this.mode === 'mock') {
      return this.submitMock(input);
    }
    return this.submitLive(input);
  }

  private submitMock(input: EtaxSubmissionInput): EtaxSubmissionResult {
    const providerRef = `LECEIPT-MOCK-${randomUUID().slice(0, 8)}`;
    const rdRef = `RD-MOCK-${input.documentNumber}`;
    this.logger.log(
      `[MOCK] Leceipt submit ${input.documentType} ${input.documentNumber} → ${providerRef} (RD ${rdRef})`,
    );
    return {
      status: 'success',
      providerReference: providerRef,
      rdReference: rdRef,
      ackTimestamp: new Date(),
      raw: { mock: true, etdaCode: input.etdaCode, xmlHash: input.xmlHash },
    };
  }

  private async submitLive(input: EtaxSubmissionInput): Promise<EtaxSubmissionResult> {
    const url = `${this.apiBase}/etax-documents`;
    const body = {
      type: input.etdaCode,
      documentNumber: input.documentNumber,
      xml: Buffer.from(input.xml, 'utf8').toString('base64'),
      xmlHash: input.xmlHash,
      ...(input.buyerEmail ? { buyerEmail: input.buyerEmail } : {}),
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        return {
          status: 'error',
          message: `HTTP ${res.status}: ${(json as any).message ?? 'Leceipt error'}`,
          retryable,
          raw: json,
        };
      }

      return {
        status: classifyStatus(json),
        providerReference: (json.id as string) ?? undefined,
        rdReference: (json.rd_acknowledgement_id as string) ?? undefined,
        ackTimestamp: json.ack_timestamp ? new Date(json.ack_timestamp as string) : undefined,
        raw: json,
      };
    } catch (err: any) {
      // Network/transport errors are transient.
      return {
        status: 'error',
        message: err?.message ?? 'network error',
        retryable: true,
        raw: { networkError: true },
      };
    }
  }
}

function classifyStatus(json: Record<string, unknown>): EtaxSubmissionResult['status'] {
  const s = String(json.status ?? '').toLowerCase();
  if (s === 'acknowledged' || s === 'success') return 'success';
  if (s === 'pending' || s === 'submitted') return 'pending';
  if (s === 'rejected') return 'rejected';
  return 'error';
}
