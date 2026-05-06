import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { BookOpen, Download, Loader2, RefreshCw } from "lucide-react";
import { api, formatMoney } from "~/lib/api";

interface CashBookLine {
  date: string;
  entryNumber: number;
  journalEntryId: string;
  description: string;
  reference: string | null;
  sourceModule: string | null;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
}

interface CashBookReport {
  from: string;
  to: string;
  cashAccounts: Array<{ code: string; name: string }>;
  openingBalanceCents: number;
  closingBalanceCents: number;
  netChangeCents: number;
  lines: CashBookLine[];
}

const SOURCE_LABELS: Record<string, string> = {
  pos: "POS",
  invoicing: "AR",
  purchasing: "AP",
  manual: "Manual",
  payroll: "Payroll",
  depreciation: "Depr.",
};

export function CashBookTab({ currency, useThai }: { currency: string; useThai: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<CashBookReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setErr(null);
    api<CashBookReport>(`/api/reports/cash-book?from=${from}&to=${to}`)
      .then(setReport)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const csvHref = `/api/reports/cash-book.csv?from=${from}&to=${to}`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                {useThai ? "สมุดเงินสด" : "Cash Book"}
              </CardTitle>
              <CardDescription>
                {useThai
                  ? "บัญชีเงินสดตามมาตรา 17 พ.ร.บ.การบัญชี พ.ศ. 2543 — แสดงทุกรายการที่กระทบบัญชีเงินสดพร้อมยอดคงเหลือสะสม"
                  : "Statutory Cash Book per §17 Accounting Act B.E. 2543 — every debit/credit on cash accounts with running balance."}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36 text-xs" />
              <span className="text-xs text-muted-foreground">→</span>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36 text-xs" />
              <Button size="sm" variant="outline" onClick={load} disabled={loading}>
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </Button>
              <a href={csvHref} download>
                <Button size="sm" variant="outline">
                  <Download className="h-3.5 w-3.5 mr-1" /> CSV
                </Button>
              </a>
            </div>
          </div>
        </CardHeader>

        {report && (
          <CardContent className="pb-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
              {[
                { label: useThai ? "บัญชีเงินสด" : "Cash accounts", value: report.cashAccounts.map((a) => a.code).join(", ") || "—" },
                { label: useThai ? "ยอดต้นงวด" : "Opening balance", value: formatMoney(report.openingBalanceCents, currency) },
                { label: useThai ? "ยอดปลายงวด" : "Closing balance", value: formatMoney(report.closingBalanceCents, currency) },
                { label: useThai ? "การเปลี่ยนแปลงสุทธิ" : "Net change", value: formatMoney(report.netChangeCents, currency) },
              ].map((s) => (
                <div key={s.label} className="rounded-md border p-2.5">
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className="mt-0.5 font-semibold tabular-nums text-sm">{s.value}</p>
                </div>
              ))}
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardContent className="pt-4">
          {loading && !report && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {useThai ? "กำลังโหลด…" : "Loading…"}
            </div>
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
          {report && report.lines.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {useThai ? "ไม่มีรายการในช่วงนี้" : "No cash transactions in this period."}
            </p>
          )}
          {report && report.lines.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-1.5 pr-3 text-left">{useThai ? "วันที่" : "Date"}</th>
                    <th className="py-1.5 pr-3 text-left">{useThai ? "คำอธิบาย" : "Description"}</th>
                    <th className="py-1.5 pr-3 text-left">{useThai ? "ที่มา" : "Source"}</th>
                    <th className="py-1.5 pr-3 text-left">{useThai ? "บัญชี" : "Account"}</th>
                    <th className="py-1.5 pr-3 text-right">{useThai ? "เดบิต" : "Debit"}</th>
                    <th className="py-1.5 pr-3 text-right">{useThai ? "เครดิต" : "Credit"}</th>
                    <th className="py-1.5 text-right">{useThai ? "ยอดคงเหลือ" : "Balance"}</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Opening balance row */}
                  <tr className="bg-muted/30 border-b">
                    <td className="py-1 pr-3 text-muted-foreground">{from}</td>
                    <td className="py-1 pr-3 text-muted-foreground" colSpan={4}>
                      {useThai ? "ยอดยกมา" : "Opening balance b/f"}
                    </td>
                    <td />
                    <td className="py-1 text-right tabular-nums font-medium">
                      {formatMoney(report.openingBalanceCents, currency)}
                    </td>
                  </tr>
                  {report.lines.map((l, i) => (
                    <tr key={`${l.journalEntryId}-${i}`} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="py-1 pr-3 tabular-nums text-muted-foreground">{l.date}</td>
                      <td className="py-1 pr-3 max-w-[180px] truncate" title={l.description}>
                        {l.description}
                        {l.reference && (
                          <span className="ml-1 text-muted-foreground">· {l.reference}</span>
                        )}
                      </td>
                      <td className="py-1 pr-3">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                          {SOURCE_LABELS[l.sourceModule ?? ""] ?? (l.sourceModule ?? "—")}
                        </span>
                      </td>
                      <td className="py-1 pr-3 text-muted-foreground">{l.accountCode}</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-emerald-700">
                        {l.debitCents > 0 ? formatMoney(l.debitCents, currency) : ""}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums text-rose-600">
                        {l.creditCents > 0 ? formatMoney(l.creditCents, currency) : ""}
                      </td>
                      <td className={`py-1 text-right tabular-nums font-medium ${l.balanceCents < 0 ? "text-rose-600" : ""}`}>
                        {formatMoney(l.balanceCents, currency)}
                      </td>
                    </tr>
                  ))}
                  {/* Closing balance row */}
                  <tr className="bg-muted/30">
                    <td className="py-1 pr-3 text-muted-foreground">{to}</td>
                    <td className="py-1 pr-3 font-medium text-muted-foreground" colSpan={4}>
                      {useThai ? "ยอดยกไป" : "Closing balance c/f"}
                    </td>
                    <td />
                    <td className={`py-1 text-right tabular-nums font-semibold ${report.closingBalanceCents < 0 ? "text-rose-600" : ""}`}>
                      {formatMoney(report.closingBalanceCents, currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
