import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { DatePicker } from "~/components/ui/date-picker";
import { Loader2 } from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import type { BalanceSheet } from "./types";
import { Stat, FsSectionCard } from "./shared";

export function BalanceSheetTab({ currency, useThai }: { currency: string; useThai: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [data, setData] = useState<BalanceSheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<BalanceSheet>(`/api/accounting/balance-sheet?asOf=${asOf}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [asOf]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-end justify-between">
          <div>
            <CardTitle>{useThai ? "งบดุล" : "Balance sheet"}</CardTitle>
            <CardDescription>
              {useThai
                ? "สินทรัพย์ = หนี้สิน + ส่วนของเจ้าของ + กำไรสะสม (TFRS for NPAEs)"
                : "Assets = Liabilities + Equity + YTD Net Income (TFRS for NPAEs)"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">{useThai ? "ณ วันที่" : "As of"}</label>
            <DatePicker
              value={asOf}
              onChange={(iso) => setAsOf(iso)}
              className="w-44"
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {err && (
            <p className="text-sm text-destructive">{err}</p>
          )}
          {loading || !data ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Stat label={useThai ? "สินทรัพย์รวม" : "Total assets"}>
                  {formatMoney(data.totals.assetsCents, currency)}
                </Stat>
                <Stat label={useThai ? "หนี้สิน + ส่วนของเจ้าของ" : "Liab + Equity"}>
                  {formatMoney(data.totals.liabilitiesPlusEquityCents, currency)}
                </Stat>
                <Stat label={useThai ? "ความต่าง (ต้องเป็น 0)" : "Δ (must be 0)"}>
                  <span
                    className={
                      data.totals.deltaCents === 0 ? "text-emerald-700" : "text-rose-700"
                    }
                  >
                    {formatMoney(data.totals.deltaCents, currency)}
                  </span>
                </Stat>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <FsSectionCard
                  title={useThai ? "สินทรัพย์" : "Assets"}
                  rows={data.assets.rows}
                  totalCents={data.assets.totalCents}
                  currency={currency}
                  useThai={useThai}
                />
                <div className="space-y-4">
                  <FsSectionCard
                    title={useThai ? "หนี้สิน" : "Liabilities"}
                    rows={data.liabilities.rows}
                    totalCents={data.liabilities.totalCents}
                    currency={currency}
                    useThai={useThai}
                  />
                  <FsSectionCard
                    title={useThai ? "ส่วนของเจ้าของ" : "Equity"}
                    rows={data.equity.rows}
                    totalCents={data.equity.totalCents}
                    currency={currency}
                    useThai={useThai}
                    extraRow={{
                      label: useThai ? "กำไรสะสมระหว่างปี" : "YTD Net Income",
                      amountCents: data.equity.netIncomeYtdCents,
                    }}
                  />
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Profit & Loss ──────────────────────────────────────────────────────────
