import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { PP30Service } from './pp30.service';
import { Pp30ReconciliationService } from './pp30-reconciliation.service';
import { PndService, type PndForm } from './pnd.service';
import { InputVatExpiryService } from './input-vat-expiry.service';
import { InputVatReclassService } from './input-vat-reclass.service';
import { Pp30ClosingService } from './pp30-closing.service';
import { GoodsReportService } from './goods-report.service';
import { InsightsService } from './insights.service';
import { SequenceAuditService } from './sequence-audit.service';
import { TimeseriesService, type Granularity } from './timeseries.service';
import { CustomersAnalysisService } from './customers-analysis.service';
import { InventorySnapshotService } from './inventory-snapshot.service';
import { MatchExceptionsService } from './match-exceptions.service';
import { VatMixService } from './vat-mix.service';
import { ProfitabilityService } from './profitability.service';
import { CohortsService } from './cohorts.service';
import { WhtRollupService } from './wht-rollup.service';
import { AuditAnomaliesService } from './audit-anomalies.service';
import { CitService } from './cit.service';
import { buildCitXlsx } from './cit-xlsx.builder';
import { NonDeductibleService } from './non-deductible.service';
import { parseCategory } from './non-deductible.calculator';
import { PP36Service } from './pp36.service';
import { CashBookService } from './cash-book.service';
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
    private readonly inputVatReclass: InputVatReclassService,
    private readonly pp30Close: Pp30ClosingService,
    private readonly goodsReport: GoodsReportService,
    private readonly insights: InsightsService,
    private readonly sequences: SequenceAuditService,
    private readonly timeseries: TimeseriesService,
    private readonly customers: CustomersAnalysisService,
    private readonly inventorySnap: InventorySnapshotService,
    private readonly matchEx: MatchExceptionsService,
    private readonly vatMix: VatMixService,
    private readonly profitability: ProfitabilityService,
    private readonly cohorts: CohortsService,
    private readonly whtRollup: WhtRollupService,
    private readonly auditAnomalies: AuditAnomaliesService,
    private readonly cit: CitService,
    private readonly nonDeductible: NonDeductibleService,
    private readonly pp36: PP36Service,
    private readonly cashBook: CashBookService,
    private readonly org: OrganizationService,
  ) {}

  /** Normalise PND form param: accept shorthand (3, 53, 54) or canonical (PND3, PND53, PND54). */
  private normalisePndForm(raw: string): PndForm {
    const up = raw.toUpperCase();
    const form = (['3', '53', '54'].includes(up) ? `PND${up}` : up) as PndForm;
    if (form !== 'PND3' && form !== 'PND53' && form !== 'PND54') {
      throw new BadRequestException('form must be PND3, PND53, or PND54 (shorthand 3/53/54 also accepted)');
    }
    return form;
  }

  private async assertThaiMode() {
    const settings = await this.org.snapshot();
    if (settings.countryMode !== 'TH') {
      throw new NotFoundException(
        'This is a Thai Revenue Department report — only available in Thai mode',
      );
    }
  }

  /**
   * Stricter gate for PP.30 / Input VAT endpoints. PND (withholding) is the
   * payer's obligation regardless of VAT status, but PP.30 only matters once
   * the merchant is VAT-registered (annual revenue > ฿1.8M and registered with
   * the RD). Returning "not enabled" instead of zeroed reports prevents users
   * from filing a misleadingly empty PP.30.
   */
  private async assertThaiVatRegistered() {
    const settings = await this.org.snapshot();
    if (settings.countryMode !== 'TH') {
      throw new NotFoundException(
        'PP.30 is a Thai Revenue Department filing — only available in Thai mode',
      );
    }
    if (!settings.vatRegistered) {
      throw new NotFoundException(
        'PP.30 only applies to VAT-registered merchants — enable VAT registration in Settings',
      );
    }
  }

  @Get('pp30')
  @Roles('admin', 'accountant')
  async pp30Summary(@Query('year') year?: string, @Query('month') month?: string) {
    await this.assertThaiVatRegistered();
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
    await this.assertThaiVatRegistered();
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
    await this.assertThaiVatRegistered();
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
   * 🇹🇭 PP.30 monthly close — preview the would-be settlement journal.
   * Read-only. Computes output VAT (net of CN/DN), eligible input VAT, the
   * net payable / refund, and the GL line blueprint. Surfaces an existing
   * filing if the period is already closed.
   */
  @Get('pp30/close/preview')
  @Roles('admin', 'accountant')
  async pp30ClosePreview(@Query('year') year?: string, @Query('month') month?: string) {
    await this.assertThaiVatRegistered();
    const y = Number(year ?? new Date().getUTCFullYear());
    const m = Number(month ?? new Date().getUTCMonth() + 1);
    return this.pp30Close.preview(y, m);
  }

  /**
   * 🇹🇭 PP.30 close — POSTS the settlement journal and stamps every
   * contributing pos_order + vendor_bill. Admin-only because it touches the
   * trial balance + makes the period read-only against re-claim.
   */
  @Post('pp30/close')
  @Roles('admin')
  async runPp30Close(
    @Body()
    body: {
      year: number;
      month: number;
      filedBy?: string;
      rdFilingReference?: string;
      notes?: string;
    },
  ) {
    await this.assertThaiVatRegistered();
    return this.pp30Close.close(Number(body.year), Number(body.month), {
      filedBy: body.filedBy ?? null,
      rdFilingReference: body.rdFilingReference,
      notes: body.notes,
    });
  }

  /** GET the active filing for a period (null if none). */
  @Get('pp30/filing')
  @Roles('admin', 'accountant')
  async pp30Filing(@Query('year') year?: string, @Query('month') month?: string) {
    await this.assertThaiVatRegistered();
    const y = Number(year ?? new Date().getUTCFullYear());
    const m = Number(month ?? new Date().getUTCMonth() + 1);
    return { filing: await this.pp30Close.findActiveFiling(y, m) };
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
    const f = this.normalisePndForm(form);
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
    await this.assertThaiVatRegistered();
    return this.inputVatExpiry.report({ from, to });
  }

  /**
   * 🇹🇭 Preview the bills the §82/3 reclass cron would touch tonight.
   * Read-only — surface for the operator to sanity-check before pulling the
   * trigger manually or letting the daily cron at 04:30 ICT do it.
   */
  @Get('input-vat-reclass/preview')
  @Roles('admin', 'accountant')
  async inputVatReclassPreview(@Query('asOf') asOf?: string) {
    await this.assertThaiVatRegistered();
    return this.inputVatReclass.preview({ asOf });
  }

  /**
   * 🇹🇭 Run the §82/3 reclass NOW. Manual trigger for the same code path the
   * daily cron runs — accepts an optional dryRun flag to surface the plan
   * without writing to the GL. Admin-only because it posts journal entries
   * that affect the trial balance.
   */
  @Post('input-vat-reclass/run')
  @Roles('admin')
  async inputVatReclassRun(@Body() body: { asOf?: string; dryRun?: boolean } = {}) {
    await this.assertThaiVatRegistered();
    return this.inputVatReclass.run({ asOf: body.asOf, dryRun: body.dryRun ?? false });
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
    const f = this.normalisePndForm(form);
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

  /**
   * 🇹🇭 v1.0 RD-Prep input format — the format real-world Thai SMEs use today.
   *
   * Pipeline: download this `.txt` → open in RD Prep (Windows desktop, from
   * rd.go.th) → RD Prep validates + writes `.rdx` → upload `.rdx` to efiling.
   *
   * No header row, ~16-17 fields per detail line, pipe-delimited UTF-8 with
   * CRLF line endings. Field layout matches OCA `l10n_th_account_tax_report`
   * defaults so files are interchangeable with what users already file via Odoo.
   */
  @Get('pnd/:form/rd-upload-v1')
  @Roles('admin', 'accountant')
  async pndRdUploadV1(
    @Param('form') form: string,
    @Query('year') year: string,
    @Query('month') month: string,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    await this.assertThaiMode();
    const f = this.normalisePndForm(form);
    const y = Number(year);
    const m = Number(month);
    const settings = await this.org.snapshot();
    if (!settings.sellerTin) {
      throw new BadRequestException(
        'sellerTin must be configured in Settings before generating an RD upload',
      );
    }
    const report = await this.pnd.forMonth(f, y, m);
    const { filename, content } = this.pnd.toRdUploadV1(report, {
      payerTin: settings.sellerTin,
      payerBranch: (settings.sellerBranch || '00000').padStart(6, '0'),
      formType: '00',
    });
    reply
      .type('text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(content);
  }

  /**
   * 🇹🇭 v2.0 (FORMAT กลาง / SWC API) — RD's newer Software Component pipeline.
   * Pipe-delimited UTF-8 with H header + D detail rows. Designed for software
   * vendors enrolled with RD as integration partners; SMEs filing on their own
   * use v1.0 (RD Prep input) above instead.
   *
   * PND.3 / PND.53 are spec-compliant per FORMAT กลาง v2.0 (16/06/2568).
   * PND.54 emits the same shape but is a best-effort fallback — RD has not
   * published a v2.0 batch spec for §70 (foreign payments).
   */
  @Get('pnd/:form/rd-upload')
  @Roles('admin', 'accountant')
  async pndRdUpload(
    @Param('form') form: string,
    @Query('year') year: string,
    @Query('month') month: string,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    await this.assertThaiMode();
    const f = this.normalisePndForm(form);
    const y = Number(year);
    const m = Number(month);
    const settings = await this.org.snapshot();
    if (!settings.sellerTin) {
      throw new BadRequestException(
        'sellerTin must be configured in Settings before generating an RD upload',
      );
    }
    const report = await this.pnd.forMonth(f, y, m);
    const { filename, content } = this.pnd.toRdUpload(report, {
      // SENDER_ID: 4-char sender code. v2.0 spec PND.53 row 2 says
      // "for media-submission filers, use `0000`". RD assigns non-default codes
      // when a software vendor enrols for the SWC API.
      senderId: '0000',
      payerTin: settings.sellerTin,
      payerBranch: (settings.sellerBranch || '00000').padStart(6, '0'),
      senderRole: '1',
      lto: '0',
      deptName: '',
      userId: settings.sellerTin,
      branchType: '',
      formType: '00',
    });
    reply
      .type('text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(content);
  }

  @Get('pp30.xlsx')
  @Roles('admin', 'accountant')
  async pp30Xlsx(
    @Query('year') year: string,
    @Query('month') month: string,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    await this.assertThaiVatRegistered();
    const y = Number(year);
    const m = Number(month);
    // 🇹🇭 Pull merchant identity for the 2026-03-01 PP.30 layout: seller block
    // at top + PromptPay refund channel at bottom. The XLSX silently drops to
    // the legacy summary-only layout if `merchant` is omitted, so the call
    // remains backwards-compatible if the org row is somehow null.
    const settings = await this.org.snapshot();
    const buf = await this.pp30.monthlyXlsx(y, m, {
      sellerName: settings.sellerName ?? '',
      sellerTin: settings.sellerTin,
      sellerBranch: settings.sellerBranch ?? '00000',
      sellerAddress: settings.sellerAddress ?? '',
      promptpayRefundId: settings.promptpayRefundId,
    });
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

  // ─── Tier 2 Money Snapshot — admin-only roll-ups ───────────────────────

  /**
   * Inventory cash + reorder + velocity. Value = Σ qty_on_hand × avg_cost_cents
   * across active SKUs; velocity = stock_moves bucketed by move_type within
   * the optional [from, to) window (defaults to last 30 days).
   */
  @Get('inventory-snapshot')
  @Roles('admin', 'accountant')
  async inventorySnapshotReport(@Query('from') from?: string, @Query('to') to?: string) {
    return this.inventorySnap.report({ fromIso: from, toIso: to });
  }

  /**
   * Three-way-match exceptions: vendor bills that haven't been reconciled to
   * a PO+GRN (NULL match_status or != 'matched'). Voided bills excluded.
   */
  @Get('match-exceptions')
  @Roles('admin', 'accountant')
  async matchExceptionsReport() {
    return this.matchEx.report();
  }

  /**
   * 🇹🇭 VAT mix — taxable / zero-rated / exempt revenue split + total output
   * VAT for the window. Same source as PP.30 (pos_orders.vat_breakdown), so
   * useful as a live preview before month-end.
   */
  @Get('vat-mix')
  @Roles('admin', 'accountant')
  async vatMixReport(@Query('from') from?: string, @Query('to') to?: string) {
    return this.vatMix.report({ fromIso: from, toIso: to });
  }

  // ─── Tier 3 Deep Analytics — admin-only ─────────────────────────────────

  /**
   * Revenue − COGS by product + by category. COGS uses CURRENT
   * products.avg_cost_cents (approximate). The report's `cogsCoveragePct`
   * surfaces what fraction of revenue we have a cost basis for.
   */
  @Get('profitability')
  @Roles('admin', 'accountant')
  async profitabilityReport(@Query('from') from?: string, @Query('to') to?: string) {
    return this.profitability.report({ fromIso: from, toIso: to });
  }

  /**
   * Customer cohort retention. Walk-ins (no buyer_tin) excluded from the
   * cohort math but reported separately so the merchant can see anonymous
   * volume.
   */
  @Get('cohorts')
  @Roles('admin')
  async cohortsReport(@Query('from') from?: string, @Query('to') to?: string) {
    return this.cohorts.report({ fromIso: from, toIso: to });
  }

  /**
   * 🇹🇭 WHT roll-up. PAID = bill_payments.wht_cents (we owe RD via
   * PND.3/53), RECEIVED = invoice_receipts.wht_cents (we'll claim back on
   * PND.50 at year-end). Aggregated by Asia/Bangkok calendar month.
   */
  @Get('wht-rollup')
  @Roles('admin', 'accountant')
  async whtRollupReport(@Query('from') from?: string, @Query('to') to?: string) {
    return this.whtRollup.report({ fromIso: from, toIso: to });
  }

  /**
   * Operational + security anomalies pulled from audit_events.
   * Counts: token reuse, failed logins, voids, refunds, settings churn,
   * manual JEs. Plus the most-recent 5 events per class for context.
   */
  @Get('audit-anomalies')
  @Roles('admin')
  async auditAnomaliesReport(@Query('from') from?: string, @Query('to') to?: string) {
    return this.auditAnomalies.report({ fromIso: from, toIso: to });
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

  // ─── CIT (PND.50 / PND.51) ────────────────────────────────────────────

  /**
   * Preview CIT for a fiscal year. Reads net income from the existing P&L
   * service so depreciation/COGS/etc. flow through. For PND.51 (mid-year
   * estimate), pass `halfYear=true` and supply paidInCapital so the SME
   * eligibility check is correct.
   */
  @Get('cit/preview')
  @Roles('admin', 'accountant')
  async citPreview(
    @Query('fiscalYear') fiscalYear: string,
    @Query('halfYear') halfYear?: string,
    @Query('paidInCapitalCents') paidInCapitalCents?: string,
  ) {
    await this.assertThaiMode();
    const fy = Number(fiscalYear);
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) {
      throw new BadRequestException('fiscalYear out of range');
    }
    // Auto-read paid-in capital from org settings if caller doesn't override.
    const orgCapital = (await this.org.snapshot()).paidInCapitalCents ?? undefined;
    return this.cit.preview({
      fiscalYear: fy,
      halfYear: halfYear === 'true' || halfYear === '1',
      paidInCapitalCents: paidInCapitalCents ? Number(paidInCapitalCents) : orgCapital,
    });
  }

  /**
   * File the CIT — POSTS the settlement journal (Dr 9110 / Cr 1157 / Cr 2220)
   * and locks the period from re-filing. Admin-only because it touches the
   * trial balance and locks compliance state.
   */
  @Post('cit/file')
  @Roles('admin')
  async citFile(
    @Body()
    body: {
      fiscalYear: number;
      halfYear?: boolean;
      paidInCapitalCents?: number;
      filedBy?: string | null;
      rdFilingReference?: string;
      notes?: string;
    },
  ) {
    await this.assertThaiMode();
    if (!Number.isInteger(body.fiscalYear) || body.fiscalYear < 2000 || body.fiscalYear > 2100) {
      throw new BadRequestException('fiscalYear out of range');
    }
    return this.cit.file({
      fiscalYear: body.fiscalYear,
      halfYear: !!body.halfYear,
      paidInCapitalCents: body.paidInCapitalCents,
      filedBy: body.filedBy,
      rdFilingReference: body.rdFilingReference,
      notes: body.notes,
    });
  }

  @Get('cit/filings')
  @Roles('admin', 'accountant')
  async citList(@Query('fiscalYear') fiscalYear?: string) {
    await this.assertThaiMode();
    return this.cit.list({
      fiscalYear: fiscalYear ? Number(fiscalYear) : undefined,
    });
  }

  /**
   * 🇹🇭 PND.50 / PND.51 — RD-friendly Excel filing worksheet.
   *
   * Pulls the same `CitService.preview()` numbers the web preview uses, then
   * lays them out across 4–5 sheets matching the rd.go.th web wizard's box
   * layout so the accountant can copy field-by-field. PND.50 includes WHT
   * credits + PND.51 advance; PND.51 only the half-year estimate.
   *
   * Filename pattern:
   *   PND50_<fy>_<TIN13>_<branch6>.xlsx
   *   PND51_<fy>_<TIN13>_<branch6>.xlsx
   */
  @Get('cit/preview.xlsx')
  @Roles('admin', 'accountant')
  async citPreviewXlsx(
    @Query('fiscalYear') fiscalYear: string,
    @Res({ passthrough: false }) reply: Reply,
    @Query('halfYear') halfYear?: string,
    @Query('paidInCapitalCents') paidInCapitalCents?: string,
  ) {
    await this.assertThaiMode();
    const fy = Number(fiscalYear);
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) {
      throw new BadRequestException('fiscalYear out of range');
    }
    const settings = await this.org.snapshot();
    if (!settings.sellerTin) {
      throw new BadRequestException(
        'sellerTin must be configured in Settings before generating a PND.50/51 worksheet',
      );
    }
    const preview = await this.cit.preview({
      fiscalYear: fy,
      halfYear: halfYear === 'true' || halfYear === '1',
      paidInCapitalCents: paidInCapitalCents ? Number(paidInCapitalCents) : undefined,
    });
    const { filename, buffer } = await buildCitXlsx(preview, {
      payerTin: settings.sellerTin,
      payerBranch: (settings.sellerBranch || '00000').padStart(6, '0'),
      payerName: settings.sellerName || '',
    });
    reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buffer);
  }

  // ─── §65 ter — non-deductible expense register ────────────────────────────

  /**
   * 🇹🇭 §65 ter register for a fiscal period — flagged lines + per-category
   * totals + cap math (entertainment, donations) + suggestions for the
   * auto-flag rules. Reads CIT inputs from the `cit/preview` flow.
   */
  @Get('non-deductible')
  @Roles('admin', 'accountant')
  async nonDeductibleRegister(
    @Query('fiscalYear') fiscalYear: string,
    @Query('halfYear') halfYear?: string,
    @Query('paidInCapitalCents') paidInCapitalCents?: string,
  ) {
    await this.assertThaiMode();
    const fy = Number(fiscalYear);
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) {
      throw new BadRequestException('fiscalYear out of range');
    }
    // Re-read the CIT inputs so cap math uses the same revenue / expense /
    // capital figures the operator sees on the CIT card.
    const preview = await this.cit.preview({
      fiscalYear: fy,
      halfYear: halfYear === 'true' || halfYear === '1',
      paidInCapitalCents: paidInCapitalCents ? Number(paidInCapitalCents) : undefined,
    });
    return this.nonDeductible.register({
      fiscalYear: fy,
      halfYear: preview.halfYear,
      revenueCents: preview.revenueCents,
      expenseCents: preview.expenseCents,
      paidInCapitalCents: preview.paidInCapitalCents,
      annualisedRevenueCents: preview.annualisedRevenueCents,
    });
  }

  /**
   * Manually flag a journal-entry line as non-deductible. Operators use this
   * for category 'personal', 'capital_expensed', 'fines_penalties', etc. —
   * judgment calls the auto-rules don't make.
   */
  @Post('non-deductible/flag')
  @Roles('admin', 'accountant')
  async nonDeductibleFlag(
    @Body()
    body: {
      jeLineId: string;
      category: string;
      cents: number;
      reason?: string;
    },
  ) {
    await this.assertThaiMode();
    if (!body?.jeLineId || typeof body.jeLineId !== 'string') {
      throw new BadRequestException('jeLineId is required');
    }
    const cat = parseCategory(body.category);
    if (!cat) {
      throw new BadRequestException(
        `category must be one of the §65 ter codes (got '${body.category}')`,
      );
    }
    if (!Number.isInteger(body.cents) || body.cents <= 0) {
      throw new BadRequestException('cents must be a positive integer');
    }
    return this.nonDeductible.flag({
      jeLineId: body.jeLineId,
      category: cat,
      cents: body.cents,
      reason: body.reason ?? null,
    });
  }

  /** Clear a §65 ter flag from a JE line. */
  @Delete('non-deductible/:jeLineId')
  @Roles('admin', 'accountant')
  async nonDeductibleUnflag(@Param('jeLineId') jeLineId: string) {
    await this.assertThaiMode();
    return this.nonDeductible.unflag(jeLineId);
  }

  /**
   * Apply auto-rules for a fiscal period — flags CIT-self, reserves, and the
   * over-cap portion of entertainment + donations. Idempotent.
   */
  @Post('non-deductible/auto')
  @Roles('admin', 'accountant')
  async nonDeductibleAuto(
    @Body()
    body: {
      fiscalYear: number;
      halfYear?: boolean;
      paidInCapitalCents?: number;
    },
  ) {
    await this.assertThaiMode();
    if (!Number.isInteger(body?.fiscalYear) || body.fiscalYear < 2000 || body.fiscalYear > 2100) {
      throw new BadRequestException('fiscalYear out of range');
    }
    const preview = await this.cit.preview({
      fiscalYear: body.fiscalYear,
      halfYear: !!body.halfYear,
      paidInCapitalCents: body.paidInCapitalCents,
    });
    return this.nonDeductible.autoFlag({
      fiscalYear: body.fiscalYear,
      halfYear: preview.halfYear,
      revenueCents: preview.revenueCents,
      expenseCents: preview.expenseCents,
      paidInCapitalCents: preview.paidInCapitalCents,
      annualisedRevenueCents: preview.annualisedRevenueCents,
    });
  }

  // ── PP.36 — self-assessment VAT on imports of services ────────────────────
  /**
   * 🇹🇭 Phor.Por.36 monthly summary. Aggregates every payment to a foreign
   * vendor (no 13-digit Thai TIN) within the period; computes 7% self-
   * assessment VAT and the e-filing due date. The accountant types these
   * totals onto rd.go.th's web form — RD does not publish a batch-upload
   * schema for PP.36.
   */
  @Get('pp36')
  @Roles('admin', 'accountant')
  async pp36Summary(@Query('year') year?: string, @Query('month') month?: string) {
    await this.assertThaiVatRegistered();
    const y = Number(year ?? new Date().getUTCFullYear());
    const m = Number(month ?? new Date().getUTCMonth() + 1);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new BadRequestException('year out of range');
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new BadRequestException('month must be 1..12');
    }
    return this.pp36.forMonth(y, m);
  }

  @Get('pp36.csv')
  @Roles('admin', 'accountant')
  async pp36Csv(
    @Query('year') year: string,
    @Query('month') month: string,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    await this.assertThaiVatRegistered();
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new BadRequestException('year out of range');
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new BadRequestException('month must be 1..12');
    }
    const report = await this.pp36.forMonth(y, m);
    const csv = this.pp36.toCsv(report);
    reply
      .type('text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename=pp36-${y}${String(m).padStart(2, '0')}.csv`,
      )
      .send(csv);
  }

  @Get('pp36.xlsx')
  @Roles('admin', 'accountant')
  async pp36Xlsx(
    @Query('year') year: string,
    @Query('month') month: string,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    await this.assertThaiVatRegistered();
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new BadRequestException('year out of range');
    }
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new BadRequestException('month must be 1..12');
    }
    const report = await this.pp36.forMonth(y, m);
    const buf = await this.pp36.toXlsx(report);
    reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'Content-Disposition',
        `attachment; filename=pp36-${y}${String(m).padStart(2, '0')}.xlsx`,
      )
      .send(buf);
  }

  /**
   * 🇹🇭 Statutory Cash Book (สมุดเงินสด) — §17 Accounting Act B.E. 2543.
   * Every debit and credit on cash accounts in chronological order with
   * running balance. One of the seven mandatory statutory books.
   */
  @Get('cash-book')
  @Roles('admin', 'accountant')
  async getCashBook(@Query('from') from?: string, @Query('to') to?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';
    return this.cashBook.report({ from: from ?? monthStart, to: to ?? today });
  }

  /** Cash Book as CSV — one line per JE line touching a cash account. */
  @Get('cash-book.csv')
  @Roles('admin', 'accountant')
  async getCashBookCsv(
    @Query('from') from: string,
    @Query('to') to: string,
    @Res({ passthrough: false }) reply: Reply,
  ) {
    const report = await this.cashBook.report({ from, to });
    const rows = [
      'Date,Entry#,Description,Reference,Account,Debit,Credit,Balance',
      ...report.lines.map((l) =>
        [
          l.date,
          l.entryNumber,
          `"${(l.description ?? '').replace(/"/g, '""')}"`,
          l.reference ?? '',
          l.accountCode,
          l.debitCents,
          l.creditCents,
          l.balanceCents,
        ].join(','),
      ),
    ].join('\r\n');
    reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename=cash-book-${from}-${to}.csv`)
      .send('﻿' + rows);
  }
}
