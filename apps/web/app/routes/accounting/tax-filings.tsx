import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Input } from "~/components/ui/input";
import {
  AlertTriangle, CheckCircle2, ChevronRight, Download, Info, Loader2,
} from "lucide-react";
import { api, downloadFile, formatMoney } from "~/lib/api";
import { useAuth } from "~/lib/auth";
import { Stat } from "./shared";
import type {
  CitPreview, ClosingPreview, CloseResult, InputVatExpiry,
  PndForm, PndReport, Pp30Recon, ReclassPreview, ReclassRunResult,
} from "./types";

export function TaxFilingsTab({
  useThai,
  currency,
  vatRegistered,
}: {
  useThai: boolean;
  currency: string;
  vatRegistered: boolean;
}) {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [recon, setRecon] = useState<Pp30Recon | null>(null);
  const [pnd3, setPnd3] = useState<PndReport | null>(null);
  const [pnd53, setPnd53] = useState<PndReport | null>(null);
  const [pnd54, setPnd54] = useState<PndReport | null>(null);
  const [vatExpiry, setVatExpiry] = useState<InputVatExpiry | null>(null);
  const [reclassPreview, setReclassPreview] = useState<ReclassPreview | null>(null);
  const [reclassResult, setReclassResult] = useState<string | null>(null);
  const [reclassBusy, setReclassBusy] = useState(false);
  const [closingPreview, setClosingPreview] = useState<ClosingPreview | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeResult, setCloseResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  const reload = () => {
    setBusy(true);
    setBackfillResult(null);
    const q = `?year=${year}&month=${month}`;
    // PND fetches always run — WHT remittance is the payer's obligation
    // regardless of VAT status. PP.30 + Input VAT only when registered.
    const tasks: Array<Promise<any>> = [
      vatRegistered
        ? api<Pp30Recon>(`/api/reports/pp30/reconcile${q}`).catch(() => null)
        : Promise.resolve(null),
      api<PndReport>(`/api/reports/pnd/PND3${q}`).catch(() => null),
      api<PndReport>(`/api/reports/pnd/PND53${q}`).catch(() => null),
      api<PndReport>(`/api/reports/pnd/PND54${q}`).catch(() => null),
      vatRegistered
        ? api<InputVatExpiry>("/api/reports/input-vat-expiry").catch(() => null)
        : Promise.resolve(null),
      vatRegistered
        ? api<ReclassPreview>("/api/reports/input-vat-reclass/preview").catch(() => null)
        : Promise.resolve(null),
      vatRegistered
        ? api<ClosingPreview>(`/api/reports/pp30/close/preview${q}`).catch(() => null)
        : Promise.resolve(null),
    ];
    Promise.all(tasks)
      .then(([r, p3, p53, p54, ve, rp, cp]) => {
        setRecon(r);
        setPnd3(p3);
        setPnd53(p53);
        setPnd54(p54);
        setVatExpiry(ve);
        setReclassPreview(rp);
        setClosingPreview(cp);
      })
      .finally(() => setBusy(false));
  };

  const runClose = async () => {
    if (!closingPreview) return;
    const period = closingPreview.periodLabel;
    const action = useThai
      ? `ปิดงบ ภ.พ.30 เดือน ${period}? — จะลงรายการบัญชี Dr 2201/Cr 1155 และล็อกเดือนไม่ให้แก้ไข VAT ได้อีก`
      : `Close PP.30 for ${period}? Posts the Dr 2201 / Cr 1155 settlement journal and locks the period from further VAT changes.`;
    if (!window.confirm(action)) return;
    setCloseBusy(true);
    setCloseResult(null);
    try {
      const res = await api<CloseResult>("/api/reports/pp30/close", {
        method: "POST",
        body: JSON.stringify({ year, month }),
      });
      setCloseResult(
        useThai
          ? `ปิดงบสำเร็จ — JE${res.closingJournalId.slice(0, 8)}, แตะ ${res.stampedBillCount} ใบแจ้งหนี้ + ${res.stampedOrderCount} รายการขาย, สุทธิ ${formatMoney(res.filing.netPayableCents, currency)}`
          : `Closed — JE${res.closingJournalId.slice(0, 8)}, stamped ${res.stampedBillCount} bills + ${res.stampedOrderCount} sales, net ${formatMoney(res.filing.netPayableCents, currency)}`,
      );
      reload();
    } catch (e: any) {
      setCloseResult(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setCloseBusy(false);
    }
  };

  const runReclass = async (dryRun: boolean) => {
    setReclassBusy(true);
    setReclassResult(null);
    try {
      const res = await api<ReclassRunResult>("/api/reports/input-vat-reclass/run", {
        method: "POST",
        body: JSON.stringify({ dryRun }),
      });
      setReclassResult(
        useThai
          ? `${dryRun ? "ทดลอง" : "ดำเนินการแล้ว"} — ${res.reclassed} รายการ, รวม ${formatMoney(res.totalReclassedCents, currency)}`
          : `${dryRun ? "Dry-run" : "Reclassed"} — ${res.reclassed} bill(s), total ${formatMoney(res.totalReclassedCents, currency)}`,
      );
      reload();
    } catch (e: any) {
      setReclassResult(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setReclassBusy(false);
    }
  };

  const runBackfill = async () => {
    setBusy(true);
    try {
      const res = await api<{
        sales: { posted: number; candidateCount: number; failed: any[] };
        cogs: { posted: number; candidateCount: number; failed: any[] };
      }>("/api/accounting/backfill/pos-journals", { method: "POST" });
      setBackfillResult(
        useThai
          ? `เพิ่มรายการแล้ว — ขาย ${res.sales.posted}/${res.sales.candidateCount}, ต้นทุน ${res.cogs.posted}/${res.cogs.candidateCount}`
          : `Posted — sales ${res.sales.posted}/${res.sales.candidateCount}, COGS ${res.cogs.posted}/${res.cogs.candidateCount}`,
      );
      // Re-fetch reports
      reload();
    } catch (e: any) {
      setBackfillResult(`Error: ${e?.message ?? String(e)}`);
      setBusy(false);
    }
  };

  useEffect(reload, [year, month]);

  const periodLabel = `${year}-${String(month).padStart(2, "0")}`;

  return (
    <div className="space-y-5">
      {/* Period picker */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {useThai ? "ปี" : "Year"}
          </label>
          <Input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="h-10 w-24 tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {useThai ? "เดือน" : "Month"}
          </label>
          <Select value={String(month)} onValueChange={(v) => setMonth(Number(v ?? "1"))}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {String(m).padStart(2, "0")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={reload} disabled={busy} className="h-10">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
          {useThai ? "รีเฟรช" : "Refresh"}
        </Button>
      </div>

      {/* Notice when only PND is available (not VAT-registered) */}
      {!vatRegistered && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm flex items-start gap-2">
          <Info className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              {useThai
                ? "ยังไม่ได้จดทะเบียน VAT — ซ่อน ภ.พ.30 และส่วนภาษีซื้อ"
                : "Not VAT-registered — PP.30 and Input VAT sections are hidden."}
            </p>
            <p className="text-muted-foreground text-xs mt-0.5">
              {useThai
                ? "ภ.ง.ด.3/53/54 (หัก ณ ที่จ่าย) ยังคงใช้งานได้ — เป็นภาระของผู้จ่ายเงินไม่ว่าจะจด VAT หรือไม่ก็ตาม"
                : "PND.3/53/54 stays available — withholding tax is the payer's obligation regardless of VAT status."}{" "}
              <a href="/settings" className="text-primary underline-offset-2 hover:underline">
                {useThai ? "เปิด VAT ในการตั้งค่า" : "Enable VAT in Settings"}
              </a>
            </p>
          </div>
        </div>
      )}

      {/* PP.30 ↔ GL reconciliation */}
      {vatRegistered && (
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                {recon?.reconciled ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                )}
                {useThai ? "การกระทบยอด ภ.พ.30 กับบัญชี" : "PP.30 ↔ GL reconciliation"}
              </CardTitle>
              <CardDescription>
                {useThai
                  ? `เดือน ${periodLabel} — ความคลาดเคลื่อนที่ยอมรับได้คือ ฿1`
                  : `Period ${periodLabel} — tolerance ฿1`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() =>
                  downloadFile(
                    `/api/reports/pp30.csv?year=${year}&month=${month}`,
                    `pp30-${year}${String(month).padStart(2, "0")}.csv`,
                  ).catch((e) => alert(`Download failed: ${e.message}`))
                }
              >
                <Download className="h-3 w-3" /> PP.30 CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() =>
                  downloadFile(
                    `/api/reports/pp30.xlsx?year=${year}&month=${month}`,
                    `pp30-${year}${String(month).padStart(2, "0")}.xlsx`,
                  ).catch((e) => alert(`Download failed: ${e.message}`))
                }
              >
                <Download className="h-3 w-3" /> PP.30 XLSX
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {!recon ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
              <ReconCard
                title={useThai ? "ภาษีขาย (Output VAT)" : "Output VAT"}
                pp30Cents={recon.pp30.outputVatNetCents}
                glCents={recon.gl.outputVatNetCents}
                deltaCents={recon.delta.outputVatCents}
                currency={currency}
                useThai={useThai}
              />
              <ReconCard
                title={useThai ? "ภาษีซื้อ (Input VAT)" : "Input VAT"}
                pp30Cents={recon.pp30.inputVatClaimedCents}
                glCents={recon.gl.inputVatNetCents}
                deltaCents={recon.delta.inputVatCents}
                currency={currency}
                useThai={useThai}
              />
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground lg:col-span-2">
                {useThai ? "VAT ต้องชำระสุทธิ" : "Net VAT payable"}: {" "}
                <span className="font-semibold tabular-nums">
                  {formatMoney(recon.pp30.netVatPayableCents, currency)}
                </span>
                <span className="ml-3">
                  {useThai
                    ? `ที่มา — ${recon.source.journalEntryCount} รายการ GL, ${recon.source.vendorBillCount} ใบแจ้งหนี้`
                    : `Source — ${recon.source.journalEntryCount} GL entries, ${recon.source.vendorBillCount} vendor bills`}
                </span>
              </div>
              {!recon.reconciled && (
                <div className="lg:col-span-2 rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
                  <p className="text-xs">
                    {useThai
                      ? "พบรายการ POS ที่ยังไม่ลงบัญชี — กดเติมเพื่อปิดช่องว่างนี้"
                      : "Some POS sales / refunds aren't in the GL yet. Run backfill to close the gap."}
                  </p>
                  <Button variant="outline" size="sm" className="h-8" onClick={runBackfill} disabled={busy}>
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    {useThai ? "เติมรายการบัญชี POS" : "Run POS journal backfill"}
                  </Button>
                  {backfillResult && (
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
                      {backfillResult}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* PP.30 close — period settlement journal */}
      {closingPreview && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {closingPreview.alreadyFiled ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  ) : closingPreview.branch === "noop" ? (
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-blue-500" />
                  )}
                  {useThai
                    ? `ปิดงบ ภ.พ.30 — ${closingPreview.periodLabel}`
                    : `PP.30 close — ${closingPreview.periodLabel}`}
                </CardTitle>
                <CardDescription>
                  {useThai
                    ? "ลงรายการบัญชีปิดงวด: Dr 2201 / Cr 1155 และ Cr 2210 (ค้างจ่าย) หรือ Dr 1158 (ขอคืน) — ล็อกเดือนจากการ reclass หลังจากนี้"
                    : "Posts the period settlement journal — Dr 2201 / Cr 1155 plus Cr 2210 (payable) or Dr 1158 (refund). Locks the month against further VAT reclass."}
                </CardDescription>
              </div>
              {closingPreview.alreadyFiled && closingPreview.filing && (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  {useThai ? "ปิดงบแล้ว" : "Filed"}{" "}
                  {new Date(closingPreview.filing.filedAt).toISOString().slice(0, 10)}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
              <Stat label={useThai ? "ภาษีขาย (Output)" : "Output VAT"}>
                {formatMoney(closingPreview.outputVatCents, currency)}
              </Stat>
              <Stat label={useThai ? "ภาษีซื้อ (Input)" : "Input VAT"}>
                {formatMoney(closingPreview.inputVatCents, currency)}
              </Stat>
              <Stat
                label={
                  closingPreview.netPayableCents >= 0
                    ? useThai
                      ? "ค้างจ่าย RD"
                      : "Payable to RD"
                    : useThai
                    ? "ขอคืนจาก RD"
                    : "Refund from RD"
                }
              >
                {formatMoney(Math.abs(closingPreview.netPayableCents), currency)}
              </Stat>
              <Stat label={useThai ? "เกี่ยวข้อง" : "Contributing"}>
                {closingPreview.source.contributingBillCount}{" "}
                {useThai ? "ใบ" : "bills"} ·{" "}
                {closingPreview.source.contributingOrderCount}{" "}
                {useThai ? "รายการขาย" : "sales"}
              </Stat>
            </div>

            {!closingPreview.alreadyFiled && closingPreview.branch !== "noop" && (
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  {useThai ? "ตัวอย่างรายการบัญชี" : "Closing journal preview"}
                </p>
                <table className="w-full text-xs font-mono tabular-nums">
                  <tbody>
                    {closingPreview.blueprintLines.map((l, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="py-1 pr-2">{l.accountCode}</td>
                        <td className="py-1 pr-2 font-sans">{l.accountName}</td>
                        <td className="py-1 pr-2 text-right">
                          {l.debitCents > 0 ? "Dr " + formatMoney(l.debitCents, currency) : ""}
                        </td>
                        <td className="py-1 text-right">
                          {l.creditCents > 0 ? "Cr " + formatMoney(l.creditCents, currency) : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {closingPreview.alreadyFiled && closingPreview.filing && (
              <div className="text-xs text-muted-foreground">
                {useThai ? "ลงบัญชีในรายการที่ " : "Closing journal: "}
                <span className="font-mono">
                  {closingPreview.filing.closingJournalId?.slice(0, 8) ?? "—"}
                </span>
                {closingPreview.filing.notes && ` · ${closingPreview.filing.notes}`}
              </div>
            )}

            {!closingPreview.alreadyFiled && closingPreview.branch !== "noop" && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  className="h-9"
                  onClick={runClose}
                  disabled={closeBusy}
                >
                  {closeBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3" />
                  )}
                  {useThai ? "ปิดงบและลงบัญชี" : "Close period & post journal"}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {useThai
                    ? "การปิดงบจะแตะใบแจ้งหนี้และรายการขายทั้งหมดในงวด — กลับไม่ได้ผ่าน UI ปกติ"
                    : "Close stamps every contributing bill + sale — not reversible through the normal UI"}
                </p>
              </div>
            )}
            {closeResult && (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                {closeResult}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Input VAT 6-month tracker */}
      {vatExpiry && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {vatExpiry.totals.expired.count > 0 ? (
                <AlertTriangle className="h-5 w-5 text-rose-500" />
              ) : vatExpiry.totals.expiringSoon.count > 0 ? (
                <AlertTriangle className="h-5 w-5 text-amber-500" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              )}
              {useThai
                ? "ภาษีซื้อ — กฎ 6 เดือน (มาตรา 82/3)"
                : "Input VAT — 6-month claim window (§82/3)"}
            </CardTitle>
            <CardDescription>
              {useThai
                ? "ภาษีซื้อต้องเครดิตภายในเดือนที่จุดความรับผิดเกิด หรือ 6 เดือนถัดไป — เลยกำหนดถือว่าสูญเสียถาวร"
                : "Input VAT is claimable in the tax-point month or the following 6 — past that, it's permanently lost."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 text-sm">
              <ExpiryStat
                label={useThai ? "ลงบัญชีแล้ว" : "Claimed"}
                count={vatExpiry.totals.claimed.count}
                cents={vatExpiry.totals.claimed.vatCents}
                tone="muted"
                currency={currency}
              />
              <ExpiryStat
                label={useThai ? "ยังลงได้" : "Claimable"}
                count={vatExpiry.totals.claimable.count}
                cents={vatExpiry.totals.claimable.vatCents}
                tone="ok"
                currency={currency}
              />
              <ExpiryStat
                label={useThai ? "ใกล้หมดอายุ ≤30วัน" : "Expiring ≤30d"}
                count={vatExpiry.totals.expiringSoon.count}
                cents={vatExpiry.totals.expiringSoon.vatCents}
                tone="warn"
                currency={currency}
              />
              <ExpiryStat
                label={useThai ? "หมดอายุ — สูญเสีย" : "Expired — lost"}
                count={vatExpiry.totals.expired.count}
                cents={vatExpiry.totals.expired.vatCents}
                tone="alert"
                currency={currency}
              />
              <ExpiryStat
                label={useThai ? "ย้ายเป็นค่าใช้จ่ายแล้ว" : "Reclassified"}
                count={vatExpiry.totals.reclassified.count}
                cents={vatExpiry.totals.reclassified.vatCents}
                tone="muted"
                currency={currency}
              />
            </div>

            {/* Reclass action panel — only when there's eligible work */}
            {reclassPreview && reclassPreview.length > 0 && (
              <div className="rounded-md border border-rose-300/60 bg-rose-50 dark:bg-rose-950/30 p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-xs space-y-1">
                    <p className="font-medium">
                      {useThai
                        ? `${reclassPreview.length} ใบแจ้งหนี้พ้นกรอบเวลา 6 เดือนแล้ว — รวมภาษีซื้อ ${formatMoney(
                            reclassPreview.reduce((s, r) => s + r.vatCents, 0),
                            currency,
                          )}`
                        : `${reclassPreview.length} bill(s) past the 6-month window — ${formatMoney(
                            reclassPreview.reduce((s, r) => s + r.vatCents, 0),
                            currency,
                          )} of input VAT lost.`}
                    </p>
                    <p className="text-muted-foreground">
                      {useThai
                        ? "การ Reclass จะย้ายยอดจากบัญชี 1155 ไปบัญชี 6390 (ค่าใช้จ่ายภาษีซื้อหมดอายุ — หักลดหย่อน CIT ได้) — Cron จะรันอัตโนมัติเวลา 04:30 ICT ทุกวัน"
                        : "Reclass moves 1155 → 6390 (CIT-deductible expense). Auto-cron runs daily at 04:30 ICT."}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => runReclass(true)}
                    disabled={reclassBusy}
                  >
                    {reclassBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    {useThai ? "ทดลองคำนวณ (ไม่ลงบัญชี)" : "Dry-run"}
                  </Button>
                  <Button
                    size="sm"
                    className="h-8"
                    onClick={() => runReclass(false)}
                    disabled={reclassBusy}
                  >
                    {reclassBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3" />
                    )}
                    {useThai ? "Reclass เดี๋ยวนี้" : "Reclass now"}
                  </Button>
                </div>
                {reclassResult && (
                  <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
                    {reclassResult}
                  </p>
                )}
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    {useThai
                      ? `ดูรายการที่จะ Reclass (${reclassPreview.length})`
                      : `Show ${reclassPreview.length} bill(s)`}
                  </summary>
                  <table className="mt-2 w-full">
                    <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-1 py-1 text-left">
                          {useThai ? "เลขที่" : "Bill"}
                        </th>
                        <th className="px-1 py-1 text-left">
                          {useThai ? "ผู้ขาย" : "Supplier"}
                        </th>
                        <th className="px-1 py-1 text-left">
                          {useThai ? "จุดเสียภาษี" : "Tax-point"}
                        </th>
                        <th className="px-1 py-1 text-right">
                          {useThai ? "เกินกำหนด" : "Overdue"}
                        </th>
                        <th className="px-1 py-1 text-right">VAT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reclassPreview.slice(0, 50).map((r) => (
                        <tr key={r.billId} className="border-t border-border/50">
                          <td className="px-1 py-1 font-mono">{r.internalNumber}</td>
                          <td className="px-1 py-1">{r.supplierName}</td>
                          <td className="px-1 py-1">{r.taxPointDate}</td>
                          <td className="px-1 py-1 text-right tabular-nums text-rose-600 dark:text-rose-400">
                            {r.daysOverdue}d
                          </td>
                          <td className="px-1 py-1 text-right tabular-nums font-medium">
                            {formatMoney(r.vatCents, currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </div>
            )}
            {(vatExpiry.totals.expiringSoon.count > 0 ||
              vatExpiry.totals.expired.count > 0) && (
              <div className="rounded-md border bg-muted/30 max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 text-left">
                        {useThai ? "เลขที่" : "Bill"}
                      </th>
                      <th className="px-2 py-1 text-left">
                        {useThai ? "ผู้ขาย" : "Supplier"}
                      </th>
                      <th className="px-2 py-1 text-left">
                        {useThai ? "จุดเสียภาษี" : "Tax-point"}
                      </th>
                      <th className="px-2 py-1 text-left">
                        {useThai ? "ครบกำหนด" : "Deadline"}
                      </th>
                      <th className="px-2 py-1 text-right">
                        {useThai ? "เหลือ (วัน)" : "Days left"}
                      </th>
                      <th className="px-2 py-1 text-right">VAT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vatExpiry.rows
                      .filter(
                        (r) => r.status === "expired" || r.status === "expiring_soon",
                      )
                      .sort((a, b) => a.daysRemaining - b.daysRemaining)
                      .slice(0, 100)
                      .map((r) => (
                        <tr
                          key={r.billId}
                          className={
                            "border-t border-border/50 " +
                            (r.status === "expired"
                              ? "bg-rose-50 dark:bg-rose-950/20"
                              : "bg-amber-50/40 dark:bg-amber-950/10")
                          }
                        >
                          <td className="px-2 py-1 font-mono">{r.internalNumber}</td>
                          <td className="px-2 py-1">{r.supplierName}</td>
                          <td className="px-2 py-1">{r.taxPointDate}</td>
                          <td className="px-2 py-1">{r.claimDeadline}</td>
                          <td
                            className={
                              "px-2 py-1 text-right tabular-nums " +
                              (r.daysRemaining < 0
                                ? "text-rose-600 dark:text-rose-400 font-semibold"
                                : "text-amber-600 dark:text-amber-400")
                            }
                          >
                            {r.daysRemaining}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums font-medium">
                            {formatMoney(r.vatCents, currency)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* CIT — PND.50 / PND.51 */}
      {vatRegistered && <CitCard year={year} currency={currency} useThai={useThai} />}

      {/* PND.3 / PND.53 / PND.54 */}
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground space-y-1">
        {useThai ? (
          <>
            <div>
              <strong className="text-foreground">RD Prep (.txt):</strong> เลือกอันนี้สำหรับการยื่นปกติ — เปิดไฟล์ในโปรแกรม RD Prep (ดาวน์โหลดฟรีจากกรมสรรพากร) แล้วเซฟเป็น <code>.rdx</code> เพื่ออัปโหลดที่ efiling.rd.go.th
            </div>
            <div>
              <strong className="text-foreground">v2.0 SWC:</strong> รูปแบบใหม่ FORMAT กลาง สำหรับผู้พัฒนาซอฟต์แวร์ที่ขึ้นทะเบียน Software Component กับสรรพากร — ผู้ประกอบการทั่วไปไม่ต้องใช้
            </div>
            <div>
              <strong className="text-foreground">CSV ตรวจทาน:</strong> ตาราง CSV สำหรับตรวจทานข้อมูลก่อนยื่น ไม่ใช่ไฟล์ที่กรมสรรพากรรับ
            </div>
          </>
        ) : (
          <>
            <div>
              <strong className="text-foreground">RD Prep (.txt):</strong> Use this for normal filing. Open in RD Prep (free desktop tool from rd.go.th, Windows), save as <code>.rdx</code>, then upload to efiling.rd.go.th.
            </div>
            <div>
              <strong className="text-foreground">v2.0 SWC:</strong> RD's newer FORMAT กลาง — only for software vendors enrolled as Software Component integration partners. Not needed for regular filers.
            </div>
            <div>
              <strong className="text-foreground">CSV (review):</strong> Friendly spreadsheet for review before filing. Not a format RD accepts.
            </div>
          </>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <PndCard
          form="PND3"
          report={pnd3}
          year={year}
          month={month}
          currency={currency}
          useThai={useThai}
        />
        <PndCard
          form="PND53"
          report={pnd53}
          year={year}
          month={month}
          currency={currency}
          useThai={useThai}
        />
        <PndCard
          form="PND54"
          report={pnd54}
          year={year}
          month={month}
          currency={currency}
          useThai={useThai}
        />
      </div>
    </div>
  );
}

function ReconCard({
  title,
  pp30Cents,
  glCents,
  deltaCents,
  currency,
  useThai,
}: {
  title: string;
  pp30Cents: number;
  glCents: number;
  deltaCents: number;
  currency: string;
  useThai: boolean;
}) {
  const ok = Math.abs(deltaCents) <= 100;
  return (
    <div className="rounded-md border p-3 space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="grid grid-cols-3 text-sm tabular-nums">
        <div>
          <p className="text-[11px] text-muted-foreground">PP.30</p>
          <p className="font-semibold">{formatMoney(pp30Cents, currency)}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">GL</p>
          <p className="font-semibold">{formatMoney(glCents, currency)}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">
            {useThai ? "ส่วนต่าง" : "Delta"}
          </p>
          <p
            className={
              "font-semibold " +
              (ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")
            }
          >
            {formatMoney(deltaCents, currency)}
          </p>
        </div>
      </div>
    </div>
  );
}

function PndCard({
  form,
  report,
  year,
  month,
  currency,
  useThai,
}: {
  form: PndForm;
  report: PndReport | null;
  year: number;
  month: number;
  currency: string;
  useThai: boolean;
}) {
  const titleByForm: Record<PndForm, string> = {
    PND3: useThai ? "ภ.ง.ด.3 — บุคคลธรรมดา" : "PND.3 — natural persons",
    PND53: useThai ? "ภ.ง.ด.53 — นิติบุคคล" : "PND.53 — juristic persons",
    PND54: useThai ? "ภ.ง.ด.54 — ต่างประเทศ" : "PND.54 — foreign payments",
  };
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{titleByForm[form]}</CardTitle>
            <CardDescription>
              {useThai
                ? `ผู้ขาย ${report?.totals.supplierCount ?? 0} ราย · ${
                    report?.totals.billCount ?? 0
                  } ใบ`
                : `${report?.totals.supplierCount ?? 0} suppliers · ${
                    report?.totals.billCount ?? 0
                  } bills`}
            </CardDescription>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button
              size="sm"
              className="h-8 whitespace-nowrap"
              title={
                useThai
                  ? "ไฟล์สำหรับโปรแกรม RD Prep — เปิดในโปรแกรมแล้วเซฟเป็น .rdx จึงอัปโหลดที่ efiling.rd.go.th"
                  : "RD Prep input — open in RD Prep, save as .rdx, then upload to efiling.rd.go.th"
              }
              onClick={() =>
                downloadFile(
                  `/api/reports/pnd/${form}/rd-upload-v1?year=${year}&month=${month}`,
                ).catch((e) => alert(`Download failed: ${e.message}`))
              }
            >
              <Download className="h-3 w-3" />{" "}
              {useThai ? "ไฟล์ RD Prep (.txt)" : "RD Prep (.txt)"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs whitespace-nowrap"
              title={
                useThai
                  ? "รูปแบบ FORMAT กลาง v2.0 (16/06/2568) — สำหรับผู้พัฒนาที่ขึ้นทะเบียน Software Component (SWC) กับสรรพากร เท่านั้น"
                  : "FORMAT กลาง v2.0 (dated 16/06/2568) — only for software vendors enrolled with RD as Software Component (SWC) integration partners"
              }
              onClick={() =>
                downloadFile(
                  `/api/reports/pnd/${form}/rd-upload?year=${year}&month=${month}`,
                ).catch((e) => alert(`Download failed: ${e.message}`))
              }
            >
              <Download className="h-3 w-3" />{" "}
              {useThai ? "v2.0 SWC" : "v2.0 SWC"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              title={
                useThai
                  ? "CSV สำหรับตรวจทาน — ไม่ใช่รูปแบบยื่นกับสรรพากร"
                  : "CSV for review (not RD-filing format)"
              }
              onClick={() =>
                downloadFile(
                  `/api/reports/pnd/${form}/csv?year=${year}&month=${month}`,
                  `${form.toLowerCase()}-${year}${String(month).padStart(2, "0")}.csv`,
                ).catch((e) => alert(`Download failed: ${e.message}`))
              }
            >
              <Download className="h-3 w-3" />{" "}
              {useThai ? "CSV ตรวจทาน" : "CSV (review)"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="rounded-md bg-muted/30 px-3 py-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {useThai ? "ภาษีหัก ณ ที่จ่าย" : "Total WHT withheld"}
            </span>
            <span className="font-semibold tabular-nums">
              {formatMoney(report?.totals.whtCents ?? 0, currency)}
            </span>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{useThai ? "ฐานเงินที่จ่าย" : "Paid net"}</span>
            <span className="tabular-nums">
              {formatMoney(report?.totals.paidNetCents ?? 0, currency)}
            </span>
          </div>
        </div>
        {form === "PND54" && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
            {useThai
              ? "หมายเหตุ: สรรพากรยังไม่ได้ออกรูปแบบ v2.0 สำหรับ ภ.ง.ด.54 อย่างเป็นทางการ — ไฟล์ที่ดาวน์โหลดได้ใช้โครงสร้างเดียวกับ ภ.ง.ด.53 เพื่อสำรองไว้เท่านั้น แนะนำให้กรอกผ่านเว็บฟอร์มที่ efiling.rd.go.th หรือใช้ ASP (Leceipt / INET) สำหรับการยื่นเป็นชุด"
              : "Note: RD has not published a v2.0 batch format for PND.54. The downloadable file mirrors PND.53's shape as a fallback only — for official filing, use the web form at efiling.rd.go.th or an ASP (Leceipt / INET) for batch upload."}
          </div>
        )}
        {report && report.rows.length > 0 ? (
          <div className="max-h-64 overflow-y-auto -mx-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1">{useThai ? "ผู้ขาย" : "Supplier"}</th>
                  <th className="px-2 py-1">{useThai ? "ประเภท" : "Type"}</th>
                  <th className="px-2 py-1 text-right">{useThai ? "ฐาน" : "Net"}</th>
                  <th className="px-2 py-1 text-right">WHT</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.slice(0, 50).map((r) => (
                  <tr
                    key={`${r.supplierId}-${r.whtCategory}`}
                    className="border-t border-border/50"
                  >
                    <td className="px-2 py-1">{r.supplierName}</td>
                    <td className="px-2 py-1 text-muted-foreground">
                      {r.whtCategoryLabel} · {r.rdSection}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {formatMoney(r.paidNetCents, currency)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums font-medium">
                      {formatMoney(r.whtCents, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic px-2">
            {useThai ? "ไม่มีรายการในเดือนนี้" : "No bills paid this month."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}


function ExpiryStat({
  label,
  count,
  cents,
  tone,
  currency,
}: {
  label: string;
  count: number;
  cents: number;
  tone: "muted" | "ok" | "warn" | "alert";
  currency: string;
}) {
  const toneCls =
    tone === "alert"
      ? "border-rose-300/70 bg-rose-50 dark:bg-rose-950/30"
      : tone === "warn"
      ? "border-amber-300/70 bg-amber-50 dark:bg-amber-950/30"
      : tone === "ok"
      ? "border-emerald-300/60 bg-emerald-50 dark:bg-emerald-950/30"
      : "border-border bg-muted/30";
  const labelCls =
    tone === "alert"
      ? "text-rose-700 dark:text-rose-300"
      : tone === "warn"
      ? "text-amber-700 dark:text-amber-300"
      : tone === "ok"
      ? "text-emerald-700 dark:text-emerald-300"
      : "text-muted-foreground";
  return (
    <div className={"rounded-md border p-2 " + toneCls}>
      <p className={"text-[10px] font-medium uppercase tracking-wide " + labelCls}>
        {label}
      </p>
      <p className="text-base font-semibold tabular-nums">{count}</p>
      <p className="text-xs tabular-nums">{formatMoney(cents, currency)}</p>
    </div>
  );
}

// ─── Fixed Assets ─────────────────────────────────────────────────────────

function CitCard({
  year,
  currency,
  useThai,
}: {
  year: number;
  currency: string;
  useThai: boolean;
}) {
  // Default to PND.50 (annual) for the selected year
  const [halfYear, setHalfYear] = useState(false);
  const [paidInCapitalBaht, setPaidInCapitalBaht] = useState("1000000");
  const [preview, setPreview] = useState<CitPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [filing, setFiling] = useState(false);
  const [filedResult, setFiledResult] = useState<string | null>(null);
  const isAdmin = useAuth((s) => s.user?.role === "admin");

  const reload = async () => {
    setLoading(true);
    setFiledResult(null);
    try {
      const cap = Math.round(Number(paidInCapitalBaht) * 100);
      const q = `?fiscalYear=${year}&halfYear=${halfYear}&paidInCapitalCents=${cap}`;
      const r = await api<CitPreview>(`/api/reports/cit/preview${q}`);
      setPreview(r);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, [year, halfYear, paidInCapitalBaht]);

  const runFile = async () => {
    if (!preview) return;
    const formName = halfYear ? "PND.51" : "PND.50";
    const ok = window.confirm(
      useThai
        ? `ยื่น ${formName} สำหรับปี ${year}? ระบบจะลงรายการบัญชี Dr 9110 / Cr 2220 และล็อกการยื่นซ้ำ`
        : `File ${formName} for FY${year}? Posts Dr 9110 / Cr 2220 settlement journal and locks the period.`,
    );
    if (!ok) return;
    setFiling(true);
    setFiledResult(null);
    try {
      const cap = Math.round(Number(paidInCapitalBaht) * 100);
      const r = await api<{ filingId: string; journalEntryId: string }>(
        "/api/reports/cit/file",
        {
          method: "POST",
          body: JSON.stringify({
            fiscalYear: year,
            halfYear,
            paidInCapitalCents: cap,
          }),
        },
      );
      setFiledResult(
        useThai
          ? `ยื่นสำเร็จ — JE${r.journalEntryId.slice(0, 8)}`
          : `Filed — JE${r.journalEntryId.slice(0, 8)}`,
      );
      await reload();
    } catch (e: any) {
      setFiledResult(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setFiling(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              {preview?.alreadyFiled ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              ) : preview?.taxableIncomeCents !== undefined && preview.taxableIncomeCents <= 0 ? (
                <Info className="h-5 w-5 text-muted-foreground" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-blue-500" />
              )}
              {useThai
                ? `ภาษีเงินได้นิติบุคคล — ${halfYear ? "ภ.ง.ด.51 (กลางปี)" : "ภ.ง.ด.50 (ประจำปี)"}`
                : `Corporate Income Tax — ${halfYear ? "PND.51 (half-year)" : "PND.50 (annual)"}`}
            </CardTitle>
            <CardDescription>
              {useThai
                ? `ปี ${year} · ${preview ? `${preview.periodFrom} ถึง ${preview.periodTo}` : ""}`
                : `FY${year} · ${preview ? `${preview.periodFrom} → ${preview.periodTo}` : ""}`}
            </CardDescription>
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">
                {useThai ? "ทุนจดทะเบียน (฿)" : "Paid-in capital (฿)"}
              </label>
              <Input
                type="number"
                value={paidInCapitalBaht}
                onChange={(e) => setPaidInCapitalBaht(e.target.value)}
                className="h-9 w-32 tabular-nums"
              />
            </div>
            <Button
              variant={halfYear ? "outline" : "default"}
              size="sm"
              className="h-9"
              onClick={() => setHalfYear(false)}
            >
              {useThai ? "ประจำปี" : "Annual"}
            </Button>
            <Button
              variant={halfYear ? "default" : "outline"}
              size="sm"
              className="h-9"
              onClick={() => setHalfYear(true)}
            >
              {useThai ? "กลางปี" : "Half-year"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : preview ? (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-2 text-sm">
              <Stat label={useThai ? "รายได้" : "Revenue"}>
                {formatMoney(preview.revenueCents, currency)}
              </Stat>
              <Stat label={useThai ? "ค่าใช้จ่าย" : "Expense"}>
                {formatMoney(preview.expenseCents, currency)}
              </Stat>
              <Stat label={useThai ? "กำไรก่อนภาษี" : "Taxable income"}>
                <span
                  className={
                    preview.taxableIncomeCents < 0 ? "text-rose-600" : "text-foreground"
                  }
                >
                  {formatMoney(preview.taxableIncomeCents, currency)}
                </span>
              </Stat>
              <Stat
                label={
                  preview.rateBracket === "sme"
                    ? useThai
                      ? "ภาษี (SME)"
                      : "Tax (SME)"
                    : useThai
                    ? "ภาษี (20% คงที่)"
                    : "Tax (flat 20%)"
                }
              >
                <span className="font-semibold">
                  {formatMoney(preview.taxDueCents, currency)}
                </span>
              </Stat>
            </div>

            {preview.breakdown.length > 0 && (
              <div className="rounded-md border bg-muted/30 p-2 text-xs space-y-1">
                <p className="font-medium">{useThai ? "รายละเอียดภาษี" : "Bracket breakdown"}</p>
                {preview.breakdown.map((b, i) => (
                  <div key={i} className="flex justify-between">
                    <span>{b.label}</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(b.baseCents, currency)} → {formatMoney(b.taxCents, currency)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 text-sm">
              <Stat label={useThai ? "ภาษีหัก ณ ที่จ่ายค้างรับ" : "WHT credits (1157)"}>
                {formatMoney(preview.whtCreditsCents, currency)}
              </Stat>
              {!halfYear && (
                <Stat label={useThai ? "จ่ายล่วงหน้า ภ.ง.ด.51" : "Advance paid (PND.51)"}>
                  {formatMoney(preview.advancePaidCents, currency)}
                </Stat>
              )}
              <Stat label={useThai ? "สุทธิที่ต้องชำระ" : "Net payable"}>
                <span
                  className={
                    preview.netPayableCents < 0
                      ? "text-emerald-600 font-semibold"
                      : "font-semibold"
                  }
                >
                  {formatMoney(preview.netPayableCents, currency)}
                </span>
              </Stat>
            </div>

            {preview.warnings.length > 0 && (
              <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-2 text-xs space-y-1">
                {preview.warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1.5">
                    <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                    {w}
                  </p>
                ))}
              </div>
            )}

            {preview.alreadyFiled && preview.filing && (
              <div className="rounded-md border border-emerald-300/60 bg-emerald-50 dark:bg-emerald-950/30 p-2 text-xs">
                <p className="font-medium">
                  {useThai ? "ยื่นแล้ว" : "Already filed"} —{" "}
                  {new Date(preview.filing.filedAt).toISOString().slice(0, 10)}
                  {preview.filing.rdFilingReference &&
                    ` · ${preview.filing.rdFilingReference}`}
                </p>
                {preview.filing.notes && (
                  <p className="text-muted-foreground">{preview.filing.notes}</p>
                )}
              </div>
            )}

            {!preview.alreadyFiled && preview.taxableIncomeCents > 0 && isAdmin && (
              <div className="flex items-center gap-2 pt-1">
                <Button onClick={runFile} disabled={filing}>
                  {filing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  {useThai
                    ? `ยื่น ${halfYear ? "ภ.ง.ด.51" : "ภ.ง.ด.50"}`
                    : `File ${halfYear ? "PND.51" : "PND.50"}`}
                </Button>
                {filedResult && <p className="text-xs text-emerald-700">{filedResult}</p>}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{useThai ? "ไม่มีข้อมูล" : "No data"}</p>
        )}
      </CardContent>
    </Card>
  );
}
