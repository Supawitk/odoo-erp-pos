import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  type EtaxSubmissionInput,
  type EtaxSubmissionResult,
} from '../dtos/leceipt-response.dto';

/**
 * 🇹🇭 INET ASP REST adapter (Phase 4B fallback path).
 *
 * INET is the secondary ASP — used for failover when Leceipt rejects. INET is
 * also a CA, so the upgrade path to direct H2H signing (Phase 4C) is shorter
 * if we already speak INET's protocol.
 *
 * Same contract as LeceiptAdapter:
 *   - submit(input): EtaxSubmissionResult
 *   - mock mode toggleable via INET_MODE=mock or absent INET_ETAX_API_KEY
 *
 * Live INET endpoint: POST /etax-saas/api/v1/document/submit
 *   Auth: { user_code, access_key } in body
 *   Returns: { documentId, statusCode, rdRef, ackTimestamp }
 */
@Injectable()
export class InetAdapter {
  private readonly logger = new Logger(InetAdapter.name);
  private readonly apiBase = process.env.INET_ETAX_API_BASE ?? 'https://api.efiling.inet.co.th';
  private readonly apiKey = process.env.INET_ETAX_API_KEY;
  private readonly userCode = process.env.INET_ETAX_USER_CODE;
  private readonly accessKey = process.env.INET_ETAX_ACCESS_KEY;
  private readonly mode: 'mock' | 'live';

  constructor() {
    const hasCreds = !!(this.apiKey && this.userCode && this.accessKey);
    this.mode = (process.env.INET_MODE as 'mock' | 'live') ?? (hasCreds ? 'live' : 'mock');
    this.logger.log(`INET adapter mode=${this.mode}`);
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
    const providerRef = `INET-MOCK-${randomUUID().slice(0, 8)}`;
    const rdRef = `RD-MOCK-${input.documentNumber}`;
    this.logger.log(
      `[MOCK] INET submit ${input.documentType} ${input.documentNumber} → ${providerRef} (RD ${rdRef})`,
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
    const url = `${this.apiBase}/etax-saas/api/v1/document/submit`;
    const body = {
      userCode: this.userCode,
      accessKey: this.accessKey,
      apiKey: this.apiKey,
      documentType: input.etdaCode,
      documentNumber: input.documentNumber,
      xmlBase64: Buffer.from(input.xml, 'utf8').toString('base64'),
      xmlHash: input.xmlHash,
      ...(input.buyerEmail ? { buyerEmail: input.buyerEmail } : {}),
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        return {
          status: 'error',
          message: `HTTP ${res.status}: ${(json as any).message ?? 'INET error'}`,
          retryable,
          raw: json,
        };
      }

      return {
        status: classifyStatus(json),
        providerReference: (json.documentId as string) ?? undefined,
        rdReference: (json.rdRef as string) ?? undefined,
        ackTimestamp: json.ackTimestamp ? new Date(json.ackTimestamp as string) : undefined,
        raw: json,
      };
    } catch (err: any) {
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
  const s = String(json.statusCode ?? json.status ?? '').toLowerCase();
  if (s === 'success' || s === '200' || s === 'ok' || s === 'acknowledged') return 'success';
  if (s === 'pending' || s === 'submitted') return 'pending';
  if (s === 'rejected') return 'rejected';
  return 'error';
}
