import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { Logger, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { posOrders, etaxSubmissions, type Database } from '@erp/db';
import { OrderCompletedEvent } from '../../../pos/domain/events';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { OrganizationService } from '../../../organization/organization.service';
import { TaxInvoiceXmlBuilder } from '../../services/tax-invoice-xml-builder';
import { EtdaXsdValidator } from '../../validators/etda-xsd.validator';
import { EtaxSubmissionService } from '../../services/etax-submission.service';

/**
 * 🇹🇭 Auto-queue eligible orders for e-Tax submission on OrderCompletedEvent.
 *
 * Eligibility:
 *   - Country mode = TH
 *   - Org is VAT-registered
 *   - Document type is TX/ABB/CN/DN (not RE — plain receipts skip ETDA)
 *
 * What this handler does:
 *   - Builds the XML, validates it (TIER 1 structural)
 *   - Inserts a `pending` submission row in custom.etax_submissions
 *
 * What this handler does NOT do:
 *   - Actually call the ASP. That's the BullMQ relay's job (Phase 4B Stage 2).
 *     Until that exists, the row sits at `pending` and operators can drain it
 *     manually via POST /api/etax/orders/:id/submit.
 *
 * Best-effort like the Odoo handler — never blocks the POS. If the build/validate
 * step fails, log a warning and move on; the operator can re-queue from the UI.
 */
@EventsHandler(OrderCompletedEvent)
export class OnOrderCompletedEtax implements IEventHandler<OrderCompletedEvent> {
  private readonly logger = new Logger(OnOrderCompletedEtax.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly org: OrganizationService,
    private readonly submission: EtaxSubmissionService,
    private readonly builder: TaxInvoiceXmlBuilder,
    private readonly validator: EtdaXsdValidator,
  ) {}

  async handle(event: OrderCompletedEvent) {
    try {
      const settings = await this.org.snapshot();
      if (settings.countryMode !== 'TH' || !settings.vatRegistered) return;

      const [order] = await this.db
        .select()
        .from(posOrders)
        .where(eq(posOrders.id, event.orderId))
        .limit(1);
      if (!order) return;
      if (!['TX', 'ABB', 'CN', 'DN'].includes(order.documentType)) return;
      if (!order.documentNumber) {
        this.logger.warn(`order ${order.id} missing documentNumber; skipping etax queue`);
        return;
      }

      // Don't double-queue: if any submission row exists for this order, skip.
      const existing = await this.db
        .select({ id: etaxSubmissions.id })
        .from(etaxSubmissions)
        .where(eq(etaxSubmissions.orderId, order.id))
        .limit(1);
      if (existing.length > 0) return;

      const dto = this.submission.buildDto(order, settings);
      const { xml, hash, etdaCode } = this.builder.build(dto);
      const validation = this.validator.validate(xml);
      if (!validation.valid) {
        this.logger.warn(
          `XML for order ${order.documentNumber} failed validation; not queued: ${validation.errors.join('; ')}`,
        );
        return;
      }

      await this.db.insert(etaxSubmissions).values({
        orderId: order.id,
        documentType: order.documentType,
        documentNumber: order.documentNumber,
        etdaCode,
        provider: 'leceipt',
        status: 'pending',
        xmlPayload: xml,
        xmlHash: hash,
        attempts: 0,
      });
      this.logger.log(
        `Queued e-Tax submission for ${order.documentType} ${order.documentNumber} (${etdaCode})`,
      );
    } catch (err: any) {
      // Never fail an order on this handler.
      this.logger.warn(`e-Tax queueing skipped for order ${event.orderId}: ${err?.message ?? err}`);
    }
  }
}
