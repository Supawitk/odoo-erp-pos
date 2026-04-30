import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Plus,
  Receipt,
  Trash2,
} from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import { useT } from "~/hooks/use-t";
import { useOrgSettings } from "~/hooks/use-org-settings";

type Status = "draft" | "posted" | "paid" | "void";

type BillRow = {
  id: string;
  internalNumber: string;
  supplierInvoiceNumber: string | null;
  supplierTaxInvoiceNumber: string | null;
  supplierTaxInvoiceDate: string | null;
  supplierId: string;
  purchaseOrderId: string | null;
  billDate: string;
  dueDate: string | null;
  currency: string;
  subtotalCents: number;
  vatCents: number;
  whtCents: number;
  totalCents: number;
  status: Status;
  matchStatus: string | null;
  postedAt: string | null;
  paidAt: string | null;
};

type BillLine = {
  id: string;
  lineNo: number;
  productId: string | null;
  description: string;
  qty: number;
  unitPriceCents: number;
  netCents: number;
  vatCategory: "standard" | "zero_rated" | "exempt";
  vatMode: "inclusive" | "exclusive";
  vatCents: number;
  whtCategory: string | null;
  whtRateBp: number | null;
  whtCents: number;
  expenseAccountCode: string | null;
  matchStatus: string | null;
};

type Bill = BillRow & { lines: BillLine[] };

type Supplier = {
  id: string;
  name: string;
  tin: string | null;
  isSupplier: boolean;
};

type Product = { id: string; name: string; priceCents: number };

const WHT_OPTIONS = [
  { value: "none", label: "—" },
  { value: "services", label: "Services 3%" },
  { value: "rent", label: "Rent 5%" },
  { value: "ads", label: "Ads 2%" },
  { value: "freight", label: "Freight 1%" },
  { value: "dividends", label: "Dividends 10%" },
  { value: "interest", label: "Interest 15%" },
  { value: "foreign", label: "Foreign 15%" },
];

export default function BillsPage() {
  const t = useT();
  const { settings } = useOrgSettings();
  const useThai = settings?.countryMode === "TH";
  const currency = settings?.currency ?? "THB";

  const [bills, setBills] = useState<BillRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const q = statusFilter === "all" ? "" : `?status=${statusFilter}`;
      const rows = await api<BillRow[]>(`/api/purchasing/vendor-bills${q}`);
      setBills(rows);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {useThai ? "ใบแจ้งหนี้ผู้ขาย" : "Vendor bills"}
          </h1>
          <p className="text-muted-foreground">
            {useThai
              ? "บันทึกใบแจ้งหนี้จากผู้ขาย จับคู่ 3 ทาง (PO ↔ GRN ↔ Bill) ลงบัญชี และจ่ายเงิน (พร้อมหัก ณ ที่จ่าย)"
              : "Three-way match (PO ↔ GRN ↔ Bill), post to the GL, pay with optional WHT."}
          </p>
        </div>
        <div className="flex gap-2">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter((v as typeof statusFilter) ?? "all")}
          >
            <SelectTrigger size="sm" className="w-[10rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{useThai ? "ทั้งหมด" : "All"}</SelectItem>
              <SelectItem value="draft">{useThai ? "ร่าง" : "Draft"}</SelectItem>
              <SelectItem value="posted">{useThai ? "ลงบัญชีแล้ว" : "Posted"}</SelectItem>
              <SelectItem value="paid">{useThai ? "จ่ายแล้ว" : "Paid"}</SelectItem>
              <SelectItem value="void">{useThai ? "ยกเลิก" : "Void"}</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={() => setCreateOpen(true)} className="h-10 touch-manipulation">
            <Plus className="h-4 w-4" />
            {useThai ? "ใบแจ้งหนี้ใหม่" : "New bill"}
          </Button>
        </div>
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
      ) : bills.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {useThai
              ? "ยังไม่มีใบแจ้งหนี้ในสถานะนี้"
              : "No bills in this status."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">{useThai ? "เลขที่" : "Number"}</th>
                  <th className="px-4 py-2">{useThai ? "ใบกำกับภาษีผู้ขาย" : "Supplier TX"}</th>
                  <th className="px-4 py-2">{useThai ? "วันที่" : "Date"}</th>
                  <th className="px-4 py-2 text-right">{useThai ? "ยอดสุทธิ" : "Net"}</th>
                  <th className="px-4 py-2 text-right">VAT</th>
                  <th className="px-4 py-2 text-right">WHT</th>
                  <th className="px-4 py-2 text-right">{useThai ? "ยอดรวม" : "Total"}</th>
                  <th className="px-4 py-2">{useThai ? "สถานะ" : "Status"}</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-2 font-mono text-xs">{b.internalNumber}</td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {b.supplierTaxInvoiceNumber ?? b.supplierInvoiceNumber ?? "—"}
                    </td>
                    <td className="px-4 py-2">{b.billDate}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatMoney(b.subtotalCents, b.currency)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {b.vatCents > 0 ? formatMoney(b.vatCents, b.currency) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {b.whtCents > 0 ? formatMoney(b.whtCents, b.currency) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">
                      {formatMoney(b.totalCents, b.currency)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusPill status={b.status} matchStatus={b.matchStatus} useThai={useThai} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setSelected(b.id)}>
                        {useThai ? "ดู" : "View"}
                        <ChevronRight className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {selected && (
        <BillModal
          billId={selected}
          onClose={() => setSelected(null)}
          onChanged={reload}
          currency={currency}
          useThai={useThai}
        />
      )}
      {createOpen && (
        <CreateBillModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            reload();
            setSelected(id);
          }}
          useThai={useThai}
        />
      )}
    </div>
  );
}

function StatusPill({
  status,
  matchStatus,
  useThai,
}: {
  status: Status;
  matchStatus: string | null;
  useThai: boolean;
}) {
  const tone =
    status === "paid"
      ? "bg-emerald-500/15 text-emerald-700"
      : status === "posted"
      ? "bg-blue-500/15 text-blue-700"
      : status === "void"
      ? "bg-rose-500/15 text-rose-700"
      : "bg-amber-500/15 text-amber-700";
  const label =
    status === "paid"
      ? useThai
        ? "จ่ายแล้ว"
        : "Paid"
      : status === "posted"
      ? useThai
        ? "ลงบัญชี"
        : "Posted"
      : status === "void"
      ? useThai
        ? "ยกเลิก"
        : "Void"
      : useThai
      ? "ร่าง"
      : "Draft";
  return (
    <div className="flex items-center gap-1.5">
      <span className={"rounded-full px-2 py-0.5 text-[10px] font-medium " + tone}>
        {label}
      </span>
      {matchStatus === "override" && (
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
          override
        </span>
      )}
    </div>
  );
}

// ─── Detail / actions modal ─────────────────────────────────────────────────

function BillModal({
  billId,
  onClose,
  onChanged,
  currency,
  useThai,
}: {
  billId: string;
  onClose: () => void;
  onChanged: () => void;
  currency: string;
  useThai: boolean;
}) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [busy, setBusy] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reload = () => api<Bill>(`/api/purchasing/vendor-bills/${billId}`).then(setBill);
  useEffect(() => {
    reload();
  }, [billId]);

  const post = async (override?: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const body: any = {};
      if (override) {
        if (overrideReason.trim().length < 3) {
          setErr(useThai ? "กรุณาใส่เหตุผล (อย่างน้อย 3 ตัวอักษร)" : "Reason ≥3 chars required");
          setBusy(false);
          return;
        }
        body.overrideMatchBy = "system";
        body.overrideReason = overrideReason;
      }
      await api(`/api/purchasing/vendor-bills/${billId}/post`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await reload();
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/purchasing/vendor-bills/${billId}/pay`, {
        method: "POST",
        body: JSON.stringify({ cashAccountCode: "1120" }),
      });
      await reload();
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="font-mono">{bill?.internalNumber ?? "…"}</CardTitle>
              <CardDescription>
                {bill ? `${bill.billDate} · ${bill.lines.length} lines` : ""}
              </CardDescription>
            </div>
            {bill && <StatusPill status={bill.status} matchStatus={bill.matchStatus} useThai={useThai} />}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!bill ? (
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <>
              {/* Lines */}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2">{useThai ? "รายการ" : "Description"}</th>
                    <th className="py-2 text-right">{useThai ? "จำนวน" : "Qty"}</th>
                    <th className="py-2 text-right">{useThai ? "ราคา" : "Price"}</th>
                    <th className="py-2 text-right">{useThai ? "สุทธิ" : "Net"}</th>
                    <th className="py-2 text-right">VAT</th>
                    <th className="py-2 text-right">WHT</th>
                    <th className="py-2">{useThai ? "จับคู่" : "Match"}</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.lines.map((l) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="py-2">{l.description}</td>
                      <td className="py-2 text-right tabular-nums">{l.qty}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(l.unitPriceCents, currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(l.netCents, currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {l.vatCents > 0 ? formatMoney(l.vatCents, currency) : "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {l.whtCents > 0
                          ? `${formatMoney(l.whtCents, currency)}${l.whtCategory ? ` (${l.whtCategory})` : ""}`
                          : "—"}
                      </td>
                      <td className="py-2 text-xs">
                        <MatchPill status={l.matchStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold border-t-2">
                    <td className="pt-2" colSpan={3}>
                      {useThai ? "รวม" : "Totals"}
                    </td>
                    <td className="pt-2 text-right tabular-nums">
                      {formatMoney(bill.subtotalCents, bill.currency)}
                    </td>
                    <td className="pt-2 text-right tabular-nums">
                      {formatMoney(bill.vatCents, bill.currency)}
                    </td>
                    <td className="pt-2 text-right tabular-nums">
                      {formatMoney(bill.whtCents, bill.currency)}
                    </td>
                    <td className="pt-2 text-right tabular-nums">
                      {formatMoney(bill.totalCents, bill.currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>

              {/* Override-on-mismatch UI */}
              {bill.status === "draft" && (
                <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {useThai
                      ? "ถ้าจับคู่ 3 ทางไม่ผ่าน (ปริมาณ/ราคาต่างจาก PO/GRN) ใส่เหตุผลเพื่อ override:"
                      : "If 3-way match fails, supply a reason to override:"}
                  </p>
                  <Input
                    placeholder={useThai ? "เหตุผล (≥3 ตัวอักษร)" : "Override reason (≥3 chars)"}
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    className="h-10"
                  />
                </div>
              )}

              {err && <p className="text-xs text-destructive">{err}</p>}

              {/* Actions */}
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={onClose} className="h-10">
                  {useThai ? "ปิด" : "Close"}
                </Button>
                {bill.status === "draft" && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => post(true)}
                      disabled={busy}
                      className="h-10"
                    >
                      {useThai ? "Override + ลงบัญชี" : "Override + post"}
                    </Button>
                    <Button onClick={() => post(false)} disabled={busy} className="h-10">
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                      {useThai ? "ลงบัญชี" : "Post"}
                    </Button>
                  </>
                )}
                {bill.status === "posted" && (
                  <Button onClick={pay} disabled={busy} className="h-10">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />}
                    {useThai ? "จ่ายเงิน" : "Pay"}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MatchPill({ status }: { status: string | null }) {
  if (!status || status === "matched") {
    return <span className="text-emerald-600">✓</span>;
  }
  if (status === "unmatched") {
    return <span className="text-muted-foreground">—</span>;
  }
  return <span className="text-rose-600 inline-flex items-center gap-1"><AlertCircle className="h-3 w-3" /> {status}</span>;
}

// ─── Create modal ───────────────────────────────────────────────────────────

interface DraftLine {
  productId: string | null;
  description: string;
  qty: string;
  unitPriceCents: string;
  vatCategory: "standard" | "zero_rated" | "exempt";
  whtCategory: string;
  expenseAccountCode: string;
}

function CreateBillModal({
  onClose,
  onCreated,
  useThai,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  useThai: boolean;
}) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [billDate, setBillDate] = useState(new Date().toISOString().slice(0, 10));
  const [supplierTxNumber, setSupplierTxNumber] = useState("");
  const [supplierTxDate, setSupplierTxDate] = useState("");
  const [vatMode, setVatMode] = useState<"inclusive" | "exclusive">("exclusive");
  const [lines, setLines] = useState<DraftLine[]>([
    {
      productId: null,
      description: "",
      qty: "1",
      unitPriceCents: "",
      vatCategory: "standard",
      whtCategory: "none",
      expenseAccountCode: "",
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Supplier[]>("/api/purchasing/partners?role=supplier").then(setSuppliers);
    api<Product[]>("/api/products").then(setProducts);
  }, []);

  const totalPreview = useMemo(() => {
    let sub = 0;
    for (const l of lines) {
      const qty = Number(l.qty || "0");
      const price = Number(l.unitPriceCents || "0");
      sub += qty * price;
    }
    return sub;
  }, [lines]);

  const submit = async () => {
    if (!supplierId) {
      setErr(useThai ? "เลือกผู้ขาย" : "Select a supplier");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const result = await api<{ id: string }>("/api/purchasing/vendor-bills", {
        method: "POST",
        body: JSON.stringify({
          supplierId,
          billDate,
          supplierTaxInvoiceNumber: supplierTxNumber || null,
          supplierTaxInvoiceDate: supplierTxDate || null,
          vatMode,
          lines: lines.map((l) => ({
            productId: l.productId ?? undefined,
            description: l.description || "Line",
            qty: Number(l.qty),
            unitPriceCents: Number(l.unitPriceCents),
            vatCategory: l.vatCategory,
            whtCategory: l.whtCategory === "none" ? null : l.whtCategory,
            expenseAccountCode: l.expenseAccountCode || undefined,
          })),
        }),
      });
      onCreated(result.id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const updateLine = (i: number, patch: Partial<DraftLine>) => {
    setLines((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle>{useThai ? "ใบแจ้งหนี้ใหม่" : "New vendor bill"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                {useThai ? "ผู้ขาย" : "Supplier"}
              </label>
              <Select value={supplierId} onValueChange={(v) => setSupplierId(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder={useThai ? "เลือกผู้ขาย…" : "Pick supplier…"} />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                {useThai ? "วันที่ใบแจ้งหนี้" : "Bill date"}
              </label>
              <Input
                type="date"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
                className="h-10"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                {useThai ? "เลขที่ใบกำกับภาษีผู้ขาย" : "Supplier tax invoice #"}
              </label>
              <Input
                placeholder="TX-2604-001234"
                value={supplierTxNumber}
                onChange={(e) => setSupplierTxNumber(e.target.value)}
                className="h-10"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">VAT mode</label>
              <Select value={vatMode} onValueChange={(v) => setVatMode((v as typeof vatMode) ?? "exclusive")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="exclusive">Exclusive</SelectItem>
                  <SelectItem value="inclusive">Inclusive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Lines */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">
              {useThai ? "รายการ" : "Lines"}
            </label>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-end border rounded-md p-2">
                <div className="col-span-4 space-y-1">
                  <label className="text-[10px] text-muted-foreground">
                    {useThai ? "คำอธิบาย" : "Description"}
                  </label>
                  <Input
                    value={l.description}
                    onChange={(e) => updateLine(i, { description: e.target.value })}
                    className="h-9"
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <label className="text-[10px] text-muted-foreground">
                    {useThai ? "สินค้า (ถ้ามี)" : "Product"}
                  </label>
                  <Select
                    value={l.productId ?? "none"}
                    onValueChange={(v) =>
                      updateLine(i, { productId: v === "none" ? null : v })
                    }
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">—</SelectItem>
                      {products.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-1 space-y-1">
                  <label className="text-[10px] text-muted-foreground">
                    {useThai ? "จำนวน" : "Qty"}
                  </label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={l.qty}
                    onChange={(e) => updateLine(i, { qty: e.target.value })}
                    className="h-9 text-right"
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <label className="text-[10px] text-muted-foreground">
                    {useThai ? "ราคา (สตางค์)" : "Price (cents)"}
                  </label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={l.unitPriceCents}
                    onChange={(e) => updateLine(i, { unitPriceCents: e.target.value })}
                    className="h-9 text-right"
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <label className="text-[10px] text-muted-foreground">WHT</label>
                  <Select
                    value={l.whtCategory}
                    onValueChange={(v) => updateLine(i, { whtCategory: v ?? "none" })}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WHT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-1 flex justify-end">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                    disabled={lines.length === 1}
                    className="h-9 w-9"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setLines((prev) => [
                  ...prev,
                  {
                    productId: null,
                    description: "",
                    qty: "1",
                    unitPriceCents: "",
                    vatCategory: "standard",
                    whtCategory: "none",
                    expenseAccountCode: "",
                  },
                ])
              }
            >
              <Plus className="h-3 w-3" /> {useThai ? "เพิ่มรายการ" : "Add line"}
            </Button>
          </div>

          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {useThai ? "ยอดสุทธิก่อน VAT (ประมาณ)" : "Subtotal preview"}
            </span>
            <span className="font-semibold tabular-nums">
              {formatMoney(totalPreview, "THB")}
            </span>
          </div>

          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} className="h-10">
              {useThai ? "ยกเลิก" : "Cancel"}
            </Button>
            <Button onClick={submit} disabled={busy} className="h-10">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {useThai ? "สร้างร่าง" : "Create draft"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
