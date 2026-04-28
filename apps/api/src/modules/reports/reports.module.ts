import { Module } from '@nestjs/common';
import { PP30Service } from './pp30.service';
import { GoodsReportService } from './goods-report.service';
import { GoodsReportCronService } from './goods-report-cron.service';
import { InsightsService } from './insights.service';
import { SequenceAuditService } from './sequence-audit.service';
import { TimeseriesService } from './timeseries.service';
import { CustomersAnalysisService } from './customers-analysis.service';
import { ReportsController } from './reports.controller';
import { OrganizationModule } from '../organization/organization.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [OrganizationModule, AuthModule],
  controllers: [ReportsController],
  providers: [
    PP30Service,
    GoodsReportService,
    GoodsReportCronService,
    InsightsService,
    SequenceAuditService,
    TimeseriesService,
    CustomersAnalysisService,
  ],
  exports: [
    PP30Service,
    GoodsReportService,
    InsightsService,
    SequenceAuditService,
    TimeseriesService,
    CustomersAnalysisService,
  ],
})
export class ReportsModule {}
