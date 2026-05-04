import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Loader2 } from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import type { CashFlow } from "./types";
import { Stat } from "./shared";

export function CashFlowTab({ currency, useThai }: { currency: string; useThai: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<CashFlow | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<CashFlow>(`/api/accounting/cash-flow?from=${from}&to=${to}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const bucketLabel = (b: string) =>
    useThai
      ? { operating: "ดำเนินงาน", investing: "ลงทุน", financing: "จัดหาเงิน", void: "ยกเลิก" }[b] ?? b
      : b;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-end justify-between">
          <div>
            <CardTitle>{useThai ? "งบกระแสเงินสด" : "Cash flow"}</CardTitle>
            <CardDescription>
              {useThai
                ? "เปลี่ยนแปลงเงินสด แยกตามกิจกรรม (ดำเนินงาน / ลงทุน / จัดหาเงิน). ตรวจกับยอดบัญชี 1110/1120/1130"
                : "Net cash change by activity (operating / investing / financing). Reconciles to direct delta on cash accounts 1110/1120/1130"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-9 w-40"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-9 w-40"
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
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label={useThai ? "ดำเนินงาน" : "Operating"}>
                  {formatMoney(data.operatingCents, currency)}
                </Stat>
                <Stat label={useThai ? "ลงทุน" : "Investing"}>
                  {formatMoney(data.investingCents, currency)}
                </Stat>
                <Stat label={useThai ? "จัดหาเงิน" : "Financing"}>
                  {formatMoney(data.financingCents, currency)}
                </Stat>
                <Stat label={useThai ? "ยกเลิก" : "Voided"}>
                  {formatMoney(data.voidedCents, currency)}
                </Stat>
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label={useThai ? "เงินสดต้นงวด" : "Opening cash"}>
                  {formatMoney(data.openingCashCents, currency)}
                </Stat>
                <Stat label={useThai ? "เปลี่ยนแปลงสุทธิ" : "Net change"}>
                  <span
                    className={
                      data.netChangeCents >= 0 ? "text-emerald-700" : "text-rose-700"
                    }
                  >
                    {formatMoney(data.netChangeCents, currency)}
                  </span>
                </Stat>
                <Stat label={useThai ? "เงินสดปลายงวด" : "Closing cash"}>
                  {formatMoney(data.closingCashCents, currency)}
                </Stat>
                <Stat label={useThai ? "ความต่าง (ต้องเป็น 0)" : "Δ (must be 0)"}>
                  <span
                    className={data.deltaCents === 0 ? "text-emerald-700" : "text-rose-700"}
                  >
                    {formatMoney(data.deltaCents, currency)}
                  </span>
                </Stat>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">
                    {useThai ? "แยกตามแหล่งที่มา" : "By source module"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto px-0">
                  {data.bySource.length === 0 ? (
                    <p className="px-4 py-6 text-sm text-muted-foreground">
                      {useThai ? "ไม่มีกระแสเงินสดในช่วงนี้" : "No cash flow in this period."}
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="px-4 py-2">{useThai ? "กิจกรรม" : "Activity"}</th>
                          <th className="px-4 py-2">{useThai ? "แหล่งที่มา" : "Source module"}</th>
                          <th className="px-4 py-2 text-right">{useThai ? "เปลี่ยนแปลง" : "Δ"}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.bySource.map((r, i) => (
                          <tr key={i} className="border-b last:border-0">
                            <td className="px-4 py-2 capitalize">{bucketLabel(r.bucket)}</td>
                            <td className="px-4 py-2 font-mono text-xs">{r.sourceModule}</td>
                            <td className="px-4 py-2 text-right tabular-nums">
                              <span
                                className={
                                  r.deltaCents > 0
                                    ? "text-emerald-700"
                                    : r.deltaCents < 0
                                    ? "text-rose-700"
                                    : ""
                                }
                              >
                                {formatMoney(r.deltaCents, currency)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
