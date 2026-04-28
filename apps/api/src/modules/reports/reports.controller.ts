import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { PP30Service } from './pp30.service';
import { GoodsReportService } from './goods-report.service';
import { InsightsService } from './insights.service';
import { SequenceAuditService } from './sequence-audit.service';
import { TimeseriesService, type Granularity } from './timeseries.service';
import { CustomersAnalysisService } from './customers-analysis.service';
import { OrganizationService } from '../organization/organization.service';
import { JwtAuthGuard, Roles } from '../auth/jwt-auth.guard';

type Reply = { type(mime: string): Reply; header(name: string, value: string): Reply; send(body: unknown): void };


@Controller('api/reports')
export class ReportsController {
  constructor(
    private readonly pp30: PP30Service,
    private readonly goodsReport: GoodsReportService,
    private readonly insights: InsightsService,
    private readonly sequences: SequenceAuditService,
    private readonly timeseries: TimeseriesService,
    private readonly customers: CustomersAnalysisService,
    private readonly org: OrganizationService,
  ) {}

  private async assertThaiMode() {
    const settings = await this.org.snapshot();
    if (settings.countryMode !== 'TH') {
      throw new NotFoundException(
        'PP.30 is a Thai Revenue Department filing — only available in Thai mode',
      );
    }
  }

  @Get('pp30')
  async pp30Summary(@Query('year') year?: string, @Query('month') month?: string) {
    await this.assertThaiMode();
    const y = Number(year ?? new Date().getUTCFullYear());
    const m = Number(month ?? new Date().getUTCMonth() + 1);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new BadRequestException('year out of range');
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new BadRequestException('month must be 1..12');
    }
    return this.pp30.forMonth(y, m);
  }

  @Get('pp30.csv')
  async pp30Csv(
    @Query('year') year: string,
    @Query('month') month: string,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    await this.assertThaiMode();
    const y = Number(year);
    const m = Number(month);
    const csv = await this.pp30.monthlySalesCsv(y, m);
    reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename=pp30-${y}${String(m).padStart(2, '0')}.csv`)
      .send(csv);
  }

  @Get('pp30.xlsx')
  async pp30Xlsx(
    @Query('year') year: string,
    @Query('month') month: string,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    await this.assertThaiMode();
    const y = Number(year);
    const m = Number(month);
    const buf = await this.pp30.monthlyXlsx(y, m);
    reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'Content-Disposition',
        `attachment; filename=pp30-${y}${String(m).padStart(2, '0')}.xlsx`,
      )
      .send(buf);
  }

  /**
   * 🇹🇭 Daily Inventory & Goods Report (รายงานสินค้าและวัตถุดิบ)
   * per RD Director-General Notice No. 89 §9.
   *
   * Query params:
   *   from=YYYY-MM-DD (default: today − 7d)
   *   to=YYYY-MM-DD   (default: today)
   *   branch=00000    (optional, filters by branch code)
   */
  @Get('goods-report')
  async goodsReportJson(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branch') branch?: string,
  ) {
    await this.assertThaiMode();
    const today = new Date().toISOString().slice(0, 10);
    const defaultFrom = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return d.toISOString().slice(0, 10);
    })();
    return this.goodsReport.getReport({
      fromDate: from ?? defaultFrom,
      toDate: to ?? today,
      branchCode: branch,
    });
  }

  @Get('goods-report.csv')
  async goodsReportCsv(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('branch') branch: string | undefined,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    await this.assertThaiMode();
    const { rows } = await this.goodsReport.getReport({
      fromDate: from,
      toDate: to,
      branchCode: branch,
    });
    const csv = this.goodsReport.toCsv(rows);
    reply
      .type('text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename=goods-report-${from}_to_${to}.csv`,
      )
      .send(csv);
  }

  /**
   * Sales Insights — payment mix, hourly heatmap, doc-type compliance signal,
   * period comparison. Available in any country mode.
   *
   *   from / to: ISO datetime, default last 30 days
   */
  @Get('insights')
  async insightsReport(@Query('from') from?: string, @Query('to') to?: string) {
    return this.insights.report({ fromIso: from, toIso: to });
  }

  /**
   * Time-series buckets sized for charts. The dashboard time-range toggle
   * (Today / 7d / Month / Quarter / Year) maps to (hour / day / day / week / month).
   *
   *   from, to: ISO datetime (required)
   *   granularity: hour | day | week | month | quarter | year
   */
  @Get('timeseries')
  async timeseriesReport(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('granularity') granularity: Granularity = 'day',
  ) {
    if (!from || !to) {
      throw new BadRequestException('from and to are required (ISO datetime)');
    }
    const allowed: Granularity[] = ['hour', 'day', 'week', 'month', 'quarter', 'year'];
    if (!allowed.includes(granularity)) {
      throw new BadRequestException(`granularity must be one of ${allowed.join(', ')}`);
    }
    try {
      return await this.timeseries.report({ fromIso: from, toIso: to, granularity });
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'invalid window');
    }
  }

  /**
   * Customer concentration + ranking. Admin only — touches buyer PII.
   * Pulls from pos_orders.buyer_name / buyer_tin; walk-ins (no buyer captured)
   * are aggregated under a single "Walk-in" row.
   */
  @Get('customers-analysis')
  @UseGuards(JwtAuthGuard)
  @Roles('admin')
  async customersReport(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from
      ? new Date(from)
      : new Date(toDate.getTime() - 90 * 24 * 60 * 60 * 1000);
    return this.customers.report({
      fromIso: fromDate.toISOString(),
      toIso: toDate.toISOString(),
    });
  }

  /**
   * 🇹🇭 Document sequence gap audit (§86 — no gaps allowed).
   * Returns one row per (documentType, period). Empty `missing` array per row
   * means clean. Available in any country mode (sequences exist regardless).
   */
  @Get('sequences')
  async sequenceAudit() {
    return this.sequences.audit();
  }

  @Get('goods-report.pdf')
  async goodsReportPdf(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('branch') branch: string | undefined,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    await this.assertThaiMode();
    const settings = await this.org.snapshot();
    const { rows, summary } = await this.goodsReport.getReport({
      fromDate: from,
      toDate: to,
      branchCode: branch,
    });
    const pdf = await this.goodsReport.toPdf(summary, rows, {
      name: settings.sellerName ?? 'ERP-POS Merchant',
      tin: settings.sellerTin,
      branchCode: settings.sellerBranch,
    });
    reply
      .type('application/pdf')
      .header(
        'Content-Disposition',
        `attachment; filename=goods-report-${from}_to_${to}.pdf`,
      )
      .send(pdf);
  }
}
