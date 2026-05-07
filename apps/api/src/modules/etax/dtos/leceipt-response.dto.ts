/**
 * 🇹🇭 Leceipt + INET ASP response shapes (Phase 4B).
 *
 * Both ASPs return a similar envelope, normalised here so the rest of the system
 * doesn't care which provider was used:
 *
 *   { status: 'success' | 'error', rdReference?, providerReference?, message? }
 *
 * Real Leceipt endpoint: POST /api/v1/etax-documents
 *   Returns: { id, status, etda_response_code, rd_acknowledgement_id, ... }
 *
 * Real INET endpoint: POST /etax-saas/api/v1/document/submit
 *   Returns: { documentId, statusCode, rdRef, ackTimestamp, ... }
 */

export type EtaxProviderStatus = 'success' | 'pending' | 'rejected' | 'error';

export interface EtaxSubmissionResult {
  status: EtaxProviderStatus;
  /** Provider's internal id — leceipt or inet doc id. */
  providerReference?: string;
  /** RD-issued reference once acked. */
  rdReference?: string;
  /** When the provider ack'd. */
  ackTimestamp?: Date;
  /** Whether the error (if any) is transient and should be retried. */
  retryable?: boolean;
  /** Provider-side error message. */
  message?: string;
  /** Full response body for forensic replay. */
  raw?: unknown;
}

export interface EtaxSubmissionInput {
  documentNumber: string;
  documentType: 'RE' | 'ABB' | 'TX' | 'CN' | 'DN';
  etdaCode: 'T01' | 'T02' | 'T03' | 'T04' | 'T05';
  xml: string;
  /** sha256 hex of xml — provider may verify on ingest. */
  xmlHash: string;
  buyerEmail?: string;
}
