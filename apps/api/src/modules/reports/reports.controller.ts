import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { PP30Service } from './pp30.service';
import { Pp30ReconciliationService } from './pp30-reconciliation.service';
import { PndService, type PndForm } from './pnd.service';
import { InputVatExpiryService } from './input-vat-expiry.service';
import { GoodsReportService } from './goods-report.service';
import { InsightsService } from './insights.service';
import { SequenceAuditService } from './sequence-audit.service';
import { TimeseriesService, type Granularity } from './timeseries.service';
import { CustomersAnalysisService } from './customers-analysis.service';
import { OrganizationService } from '../organization/organization.service';
import { Roles } from '../auth/jwt-auth.guard';

type Reply = { type(mime: string): Reply; header(name: string, value: string): Reply; send(body: unknown): void };


@Controller('api/reports')
export class ReportsController {
  constructor(
    private readonly pp30: PP30Service,
    private readonly pp30Recon: Pp30ReconciliationService,
    private readonly pnd: PndService,
    private readonly inputVatExpiry: InputVatExpiryService,
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
  @Roles('admin', 'accountant')
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
  @Roles('admin', 'accountant')
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

  /**
   * 🇹🇭 PP.30 ↔ GL reconciliation. Compares the PP.30 form (computed from
   * pos_orders.vat_breakdown) against the GL VAT accounts (2201/1155). Flags
   * variance > ฿1 — the most expensive Phase 4 bug class to miss.
   */
  @Get('pp30/reconcile')
  @Roles('admin', 'accountant')
  async pp30Reconcile(@Query('year') year?: string, @Query('month') month?: string) {
    await this.assertThaiMode();
    const y = Number(year ?? new Date().getUTCFullYear());
    const m = Number(month ?? new Date().getUTCMonth() + 1);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new BadRequestException('year out of range');
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new BadRequestException('month must be 1..12');
    }
    return this.pp30Recon.forMonth(y, m);
  }

  /**
   * 🇹🇭 PND.3 / PND.53 / PND.54 — monthly WHT remittance.
   * Routing is automatic: bills paid to citizens → PND.3, juristic → PND.53,
   * foreign / no-Thai-TIN → PND.54. JSON form for the UI.
   */
  @Get('pnd/:form')
  @Roles('admin', 'accountant')
  async pndForm(
    @Param('form') form: string,
    @Query('year') year?: string,
    @Query('month') month?: string,
  ) {
    await this.assertThaiMode();
    const f = form.toUpperCase() as PndForm;
    if (f !== 'PND3' && f !== 'PND53' && f !== 'PND54') {
      throw new BadRequestException('form must be PND3, PND53, or PND54');
    }
    const y = Number(year ?? new Date().getUTCFullYear());
    const m = Number(month ?? new Date().getUTCMonth() + 1);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new BadRequestException('year out of range');
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new BadRequestException('month must be 1..12');
    }
    return this.pnd.forMonth(f, y, m);
  }

  /**
   * 🇹🇭 Input VAT 6-month expiry tracker (§82/3 / §2.8).
   * Lists draft bills approaching the 6-month claim window or already past
   * it (PERMANENT loss) plus already-claimed bills for context. Read-only —
   * does NOT auto-reclass. Default scope is the trailing 12 months.
   */
  @Get('input-vat-expiry')
  @Roles('admin', 'accountant')
  async inputVatExpiryReport(@Query('from') from?: string, @Query('to') to?: string) {
    await this.assertThaiMode();
    return this.inputVatExpiry.report({ from, to });
  }

  /** RD e-filing CSV template for one of the PND forms. */
  @Get('pnd/:form/csv')
  @Roles('admin', 'accountant')
  async pndCsv(
    @Param('form') form: string,
    @Query('year') year: string,
    @Query('month') month: string,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    await this.assertThaiMode();
    const f = form.toUpperCase() as PndForm;
    if (f !== 'PND3' && f !== 'PND53' && f !== 'PND54') {
      throw new BadRequestException('form must be PND3, PND53, or PND54');
    }
    const y = Number(year);
    const m = Number(month);
    const report = await this.pnd.forMonth(f, y, m);
    const csv = this.pnd.toCsv(report);
    reply
      .type('text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename=${f.toLowerCase()}-${y}${String(m).padStart(2, '0')}.csv`,
      )
      .send(csv);
  }

  @Get('pp30.xlsx')
  @Roles('admin', 'accountant')
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
  @Roles('admin', 'accountant')
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
  @Roles('admin', 'accountant')
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
  @Roles('admin', 'accountant')
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
