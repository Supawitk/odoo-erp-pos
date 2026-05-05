import { Module } from '@nestjs/common';
import { PP30Service } from './pp30.service';
import { Pp30ReconciliationService } from './pp30-reconciliation.service';
import { PndService } from './pnd.service';
import { InputVatExpiryService } from './input-vat-expiry.service';
import { InputVatReclassService } from './input-vat-reclass.service';
import { Pp30ClosingService } from './pp30-closing.service';
import { GoodsReportService } from './goods-report.service';
import { GoodsReportCronService } from './goods-report-cron.service';
import { InsightsService } from './insights.service';
import { SequenceAuditService } from './sequence-audit.service';
import { TimeseriesService } from './timeseries.service';
import { CustomersAnalysisService } from './customers-analysis.service';
import { InventorySnapshotService } from './inventory-snapshot.service';
import { MatchExceptionsService } from './match-exceptions.service';
import { VatMixService } from './vat-mix.service';
import { ProfitabilityService } from './profitability.service';
import { CohortsService } from './cohorts.service';
import { WhtRollupService } from './wht-rollup.service';
import { AuditAnomaliesService } from './audit-anomalies.service';
import { CitService } from './cit.service';
import { NonDeductibleService } from './non-deductible.service';
import { ReportsController } from './reports.controller';
import { OrganizationModule } from '../organization/organization.module';
import { AuthModule } from '../auth/auth.module';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [OrganizationModule, AuthModule, AccountingModule],
  controllers: [ReportsController],
  providers: [
    PP30Service,
    Pp30ReconciliationService,
    PndService,
    InputVatExpiryService,
    InputVatReclassService,
    Pp30ClosingService,
    GoodsReportService,
    GoodsReportCronService,
    InsightsService,
    SequenceAuditService,
    TimeseriesService,
    CustomersAnalysisService,
    InventorySnapshotService,
    MatchExceptionsService,
    VatMixService,
    ProfitabilityService,
    CohortsService,
    WhtRollupService,
    AuditAnomaliesService,
    NonDeductibleService,
    CitService,
  ],
  exports: [
    PP30Service,
    Pp30ReconciliationService,
    PndService,
    InputVatExpiryService,
    InputVatReclassService,
    Pp30ClosingService,
    GoodsReportService,
    InsightsService,
    SequenceAuditService,
    TimeseriesService,
    CustomersAnalysisService,
    InventorySnapshotService,
    MatchExceptionsService,
    VatMixService,
    ProfitabilityService,
    CohortsService,
    WhtRollupService,
    AuditAnomaliesService,
    NonDeductibleService,
  ],
})
export class ReportsModule {}
