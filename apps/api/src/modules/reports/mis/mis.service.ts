import { Injectable } from '@nestjs/common';
import { MisTemplateAdapter } from './mis-template.adapter';
import { MisExpressionEvaluator } from './mis-expression.evaluator';
import { OrganizationService } from '../../organization/organization.service';
import type { MisCell, MisListEntry, MisPeriod, MisReport, MisRow } from './mis.types';

/**
 * Renders an MIS report by:
 *   1. Pulling the template (KPIs + expressions) from Odoo (cached 5 min)
 *   2. Building 1+ periods (current period + optional comparison)
 *   3. Evaluating every KPI per period against custom.journal_entry_lines
 *   4. Returning a JSON shape close to what Odoo's compute() emits
 *
 * The web UI is template-agnostic — it just renders the rows + cells.
 */
@Injectable()
export class MisService {
  constructor(
    private readonly templates: MisTemplateAdapter,
    private readonly evaluator: MisExpressionEvaluator,
    private readonly orgs: OrganizationService,
  ) {}

  async listTemplates(): Promise<MisListEntry[]> {
    return this.templates.listTemplates();
  }

  async compute(
    templateId: number,
    options: {
      from: Date;
      to: Date;
      compareWith?: { from: Date; to: Date };
      currency?: string;
    },
  ): Promise<MisReport> {
    const template = await this.templates.getTemplate(templateId);
    const org = await this.orgs.snapshot();
    const currency = options.currency ?? org.currency ?? 'THB';

    const periods: MisPeriod[] = [
      {
        name: 'current',
        label: formatPeriodLabel(options.from, options.to),
        dateFrom: options.from.toISOString().slice(0, 10),
        dateTo: options.to.toISOString().slice(0, 10),
      },
    ];
    if (options.compareWith) {
      periods.push({
        name: 'previous',
        label: formatPeriodLabel(options.compareWith.from, options.compareWith.to),
        dateFrom: options.compareWith.from.toISOString().slice(0, 10),
        dateTo: options.compareWith.to.toISOString().slice(0, 10),
      });
    }

    // Evaluate each period independently (KPIs depend only on their own period).
    const valuesPerPeriod = await Promise.all(
      [
        { from: options.from, to: options.to },
        ...(options.compareWith ? [options.compareWith] : []),
      ].map((p) => this.evaluator.evaluateAll(template.kpis, p.from, p.to)),
    );

    const sortedKpis = [...template.kpis].sort(
      (a, b) => a.sequence - b.sequence || a.id - b.id,
    );

    const rows: MisRow[] = sortedKpis.map((kpi) => {
      const isHeader =
        !kpi.expression || kpi.expression.trim() === 'AccountingNone';
      const cells: MisCell[] = isHeader
        ? []
        : valuesPerPeriod.map((vals) => {
            const v = vals.get(kpi.name) ?? 0;
            return {
              value: v,
              display: formatMoney(v, currency),
              style: kpi.styleExpression,
            };
          });
      return {
        name: kpi.name,
        label: kpi.label || kpi.name,
        sequence: kpi.sequence,
        description: kpi.description,
        style: kpi.styleExpression,
        isHeader,
        cells,
      };
    });

    return {
      templateId: template.id,
      templateName: template.name,
      kind: template.kind,
      periods,
      rows,
      computedAt: new Date().toISOString(),
      currency,
      templateSource: template.fromOdoo ? 'odoo' : 'fallback',
      warning: template.fromOdoo
        ? undefined
        : 'Template loaded from local fallback (Odoo unreachable). Update OCA modules in Odoo to refresh template definitions.',
    };
  }
}

function formatPeriodLabel(from: Date, to: Date): string {
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);
  return `${fromIso} → ${toIso}`;
}

function formatMoney(value: number, currency: string): string {
  // Service-side display string; UI may re-format. Thai locale by default
  // (the org locale was already factored into currency choice upstream).
  try {
    return new Intl.NumberFormat('th-TH', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // Currency code unsupported by ICU — fall back to plain decimal.
    return value.toFixed(2);
  }
}
