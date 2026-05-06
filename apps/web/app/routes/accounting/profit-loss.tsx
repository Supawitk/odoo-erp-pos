import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { DatePicker } from "~/components/ui/date-picker";
import { Loader2 } from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import type { ProfitLoss } from "./types";
import { Stat, FsSectionCard } from "./shared";

export function ProfitLossTab({ currency, useThai }: { currency: string; useThai: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<ProfitLoss | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<ProfitLoss>(`/api/accounting/profit-loss?from=${from}&to=${to}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-end justify-between">
          <div>
            <CardTitle>{useThai ? "งบกำไรขาดทุน" : "Profit & Loss"}</CardTitle>
            <CardDescription>
              {useThai
                ? "กำไร = รายได้สุทธิ − ค่าใช้จ่ายสุทธิ (สำหรับช่วงเวลา)"
                : "Net Income = Revenue − Expense (for period)"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <DatePicker
              value={from}
              onChange={(iso) => setFrom(iso)}
              className="w-40"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <DatePicker
              value={to}
              onChange={(iso) => setTo(iso)}
              className="w-40"
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {err && <p className="text-sm text-destructive">{err}</p>}
          {loading || !data ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Stat label={useThai ? "รายได้รวม" : "Revenue"}>
                  {formatMoney(data.revenue.totalCents, currency)}
                </Stat>
                <Stat label={useThai ? "ค่าใช้จ่ายรวม" : "Expense"}>
                  {formatMoney(data.expense.totalCents, currency)}
                </Stat>
                <Stat label={useThai ? "กำไรสุทธิ" : "Net income"}>
                  <span
                    className={data.netIncomeCents >= 0 ? "text-emerald-700" : "text-rose-700"}
                  >
                    {formatMoney(data.netIncomeCents, currency)}
                  </span>
                </Stat>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <FsSectionCard
                  title={useThai ? "รายได้" : "Revenue"}
                  rows={data.revenue.rows}
                  totalCents={data.revenue.totalCents}
                  currency={currency}
                  useThai={useThai}
                />
                <FsSectionCard
                  title={useThai ? "ค่าใช้จ่าย" : "Expense"}
                  rows={data.expense.rows}
                  totalCents={data.expense.totalCents}
                  currency={currency}
                  useThai={useThai}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Cash Flow ──────────────────────────────────────────────────────────────
