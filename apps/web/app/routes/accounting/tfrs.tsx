import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Loader2, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "~/lib/api";
import type { MisListEntry, MisReport } from "./types";

/**
 * TFRS-format BS/PL/TB reports driven by OCA/mis-builder templates pulled
 * from Odoo. Values are computed against our own custom.journal_entry_lines
 * by the NestJS evaluator — Odoo provides the template definitions only.
 *
 * Internal sub-selector for BS / P&L / TB so we keep the accounting tab bar
 * uncluttered (would otherwise be 3 separate tabs on top of the existing 9).
 */
export function TfrsTab({
  currency,
  useThai,
}: {
  currency: string;
  useThai: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [compare, setCompare] = useState(true);

  const [templates, setTemplates] = useState<MisListEntry[] | null>(null);
  const [tplListError, setTplListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [report, setReport] = useState<MisReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);

  // 1. Fetch the template list once on mount.
  useEffect(() => {
    let cancelled = false;
    api<MisListEntry[]>("/api/reports/mis/templates")
      .then((d) => {
        if (cancelled) return;
        setTemplates(d);
        // Auto-select P&L if available (most useful first paint), else first.
        const pl = d.find((t) => t.kind === "PL");
        setSelectedId((pl ?? d[0])?.id ?? null);
      })
      .catch((e) => !cancelled && setTplListError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Recompute the report whenever the selection or date window changes.
  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    setLoading(true);
    setReportError(null);
    const compareFlag = compare ? "1" : "0";
    api<MisReport>(
      `/api/reports/mis/${selectedId}?from=${from}&to=${to}&compare=${compareFlag}`,
    )
      .then((d) => !cancelled && setReport(d))
      .catch((e) => !cancelled && setReportError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId, from, to, compare]);

  const periodCount = report?.periods.length ?? 0;

  return (
    <div className="space-y-4">
      {/* Header card with the date controls + template picker */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                {useThai ? "งบการเงินตามมาตรฐาน TFRS" : "TFRS-format financial reports"}
                <SourceBadge source={report?.templateSource} useThai={useThai} />
              </CardTitle>
              <CardDescription>
                {useThai
                  ? "งบดุล / กำไรขาดทุน / งบทดลอง รูปแบบมาตรฐาน TFRS for NPAEs (โครงสร้างจาก OCA mis-builder · ค่าจากบัญชีของเรา)"
                  : "Balance Sheet / Profit & Loss / Trial Balance per TFRS for NPAEs (template from OCA mis-builder · values from our ledger)"}
              </CardDescription>
            </div>

            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 w-40"
                aria-label={useThai ? "ตั้งแต่" : "From"}
              />
              <span className="text-xs text-muted-foreground">→</span>
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 w-40"
                aria-label={useThai ? "ถึง" : "To"}
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none cursor-pointer">
                <input
                  type="checkbox"
                  checked={compare}
                  onChange={(e) => setCompare(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                {useThai ? "เทียบช่วงก่อน" : "Compare prior"}
              </label>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {/* Template picker: pill row */}
          {tplListError && (
            <div className="text-sm text-destructive" role="alert">
              {useThai ? "โหลดเทมเพลตล้มเหลว: " : "Failed to load templates: "}
              {tplListError}
            </div>
          )}
          {!templates && !tplListError && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {useThai ? "กำลังโหลดเทมเพลต…" : "Loading templates…"}
            </div>
          )}
          {templates && templates.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  className={
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition " +
                    (selectedId === t.id
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground hover:bg-muted")
                  }
                >
                  <KindGlyph kind={t.kind} />
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Warning when running on the local fallback template */}
      {report?.warning && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/30 dark:bg-amber-950/20 dark:text-amber-200"
          role="status"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{report.warning}</span>
        </div>
      )}

      {/* Report rendering */}
      <Card>
        <CardHeader className="flex flex-row items-end justify-between">
          <div>
            <CardTitle className="text-lg">
              {report ? report.templateName : useThai ? "เลือกรายงาน" : "Pick a report"}
            </CardTitle>
            {report && (
              <CardDescription className="text-xs">
                {useThai
                  ? `คำนวณ ${new Date(report.computedAt).toLocaleString("th-TH")} · ${periodCount} ช่วง · ${report.rows.length} แถว`
                  : `Computed ${new Date(report.computedAt).toLocaleString()} · ${periodCount} period(s) · ${report.rows.length} rows`}
              </CardDescription>
            )}
          </div>
          {report && (
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {expanded ? (useThai ? "ย่อ" : "Collapse") : useThai ? "ขยาย" : "Expand"}
            </button>
          )}
        </CardHeader>
        <CardContent>
          {loading && !report && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {useThai ? "กำลังคำนวณ…" : "Computing…"}
            </div>
          )}
          {reportError && (
            <div className="text-sm text-destructive" role="alert">
              {reportError}
            </div>
          )}
          {report && expanded && <ReportTable report={report} useThai={useThai} loading={loading} />}
        </CardContent>
      </Card>
    </div>
  );
}

function ReportTable({
  report,
  useThai,
  loading,
}: {
  report: MisReport;
  useThai: boolean;
  loading: boolean;
}) {
  const periodHeaders = report.periods.map((p) => p.label);
  return (
    <div className={"relative overflow-x-auto " + (loading ? "opacity-60" : "")}>
      {loading && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {useThai ? "กำลังโหลด" : "Loading"}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-background border-b">
          <tr>
            <th className="text-left py-2 px-3 font-medium">
              {useThai ? "รายการ" : "Item"}
            </th>
            {periodHeaders.map((label, i) => (
              <th key={i} className="text-right py-2 px-3 font-medium tabular-nums">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => {
            const isBold = (row.style ?? "").includes("bold");
            const isItalic = (row.style ?? "").includes("italic");
            return (
              <tr
                key={row.name}
                className={
                  "border-b last:border-0 " +
                  (row.isHeader ? "bg-muted/40" : "hover:bg-muted/30")
                }
              >
                <td
                  className={
                    "py-1.5 px-3 " +
                    (isBold ? "font-semibold " : "") +
                    (isItalic ? "italic " : "") +
                    (row.isHeader ? "text-muted-foreground uppercase text-xs tracking-wide" : "")
                  }
                  title={row.description ?? row.name}
                >
                  {row.label}
                </td>
                {row.isHeader
                  ? periodHeaders.map((_, i) => (
                      <td key={i} className="py-1.5 px-3" />
                    ))
                  : row.cells.map((cell, i) => (
                      <td
                        key={i}
                        className={
                          "py-1.5 px-3 text-right tabular-nums " +
                          (isBold ? "font-semibold " : "") +
                          (cell.value < 0 ? "text-rose-600" : "")
                        }
                      >
                        {cell.display}
                      </td>
                    ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function KindGlyph({ kind }: { kind: "BS" | "PL" | "TB" | "CUSTOM" }) {
  const label =
    kind === "BS" ? "ดุล" :
    kind === "PL" ? "P&L" :
    kind === "TB" ? "TB" : "—";
  return (
    <span className="inline-flex h-4 min-w-[2rem] items-center justify-center rounded bg-muted/60 px-1 text-[10px] font-semibold uppercase tracking-wide">
      {label}
    </span>
  );
}

function SourceBadge({
  source,
  useThai,
}: {
  source: "odoo" | "fallback" | undefined;
  useThai: boolean;
}) {
  if (!source) return null;
  if (source === "odoo") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300"
        title={useThai ? "เทมเพลตจาก OCA mis-builder ใน Odoo" : "Template from OCA mis-builder in Odoo"}
      >
        <CheckCircle2 className="h-3 w-3" />
        {useThai ? "Odoo MIS" : "Odoo MIS"}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-300"
      title={useThai ? "ใช้เทมเพลตสำรอง (Odoo ไม่พร้อมใช้งาน)" : "Using fallback template (Odoo unavailable)"}
    >
      <AlertTriangle className="h-3 w-3" />
      {useThai ? "สำรอง" : "Fallback"}
    </span>
  );
}
