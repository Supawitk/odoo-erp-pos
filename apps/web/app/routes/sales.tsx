/**
 * Sales — three tabs:
 *   1. Ledger     — every customer-facing document (RE/ABB/TX/CN), filterable
 *   2. Customers  — buyers ranked by spend, enriched from custom.partners
 *   3. Analytics  — daily revenue chart + KPI tiles + top products
 *
 * Reads existing data from custom.pos_orders — POS sales ARE the sales.
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import {
  ShoppingCart, Users, BarChart3, FileText, Receipt, RefreshCw, Filter, Download, ExternalLink,
  Sparkles, TrendingUp, TrendingDown,
} from "lucide-react";
import { API_BASE, api, formatMoney } from "~/lib/api";
import { useT } from "~/hooks/use-t";
import { useOrgSettings } from "~/hooks/use-org-settings";

type Tab = "ledger" | "customers" | "analytics" | "insights";

type DocType = "RE" | "ABB" | "TX" | "CN";
type Status = "paid" | "refunded" | "voided" | "draft";
type Payment = "cash" | "card" | "promptpay" | "split";

interface SaleRow {
  id: string;
  documentType: DocType;
  documentNumber: string | null;
  status: Status;
  paymentMethod: Payment;
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  currency: string;
  buyerName: string | null;
  buyerTin: string | null;
  buyerBranch: string | null;
  orderLines: Array<{ name: string; qty: number; unitPriceCents: number }>;
  vatBreakdown: { taxableNetCents: number; zeroRatedNetCents: number; exemptNetCents: number; vatCents: number; grossCents: number } | null;
  originalOrderId: string | null;
  createdAt: string;
}

interface CustomerRow {
  tin: string | null;
  name: string;
  branch: string | null;
  orderCount: number;
  grossCents: number;
  refundCents: number;
  netCents: number;
  partnerId: string | null;
  email: string | null;
  phone: string | null;
  paymentTermsDays: number | null;
  firstOrderAt: string;
  lastOrderAt: string;
}

interface DailyRow {
  day: string;
  orderCount: number;
  refundCount: number;
  grossCents: number;
  refundCents: number;
  netCents: number;
  vatCents: number;
}

interface TopProductRow {
  productId: string | null;
  name: string;
  qty: number;
  revenueCents: number;
}

export default function Sales() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("ledger");

  return (
    <div className="-m-6 flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex items-center justify-between border-b px-6 pt-6 pb-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t.sales_title}</h1>
          <p className="text-muted-foreground">{t.sales_subtitle}</p>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b px-6">
        <TabButton current={tab} value="ledger" onClick={setTab} icon={<FileText className="h-4 w-4" />}>
          {t.sales_tab_ledger}
        </TabButton>
        <TabButton current={tab} value="customers" onClick={setTab} icon={<Users className="h-4 w-4" />}>
          {t.sales_tab_customers}
        </TabButton>
        <TabButton current={tab} value="analytics" onClick={setTab} icon={<BarChart3 className="h-4 w-4" />}>
          {t.sales_tab_analytics}
        </TabButton>
        <TabButton current={tab} value="insights" onClick={setTab} icon={<Sparkles className="h-4 w-4" />}>
          {t.sales_tab_insights}
        </TabButton>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === "ledger" && <LedgerTab />}
        {tab === "customers" && <CustomersTab />}
        {tab === "analytics" && <AnalyticsTab />}
        {tab === "insights" && <InsightsTab />}
      </div>
    </div>
  );
}

function TabButton({
  current, value, onClick, icon, children,
}: {
  current: Tab; value: Tab; onClick: (v: Tab) => void; icon?: React.ReactNode; children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onClick(value)}
      className={
        "flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors " +
        (active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {icon}
      {children}
    </button>
  );
}

// ─── Ledger tab ─────────────────────────────────────────────────────────────
function LedgerTab() {
  const t = useT();
  const { settings } = useOrgSettings();
  const currency = settings?.currency ?? "THB";
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filters
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const [from, setFrom] = useState(toDateInput(firstOfMonth));
  const [to, setTo] = useState(toDateInput(addDays(today, 1)));
  const [documentType, setDocumentType] = useState<DocType | "">("");
  const [status, setStatus] = useState<Status | "">("");
  const [paymentMethod, setPaymentMethod] = useState<Payment | "">("");
  const [search, setSearch] = useState("");
  const [appliedKey, setAppliedKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (documentType) qs.set("documentType", documentType);
    if (status) qs.set("status", status);
    if (paymentMethod) qs.set("paymentMethod", paymentMethod);
    if (search) qs.set("search", search);
    qs.set("limit", "200");

    api<{ rows: SaleRow[]; total: number }>(`/api/sales/orders?${qs.toString()}`)
      .then((d) => {
        setRows(d.rows);
        setTotal(d.total);
      })
      .catch(() => {
        setRows([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [appliedKey]);

  const apply = () => setAppliedKey((k) => k + 1);
  const reset = () => {
    setFrom(toDateInput(firstOfMonth));
    setTo(toDateInput(addDays(today, 1)));
    setDocumentType("");
    setStatus("");
    setPaymentMethod("");
    setSearch("");
    setAppliedKey((k) => k + 1);
  };

  const exportCsv = () => {
    const headers = [t.sales_th_date, t.sales_th_doctype, t.sales_th_doc_no, t.sales_th_buyer, t.sales_th_tin, t.sales_th_payment, t.sales_th_subtotal, t.sales_th_vat, t.sales_th_total, t.sales_th_status];
    const csv = [
      headers.join(","),
      ...rows.map((r) =>
        [
          new Date(r.createdAt).toISOString(),
          r.documentType,
          escapeCsv(r.documentNumber ?? ""),
          escapeCsv(r.buyerName ?? ""),
          escapeCsv(r.buyerTin ?? ""),
          r.paymentMethod,
          (r.subtotalCents / 100).toFixed(2),
          (r.taxCents / 100).toFixed(2),
          (r.totalCents / 100).toFixed(2),
          r.status,
        ].join(","),
      ),
    ].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Filter card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="h-4 w-4" />
            {t.sales_filter_apply}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t.sales_filter_from}</label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t.sales_filter_to}</label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t.sales_filter_doctype}</label>
              <Select
                value={documentType}
                onValueChange={(v) => setDocumentType((v as DocType | "") ?? "")}
              >
                <SelectTrigger size="sm">
                  <SelectValue placeholder={t.sales_filter_all} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t.sales_filter_all}</SelectItem>
                  <SelectItem value="RE">{t.sales_doctype_RE}</SelectItem>
                  <SelectItem value="ABB">{t.sales_doctype_ABB}</SelectItem>
                  <SelectItem value="TX">{t.sales_doctype_TX}</SelectItem>
                  <SelectItem value="CN">{t.sales_doctype_CN}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t.sales_filter_status}</label>
              <Select
                value={status}
                onValueChange={(v) => setStatus((v as Status | "") ?? "")}
              >
                <SelectTrigger size="sm">
                  <SelectValue placeholder={t.sales_filter_all} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t.sales_filter_all}</SelectItem>
                  <SelectItem value="paid">{t.sales_status_paid}</SelectItem>
                  <SelectItem value="refunded">{t.sales_status_refunded}</SelectItem>
                  <SelectItem value="voided">{t.sales_status_voided}</SelectItem>
                  <SelectItem value="draft">{t.sales_status_draft}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t.sales_filter_payment}</label>
              <Select
                value={paymentMethod}
                onValueChange={(v) => setPaymentMethod((v as Payment | "") ?? "")}
              >
                <SelectTrigger size="sm">
                  <SelectValue placeholder={t.sales_filter_all} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t.sales_filter_all}</SelectItem>
                  <SelectItem value="cash">{t.sales_payment_cash}</SelectItem>
                  <SelectItem value="card">{t.sales_payment_card}</SelectItem>
                  <SelectItem value="promptpay">{t.sales_payment_promptpay}</SelectItem>
                  <SelectItem value="split">{t.sales_payment_split}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 col-span-2 md:col-span-2 lg:col-span-1">
              <label className="text-xs text-muted-foreground">{t.sales_filter_search}</label>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apply()}
                placeholder={t.sales_filter_search}
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button onClick={apply} size="sm">
              <Filter className="mr-2 h-4 w-4" />
              {t.sales_filter_apply}
            </Button>
            <Button onClick={reset} size="sm" variant="outline">
              <RefreshCw className="mr-2 h-4 w-4" />
              {t.sales_filter_reset}
            </Button>
            <div className="flex-1" />
            <span className="text-sm text-muted-foreground">{t.sales_total_count(total)}</span>
            <Button onClick={exportCsv} size="sm" variant="outline" disabled={rows.length === 0}>
              <Download className="mr-2 h-4 w-4" />
              {t.sales_export_csv}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Results table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-6 text-center text-sm text-muted-foreground">…</p>
          ) : rows.length === 0 ? (
            <p className="p-12 text-center text-sm text-muted-foreground">{t.sales_no_results}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40">
                  <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-medium">{t.sales_th_date}</th>
                    <th className="px-4 py-3 font-medium">{t.sales_th_doctype}</th>
                    <th className="px-4 py-3 font-medium">{t.sales_th_doc_no}</th>
                    <th className="px-4 py-3 font-medium">{t.sales_th_buyer}</th>
                    <th className="px-4 py-3 font-medium">{t.sales_th_payment}</th>
                    <th className="px-4 py-3 text-right font-medium">{t.sales_th_subtotal}</th>
                    <th className="px-4 py-3 text-right font-medium">{t.sales_th_vat}</th>
                    <th className="px-4 py-3 text-right font-medium">{t.sales_th_total}</th>
                    <th className="px-4 py-3 font-medium">{t.sales_th_status}</th>
                    <th className="px-4 py-3 font-medium">{t.sales_th_actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(r.createdAt)}</td>
                      <td className="px-4 py-3">
                        <DocTypePill type={r.documentType} />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{r.documentNumber ?? "—"}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{r.buyerName ?? <span className="italic text-muted-foreground">{t.sales_walk_in}</span>}</div>
                        {r.buyerTin && <div className="text-xs text-muted-foreground">{formatTin(r.buyerTin)}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <PaymentBadge method={r.paymentMethod} />
                      </td>
                      <td className="px-4 py-3 text-right font-mono">{formatMoney(r.subtotalCents, currency)}</td>
                      <td className="px-4 py-3 text-right font-mono text-muted-foreground">{formatMoney(r.taxCents, currency)}</td>
                      <td className="px-4 py-3 text-right font-mono font-semibold">{formatMoney(r.totalCents, currency)}</td>
                      <td className="px-4 py-3">
                        <StatusPill status={r.status} />
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={`${API_BASE}/api/pos/receipts/${r.id}.html`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <Receipt className="h-3 w-3" />
                          {t.sales_open_receipt}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DocTypePill({ type }: { type: DocType }) {
  const t = useT();
  const map: Record<DocType, { label: string; cls: string }> = {
    RE: { label: t.sales_doctype_RE, cls: "bg-blue-100 text-blue-700" },
    ABB: { label: t.sales_doctype_ABB, cls: "bg-emerald-100 text-emerald-700" },
    TX: { label: t.sales_doctype_TX, cls: "bg-violet-100 text-violet-700" },
    CN: { label: t.sales_doctype_CN, cls: "bg-rose-100 text-rose-700" },
  };
  const m = map[type];
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>{type}</span>;
}

function PaymentBadge({ method }: { method: Payment }) {
  const t = useT();
  const label =
    method === "cash" ? t.sales_payment_cash :
    method === "card" ? t.sales_payment_card :
    method === "promptpay" ? t.sales_payment_promptpay :
    t.sales_payment_split;
  return <span className="text-xs">{label}</span>;
}

function StatusPill({ status }: { status: Status }) {
  const t = useT();
  const map: Record<Status, { label: string; cls: string }> = {
    paid: { label: t.sales_status_paid, cls: "bg-green-100 text-green-700" },
    refunded: { label: t.sales_status_refunded, cls: "bg-amber-100 text-amber-700" },
    voided: { label: t.sales_status_voided, cls: "bg-gray-200 text-gray-700" },
    draft: { label: t.sales_status_draft, cls: "bg-slate-100 text-slate-600" },
  };
  const m = map[status] ?? map.draft;
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>{m.label}</span>;
}

// ─── Customers tab ──────────────────────────────────────────────────────────
function CustomersTab() {
  const t = useT();
  const { settings } = useOrgSettings();
  const currency = settings?.currency ?? "THB";
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [appliedKey, setAppliedKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (search) qs.set("search", search);
    qs.set("limit", "200");
    api<CustomerRow[]>(`/api/sales/customers?${qs.toString()}`)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [appliedKey]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setAppliedKey((k) => k + 1)}
              placeholder={t.customers_search}
              className="max-w-sm"
            />
            <Button onClick={() => setAppliedKey((k) => k + 1)} size="sm">
              <Filter className="mr-2 h-4 w-4" />
              {t.sales_filter_apply}
            </Button>
            <div className="flex-1" />
            <span className="text-sm text-muted-foreground">{t.sales_total_count(rows.length)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-6 text-center text-sm text-muted-foreground">…</p>
          ) : rows.length === 0 ? (
            <p className="p-12 text-center text-sm text-muted-foreground">{t.customers_no_results}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40">
                  <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-medium">{t.customers_th_name}</th>
                    <th className="px-4 py-3 font-medium">{t.customers_th_tin}</th>
                    <th className="px-4 py-3 font-medium">{t.customers_th_contact}</th>
                    <th className="px-4 py-3 text-right font-medium">{t.customers_th_orders}</th>
                    <th className="px-4 py-3 text-right font-medium">{t.customers_th_revenue}</th>
                    <th className="px-4 py-3 text-right font-medium">{t.customers_th_refunds}</th>
                    <th className="px-4 py-3 text-right font-medium">{t.customers_th_net}</th>
                    <th className="px-4 py-3 font-medium">{t.customers_th_first}</th>
                    <th className="px-4 py-3 font-medium">{t.customers_th_last}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={r.tin ?? `walk-${idx}`} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">
                        {r.name}
                        {r.branch && r.branch !== "00000" && (
                          <span className="ml-1 text-xs text-muted-foreground">({r.branch})</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {r.tin ? formatTin(r.tin) : <span className="italic text-muted-foreground">{t.customers_no_tin}</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {r.email && <div>{r.email}</div>}
                        {r.phone && <div>{r.phone}</div>}
                        {!r.email && !r.phone && <span>—</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">{r.orderCount}</td>
                      <td className="px-4 py-3 text-right font-mono">{formatMoney(r.grossCents, currency)}</td>
                      <td className="px-4 py-3 text-right font-mono text-rose-600">
                        {r.refundCents !== 0 ? formatMoney(r.refundCents, currency) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold">{formatMoney(r.netCents, currency)}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(r.firstOrderAt)}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(r.lastOrderAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Analytics tab ──────────────────────────────────────────────────────────
function AnalyticsTab() {
  const t = useT();
  const { settings } = useOrgSettings();
  const currency = settings?.currency ?? "THB";
  const [period, setPeriod] = useState<"7d" | "30d" | "90d" | "ytd">("30d");
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [topProducts, setTopProducts] = useState<TopProductRow[]>([]);
  const [loading, setLoading] = useState(true);

  const { from, to } = useMemo(() => computePeriod(period), [period]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<DailyRow[]>(`/api/sales/summary/daily?from=${from}&to=${to}`),
      api<TopProductRow[]>(`/api/sales/summary/top-products?from=${from}&to=${to}&limit=10`),
    ])
      .then(([d, p]) => {
        setDaily(d);
        setTopProducts(p);
      })
      .catch(() => {
        setDaily([]);
        setTopProducts([]);
      })
      .finally(() => setLoading(false));
  }, [from, to]);

  // KPIs
  const totalNet = daily.reduce((s, d) => s + d.netCents, 0);
  const totalOrders = daily.reduce((s, d) => s + d.orderCount, 0);
  const totalVat = daily.reduce((s, d) => s + d.vatCents, 0);
  const totalRefunds = daily.reduce((s, d) => s + Math.abs(d.refundCents), 0);
  const aov = totalOrders ? Math.round(totalNet / totalOrders) : 0;

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t.analytics_period}:</span>
        {(["7d", "30d", "90d", "ytd"] as const).map((p) => (
          <Button
            key={p}
            size="sm"
            variant={period === p ? "default" : "outline"}
            onClick={() => setPeriod(p)}
          >
            {p === "7d" ? t.analytics_period_7d : p === "30d" ? t.analytics_period_30d : p === "90d" ? t.analytics_period_90d : t.analytics_period_ytd}
          </Button>
        ))}
      </div>

      {/* KPI tiles */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Kpi title={t.analytics_kpi_revenue} value={formatMoney(totalNet, currency)} icon={<ShoppingCart className="h-4 w-4" />} />
        <Kpi title={t.analytics_kpi_orders} value={String(totalOrders)} icon={<FileText className="h-4 w-4" />} />
        <Kpi title={t.analytics_kpi_aov} value={formatMoney(aov, currency)} icon={<BarChart3 className="h-4 w-4" />} />
        <Kpi title={t.analytics_kpi_vat} value={formatMoney(totalVat, currency)} icon={<Receipt className="h-4 w-4" />} />
        <Kpi title={t.analytics_kpi_refunds} value={formatMoney(totalRefunds, currency)} icon={<RefreshCw className="h-4 w-4" />} />
      </div>

      {/* Daily chart */}
      <Card>
        <CardHeader>
          <CardTitle>{t.analytics_chart_title}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-48 animate-pulse rounded bg-muted" />
          ) : daily.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">{t.analytics_chart_empty}</p>
          ) : (
            <BarChart data={daily} currency={currency} />
          )}
        </CardContent>
      </Card>

      {/* Top products */}
      <Card>
        <CardHeader>
          <CardTitle>{t.analytics_top_products}</CardTitle>
          <CardDescription>{t.analytics_top_products_sub}</CardDescription>
        </CardHeader>
        <CardContent>
          {topProducts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t.analytics_no_top}</p>
          ) : (
            <ul className="space-y-2">
              {topProducts.map((p, idx) => (
                <li key={`${p.productId}-${idx}`} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-3">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {idx + 1}
                    </span>
                    <span className="font-medium">{p.name}</span>
                  </span>
                  <div className="flex items-center gap-4 text-muted-foreground">
                    <span>× {p.qty}</span>
                    <span className="font-semibold text-foreground">{formatMoney(p.revenueCents, currency)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

// ─── Insights tab ───────────────────────────────────────────────────────────
interface InsightsResp {
  window: { fromIso: string; toIso: string; days: number };
  paymentMix: Array<{ method: string; orderCount: number; revenueCents: number }>;
  hourlyHeatmap: Array<{ weekday: number; hour: number; orderCount: number; revenueCents: number }>;
  documentMix: Array<{ documentType: string; orderCount: number; revenueCents: number }>;
  periodCompare: {
    current: { from: string; to: string; orderCount: number; revenueCents: number };
    previous: { from: string; to: string; orderCount: number; revenueCents: number };
    deltaPct: number;
  };
  refundCount: number;
  refundedRevenueCents: number;
}

function InsightsTab() {
  const { settings } = useOrgSettings();
  const currency = settings?.currency ?? "THB";
  const [period, setPeriod] = useState<"7d" | "30d" | "90d">("30d");
  const [data, setData] = useState<InsightsResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    api<InsightsResp>(
      `/api/reports/insights?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    )
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [period]);

  if (loading) {
    return <div className="h-48 animate-pulse rounded bg-muted" />;
  }
  if (!data) {
    return <p className="py-12 text-center text-sm text-muted-foreground">No data available.</p>;
  }

  const totalOrders = data.paymentMix.reduce((s, r) => s + r.orderCount, 0);
  const totalRev = data.paymentMix.reduce((s, r) => s + r.revenueCents, 0);
  const dPct = data.periodCompare.deltaPct;
  const txCount = data.documentMix.find((d) => d.documentType === "TX")?.orderCount ?? 0;
  const abbCount = data.documentMix.find((d) => d.documentType === "ABB")?.orderCount ?? 0;
  const reCount = data.documentMix.find((d) => d.documentType === "RE")?.orderCount ?? 0;
  const cnCount = data.documentMix.find((d) => d.documentType === "CN")?.orderCount ?? 0;

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Period:</span>
        {(["7d", "30d", "90d"] as const).map((p) => (
          <Button
            key={p}
            size="sm"
            variant={period === p ? "default" : "outline"}
            onClick={() => setPeriod(p)}
          >
            {p === "7d" ? "Last 7 days" : p === "30d" ? "Last 30 days" : "Last 90 days"}
          </Button>
        ))}
      </div>

      {/* Period comparison KPI */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Period revenue</CardTitle>
            <CardDescription className="text-xs">vs previous {data.window.days}d</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatMoney(data.periodCompare.current.revenueCents, currency)}
            </div>
            <div
              className={
                "mt-1 flex items-center gap-1 text-xs " +
                (dPct >= 0 ? "text-green-600" : "text-red-600")
              }
            >
              {dPct >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {(dPct * 100).toFixed(1)}% vs{" "}
              {formatMoney(data.periodCompare.previous.revenueCents, currency)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Orders</CardTitle>
            <CardDescription className="text-xs">{totalOrders} total</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.periodCompare.current.orderCount}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {data.periodCompare.previous.orderCount} previously
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Refunds (CN)</CardTitle>
            <CardDescription className="text-xs">
              {totalOrders > 0 ? ((data.refundCount / totalOrders) * 100).toFixed(1) : "0"}% of orders
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.refundCount}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatMoney(Math.abs(data.refundedRevenueCents), currency)} refunded
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Payment mix */}
      <Card>
        <CardHeader>
          <CardTitle>Payment method mix</CardTitle>
          <CardDescription>Where the money came in</CardDescription>
        </CardHeader>
        <CardContent>
          {data.paymentMix.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No orders in this window.</p>
          ) : (
            <div className="space-y-3">
              {data.paymentMix.map((p) => {
                const sharePct = totalRev > 0 ? (p.revenueCents / totalRev) * 100 : 0;
                return (
                  <div key={p.method}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium capitalize">{p.method}</span>
                      <span className="text-muted-foreground">
                        {p.orderCount} orders ·{" "}
                        <span className="font-semibold text-foreground">
                          {formatMoney(p.revenueCents, currency)}
                        </span>{" "}
                        ({sharePct.toFixed(1)}%)
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded bg-muted">
                      <div className="h-full bg-primary" style={{ width: `${sharePct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Doc-type compliance signal */}
      <Card>
        <CardHeader>
          <CardTitle>Document mix · compliance signal</CardTitle>
          <CardDescription>
            TX (full tax invoices) vs ABB (abbreviated) vs RE (non-VAT receipts) — check if the right doc type is being issued
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-3">
            <DocCounter label="TX" hint="Full tax invoice" count={txCount} total={totalOrders} accent="emerald" />
            <DocCounter label="ABB" hint="Abbreviated tax invoice" count={abbCount} total={totalOrders} accent="blue" />
            <DocCounter label="RE" hint="Receipt (non-VAT)" count={reCount} total={totalOrders} accent="amber" />
            <DocCounter label="CN" hint="Credit note" count={cnCount} total={totalOrders} accent="rose" />
          </div>
          {totalOrders > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Tip: ABB &gt;&gt; TX is normal for retail. A spike in CN vs sale documents (&gt;5%) warrants
              a refund-pattern review.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Hourly heatmap */}
      <Card>
        <CardHeader>
          <CardTitle>Order heatmap</CardTitle>
          <CardDescription>
            7×24 grid of order count, weekday × hour (Asia/Bangkok). Darker = busier.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Heatmap cells={data.hourlyHeatmap} />
        </CardContent>
      </Card>
    </div>
  );
}

function DocCounter({
  label, hint, count, total, accent,
}: {
  label: string; hint: string; count: number; total: number;
  accent: "emerald" | "blue" | "amber" | "rose";
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const color =
    accent === "emerald" ? "bg-emerald-500" :
    accent === "blue" ? "bg-blue-500" :
    accent === "amber" ? "bg-amber-500" :
    "bg-rose-500";
  return (
    <div className="rounded-md border p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <span className={"inline-block h-2 w-2 rounded-full " + color} />
      </div>
      <div className="text-2xl font-bold">{count}</div>
      <div className="text-xs text-muted-foreground">{hint}</div>
      <div className="text-[10px] text-muted-foreground mt-1">{pct.toFixed(1)}%</div>
    </div>
  );
}

function Heatmap({
  cells,
}: {
  cells: Array<{ weekday: number; hour: number; orderCount: number; revenueCents: number }>;
}) {
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const c of cells) {
    grid[c.weekday][c.hour] = c.orderCount;
    if (c.orderCount > max) max = c.orderCount;
  }
  const wkLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px]">
        <thead>
          <tr>
            <th className="w-10 px-1 text-left text-muted-foreground"></th>
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} className="px-0.5 text-center font-normal text-muted-foreground">
                {h % 3 === 0 ? h : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, wk) => (
            <tr key={wk}>
              <td className="pr-2 text-muted-foreground">{wkLabels[wk]}</td>
              {row.map((count, h) => {
                const intensity = max > 0 ? count / max : 0;
                const bg =
                  count === 0
                    ? "bg-muted/30"
                    : intensity > 0.75
                    ? "bg-primary"
                    : intensity > 0.5
                    ? "bg-primary/75"
                    : intensity > 0.25
                    ? "bg-primary/50"
                    : "bg-primary/25";
                return (
                  <td
                    key={h}
                    className={"h-5 border border-background " + bg}
                    title={`${wkLabels[wk]} ${String(h).padStart(2, "0")}:00 — ${count} orders`}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarChart({ data, currency }: { data: DailyRow[]; currency: string }) {
  const max = Math.max(1, ...data.map((d) => d.netCents));
  return (
    <div className="space-y-1">
      <div className="flex h-48 items-end gap-1">
        {data.map((d) => {
          const pct = (d.netCents / max) * 100;
          return (
            <div key={d.day} className="group relative flex-1" style={{ height: "100%" }}>
              <div
                className="absolute bottom-0 left-0 right-0 rounded-t bg-primary/80 transition-all hover:bg-primary"
                style={{ height: `${Math.max(2, pct)}%` }}
                title={`${d.day}: ${formatMoney(d.netCents, currency)} • ${d.orderCount} orders`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{data[0]?.day ?? ""}</span>
        <span>{data[data.length - 1]?.day ?? ""}</span>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function toDateInput(d: Date) {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString();
}
function formatTin(tin: string) {
  if (!tin || tin.length !== 13) return tin;
  return `${tin[0]}-${tin.slice(1, 5)}-${tin.slice(5, 10)}-${tin.slice(10, 12)}-${tin[12]}`;
}
function escapeCsv(s: string) {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
function computePeriod(p: "7d" | "30d" | "90d" | "ytd") {
  const today = new Date();
  const to = toDateInput(addDays(today, 1));
  let fromDate: Date;
  if (p === "7d") fromDate = addDays(today, -6);
  else if (p === "30d") fromDate = addDays(today, -29);
  else if (p === "90d") fromDate = addDays(today, -89);
  else fromDate = new Date(today.getFullYear(), 0, 1);
  return { from: toDateInput(fromDate), to };
}
