import { Injectable, Logger, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { etaxSubmissions, posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { OrganizationService } from '../../organization/organization.service';
import { TaxInvoiceXmlBuilder } from './tax-invoice-xml-builder';
import { EtdaXsdValidator } from '../validators/etda-xsd.validator';
import { LeceiptAdapter } from '../adapters/leceipt.adapter';
import { InetAdapter } from '../adapters/inet.adapter';
import {
  type TaxInvoiceDto,
  etdaCodeFor,
} from '../dtos/tax-invoice.dto';
import type { EtaxSubmissionInput } from '../dtos/leceipt-response.dto';

export type EtaxProvider = 'leceipt' | 'inet';

export interface SubmitResult {
  submissionId: string;
  status: 'acknowledged' | 'pending' | 'rejected' | 'error';
  rdReference: string | null;
  providerReference: string | null;
  retryable: boolean;
}

/**
 * 🇹🇭 e-Tax submission orchestrator (Phase 4B).
 *
 * One method does everything for one document:
 *   1. Hydrate the order from DB
 *   2. Build TaxInvoiceDto from order + org settings
 *   3. Render XML
 *   4. Validate (TIER 1 structural)
 *   5. Persist submission row (pending)
 *   6. Submit to ASP
 *   7. Update submission row with ack/error
 *
 * Idempotency: re-submitting the same orderId reuses the existing submission row
 * unless it's in `error` status (then a new attempt is recorded). This means
 * the BullMQ relay can safely retry a job without creating duplicate rows.
 */
@Injectable()
export class EtaxSubmissionService {
  private readonly logger = new Logger(EtaxSubmissionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly org: OrganizationService,
    private readonly builder: TaxInvoiceXmlBuilder,
    private readonly validator: EtdaXsdValidator,
    private readonly leceipt: LeceiptAdapter,
    private readonly inet: InetAdapter,
  ) {}

  /**
   * Submit one POS order. Provider defaults to leceipt; inet is fallback.
   * Idempotent — calling twice for the same orderId+provider returns the
   * same submission row.
   */
  async submitOrder(orderId: string, provider: EtaxProvider = 'leceipt'): Promise<SubmitResult> {
    const settings = await this.org.snapshot();
    if (settings.countryMode !== 'TH' || !settings.vatRegistered) {
      throw new BadRequestException(
        'e-Tax submission only supported for VAT-registered Thai merchants',
      );
    }
    if (!settings.sellerTin) {
      throw new BadRequestException('seller TIN must be set in org settings before submitting');
    }

    const [order] = await this.db.select().from(posOrders).where(eq(posOrders.id, orderId)).limit(1);
    if (!order) throw new NotFoundException(`order ${orderId} not found`);
    if (order.status !== 'paid' && order.status !== 'refunded') {
      throw new BadRequestException(
        `cannot submit order in status=${order.status}; only paid/refunded orders are eligible`,
      );
    }
    if (order.documentType === 'RE' && !settings.vatRegistered) {
      // Plain receipts from non-VAT merchants don't go to ETDA.
      throw new BadRequestException('plain receipts (RE) from non-VAT merchants do not require submission');
    }

    const dto = this.buildDto(order as typeof posOrders.$inferSelect, settings);
    const { xml, hash, etdaCode } = this.builder.build(dto);

    const validation = this.validator.validate(xml);
    if (!validation.valid) {
      throw new BadRequestException(
        `generated XML failed structural validation: ${validation.errors.join('; ')}`,
      );
    }

    // Idempotent upsert — find existing pending or rebuild on prior error
    const existing = await this.db
      .select()
      .from(etaxSubmissions)
      .where(
        and(eq(etaxSubmissions.orderId, orderId), eq(etaxSubmissions.provider, provider)),
      )
      .limit(1);

    let submissionId: string;
    if (existing.length > 0) {
      const row = existing[0];
      if (row.status === 'acknowledged') {
        return {
          submissionId: row.id,
          status: 'acknowledged',
          rdReference: row.rdReference,
          providerReference: row.providerReference,
          retryable: false,
        };
      }
      submissionId = row.id;
      // Refresh payload + hash in case the order was edited (rare, but possible)
      await this.db
        .update(etaxSubmissions)
        .set({
          xmlPayload: xml,
          xmlHash: hash,
          status: 'pending',
          attempts: row.attempts + 1,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(etaxSubmissions.id, submissionId));
    } else {
      const [inserted] = await this.db
        .insert(etaxSubmissions)
        .values({
          orderId,
          documentType: order.documentType,
          documentNumber: order.documentNumber ?? `unallocated-${orderId.slice(0, 8)}`,
          etdaCode,
          provider,
          status: 'pending',
          xmlPayload: xml,
          xmlHash: hash,
          attempts: 1,
        })
        .returning({ id: etaxSubmissions.id });
      submissionId = inserted.id;
    }

    const adapter = provider === 'leceipt' ? this.leceipt : this.inet;
    const submissionInput: EtaxSubmissionInput = {
      documentNumber: dto.documentNumber,
      documentType: dto.documentType,
      etdaCode,
      xml,
      xmlHash: hash,
      buyerEmail: dto.buyer?.email,
    };

    const result = await adapter.submit(submissionInput);

    let finalStatus: typeof etaxSubmissions.$inferInsert.status = 'pending';
    if (result.status === 'success') finalStatus = 'acknowledged';
    else if (result.status === 'rejected') finalStatus = 'rejected';
    else if (result.status === 'error') finalStatus = 'pending'; // leave for relay retry

    await this.db
      .update(etaxSubmissions)
      .set({
        status: finalStatus,
        providerReference: result.providerReference ?? null,
        rdReference: result.rdReference ?? null,
        providerResponse: (result.raw ?? null) as any,
        ackTimestamp: result.ackTimestamp ?? null,
        lastError: result.message ?? null,
        updatedAt: new Date(),
      })
      .where(eq(etaxSubmissions.id, submissionId));

    return {
      submissionId,
      status:
        result.status === 'success'
          ? 'acknowledged'
          : result.status === 'rejected'
            ? 'rejected'
            : result.status === 'pending'
              ? 'pending'
              : 'error',
      rdReference: result.rdReference ?? null,
      providerReference: result.providerReference ?? null,
      retryable: result.retryable ?? false,
    };
  }

  /**
   * Build a TaxInvoiceDto from a POS order row and the org snapshot.
   * Pure transformation — no DB access; testable in isolation.
   */
  buildDto(
    order: typeof posOrders.$inferSelect,
    settings: Awaited<ReturnType<OrganizationService['snapshot']>>,
  ): TaxInvoiceDto {
    const lines = (order.orderLines as Array<{
      productId: string;
      name: string;
      qty: number;
      unitPriceCents: number;
      discountCents?: number;
      vatCategory?: 'standard' | 'zero_rated' | 'exempt';
      netCents?: number;
      vatCents?: number;
      grossCents?: number;
      sku?: string;
    }>).map((l, i) => ({
      lineNo: i + 1,
      name: l.name,
      qty: l.qty,
      unitPriceCents: l.unitPriceCents,
      discountCents: l.discountCents ?? 0,
      vatCategory: (l.vatCategory ?? 'standard') as 'standard' | 'zero_rated' | 'exempt',
      netCents: l.netCents ?? l.qty * l.unitPriceCents,
      vatCents: l.vatCents ?? 0,
      grossCents: l.grossCents ?? l.qty * l.unitPriceCents,
      sku: l.sku,
    }));

    const breakdown = (order.vatBreakdown as
      | {
          taxableNetCents: number;
          zeroRatedNetCents: number;
          exemptNetCents: number;
          vatCents: number;
          grossCents: number;
        }
      | null) ?? {
      taxableNetCents: order.subtotalCents,
      zeroRatedNetCents: 0,
      exemptNetCents: 0,
      vatCents: order.taxCents,
      grossCents: order.totalCents,
    };

    return {
      orderId: order.id,
      documentType: order.documentType as 'RE' | 'ABB' | 'TX' | 'CN' | 'DN',
      documentNumber: order.documentNumber ?? `unallocated-${order.id.slice(0, 8)}`,
      issueDate: order.createdAt ?? new Date(),
      currency: order.currency,
      seller: {
        name: settings.sellerName,
        tin: settings.sellerTin ?? undefined,
        branch: settings.sellerBranch,
        address: settings.sellerAddress,
        countryCode: 'TH',
      },
      buyer: order.buyerName
        ? {
            name: order.buyerName,
            tin: order.buyerTin ?? undefined,
            branch: order.buyerBranch ?? undefined,
            address: order.buyerAddress ?? undefined,
            countryCode: 'TH',
          }
        : undefined,
      lines,
      totals: {
        subtotalCents: order.subtotalCents,
        vatCents: order.taxCents,
        grandTotalCents: order.totalCents,
        taxableNetCents: breakdown.taxableNetCents,
        zeroRatedNetCents: breakdown.zeroRatedNetCents,
        exemptNetCents: breakdown.exemptNetCents,
      },
      originalDocument:
        order.originalOrderId &&
        (order.documentType === 'CN' || order.documentType === 'DN')
          ? {
              documentNumber: `referenced-${order.originalOrderId.slice(0, 8)}`,
              issueDate: order.createdAt ?? new Date(),
            }
          : undefined,
      reason: (order.paymentDetails as any)?.refundReason as string | undefined,
    };
  }

  /** Read submission status (for the controller / dashboards). */
  async getStatus(orderId: string): Promise<Array<typeof etaxSubmissions.$inferSelect>> {
    return this.db
      .select()
      .from(etaxSubmissions)
      .where(eq(etaxSubmissions.orderId, orderId));
  }
}
