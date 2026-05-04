import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Loader2 } from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import type { ChartAccount, TrialBalanceRow } from "./types";

// ─── Trial balance ──────────────────────────────────────────────────────────

export function TrialBalanceTab({ currency, useThai }: { currency: string; useThai: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [data, setData] = useState<{
    asOfDate: string;
    rows: TrialBalanceRow[];
    totals: { debitCents: number; creditCents: number; deltaCents: number };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<typeof data>(`/api/accounting/trial-balance?asOf=${asOf}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [asOf]);

  // Group rows by account type for a textbook-style trial balance.
  const groups = useMemo(() => {
    if (!data) return [];
    const order: ChartAccount["type"][] = ["asset", "liability", "equity", "revenue", "expense"];
    const labels: Record<ChartAccount["type"], string> = useThai
      ? {
          asset: "สินทรัพย์",
          liability: "หนี้สิน",
          equity: "ส่วนของเจ้าของ",
          revenue: "รายได้",
          expense: "ค่าใช้จ่าย",
        }
      : {
          asset: "Assets",
          liability: "Liabilities",
          equity: "Equity",
          revenue: "Revenue",
          expense: "Expenses",
        };
    return order
      .map((type) => ({
        type,
        label: labels[type],
        rows: data.rows.filter((r) => r.type === type),
      }))
      .filter((g) => g.rows.length > 0);
  }, [data, useThai]);

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {useThai ? "ณ วันที่" : "As of"}
          </label>
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="w-44 h-10"
          />
        </div>
        {data && (
          <div className="ml-auto text-right">
            <div className="text-xs text-muted-foreground">
              {useThai ? "ผลต่าง (ต้องเป็นศูนย์)" : "Δ (must be zero)"}
            </div>
            <div
              className={
                "text-lg font-semibold tabular-nums " +
                (data.totals.deltaCents === 0 ? "text-emerald-600" : "text-rose-600")
              }
            >
              {formatMoney(data.totals.deltaCents, currency)}
            </div>
          </div>
        )}
      </div>

      {err && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !data || data.rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {useThai ? "ยังไม่มีรายการบัญชีในช่วงนี้" : "No posted entries yet."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">{useThai ? "รหัส" : "Code"}</th>
                  <th className="px-4 py-2">{useThai ? "บัญชี" : "Account"}</th>
                  <th className="px-4 py-2 text-right">Dr</th>
                  <th className="px-4 py-2 text-right">Cr</th>
                  <th className="px-4 py-2 text-right">
                    {useThai ? "ยอดคงเหลือ" : "Balance"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g.type} group={g} currency={currency} />
                ))}
                <tr className="border-t-2 bg-muted/30 font-semibold">
                  <td className="px-4 py-2" colSpan={2}>
                    {useThai ? "รวม" : "Totals"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMoney(data.totals.debitCents, currency)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMoney(data.totals.creditCents, currency)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span
                      className={
                        data.totals.deltaCents === 0 ? "text-emerald-600" : "text-rose-600"
                      }
                    >
                      Δ {formatMoney(data.totals.deltaCents, currency)}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function GroupRows({
  group,
  currency,
}: {
  group: { type: string; label: string; rows: TrialBalanceRow[] };
  currency: string;
}) {
  return (
    <>
      <tr className="bg-muted/20">
        <td className="px-4 py-1.5 text-xs uppercase tracking-wide text-muted-foreground" colSpan={5}>
          {group.label}
        </td>
      </tr>
      {group.rows.map((r) => (
        <tr key={r.accountCode} className="border-b last:border-0">
          <td className="px-4 py-2 font-mono text-xs">{r.accountCode}</td>
          <td className="px-4 py-2">{r.accountName}</td>
          <td className="px-4 py-2 text-right tabular-nums">
            {r.debitCents ? formatMoney(r.debitCents, currency) : "—"}
          </td>
          <td className="px-4 py-2 text-right tabular-nums">
            {r.creditCents ? formatMoney(r.creditCents, currency) : "—"}
          </td>
          <td className="px-4 py-2 text-right tabular-nums font-medium">
            {formatMoney(r.balanceCents, currency)}
          </td>
        </tr>
      ))}
    </>
  );
}

// ─── Journal entries ────────────────────────────────────────────────────────
