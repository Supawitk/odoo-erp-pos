import { Module } from '@nestjs/common';
import { PP30Service } from './pp30.service';
import { GoodsReportService } from './goods-report.service';
import { GoodsReportCronService } from './goods-report-cron.service';
import { InsightsService } from './insights.service';
import { SequenceAuditService } from './sequence-audit.service';
import { ReportsController } from './reports.controller';
import { OrganizationModule } from '../organization/organization.module';

@Module({
  imports: [OrganizationModule],
  controllers: [ReportsController],
  providers: [
    PP30Service,
    GoodsReportService,
    GoodsReportCronService,
    InsightsService,
    SequenceAuditService,
  ],
  exports: [PP30Service, GoodsReportService, InsightsService, SequenceAuditService],
})
export class ReportsModule {}
