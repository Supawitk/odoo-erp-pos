/**
 * Sales invoices (credit B2B) — back-office invoicing distinct from POS sales.
 *
 * Two tabs:
 *   1. Invoices — draft → send (post AR) → record receipts → fully paid
 *   2. AR aging — outstanding receivables by overdue bucket
 *
 * Mirrors the AP `/bills` page structurally so the UI feels symmetric.
 */
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
  Send,
  Trash2,
  X,
} from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import { useT } from "~/hooks/use-t";
import { useOrgSettings } from "~/hooks/use-org-settings";
import { useCashAccounts } from "~/hooks/use-cash-accounts";

type Status = "draft" | "sent" | "partially_paid" | "paid" | "cancelled";

type InvoiceRow = {
  id: string;
  internalNumber: string;
  customerId: string;
  customerReference: string | null;
  invoiceDate: string;
  dueDate: string | null;
  paymentTermsDays: number;
  currency: string;
  vatMode: "inclusive" | "exclusive";
  subtotalCents: number;
  vatCents: number;
  whtCents: number;
  totalCents: number;
  paidCents: number;
  whtReceivedCents: number;
  remainingCents: number;
  status: Status;
  pp30FilingId: string | null;
  sentAt: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
};

type InvoiceLine = {
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
  revenueAccountCode: string | null;
};

type Invoice = InvoiceRow & { lines: InvoiceLine[] };

type ReceiptRow = {
  id: string;
  receiptNo: number;
  receiptDate: string;
  amountCents: number;
  whtCents: number;
  bankChargeCents: number;
  cashCents: number;
  cashAccountCode: string;
  paymentMethod: string | null;
  bankReference: string | null;
  receivedBy: string | null;
  notes: string | null;
  voidedAt: string | null;
  voidReason: string | null;
};

type Customer = {
  id: string;
  name: string;
  tin: string | null;
  isCustomer: boolean;
  paymentTermsDays: number | null;
};

type Bucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

type AgingInvoice = {
  invoiceId: string;
  internalNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  effectiveDueDate: string;
  daysOverdue: number;
  bucket: Bucket;
  totalCents: number;
  paidCents: number;
  remainingCents: number;
  whtCents: number;
  whtReceivedCents: number;
  status: string;
};

type CustomerAging = {
  customerId: string;
  customerName: string;
  totalRemainingCents: number;
  buckets: Record<Bucket, number>;
  invoices: AgingInvoice[];
};

type AgingReport = {
  asOfDate: string;
  grandTotalCents: number;
  bucketTotals: Record<Bucket, number>;
  customers: CustomerAging[];
};

type DraftLine = {
  productId: string | null;
  description: string;
  qty: string;
  unitPriceCents: string;
  vatCategory: "standard" | "zero_rated" | "exempt";
  whtCategory: string;
};

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

function blankLine(): DraftLine {
  return {
    productId: null,
    description: "",
    qty: "1",
    unitPriceCents: "",
    vatCategory: "standard",
    whtCategory: "none",
  };
}

export default function InvoicesPage() {
  const t = useT();
  const { settings } = useOrgSettings();
  const useThai = settings?.countryMode === "TH";
  const currency = settings?.currency ?? "THB";

  const [tab, setTab] = useState<"invoices" | "aging">("invoices");
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const q = statusFilter === "all" ? "" : `?status=${statusFilter}`;
      const rows = await api<InvoiceRow[]>(`/api/sales/invoices${q}`);
      setInvoices(rows);
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
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          {useThai ? "ใบกำกับภาษีลูกหนี้" : "Sales invoices"}
        </h1>
        <p className="text-muted-foreground">
          {useThai
            ? "ออกใบกำกับภาษีเครดิต ส่งให้ลูกค้า รับชำระเต็มหรือผ่อน และดูรายงานลูกหนี้คงค้าง"
            : "Issue credit invoices, send to customer, receive payments (full or installments), and review AR aging."}
        </p>
      </div>

      <div className="inline-flex rounded-md border bg-muted/30 p-1">
        <Button
          variant={tab === "invoices" ? "default" : "ghost"}
          size="sm"
          className="h-8"
          onClick={() => setTab("invoices")}
        >
          {useThai ? "ใบกำกับภาษี" : "Invoices"}
        </Button>
        <Button
          variant={tab === "aging" ? "default" : "ghost"}
          size="sm"
          className="h-8"
          onClick={() => setTab("aging")}
        >
          {useThai ? "ลูกหนี้คงค้าง" : "AR aging"}
        </Button>
      </div>

      {tab === "invoices" && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex gap-2 ml-auto">
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
                <SelectItem value="sent">{useThai ? "ส่งแล้ว" : "Sent"}</SelectItem>
                <SelectItem value="partially_paid">{useThai ? "รับบางส่วน" : "Partial"}</SelectItem>
                <SelectItem value="paid">{useThai ? "รับครบ" : "Paid"}</SelectItem>
                <SelectItem value="cancelled">{useThai ? "ยกเลิก" : "Cancelled"}</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => setCreateOpen(true)} className="h-10 touch-manipulation">
              <Plus className="h-4 w-4" />
              {useThai ? "ใบกำกับภาษีใหม่" : "New invoice"}
            </Button>
          </div>
        </div>
      )}

      {tab === "aging" && <ArAgingTab useThai={useThai} currency={currency} />}

      {tab === "invoices" && err && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {tab !== "invoices" ? null : loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : invoices.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {useThai ? "ยังไม่มีใบกำกับภาษีในสถานะนี้" : "No invoices in this status."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">{useThai ? "เลขที่" : "Number"}</th>
                  <th className="px-4 py-2">{useThai ? "อ้างอิงลูกค้า" : "Customer ref"}</th>
                  <th className="px-4 py-2">{useThai ? "วันที่" : "Date"}</th>
                  <th className="px-4 py-2">{useThai ? "ครบกำหนด" : "Due"}</th>
                  <th className="px-4 py-2 text-right">{useThai ? "ยอดรวม" : "Total"}</th>
                  <th className="px-4 py-2 text-right">{useThai ? "คงเหลือ" : "Remaining"}</th>
                  <th className="px-4 py-2">{useThai ? "สถานะ" : "Status"}</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((r) => (
                  <tr
                    key={r.id}
                    className={
                      "border-b last:border-0 hover:bg-muted/40 cursor-pointer " +
                      (selected === r.id ? "bg-muted/40" : "")
                    }
                    onClick={() => setSelected(r.id)}
                  >
                    <td className="px-4 py-2 font-mono text-xs">{r.internalNumber}</td>
                    <td className="px-4 py-2">{r.customerReference ?? "—"}</td>
                    <td className="px-4 py-2">{r.invoiceDate}</td>
                    <td className="px-4 py-2">{r.dueDate ?? "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatMoney(r.totalCents, r.currency)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">
                      {formatMoney(r.remainingCents, r.currency)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusPill status={r.status} useThai={useThai} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <ChevronRight className="h-4 w-4 text-muted-foreground inline" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {selected && tab === "invoices" && (
        <InvoiceDetail
          invoiceId={selected}
          useThai={useThai}
          onChanged={reload}
          onClose={() => setSelected(null)}
        />
      )}

      {createOpen && (
        <CreateInvoiceDialog
          useThai={useThai}
          currency={currency}
          onClose={() => setCreateOpen(false)}
          onCreated={async (id) => {
            setCreateOpen(false);
            await reload();
            setSelected(id);
          }}
        />
      )}
    </div>
  );
}

function StatusPill({ status, useThai }: { status: Status; useThai: boolean }) {
  const map: Record<Status, { label: string; className: string }> = {
    draft: {
      label: useThai ? "ร่าง" : "Draft",
      className: "bg-muted text-muted-foreground",
    },
    sent: {
      label: useThai ? "ส่งแล้ว" : "Sent",
      className: "bg-amber-500/15 text-amber-700",
    },
    partially_paid: {
      label: useThai ? "รับบางส่วน" : "Partial",
      className: "bg-sky-500/15 text-sky-700",
    },
    paid: {
      label: useThai ? "รับครบ" : "Paid",
      className: "bg-emerald-500/15 text-emerald-700",
    },
    cancelled: {
      label: useThai ? "ยกเลิก" : "Cancelled",
      className: "bg-rose-500/15 text-rose-700",
    },
  };
  const m = map[status];
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${m.className}`}>
      {m.label}
    </span>
  );
}

function InvoiceDetail({
  invoiceId,
  useThai,
  onChanged,
  onClose,
}: {
  invoiceId: string;
  useThai: boolean;
  onChanged: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const [inv, rs] = await Promise.all([
        api<Invoice>(`/api/sales/invoices/${invoiceId}`),
        api<ReceiptRow[]>(`/api/sales/invoices/${invoiceId}/receipts`),
      ]);
      setInvoice(inv);
      setReceipts(rs);
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
  }, [invoiceId]);

  const send = async () => {
    if (!invoice) return;
    if (!confirm(useThai ? "ยืนยันส่งใบกำกับภาษี? จะลงบัญชี AR ทันที" : "Send invoice? AR will be posted to GL.")) return;
    setBusy(true);
    try {
      await api(`/api/sales/invoices/${invoiceId}/send`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await reload();
      await onChanged();
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  };

  const voidReceipt = async (receiptNo: number) => {
    const reason = prompt(
      useThai
        ? `เหตุผลการยกเลิกการรับชำระ #${receiptNo} (อย่างน้อย 3 ตัวอักษร):`
        : `Reason for voiding receipt #${receiptNo} (≥3 chars):`,
    );
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    try {
      await api(`/api/sales/invoices/${invoiceId}/receipts/${receiptNo}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      await reload();
      await onChanged();
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  };

  const cancelInvoice = async () => {
    if (!invoice) return;
    const reason = prompt(useThai ? "เหตุผลการยกเลิก:" : "Cancellation reason:");
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    try {
      await api(`/api/sales/invoices/${invoiceId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      await reload();
      await onChanged();
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-2">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="font-mono text-lg">
            {invoice?.internalNumber ?? "…"}
          </CardTitle>
          <CardDescription>
            {invoice?.invoiceDate}
            {invoice?.dueDate ? ` → ${invoice.dueDate}` : ""}
            {invoice?.customerReference ? ` · ref ${invoice.customerReference}` : ""}
          </CardDescription>
        </div>
        <div className="flex gap-2">
          {invoice?.status === "draft" && (
            <>
              <Button variant="outline" size="sm" onClick={cancelInvoice} disabled={busy}>
                <X className="h-4 w-4" />
                {useThai ? "ยกเลิก" : "Cancel"}
              </Button>
              <Button size="sm" onClick={send} disabled={busy}>
                <Send className="h-4 w-4" />
                {useThai ? "ส่ง (ลงบัญชี)" : "Send"}
              </Button>
            </>
          )}
          {invoice?.status === "sent" && (
            <Button variant="outline" size="sm" onClick={cancelInvoice} disabled={busy}>
              <X className="h-4 w-4" />
              {useThai ? "ยกเลิก (กลับบัญชี)" : "Cancel (reverse GL)"}
            </Button>
          )}
          {(invoice?.status === "sent" || invoice?.status === "partially_paid") && (
            <Button size="sm" onClick={() => setRecordOpen(true)} disabled={busy}>
              <Receipt className="h-4 w-4" />
              {useThai ? "บันทึกการรับชำระ" : "Record receipt"}
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}
        {loading || !invoice ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <Stat label={useThai ? "ยอดสุทธิ" : "Subtotal"}>
                {formatMoney(invoice.subtotalCents, invoice.currency)}
              </Stat>
              <Stat label={useThai ? "ภาษีมูลค่าเพิ่ม" : "VAT"}>
                {formatMoney(invoice.vatCents, invoice.currency)}
              </Stat>
              <Stat label={useThai ? "ภาษีหัก ณ ที่จ่าย" : "WHT (expected)"}>
                {formatMoney(invoice.whtCents, invoice.currency)}
              </Stat>
              <Stat label={useThai ? "ยอดรวมทั้งสิ้น" : "Total"}>
                <span className="text-lg font-bold">
                  {formatMoney(invoice.totalCents, invoice.currency)}
                </span>
              </Stat>
              <Stat label={useThai ? "รับแล้ว" : "Received"}>
                {formatMoney(invoice.paidCents, invoice.currency)}
              </Stat>
              <Stat label={useThai ? "WHT ที่ลูกค้าหัก" : "WHT recognised"}>
                {formatMoney(invoice.whtReceivedCents, invoice.currency)}
              </Stat>
              <Stat label={useThai ? "คงเหลือ" : "Remaining"}>
                <span className={invoice.remainingCents > 0 ? "text-amber-700 font-semibold" : "text-emerald-700"}>
                  {formatMoney(invoice.remainingCents, invoice.currency)}
                </span>
              </Stat>
              <Stat label={useThai ? "สถานะ" : "Status"}>
                <StatusPill status={invoice.status} useThai={useThai} />
              </Stat>
            </div>

            <div>
              <h4 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                {useThai ? "รายการ" : "Lines"}
              </h4>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-1">#</th>
                    <th className="px-2 py-1">{useThai ? "รายละเอียด" : "Description"}</th>
                    <th className="px-2 py-1 text-right">{useThai ? "จำนวน" : "Qty"}</th>
                    <th className="px-2 py-1 text-right">{useThai ? "ราคา" : "Price"}</th>
                    <th className="px-2 py-1 text-right">{useThai ? "สุทธิ" : "Net"}</th>
                    <th className="px-2 py-1 text-right">VAT</th>
                    <th className="px-2 py-1 text-right">WHT</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lines.map((l) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="px-2 py-1 text-xs text-muted-foreground">{l.lineNo}</td>
                      <td className="px-2 py-1">{l.description}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{l.qty}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {formatMoney(l.unitPriceCents, invoice.currency)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {formatMoney(l.netCents, invoice.currency)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-xs text-muted-foreground">
                        {formatMoney(l.vatCents, invoice.currency)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-xs text-muted-foreground">
                        {l.whtCategory ?? "—"} {l.whtCents ? `· ${formatMoney(l.whtCents, invoice.currency)}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h4 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                {useThai ? "การรับชำระ" : "Receipts"} ({receipts.length})
              </h4>
              {receipts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {useThai ? "ยังไม่มีการรับชำระ" : "No receipts yet."}
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-1">#</th>
                      <th className="px-2 py-1">{useThai ? "วันที่" : "Date"}</th>
                      <th className="px-2 py-1">{useThai ? "ช่องทาง" : "Method"}</th>
                      <th className="px-2 py-1 text-right">{useThai ? "ยอด" : "Amount"}</th>
                      <th className="px-2 py-1 text-right">WHT</th>
                      <th className="px-2 py-1 text-right">{useThai ? "ค่าธรรมเนียม" : "Bank"}</th>
                      <th className="px-2 py-1 text-right">{useThai ? "เงินสดสุทธิ" : "Cash"}</th>
                      <th className="px-2 py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipts.map((r) => {
                      const voided = !!r.voidedAt;
                      return (
                        <tr
                          key={r.id}
                          className={
                            "border-b last:border-0 " +
                            (voided ? "text-muted-foreground line-through" : "")
                          }
                          title={voided ? `Voided: ${r.voidReason ?? ""}` : undefined}
                        >
                          <td className="px-2 py-1 text-xs text-muted-foreground">{r.receiptNo}</td>
                          <td className="px-2 py-1">{r.receiptDate}</td>
                          <td className="px-2 py-1 text-xs">{r.paymentMethod ?? r.cashAccountCode}</td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {formatMoney(r.amountCents, invoice.currency)}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums text-xs">
                            {formatMoney(r.whtCents, invoice.currency)}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums text-xs">
                            {formatMoney(r.bankChargeCents, invoice.currency)}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums font-semibold">
                            {formatMoney(r.cashCents, invoice.currency)}
                          </td>
                          <td className="px-2 py-1 text-right">
                            {voided ? (
                              <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rose-700">
                                {useThai ? "ยกเลิก" : "voided"}
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="text-[10px] uppercase tracking-wide text-rose-600 hover:underline disabled:opacity-50"
                                onClick={() => voidReceipt(r.receiptNo)}
                                disabled={busy}
                              >
                                {useThai ? "ยกเลิก" : "void"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </CardContent>
      {invoice && recordOpen && (
        <RecordReceiptDialog
          invoiceId={invoiceId}
          remainingCents={invoice.remainingCents}
          totalCents={invoice.totalCents}
          whtRemainingCents={Math.max(0, invoice.whtCents - invoice.whtReceivedCents)}
          currency={invoice.currency}
          useThai={useThai}
          onClose={() => setRecordOpen(false)}
          onRecorded={async () => {
            setRecordOpen(false);
            await reload();
            await onChanged();
          }}
        />
      )}
    </Card>
  );
}

function RecordReceiptDialog({
  invoiceId,
  remainingCents,
  totalCents,
  whtRemainingCents,
  currency,
  useThai,
  onClose,
  onRecorded,
}: {
  invoiceId: string;
  remainingCents: number;
  totalCents: number;
  whtRemainingCents: number;
  currency: string;
  useThai: boolean;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const pct = (p: number) => Math.min(remainingCents, Math.round((totalCents * p) / 100));
  const [amount, setAmount] = useState<string>(String(remainingCents / 100));
  const [bankCharge, setBankCharge] = useState<string>("0");
  const [receiptDate, setReceiptDate] = useState<string>(
    new Date().toISOString().slice(0, 10),
  );
  const { accounts: cashAccounts, primaryCode } = useCashAccounts();
  const [cashAccount, setCashAccount] = useState<string>(primaryCode);
  useEffect(() => {
    if (cashAccounts.length > 0 && !cashAccounts.some((a) => a.code === cashAccount)) {
      setCashAccount(primaryCode);
    }
  }, [cashAccounts, primaryCode]);
  const [paymentMethod, setPaymentMethod] = useState<string>("bank_transfer");
  const [bankReference, setBankReference] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const amountCents = Math.round(Number(amount) * 100);
  const bankChargeCents = Math.round(Number(bankCharge) * 100);
  const valid =
    Number.isInteger(amountCents) &&
    amountCents > 0 &&
    amountCents <= remainingCents &&
    Number.isInteger(bankChargeCents) &&
    bankChargeCents >= 0;

  // Preview the WHT/cash split (server is authoritative).
  const isFinal = amountCents === remainingCents;
  const previewWht = !whtRemainingCents
    ? 0
    : isFinal
    ? whtRemainingCents
    : Math.floor((amountCents * whtRemainingCents) / Math.max(1, remainingCents));
  const previewCash = Math.max(0, amountCents - previewWht - bankChargeCents);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/sales/invoices/${invoiceId}/receipts`, {
        method: "POST",
        body: JSON.stringify({
          amountCents,
          bankChargeCents: bankChargeCents || undefined,
          receiptDate,
          cashAccountCode: cashAccount,
          paymentMethod,
          bankReference: bankReference.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      onRecorded();
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle>{useThai ? "บันทึกการรับชำระ" : "Record receipt"}</CardTitle>
          <CardDescription>
            {useThai ? "คงค้าง " : "Remaining "}
            <span className="font-semibold">{formatMoney(remainingCents, currency)}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">
              {useThai ? "จำนวนเงิน (THB)" : "Amount (THB)"}
            </label>
            <Input
              type="number"
              min={0.01}
              max={remainingCents / 100}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-10"
            />
            <div className="mt-1 flex gap-1">
              {[25, 50, 75, 100].map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setAmount(String(pct(p) / 100))}
                >
                  {p}%
                </Button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "ค่าธรรมเนียมธนาคาร" : "Bank charge"}
              </label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={bankCharge}
                onChange={(e) => setBankCharge(e.target.value)}
                className="h-10"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "วันที่รับเงิน" : "Receipt date"}
              </label>
              <Input
                type="date"
                value={receiptDate}
                onChange={(e) => setReceiptDate(e.target.value)}
                className="h-10"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "บัญชีรับเงิน" : "Cash account"}
              </label>
              <Select
                value={cashAccount}
                onValueChange={(v) => v && setCashAccount(v)}
              >
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.code} value={a.code}>
                      {a.code} — {useThai ? a.nameTh ?? a.nameEn ?? "" : a.nameEn ?? a.nameTh ?? ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "ช่องทาง" : "Method"}
              </label>
              <Select value={paymentMethod} onValueChange={(v) => v && setPaymentMethod(v)}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank_transfer">{useThai ? "โอนเงิน" : "Bank transfer"}</SelectItem>
                  <SelectItem value="cheque">{useThai ? "เช็ค" : "Cheque"}</SelectItem>
                  <SelectItem value="cash">{useThai ? "เงินสด" : "Cash"}</SelectItem>
                  <SelectItem value="promptpay">PromptPay</SelectItem>
                  <SelectItem value="card">{useThai ? "บัตร" : "Card"}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {useThai ? "เลขที่อ้างอิงธนาคาร" : "Bank reference"}
            </label>
            <Input
              value={bankReference}
              onChange={(e) => setBankReference(e.target.value)}
              className="h-10"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {useThai ? "หมายเหตุ" : "Notes"}
            </label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="h-10"
            />
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              {useThai ? "การลงบัญชี (ตัวอย่าง)" : "Posting preview"}
            </p>
            <div className="space-y-0.5 font-mono text-xs">
              <p>Dr {cashAccount} {formatMoney(previewCash, currency)}</p>
              {previewWht > 0 && <p>Dr 1157 {formatMoney(previewWht, currency)}</p>}
              {bankChargeCents > 0 && <p>Dr 6170 {formatMoney(bankChargeCents, currency)}</p>}
              <p>&nbsp;&nbsp;Cr 1141 {formatMoney(amountCents, currency)}</p>
            </div>
          </div>

          {err && (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-700">
              {err}
            </div>
          )}
        </CardContent>
        <CardContent className="flex justify-end gap-2 pt-0">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {useThai ? "ยกเลิก" : "Cancel"}
          </Button>
          <Button onClick={submit} disabled={!valid || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {useThai ? "บันทึก" : "Record"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function CreateInvoiceDialog({
  useThai,
  currency,
  onClose,
  onCreated,
}: {
  useThai: boolean;
  currency: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { settings } = useOrgSettings();
  const arWht = !!settings?.featureFlags?.arWht;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<string>("");
  const [customerReference, setCustomerReference] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [paymentTerms, setPaymentTerms] = useState("30");
  const [vatMode, setVatMode] = useState<"inclusive" | "exclusive">("exclusive");
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Customer[]>(`/api/purchasing/partners?role=customer`)
      .then(setCustomers)
      .catch((e) => setErr(e.message));
  }, []);

  const subtotal = useMemo(
    () =>
      lines.reduce((s, l) => {
        const qty = Number(l.qty) || 0;
        const price = Number(l.unitPriceCents) || 0;
        return s + Math.round(qty * price);
      }, 0),
    [lines],
  );

  const valid =
    customerId &&
    invoiceDate &&
    lines.length > 0 &&
    lines.every(
      (l) =>
        l.description.trim() &&
        Number(l.qty) > 0 &&
        Number(l.unitPriceCents) > 0,
    );

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ id: string }>(`/api/sales/invoices`, {
        method: "POST",
        body: JSON.stringify({
          customerId,
          customerReference: customerReference.trim() || undefined,
          invoiceDate,
          paymentTermsDays: Number(paymentTerms) || 30,
          vatMode,
          lines: lines.map((l) => ({
            description: l.description.trim(),
            qty: Number(l.qty),
            unitPriceCents: Math.round(Number(l.unitPriceCents)),
            vatCategory: l.vatCategory,
            vatMode,
            whtCategory: l.whtCategory === "none" ? null : (l.whtCategory as any),
          })),
        }),
      });
      onCreated(res.id);
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
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
        className="w-full max-w-3xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <CardTitle>{useThai ? "ใบกำกับภาษีใหม่" : "New invoice"}</CardTitle>
          <CardDescription>
            {useThai
              ? "กรอกรายการ → บันทึกเป็นร่าง → ส่ง (ลงบัญชี AR) → รับชำระทีหลัง"
              : "Fill lines → save draft → send (post AR) → record receipts later."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground">
                {useThai ? "ลูกค้า" : "Customer"}
              </label>
              <Select value={customerId} onValueChange={(v) => v && setCustomerId(v)}>
                <SelectTrigger className="h-10">
                  <SelectValue placeholder={useThai ? "เลือกลูกค้า" : "Pick customer"} />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} {c.tin ? `· ${c.tin}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "อ้างอิงลูกค้า" : "Customer ref"}
              </label>
              <Input
                value={customerReference}
                onChange={(e) => setCustomerReference(e.target.value)}
                className="h-10"
                placeholder="PO-2026-001"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "วันที่ออก" : "Invoice date"}
              </label>
              <Input
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className="h-10"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                {useThai ? "เครดิต (วัน)" : "Payment terms (days)"}
              </label>
              <Input
                type="number"
                min={0}
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value)}
                className="h-10"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">VAT</label>
              <Select value={vatMode} onValueChange={(v) => setVatMode(v as any)}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="exclusive">{useThai ? "VAT แยก" : "Exclusive"}</SelectItem>
                  <SelectItem value="inclusive">{useThai ? "VAT รวม" : "Inclusive"}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              {useThai ? "รายการ" : "Lines"}
            </h4>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-end">
                  <Input
                    className="col-span-4 h-10"
                    placeholder={useThai ? "รายละเอียด" : "Description"}
                    value={l.description}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...next[i], description: e.target.value };
                      setLines(next);
                    }}
                  />
                  <Input
                    className="col-span-1 h-10 text-right"
                    type="number"
                    min={0}
                    step="0.001"
                    value={l.qty}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...next[i], qty: e.target.value };
                      setLines(next);
                    }}
                  />
                  <Input
                    className="col-span-2 h-10 text-right"
                    type="number"
                    min={0}
                    step="1"
                    value={l.unitPriceCents}
                    placeholder={useThai ? "ราคา (สตางค์)" : "Unit price (cents)"}
                    onChange={(e) => {
                      const next = [...lines];
                      next[i] = { ...next[i], unitPriceCents: e.target.value };
                      setLines(next);
                    }}
                  />
                  <Select
                    value={l.vatCategory}
                    onValueChange={(v) => {
                      const next = [...lines];
                      next[i] = { ...next[i], vatCategory: v as any };
                      setLines(next);
                    }}
                  >
                    <SelectTrigger className="col-span-2 h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">7%</SelectItem>
                      <SelectItem value="zero_rated">0%</SelectItem>
                      <SelectItem value="exempt">{useThai ? "ยกเว้น" : "Exempt"}</SelectItem>
                    </SelectContent>
                  </Select>
                  {arWht && (
                    <Select
                      value={l.whtCategory}
                      onValueChange={(v) => {
                        if (!v) return;
                        const next = [...lines];
                        next[i] = { ...next[i], whtCategory: v };
                        setLines(next);
                      }}
                    >
                      <SelectTrigger className="col-span-2 h-10">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WHT_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="col-span-1 h-10"
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                    disabled={lines.length === 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setLines([...lines, blankLine()])}
            >
              <Plus className="h-4 w-4" /> {useThai ? "เพิ่มบรรทัด" : "Add line"}
            </Button>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              {useThai ? "สรุป (ก่อนเครื่องคำนวณ VAT จริง)" : "Preview (rough — server is authoritative)"}
            </p>
            <div className="flex justify-between font-mono text-xs">
              <span>{useThai ? "ยอดสุทธิ" : "Subtotal"}</span>
              <span>{formatMoney(subtotal, currency)}</span>
            </div>
          </div>

          {err && (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-700">
              {err}
            </div>
          )}
        </CardContent>
        <CardContent className="flex justify-end gap-2 pt-0">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {useThai ? "ยกเลิก" : "Cancel"}
          </Button>
          <Button onClick={submit} disabled={!valid || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {useThai ? "สร้างเป็นร่าง" : "Create draft"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ArAgingTab({ useThai, currency }: { useThai: boolean; currency: string }) {
  const [asOf, setAsOf] = useState<string>(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<AgingReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<AgingReport>(`/api/sales/ar-aging?asOf=${asOf}`)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [asOf]);

  const labels: Record<Bucket, string> = useThai
    ? {
        current: "ยังไม่ครบกำหนด",
        d1_30: "เกิน 1-30 วัน",
        d31_60: "เกิน 31-60 วัน",
        d61_90: "เกิน 61-90 วัน",
        d90_plus: "เกิน 90 วัน+",
      }
    : {
        current: "Current",
        d1_30: "1-30 days",
        d31_60: "31-60 days",
        d61_90: "61-90 days",
        d90_plus: "90+ days",
      };

  const buckets: Bucket[] = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {useThai
            ? "ยอดลูกหนี้คงค้างแยกตามช่วงเวลาที่เลยกำหนดชำระ ใช้ dueDate ถ้าไม่มีก็ใช้ invoiceDate + เครดิตเทอม"
            : "Outstanding AR by overdue bucket. Effective due = dueDate ?? invoiceDate + customer paymentTermsDays."}
        </p>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">
            {useThai ? "ณ วันที่" : "As of"}
          </label>
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="h-10 w-44"
          />
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
      ) : !report || report.customers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {useThai ? "ไม่มียอดลูกหนี้คงค้าง" : "No outstanding AR."}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="grid grid-cols-2 gap-4 p-4 md:grid-cols-6">
              <Stat label={useThai ? "รวมทั้งหมด" : "Grand total"}>
                {formatMoney(report.grandTotalCents, currency)}
              </Stat>
              {buckets.map((bk) => (
                <Stat key={bk} label={labels[bk]}>
                  {formatMoney(report.bucketTotals[bk], currency)}
                </Stat>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="overflow-x-auto px-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2">{useThai ? "ลูกค้า" : "Customer"}</th>
                    {buckets.map((bk) => (
                      <th key={bk} className="px-4 py-2 text-right">
                        {labels[bk]}
                      </th>
                    ))}
                    <th className="px-4 py-2 text-right">{useThai ? "รวม" : "Total"}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.customers.map((c) => (
                    <CustomerAgingRow
                      key={c.customerId}
                      customer={c}
                      buckets={buckets}
                      currency={currency}
                      useThai={useThai}
                      labels={labels}
                    />
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function CustomerAgingRow({
  customer,
  buckets,
  currency,
  useThai,
  labels,
}: {
  customer: CustomerAging;
  buckets: Bucket[];
  currency: string;
  useThai: boolean;
  labels: Record<Bucket, string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/40">
        <td className="px-4 py-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-left hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronRight
              className={"h-3 w-3 transition-transform " + (open ? "rotate-90" : "")}
            />
            <span className="font-medium">{customer.customerName}</span>
          </button>
        </td>
        {buckets.map((bk) => (
          <td key={bk} className="px-4 py-2 text-right tabular-nums">
            {customer.buckets[bk] > 0
              ? formatMoney(customer.buckets[bk], currency)
              : "—"}
          </td>
        ))}
        <td className="px-4 py-2 text-right tabular-nums font-semibold">
          {formatMoney(customer.totalRemainingCents, currency)}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={buckets.length + 2} className="px-4 py-2 bg-muted/20">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left uppercase tracking-wide text-muted-foreground">
                  <th className="py-1">{useThai ? "เลขที่" : "Number"}</th>
                  <th className="py-1">{useThai ? "วันที่" : "Date"}</th>
                  <th className="py-1">{useThai ? "ครบกำหนด" : "Due"}</th>
                  <th className="py-1 text-right">{useThai ? "เลยกำหนด" : "Days overdue"}</th>
                  <th className="py-1 text-right">{useThai ? "รวม" : "Total"}</th>
                  <th className="py-1 text-right">{useThai ? "รับแล้ว" : "Paid"}</th>
                  <th className="py-1 text-right">{useThai ? "คงเหลือ" : "Remaining"}</th>
                </tr>
              </thead>
              <tbody>
                {customer.invoices.map((inv) => (
                  <tr key={inv.invoiceId} className="border-b last:border-0">
                    <td className="py-1 font-mono">{inv.internalNumber}</td>
                    <td className="py-1">{inv.invoiceDate}</td>
                    <td className="py-1">{inv.effectiveDueDate}</td>
                    <td className="py-1 text-right">{inv.daysOverdue || "—"}</td>
                    <td className="py-1 text-right tabular-nums">
                      {formatMoney(inv.totalCents, currency)}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {formatMoney(inv.paidCents, currency)}
                    </td>
                    <td className="py-1 text-right tabular-nums font-semibold">
                      {formatMoney(inv.remainingCents, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{children}</p>
    </div>
  );
}
