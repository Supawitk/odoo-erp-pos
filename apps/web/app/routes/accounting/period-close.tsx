import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  CheckCircle2, AlertTriangle, Clock, CalendarCheck, RefreshCw, Plus,
  Loader2, Calendar, BookOpen, TrendingUp,
} from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import type { PeriodCloseSummary, OdooCutoff, OdooFiscalYearClose } from "./types";

const CUTOFF_LABELS: Record<string, { en: string; th: string; icon: string }> = {
  accrued_expense:  { en: "Accrued expense",   th: "ค่าใช้จ่ายค้างจ่าย",    icon: "📉" },
  accrued_revenue:  { en: "Accrued revenue",    th: "รายได้ค้างรับ",          icon: "📈" },
  prepaid_expense:  { en: "Prepaid expense",    th: "ค่าใช้จ่ายจ่ายล่วงหน้า", icon: "📤" },
  prepaid_revenue:  { en: "Prepaid revenue",    th: "รายได้รับล่วงหน้า",      icon: "📥" },
};

const FY_STATE_LABEL: Record<string, { en: string; th: string; color: string }> = {
  draft:       { en: "Draft",       th: "แบบร่าง",      color: "text-muted-foreground" },
  calculated:  { en: "Calculated",  th: "คำนวณแล้ว",    color: "text-blue-600" },
  in_progress: { en: "In progress", th: "กำลังดำเนินการ", color: "text-amber-600" },
  done:        { en: "Closed",      th: "ปิดแล้ว",       color: "text-emerald-600" },
  cancelled:   { en: "Cancelled",   th: "ยกเลิก",        color: "text-rose-500" },
};

export function PeriodCloseTab({
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

  const [summary, setSummary] = useState<PeriodCloseSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const [cutoffs, setCutoffs] = useState<OdooCutoff[]>([]);
  const [cutoffsLoading, setCutoffsLoading] = useState(false);

  const [fiscalYears, setFiscalYears] = useState<OdooFiscalYearClose[]>([]);
  const [fyLoading, setFyLoading] = useState(false);

  const [newCutoffType, setNewCutoffType] = useState<string>("accrued_expense");
  const [newCutoffDate, setNewCutoffDate] = useState(monthStart);
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<string | null>(null);

  const loadSummary = () => {
    setSummaryLoading(true);
    api<PeriodCloseSummary>(`/api/accounting/period-close/summary?from=${from}&to=${to}`)
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setSummaryLoading(false));
  };

  const loadCutoffs = () => {
    setCutoffsLoading(true);
    api<OdooCutoff[]>("/api/accounting/period-close/cutoffs")
      .then(setCutoffs)
      .catch(() => setCutoffs([]))
      .finally(() => setCutoffsLoading(false));
  };

  const loadFiscalYears = () => {
    setFyLoading(true);
    api<OdooFiscalYearClose[]>("/api/accounting/period-close/fiscal-years")
      .then(setFiscalYears)
      .catch(() => setFiscalYears([]))
      .finally(() => setFyLoading(false));
  };

  useEffect(() => {
    loadSummary();
    loadCutoffs();
    loadFiscalYears();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreateCutoff = async () => {
    setCreating(true);
    setCreateMsg(null);
    try {
      const res = await api<{ id: number }>("/api/accounting/period-close/cutoffs", {
        method: "POST",
        body: JSON.stringify({ type: newCutoffType, cutoffDate: newCutoffDate }),
      });
      setCreateMsg(useThai ? `สร้างบันทึกปรับปรุง id=${res.id} ใน Odoo แล้ว` : `Created cutoff id=${res.id} in Odoo`);
      loadCutoffs();
    } catch (e: any) {
      setCreateMsg(`Error: ${e.message}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ── Readiness check ── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CalendarCheck className="h-5 w-5" />
                {useThai ? "ตรวจสอบความพร้อมปิดงวด" : "Period-close readiness check"}
              </CardTitle>
              <CardDescription>
                {useThai
                  ? "ตรวจสอบว่ารายการในงวดสมดุลและพร้อมปิดบัญชี"
                  : "Verify the ledger is balanced and documents are posted before closing."}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36 text-xs" />
              <span className="text-xs text-muted-foreground">→</span>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36 text-xs" />
              <Button size="sm" variant="outline" onClick={loadSummary} disabled={summaryLoading}>
                <RefreshCw className={`h-3.5 w-3.5 ${summaryLoading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {!summary ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {useThai ? "กำลังตรวจสอบ…" : "Checking…"}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Status banner */}
              <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
                summary.readyToClose
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300"
                  : "bg-amber-50 text-amber-800 dark:bg-amber-950/20 dark:text-amber-300"
              }`}>
                {summary.readyToClose
                  ? <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                  : <AlertTriangle className="h-4 w-4 flex-shrink-0" />}
                {summary.readyToClose
                  ? (useThai ? "พร้อมปิดงวด" : "Ready to close")
                  : (useThai ? "ยังไม่พร้อมปิดงวด" : "Not ready to close")}
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile
                  label={useThai ? "รายการที่บันทึกแล้ว" : "Posted entries"}
                  value={summary.postedEntries.toString()}
                  icon={<BookOpen className="h-4 w-4" />}
                  ok={summary.postedEntries > 0}
                />
                <StatTile
                  label={useThai ? "ความสมดุล (ต้องเป็น 0)" : "Balance delta (must be 0)"}
                  value={formatMoney(summary.balanceDeltaCents, currency)}
                  icon={<TrendingUp className="h-4 w-4" />}
                  ok={summary.balanceDeltaCents === 0}
                />
                <StatTile
                  label={useThai ? "เอกสารแบบร่าง" : "Draft documents"}
                  value={summary.draftDocuments.toString()}
                  icon={<Clock className="h-4 w-4" />}
                  ok={summary.draftDocuments === 0}
                />
                <StatTile
                  label={useThai ? "รายการธนาคารที่ยังไม่จับคู่" : "Unreconciled bank lines"}
                  value={summary.unreconciledBankLines.toString()}
                  icon={<AlertTriangle className="h-4 w-4" />}
                  ok={summary.unreconciledBankLines === 0}
                />
              </div>

              {summary.warnings.length > 0 && (
                <ul className="space-y-1 text-xs text-amber-800 dark:text-amber-300">
                  {summary.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Accrual cutoffs (OCA account.cutoff) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Calendar className="h-4 w-4" />
            {useThai ? "รายการปรับปรุงสิ้นงวด (Accrual Cutoffs)" : "Accrual cutoff batches"}
          </CardTitle>
          <CardDescription>
            {useThai
              ? "บันทึกปรับปรุงรายได้/ค่าใช้จ่ายค้างรับ-จ่าย สร้างและจัดการผ่าน OCA account.cutoff ใน Odoo"
              : "Accrued / prepaid revenue and expense adjustments. Managed via OCA account.cutoff in Odoo."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Create new cutoff */}
          <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/30 p-3">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{useThai ? "ประเภท" : "Type"}</p>
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs"
                value={newCutoffType}
                onChange={(e) => setNewCutoffType(e.target.value)}
              >
                {Object.entries(CUTOFF_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v.icon} {useThai ? v.th : v.en}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{useThai ? "วันที่" : "Cutoff date"}</p>
              <Input
                type="date"
                value={newCutoffDate}
                onChange={(e) => setNewCutoffDate(e.target.value)}
                className="h-8 w-36 text-xs"
              />
            </div>
            <Button size="sm" onClick={handleCreateCutoff} disabled={creating}>
              {creating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
              {useThai ? "สร้างใหม่" : "Create"}
            </Button>
            {createMsg && (
              <p className={`text-xs ${createMsg.startsWith("Error") ? "text-destructive" : "text-emerald-600"}`}>
                {createMsg}
              </p>
            )}
          </div>

          {/* Cutoff list */}
          {cutoffsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {useThai ? "กำลังโหลด…" : "Loading…"}
            </div>
          ) : cutoffs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {useThai ? "ยังไม่มีรายการปรับปรุงสิ้นงวด" : "No cutoff batches yet. Create one above to start."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1.5 text-left">{useThai ? "ประเภท" : "Type"}</th>
                    <th className="py-1.5 text-left">{useThai ? "วันที่ปรับปรุง" : "Cutoff date"}</th>
                    <th className="py-1.5 text-left">{useThai ? "สถานะ" : "State"}</th>
                    <th className="py-1.5 text-right">{useThai ? "บรรทัด" : "Lines"}</th>
                    <th className="py-1.5 text-left">Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {cutoffs.map((c) => {
                    const label = CUTOFF_LABELS[c.cutoffType];
                    return (
                      <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-1.5 pr-4">
                          {label?.icon} {useThai ? label?.th : label?.en}
                        </td>
                        <td className="py-1.5 pr-4 tabular-nums">{c.cutoffDate}</td>
                        <td className="py-1.5 pr-4">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            c.state === "done" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                          }`}>
                            {c.state === "done" ? (useThai ? "เสร็จแล้ว" : "Done") : (useThai ? "แบบร่าง" : "Draft")}
                          </span>
                        </td>
                        <td className="py-1.5 pr-4 text-right tabular-nums">{c.lineCount}</td>
                        <td className="py-1.5 text-xs text-muted-foreground">{c.moveRef || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Fiscal year closings (OCA account.fiscalyear.closing) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarCheck className="h-4 w-4" />
            {useThai ? "การปิดบัญชีปีงบประมาณ (Fiscal Year Close)" : "Fiscal year closings"}
          </CardTitle>
          <CardDescription>
            {useThai
              ? "ปิดบัญชีสิ้นปีตามมาตรฐาน TFRS for NPAEs — สร้างและดำเนินการผ่าน Odoo"
              : "Annual fiscal year closing per TFRS for NPAEs — initiate and execute via Odoo."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {fyLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : fiscalYears.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {useThai
                ? "ยังไม่มีการปิดบัญชีปีงบประมาณ — สร้างผ่านหน้า Accounting → Fiscal Year Closing ใน Odoo"
                : "No fiscal year closings yet. Create one via Odoo → Accounting → Fiscal Year Closing."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1.5 text-left">{useThai ? "ชื่อ" : "Name"}</th>
                    <th className="py-1.5 text-left">{useThai ? "ปี" : "Year"}</th>
                    <th className="py-1.5 text-left">{useThai ? "ช่วงเวลา" : "Period"}</th>
                    <th className="py-1.5 text-left">{useThai ? "สถานะ" : "State"}</th>
                  </tr>
                </thead>
                <tbody>
                  {fiscalYears.map((fy) => {
                    const stateInfo = FY_STATE_LABEL[fy.state] ?? { en: fy.state, th: fy.state, color: "" };
                    return (
                      <tr key={fy.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-1.5 pr-4 font-medium">{fy.name}</td>
                        <td className="py-1.5 pr-4 tabular-nums">{fy.year}</td>
                        <td className="py-1.5 pr-4 text-xs text-muted-foreground tabular-nums">
                          {fy.dateStart} → {fy.dateEnd}
                        </td>
                        <td className={`py-1.5 text-xs font-medium ${stateInfo.color}`}>
                          {useThai ? stateInfo.th : stateInfo.en}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({
  label,
  value,
  icon,
  ok,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  ok: boolean;
}) {
  return (
    <div className={`rounded-md border p-2.5 ${ok ? "" : "border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20"}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className={`mt-1 text-base font-semibold tabular-nums ${ok ? "" : "text-amber-700 dark:text-amber-300"}`}>
        {value}
      </p>
    </div>
  );
}
