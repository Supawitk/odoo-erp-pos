import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  BadRequestException,
  Res,
  UseGuards,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { JwtAuthGuard, Roles } from '../../auth/jwt-auth.guard';
import { OrganizationService } from '../../organization/organization.service';
import { EtaxSubmissionService, type EtaxProvider } from '../services/etax-submission.service';
import { EtaxRelayService } from '../services/etax-relay.service';
import { TaxInvoiceXmlBuilder } from '../services/tax-invoice-xml-builder';
import { EtdaXsdValidator } from '../validators/etda-xsd.validator';

/**
 * 🇹🇭 e-Tax invoice endpoints (Phase 4B).
 *
 * GET    /api/etax/orders/:orderId/preview      — render XML without submitting
 * GET    /api/etax/orders/:orderId/preview.xml  — same, served as application/xml
 * POST   /api/etax/orders/:orderId/submit       — build → validate → submit → persist
 * GET    /api/etax/orders/:orderId/status       — submission rows for this order
 */
@Controller('api/etax')
@UseGuards(JwtAuthGuard)
export class EtaxController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly org: OrganizationService,
    private readonly service: EtaxSubmissionService,
    private readonly relay: EtaxRelayService,
    private readonly builder: TaxInvoiceXmlBuilder,
    private readonly validator: EtdaXsdValidator,
  ) {}

  @Get('orders/:orderId/preview')
  @Roles('admin', 'accountant', 'manager')
  async preview(@Param('orderId') orderId: string) {
    const order = await this.loadOrder(orderId);
    const settings = await this.org.snapshot();
    const dto = this.service.buildDto(order, settings);
    const { xml, hash, etdaCode } = this.builder.build(dto);
    const validation = this.validator.validate(xml);
    return { etdaCode, xmlHash: hash, validation, xml };
  }

  @Get('orders/:orderId/preview.xml')
  @Roles('admin', 'accountant', 'manager')
  async previewXml(@Param('orderId') orderId: string, @Res() res: any) {
    const order = await this.loadOrder(orderId);
    const settings = await this.org.snapshot();
    const dto = this.service.buildDto(order, settings);
    const { xml } = this.builder.build(dto);
    res.header('content-type', 'application/xml; charset=utf-8');
    res.send(xml);
  }

  @Post('orders/:orderId/submit')
  @Roles('admin', 'accountant')
  async submit(
    @Param('orderId') orderId: string,
    @Query('provider') providerRaw?: string,
  ) {
    const provider = (providerRaw as EtaxProvider) ?? 'leceipt';
    if (provider !== 'leceipt' && provider !== 'inet') {
      throw new BadRequestException(`unknown provider: ${provider} (allowed: leceipt | inet)`);
    }
    return this.service.submitOrder(orderId, provider);
  }

  @Get('orders/:orderId/status')
  @Roles('admin', 'accountant', 'manager')
  async status(@Param('orderId') orderId: string) {
    const rows = await this.service.getStatus(orderId);
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      status: r.status,
      rdReference: r.rdReference,
      providerReference: r.providerReference,
      ackTimestamp: r.ackTimestamp,
      attempts: r.attempts,
      lastError: r.lastError,
      etdaCode: r.etdaCode,
      documentType: r.documentType,
      documentNumber: r.documentNumber,
      xmlHash: r.xmlHash,
      createdAt: r.createdAt,
    }));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Operator dashboard endpoints (Stage 2)
  // ──────────────────────────────────────────────────────────────────────────

  /** GET /api/etax/submissions?status=pending&provider=leceipt&limit=50 */
  @Get('submissions')
  @Roles('admin', 'accountant', 'manager')
  async listSubmissions(
    @Query('status') statusRaw?: string,
    @Query('provider') providerRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const allowedStatus = ['pending', 'submitted', 'acknowledged', 'rejected', 'dlq'];
    const allowedProvider = ['leceipt', 'inet'];
    const status = statusRaw && allowedStatus.includes(statusRaw)
      ? (statusRaw as 'pending' | 'submitted' | 'acknowledged' | 'rejected' | 'dlq')
      : undefined;
    const provider = providerRaw && allowedProvider.includes(providerRaw)
      ? (providerRaw as 'leceipt' | 'inet')
      : undefined;
    const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 100;
    const offset = offsetRaw ? Math.max(0, Number(offsetRaw)) : 0;
    return this.relay.list({ status, provider, limit, offset });
  }

  /** GET /api/etax/stats — counts by status. Lightweight, OK for polling. */
  @Get('stats')
  @Roles('admin', 'accountant', 'manager')
  async stats() {
    return this.relay.stats();
  }

  /** POST /api/etax/relay/run — drain pending rows now (admin: ad-hoc operator action). */
  @Post('relay/run')
  @Roles('admin', 'accountant')
  async runRelay(@Query('batchSize') batchRaw?: string) {
    const batchSize = batchRaw ? Math.max(1, Math.min(200, Number(batchRaw))) : 25;
    return this.relay.run(batchSize);
  }

  /** POST /api/etax/submissions/:id/requeue — reset a DLQ/rejected row to pending. */
  @Post('submissions/:id/requeue')
  @Roles('admin', 'accountant')
  async requeue(@Param('id') id: string) {
    await this.relay.requeue(id);
    return { ok: true, id };
  }

  /** POST /api/etax/submissions/:id/dlq — manually move a row to DLQ. */
  @Post('submissions/:id/dlq')
  @Roles('admin')
  async forceDlq(@Param('id') id: string, @Query('reason') reason?: string) {
    await this.relay.markDlq(id, reason ?? 'manual');
    return { ok: true, id };
  }

  /** GET /api/etax/submissions/:id/xml — download a stored payload (forensic replay). */
  @Get('submissions/:id/xml')
  @Roles('admin', 'accountant')
  async downloadXml(@Param('id') id: string, @Res() res: any) {
    const rows = await this.db.execute(
      sql`SELECT xml_payload, document_number FROM custom.etax_submissions WHERE id = ${id} LIMIT 1`,
    );
    const flat = ((rows as any).rows ?? rows) as Array<{ xml_payload: string; document_number: string }>;
    if (flat.length === 0) throw new BadRequestException(`submission ${id} not found`);
    res.header('content-type', 'application/xml; charset=utf-8');
    res.header(
      'content-disposition',
      `attachment; filename="${flat[0].document_number}.xml"`,
    );
    res.send(flat[0].xml_payload);
  }

  // ──────────────────────────────────────────────────────────────────────────

  private async loadOrder(orderId: string) {
    const [row] = await this.db
      .select()
      .from(posOrders)
      .where(eq(posOrders.id, orderId))
      .limit(1);
    if (!row) throw new BadRequestException(`order ${orderId} not found`);
    return row;
  }
}
