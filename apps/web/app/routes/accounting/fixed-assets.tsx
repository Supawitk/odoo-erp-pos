import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { CheckCircle2, ChevronRight, Loader2, Plus } from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import { useAuth } from "~/lib/auth";
import { useCashAccounts } from "~/hooks/use-cash-accounts";
import type { FixedAsset, ChartAccount } from "./types";

export function FixedAssetsTab({ currency, useThai }: { currency: string; useThai: boolean }) {
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disposed" | "retired">(
    "active",
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [disposeId, setDisposeId] = useState<string | null>(null);
  const isAdmin = useAuth((s) => s.user?.role === "admin");

  const reload = async () => {
    setLoading(true);
    try {
      const params = statusFilter === "all" ? "" : `?status=${statusFilter}`;
      const rows = await api<FixedAsset[]>(`/api/accounting/fixed-assets${params}`);
      setAssets(rows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, [statusFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{useThai ? "สถานะ" : "Status"}</label>
          <Select
            value={statusFilter}
            onValueChange={(v) =>
              setStatusFilter((v as typeof statusFilter) ?? "active")
            }
          >
            <SelectTrigger size="sm" className="w-[10rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{useThai ? "ทั้งหมด" : "All"}</SelectItem>
              <SelectItem value="active">{useThai ? "ใช้งานอยู่" : "Active"}</SelectItem>
              <SelectItem value="disposed">{useThai ? "จำหน่ายแล้ว" : "Disposed"}</SelectItem>
              <SelectItem value="retired">{useThai ? "ปลดระวาง" : "Retired"}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={() => setRunOpen(true)}>
              <ChevronRight className="h-3 w-3" />
              {useThai ? "รันค่าเสื่อมราคา" : "Run depreciation"}
            </Button>
          )}
          {isAdmin && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> {useThai ? "เพิ่มสินทรัพย์" : "New asset"}
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : assets.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {useThai
              ? `ไม่มีสินทรัพย์${statusFilter === "active" ? "ที่ใช้งานอยู่" : ""}`
              : `No ${statusFilter === "all" ? "" : statusFilter + " "}assets yet.`}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2">{useThai ? "เลขที่" : "Asset No"}</th>
                  <th className="px-3 py-2">{useThai ? "ชื่อ" : "Name"}</th>
                  <th className="px-3 py-2">{useThai ? "หมวด" : "Category"}</th>
                  <th className="px-3 py-2">{useThai ? "วันที่ได้มา" : "Acq date"}</th>
                  <th className="px-3 py-2 text-right">{useThai ? "ราคาทุน" : "Cost"}</th>
                  <th className="px-3 py-2 text-right">{useThai ? "ค่าเสื่อมสะสม" : "Accumulated"}</th>
                  <th className="px-3 py-2 text-right">{useThai ? "มูลค่าตามบัญชี" : "Net book"}</th>
                  <th className="px-3 py-2">{useThai ? "อายุ" : "Life"}</th>
                  <th className="px-3 py-2">{useThai ? "สถานะ" : "Status"}</th>
                  {isAdmin && <th className="px-3 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr
                    key={a.id}
                    className={
                      "border-b last:border-0 hover:bg-muted/30 " +
                      (a.status !== "active" ? "opacity-60" : "")
                    }
                  >
                    <td className="px-3 py-1.5 font-mono text-xs">{a.assetNo}</td>
                    <td className="px-3 py-1.5">{a.name}</td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{a.category}</td>
                    <td className="px-3 py-1.5 text-xs">{a.acquisitionDate}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatMoney(a.acquisitionCostCents, currency)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {formatMoney(a.accumulatedDepreciationCents, currency)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold">
                      {formatMoney(a.netBookValueCents, currency)}
                    </td>
                    <td className="px-3 py-1.5 text-xs">{a.usefulLifeMonths}m</td>
                    <td className="px-3 py-1.5">
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-xs " +
                          (a.status === "active"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                            : a.status === "disposed"
                            ? "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                            : "bg-muted text-muted-foreground")
                        }
                      >
                        {a.status}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-3 py-1.5 text-right">
                        {a.status === "active" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setDisposeId(a.id)}
                          >
                            {useThai ? "จำหน่าย" : "Dispose"}
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {createOpen && (
        <CreateFixedAssetDialog
          useThai={useThai}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await reload();
          }}
        />
      )}
      {runOpen && (
        <RunDepreciationDialog
          useThai={useThai}
          currency={currency}
          onClose={() => setRunOpen(false)}
          onRan={async () => {
            setRunOpen(false);
            await reload();
          }}
        />
      )}
      {disposeId && (
        <DisposeAssetDialog
          useThai={useThai}
          assetId={disposeId}
          onClose={() => setDisposeId(null)}
          onDisposed={async () => {
            setDisposeId(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function CreateFixedAssetDialog({
  useThai,
  onClose,
  onCreated,
}: {
  useThai: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("equipment");
  const [acquisitionDate, setAcquisitionDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [costBaht, setCostBaht] = useState("0");
  const [salvageBaht, setSalvageBaht] = useState("0");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("60");
  const [assetAccountCode, setAssetAccountCode] = useState("1530");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/accounting/fixed-assets`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          category,
          acquisitionDate,
          acquisitionCostCents: Math.round(Number(costBaht) * 100),
          salvageValueCents: Math.round(Number(salvageBaht) * 100),
          usefulLifeMonths: Number(usefulLifeMonths),
          assetAccountCode,
        }),
      });
      await onCreated();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <CardTitle>{useThai ? "เพิ่มสินทรัพย์ถาวร" : "New fixed asset"}</CardTitle>
          <CardDescription>
            {useThai
              ? "ค่าเสื่อมราคาแบบเส้นตรง รายเดือน เริ่มเดือนถัดจากวันที่ได้มา"
              : "Straight-line depreciation, monthly, starting the month after acquisition."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">{useThai ? "ชื่อ" : "Name"}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-10" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">{useThai ? "หมวด" : "Category"}</label>
              <Select value={category} onValueChange={(v) => v && setCategory(v)}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="equipment">{useThai ? "อุปกรณ์ (1530)" : "Equipment (1530)"}</SelectItem>
                  <SelectItem value="vehicle">{useThai ? "ยานพาหนะ (1540)" : "Vehicle (1540)"}</SelectItem>
                  <SelectItem value="building">{useThai ? "อาคาร (1520)" : "Building (1520)"}</SelectItem>
                  <SelectItem value="land">{useThai ? "ที่ดิน (1510, ไม่คิดค่าเสื่อม)" : "Land (1510, no dep.)"}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "บัญชีสินทรัพย์" : "Asset account"}
              </label>
              <Select
                value={assetAccountCode}
                onValueChange={(v) => v && setAssetAccountCode(v)}
              >
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1510">1510 — Land</SelectItem>
                  <SelectItem value="1520">1520 — Buildings</SelectItem>
                  <SelectItem value="1530">1530 — Equipment</SelectItem>
                  <SelectItem value="1540">1540 — Vehicles</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "ราคาทุน (฿)" : "Cost (฿)"}
              </label>
              <Input
                type="number"
                step="0.01"
                value={costBaht}
                onChange={(e) => setCostBaht(e.target.value)}
                className="h-10 tabular-nums"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "ราคาซาก (฿)" : "Salvage (฿)"}
              </label>
              <Input
                type="number"
                step="0.01"
                value={salvageBaht}
                onChange={(e) => setSalvageBaht(e.target.value)}
                className="h-10 tabular-nums"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "อายุ (เดือน)" : "Life (months)"}
              </label>
              <Input
                type="number"
                value={usefulLifeMonths}
                onChange={(e) => setUsefulLifeMonths(e.target.value)}
                className="h-10 tabular-nums"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {useThai ? "วันที่ได้มา" : "Acquisition date"}
            </label>
            <Input
              type="date"
              value={acquisitionDate}
              onChange={(e) => setAcquisitionDate(e.target.value)}
              className="h-10"
            />
          </div>
          {err && <p className="text-xs text-rose-600">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              {useThai ? "ยกเลิก" : "Cancel"}
            </Button>
            <Button onClick={submit} disabled={busy || !name.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {useThai ? "บันทึก" : "Create"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RunDepreciationDialog({
  useThai,
  currency,
  onClose,
  onRan,
}: {
  useThai: boolean;
  currency: string;
  onClose: () => void;
  onRan: () => void | Promise<void>;
}) {
  const now = new Date();
  // Default to previous month — books are typically closed first.
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const [year, setYear] = useState(prev.getUTCFullYear());
  const [month, setMonth] = useState(prev.getUTCMonth() + 1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    period: string;
    posted: number;
    skipped: number;
    errors: Array<{ assetId: string; reason: string }>;
    assetCount: number;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<typeof result>(`/api/accounting/fixed-assets/run-depreciation`, {
        method: "POST",
        body: JSON.stringify({ year, month }),
      });
      setResult(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-md max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <CardTitle>{useThai ? "รันค่าเสื่อมราคารายเดือน" : "Run monthly depreciation"}</CardTitle>
          <CardDescription>
            {useThai
              ? "ปลอดภัยที่จะรันซ้ำ — สินทรัพย์ที่ลงรายการแล้วจะถูกข้าม"
              : "Idempotent — assets already depreciated for this period are skipped."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">{useThai ? "ปี" : "Year"}</label>
              <Input
                type="number"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="h-10 tabular-nums"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{useThai ? "เดือน" : "Month"}</label>
              <Select value={String(month)} onValueChange={(v) => setMonth(Number(v ?? "1"))}>
                <SelectTrigger className="h-10">
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
          </div>
          {result && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
              <p className="font-medium">
                {useThai ? "ผลการรัน" : "Result"} — {result.period}
              </p>
              <p className="text-xs">
                {useThai ? "ลงรายการ" : "Posted"}: <span className="font-semibold">{result.posted}</span> ·
                {useThai ? "ข้าม" : "Skipped"}: <span>{result.skipped}</span> ·
                {useThai ? "สินทรัพย์ทั้งหมด" : "Active assets"}: <span>{result.assetCount}</span>
              </p>
              {result.errors.length > 0 && (
                <p className="text-xs text-rose-600">
                  {result.errors.length} error(s): {result.errors[0].reason}
                </p>
              )}
            </div>
          )}
          {err && <p className="text-xs text-rose-600">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              {useThai ? "ปิด" : "Close"}
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
              {useThai ? "รัน" : "Run"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DisposeAssetDialog({
  useThai,
  assetId,
  onClose,
  onDisposed,
}: {
  useThai: boolean;
  assetId: string;
  onClose: () => void;
  onDisposed: () => void | Promise<void>;
}) {
  const [proceedsBaht, setProceedsBaht] = useState("0");
  const [disposedAt, setDisposedAt] = useState(new Date().toISOString().slice(0, 10));
  const { primaryCode } = useCashAccounts();
  const [cashAccount, setCashAccount] = useState(primaryCode);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/accounting/fixed-assets/${assetId}/dispose`, {
        method: "POST",
        body: JSON.stringify({
          disposedAt,
          disposalProceedsCents: Math.round(Number(proceedsBaht) * 100),
          cashAccountCode: cashAccount,
        }),
      });
      await onDisposed();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-md max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <CardTitle>{useThai ? "จำหน่ายสินทรัพย์" : "Dispose asset"}</CardTitle>
          <CardDescription>
            {useThai
              ? "บันทึกบัญชีปิดการขาย — Dr เงินสด + Dr ค่าเสื่อมสะสม / Cr สินทรัพย์ + กำไร/ขาดทุน"
              : "Books the closing JE: Dr cash + Dr accumulated dep / Cr asset + gain/loss"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">
              {useThai ? "วันที่จำหน่าย" : "Disposal date"}
            </label>
            <Input
              type="date"
              value={disposedAt}
              onChange={(e) => setDisposedAt(e.target.value)}
              className="h-10"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {useThai ? "เงินที่ได้รับ (฿) — 0 หากปลดระวาง" : "Sale proceeds (฿) — 0 if scrapped"}
            </label>
            <Input
              type="number"
              step="0.01"
              value={proceedsBaht}
              onChange={(e) => setProceedsBaht(e.target.value)}
              className="h-10 tabular-nums"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {useThai ? "บัญชีเงินรับ" : "Cash account"}
            </label>
            <Input
              value={cashAccount}
              onChange={(e) => setCashAccount(e.target.value)}
              className="h-10 font-mono"
              placeholder="1120"
            />
          </div>
          {err && <p className="text-xs text-rose-600">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              {useThai ? "ยกเลิก" : "Cancel"}
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {useThai ? "จำหน่าย" : "Dispose"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── CIT (PND.50 / PND.51) ────────────────────────────────────────────────
