import { Injectable, Logger } from '@nestjs/common';
import { OdooJsonRpcClient } from '../../../shared/infrastructure/odoo/odoo-jsonrpc.client';
import type { MisKpi, MisTemplate, MisListEntry } from './mis.types';

/**
 * Pulls MIS template definitions (KPIs, expressions, sequence) from Odoo via
 * JSON-RPC. We keep templates source-of-truth in Odoo so OCA module updates
 * (`l10n_th_mis_report` releases) flow through; values are computed against
 * OUR custom.journal_entry_lines downstream.
 *
 * Cache TTL is 5 min — templates change rarely (only on OCA module upgrade)
 * and Odoo round-trip latency is ~80-200ms per call; missing the cache for
 * every report request would add ~600ms to first paint.
 *
 * When Odoo is unavailable (circuit open or other failure), falls back to a
 * minimal hardcoded TFRS template so the page still renders rather than 503.
 */
@Injectable()
export class MisTemplateAdapter {
  private readonly logger = new Logger(MisTemplateAdapter.name);
  private readonly cache = new Map<number, { value: MisTemplate; expiresAt: number }>();
  private listCache: { value: MisListEntry[]; expiresAt: number } | null = null;
  private readonly TTL_MS = 5 * 60 * 1000;

  constructor(private readonly odoo: OdooJsonRpcClient) {}

  async listTemplates(): Promise<MisListEntry[]> {
    if (this.listCache && this.listCache.expiresAt > Date.now()) {
      return this.listCache.value;
    }

    if (this.odoo.isCircuitOpen()) {
      return this.getFallbackList();
    }

    try {
      const rows = await this.odoo.searchRead<{ id: number; name: string | Record<string, string> }>(
        'mis.report',
        [],
        ['id', 'name'],
        { limit: 50 },
      );
      const entries: MisListEntry[] = rows.map((r) => ({
        id: r.id,
        name: pickName(r.name),
        kind: inferKind(r.id, pickName(r.name)),
        fromOdoo: true,
      }));
      this.listCache = { value: entries, expiresAt: Date.now() + this.TTL_MS };
      return entries;
    } catch (err) {
      this.logger.warn(`Odoo template list failed; using fallback: ${(err as Error).message}`);
      return this.getFallbackList();
    }
  }

  async getTemplate(id: number): Promise<MisTemplate> {
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (this.odoo.isCircuitOpen()) {
      const fb = this.getFallback(id);
      if (fb) return fb;
      throw new Error(`MIS template ${id} not available (Odoo circuit open, no fallback)`);
    }

    try {
      const reportRows = await this.odoo.searchRead<{ id: number; name: string | Record<string, string> }>(
        'mis.report',
        [['id', '=', id]],
        ['id', 'name'],
        { limit: 1 },
      );
      if (!reportRows.length) {
        throw new Error(`MIS template ${id} not found in Odoo`);
      }
      const tplName = pickName(reportRows[0].name);

      const kpiRows = await this.odoo.searchRead<{
        id: number;
        name: string;
        sequence: number;
        type: string;
        accumulation_method: string;
        style_expression: string | false;
        description: string | Record<string, string> | false;
      }>(
        'mis.report.kpi',
        [['report_id', '=', id]],
        ['id', 'name', 'sequence', 'type', 'accumulation_method', 'style_expression', 'description'],
        { limit: 200, order: 'sequence asc, id asc' },
      );

      // Pull expressions in one batch, then index by kpi_id.
      const kpiIds = kpiRows.map((k) => k.id);
      const exprRows = kpiIds.length
        ? await this.odoo.searchRead<{ kpi_id: [number, string] | number; name: string | false }>(
            'mis.report.kpi.expression',
            [['kpi_id', 'in', kpiIds]],
            ['kpi_id', 'name'],
            { limit: kpiIds.length * 4 },
          )
        : [];
      const exprByKpi = new Map<number, string>();
      for (const e of exprRows) {
        const kid = Array.isArray(e.kpi_id) ? e.kpi_id[0] : e.kpi_id;
        if (e.name && !exprByKpi.has(kid)) exprByKpi.set(kid, e.name);
      }

      const kpis: MisKpi[] = kpiRows.map((k) => {
        const desc = typeof k.description === 'string'
          ? k.description
          : k.description ? pickName(k.description) : undefined;
        // OCA's l10n_th_mis_report stores Thai labels in the jsonb `description`
        // field (under en_US for hysterical reasons). Display label prefers
        // description when present so users see "สินทรัพย์" not "A01".
        return {
          id: k.id,
          name: k.name,
          label: desc || k.name,
          sequence: k.sequence ?? 100,
          type: k.type,
          accumulationMethod: (k.accumulation_method as any) ?? 'sum',
          styleExpression: k.style_expression || undefined,
          description: desc,
          expression: exprByKpi.get(k.id),
        };
      });

      const tpl: MisTemplate = {
        id,
        name: tplName,
        kind: inferKind(id, tplName),
        kpis,
        fromOdoo: true,
      };
      this.cache.set(id, { value: tpl, expiresAt: Date.now() + this.TTL_MS });
      return tpl;
    } catch (err) {
      this.logger.warn(`Odoo template fetch failed (${id}); using fallback: ${(err as Error).message}`);
      const fb = this.getFallback(id);
      if (fb) return fb;
      throw err;
    }
  }

  /**
   * Hardcoded fallback templates that mirror l10n_th_mis_report's structure.
   * Used when Odoo is down so the report page still renders.
   * Account prefixes match our 4-digit Thai SME chart of accounts.
   */
  private getFallbackList(): MisListEntry[] {
    return [
      { id: -1, name: 'งบแสดงฐานะการเงิน (Balance Sheet)', kind: 'BS', fromOdoo: false },
      { id: -2, name: 'งบกำไรขาดทุน (Profit & Loss)', kind: 'PL', fromOdoo: false },
      { id: -3, name: 'งบทดลอง (Trial Balance)', kind: 'TB', fromOdoo: false },
    ];
  }

  private getFallback(id: number): MisTemplate | null {
    if (id === -1 || id === 1) {
      return {
        id,
        name: 'งบแสดงฐานะการเงิน (Balance Sheet)',
        kind: 'BS',
        fromOdoo: false,
        kpis: [
          { id: 1001, name: 'CURRENT_ASSETS', label: 'สินทรัพย์หมุนเวียน', sequence: 100, type: 'num', accumulationMethod: 'last', expression: 'bale[11%]' },
          { id: 1002, name: 'NON_CURRENT_ASSETS', label: 'สินทรัพย์ไม่หมุนเวียน', sequence: 200, type: 'num', accumulationMethod: 'last', expression: 'bale[12%]+bale[13%]+bale[14%]+bale[15%]+bale[16%]+bale[17%]+bale[18%]+bale[19%]' },
          { id: 1003, name: 'TOTAL_ASSETS', label: 'รวมสินทรัพย์', sequence: 300, type: 'num', accumulationMethod: 'last', expression: 'CURRENT_ASSETS+NON_CURRENT_ASSETS', styleExpression: 'font-weight:bold' },
          { id: 1004, name: 'CURRENT_LIABILITIES', label: 'หนี้สินหมุนเวียน', sequence: 400, type: 'num', accumulationMethod: 'last', expression: 'bale[21%]+bale[22%]' },
          { id: 1005, name: 'NON_CURRENT_LIABILITIES', label: 'หนี้สินไม่หมุนเวียน', sequence: 500, type: 'num', accumulationMethod: 'last', expression: 'bale[23%]+bale[24%]+bale[25%]+bale[26%]+bale[27%]+bale[28%]+bale[29%]' },
          { id: 1006, name: 'TOTAL_LIABILITIES', label: 'รวมหนี้สิน', sequence: 600, type: 'num', accumulationMethod: 'last', expression: 'CURRENT_LIABILITIES+NON_CURRENT_LIABILITIES', styleExpression: 'font-weight:bold' },
          { id: 1007, name: 'EQUITY', label: 'ส่วนของผู้ถือหุ้น', sequence: 700, type: 'num', accumulationMethod: 'last', expression: 'bale[3%]', styleExpression: 'font-weight:bold' },
          { id: 1008, name: 'TOTAL_LE', label: 'รวมหนี้สินและส่วนของผู้ถือหุ้น', sequence: 800, type: 'num', accumulationMethod: 'last', expression: 'TOTAL_LIABILITIES+EQUITY', styleExpression: 'font-weight:bold' },
        ],
      };
    }
    if (id === -2 || id === 2) {
      return {
        id,
        name: 'งบกำไรขาดทุน (Profit & Loss)',
        kind: 'PL',
        fromOdoo: false,
        kpis: [
          { id: 2001, name: 'REVENUE', label: 'รายได้', sequence: 100, type: 'num', accumulationMethod: 'sum', expression: 'abs(balp[4%])' },
          { id: 2002, name: 'TOTAL_REVENUE', label: 'รวมรายได้', sequence: 200, type: 'num', accumulationMethod: 'sum', expression: 'REVENUE', styleExpression: 'font-weight:bold' },
          { id: 2003, name: 'EXPENSE', label: 'ค่าใช้จ่าย', sequence: 300, type: 'num', accumulationMethod: 'sum', expression: 'balp[5%]+balp[6%]' },
          { id: 2004, name: 'TOTAL_EXPENSE', label: 'รวมค่าใช้จ่าย', sequence: 400, type: 'num', accumulationMethod: 'sum', expression: 'EXPENSE', styleExpression: 'font-weight:bold' },
          { id: 2005, name: 'PL', label: 'กำไร(ขาดทุน)สุทธิ', sequence: 500, type: 'num', accumulationMethod: 'sum', expression: 'TOTAL_REVENUE-TOTAL_EXPENSE', styleExpression: 'font-weight:bold' },
        ],
      };
    }
    if (id === -3 || id === 3) {
      return {
        id,
        name: 'งบทดลอง (Trial Balance)',
        kind: 'TB',
        fromOdoo: false,
        kpis: [
          { id: 3001, name: 'BALANCE', label: 'ยอดดุล', sequence: 100, type: 'num', accumulationMethod: 'last', expression: 'bale[%]' },
        ],
      };
    }
    return null;
  }
}

function pickName(name: string | Record<string, string>): string {
  if (typeof name === 'string') return name;
  return name.th_TH || name.en_US || Object.values(name)[0] || '';
}

function inferKind(id: number, name: string): 'BS' | 'PL' | 'TB' | 'CUSTOM' {
  const lower = name.toLowerCase();
  // TB check FIRST because "Trial Balance" contains the substring "balance"
  // which would otherwise match the BS check.
  if (id === 3 || lower.includes('trial') || lower.includes('ทดลอง')) return 'TB';
  if (id === 1 || lower.includes('balance sheet') || lower.includes('ฐานะ')) return 'BS';
  if (id === 2 || lower.includes('profit') || lower.includes('ผลการดำเนิน') || lower.includes('กำไร')) return 'PL';
  return 'CUSTOM';
}
