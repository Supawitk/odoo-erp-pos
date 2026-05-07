import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { OrganizationModule } from '../organization/organization.module';
import { AuthModule } from '../auth/auth.module';
import { TaxInvoiceXmlBuilder } from './services/tax-invoice-xml-builder';
import { EtaxSubmissionService } from './services/etax-submission.service';
import { EtaxRelayService } from './services/etax-relay.service';
import { EtdaXsdValidator } from './validators/etda-xsd.validator';
import { LeceiptAdapter } from './adapters/leceipt.adapter';
import { InetAdapter } from './adapters/inet.adapter';
import { EtaxController } from './presentation/etax.controller';
import { OnOrderCompletedEtax } from './application/events/on-order-completed-etax.handler';

/**
 * 🇹🇭 e-Tax module (Phase 4B).
 *
 * Listens to OrderCompletedEvent (from PosModule) and auto-queues eligible
 * VAT-registered Thai orders for ETDA submission. Exposes preview + submit
 * + status endpoints. Default ASP is Leceipt; INET is the failover.
 */
@Module({
  imports: [CqrsModule, OrganizationModule, AuthModule],
  controllers: [EtaxController],
  providers: [
    TaxInvoiceXmlBuilder,
    EtdaXsdValidator,
    LeceiptAdapter,
    InetAdapter,
    EtaxSubmissionService,
    EtaxRelayService,
    OnOrderCompletedEtax,
  ],
  exports: [EtaxSubmissionService, EtaxRelayService, TaxInvoiceXmlBuilder, EtdaXsdValidator],
})
export class EtaxModule {}
