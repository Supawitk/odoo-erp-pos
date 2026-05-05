import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  ClipboardCheck,
  Coins,
  HandCoins,
  Lock,
  Package,
  PercentSquare,
  Receipt,
  ShieldAlert,
  Star,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { api, formatMoney } from "~/lib/api";
import { useAuth } from "~/lib/auth";
import { useT } from "~/hooks/use-t";
import { useOrgSettings } from "~/hooks/use-org-settings";

type RangeKey = "7d" | "month" | "quarter" | "year";
type Granularity = "hour" | "day" | "week" | "month" | "quarter" | "year";

type TimeseriesBucket = {
  key: string;
  label: string;
  startIso: string;
  revenueCents: number;
  orderCount: number;
  refundCents: number;
  refundCount: number;
  vatCents: number;
  byDocType: Record<"RE" | "ABB" | "TX" | "CN", number>;
  byPayment: Record<string, number>;
};
type TimeseriesResponse = {
  granularity: Granularity;
  fromIso: string;
  toIso: string;
  buckets: TimeseriesBucket[];
  totals: {
    revenueCents: number;
    orderCount: number;
    refundCount: number;
    refundCents: number;
    vatCents: number;
    aovCents: number;
    refundRate: number;
  };
};

type CustomerRow = {
  key: string;
  name: string;
  tin: string | null;
  orderCount: number;
  revenueCents: number;
  refundCents: number;
  netCents: number;
  firstSeenIso: string;
  lastSeenIso: string;
};
type CustomerConcentration = {
  topCount: number;
  topRevenueCents: number;
  totalRevenueCents: number;
  share: number;
};
type CustomersAnalysis = {
  fromIso: string;
  toIso: string;
  rows: CustomerRow[];
  totals: { customerCount: number; revenueCents: number };
  concentration: { top10: CustomerConcentration; top25: CustomerConcentration };
};

type InsightsReport = {
  hourlyHeatmap: Array<{
    weekday: number;
    hour: number;
    orderCount: number;
    revenueCents: number;
  }>;
  periodCompare: {
    current: { from: string; to: string; orderCount: number; revenueCents: number };
    previous: { from: string; to: string; orderCount: number; revenueCents: number };
    deltaPct: number;
  };
};

// ── Tier 1 Finance Snapshot types ──────────────────────────────────────────
type AgingBucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";
type AgingBuckets = Record<AgingBucket, number>;

type ApAgingResp = {
  asOfDate: string;
  grandTotalCents: number;
  bucketTotals: AgingBuckets;
  suppliers: Array<{ supplierId: string; supplierName: string; totalRemainingCents: number }>;
};
type ArAgingResp = {
  asOfDate: string;
  grandTotalCents: number;
  bucketTotals: AgingBuckets;
  customers: Array<{ customerId: string; customerName: string; totalRemainingCents: number }>;
};
type ProfitLossResp = {
  from: string;
  to: string;
  revenue: { totalCents: number; rows: unknown[] };
  expense: { totalCents: number; rows: unknown[] };
  netIncomeCents: number;
};
type TrialBalanceResp = {
  asOfDate: string;
  rows: unknown[];
  totals: { debitCents: number; creditCents: number; deltaCents: number };
};
type FinanceSnapshot = {
  pnl: ProfitLossResp | null;
  tb: TrialBalanceResp | null;
  ap: ApAgingResp | null;
  ar: ArAgingResp | null;
};

// ── Tier 2 Operations Snapshot types ───────────────────────────────────────
type InventorySnapshotResp = {
  asOfIso: string;
  value: {
    totalValueCents: number;
    skuCount: number;
    skusWithStock: number;
    skusZero: number;
    skusLow: number;
  };
  velocity: {
    fromIso: string;
    toIso: string;
    rows: Array<{ moveType: string; moveCount: number; qtyAbs: number }>;
  };
};
type MatchExceptionsResp = {
  asOfIso: string;
  unmatched: { count: number; totalCents: number };
  byStatus: Array<{ status: string; count: number; totalCents: number }>;
  topBills: Array<{
    billId: string;
    internalNumber: string;
    supplierName: string;
    matchStatus: string | null;
    billStatus: string;
    totalCents: number;
    billDate: string;
  }>;
};
type VatMixResp = {
  fromIso: string;
  toIso: string;
  taxableNetCents: number;
  zeroRatedNetCents: number;
  exemptNetCents: number;
  totalNetCents: number;
  vatCents: number;
  orderCount: number;
};
type OpsSnapshot = {
  inv: InventorySnapshotResp | null;
  match: MatchExceptionsResp | null;
  vat: VatMixResp | null;
};

// ── Tier 3 Deep Analytics types ────────────────────────────────────────────
type ProfitabilityResp = {
  fromIso: string;
  toIso: string;
  totals: {
    unitsSold: number;
    revenueCents: number;
    cogsCents: number;
    marginCents: number;
    marginPct: number;
    skusSold: number;
    cogsCoveragePct: number;
  };
  byProduct: Array<{
    productId: string | null;
    name: string;
    category: string | null;
    unitsSold: number;
    revenueCents: number;
    cogsCents: number;
    marginCents: number;
    marginPct: number;
  }>;
  byCategory: Array<{
    category: string;
    unitsSold: number;
    revenueCents: number;
    cogsCents: number;
    marginCents: number;
    marginPct: number;
  }>;
};
type CohortsResp = {
  fromIso: string;
  toIso: string;
  inWindow: {
    identifiedCustomers: number;
    walkInOrderCount: number;
    walkInRevenueCents: number;
    newCustomers: number;
    returningCustomers: number;
    newRevenueCents: number;
    returningRevenueCents: number;
  };
  cohorts: Array<{
    cohortMonth: string;
    cohortSize: number;
    cells: Array<{
      cohortMonth: string;
      monthOffset: number;
      activeCustomers: number;
      revenueCents: number;
    }>;
  }>;
};
type WhtRollupResp = {
  fromIso: string;
  toIso: string;
  totals: {
    paidCents: number;
    paidCount: number;
    receivedCents: number;
    receivedCount: number;
  };
  byMonth: Array<{
    month: string;
    paidCents: number;
    paidCount: number;
    receivedCents: number;
    receivedCount: number;
  }>;
};
type AuditAnomaliesResp = {
  fromIso: string;
  toIso: string;
  counts: {
    tokenReuse: number;
    failedLogin: number;
    voids: number;
    refunds: number;
    settingsChanges: number;
    manualJournalEntries: number;
  };
  recent: {
    security: AnomalyEvent[];
    financial: AnomalyEvent[];
    operational: AnomalyEvent[];
  };
};
type AnomalyEvent = {
  id: string;
  aggregateType: string;
  eventType: string;
  userEmail: string | null;
  ipAddress: string | null;
  occurredAtIso: string;
  summary: string;
};
type DeepAnalytics = {
  profit: ProfitabilityResp | null;
  cohorts: CohortsResp | null;
  wht: WhtRollupResp | null;
  audit: AuditAnomaliesResp | null;
};

function windowFor(range: RangeKey): {
  from: Date;
  to: Date;
  granularity: Granularity;
} {
  const now = new Date();
  const to = new Date(now);
  const from = new Date(now);
  if (range === "7d") {
    from.setDate(from.getDate() - 6);
    from.setHours(0, 0, 0, 0);
    return { from, to, granularity: "day" };
  }
  if (range === "month") {
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
    return { from, to, granularity: "day" };
  }
  if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    from.setMonth(q * 3, 1);
    from.setHours(0, 0, 0, 0);
    return { from, to, granularity: "week" };
  }
  from.setMonth(0, 1);
  from.setHours(0, 0, 0, 0);
  return { from, to, granularity: "month" };
}

const PAY_PALETTE: Record<string, string> = {
  cash: "#10b981",
  card: "#3b82f6",
  promptpay: "#8b5cf6",
  qr: "#8b5cf6",
  split: "#f59e0b",
  unknown: "#94a3b8",
};

const DOC_PALETTE: Record<string, string> = {
  TX: "#10b981",
  ABB: "#3b82f6",
  RE: "#f59e0b",
  CN: "#f43f5e",
};

export default function AnalysisPage() {
  const t = useT();
  const { settings } = useOrgSettings();
  const { user, hydrated } = useAuth();
  const currency = settings?.currency ?? "USD";
  const [range, setRange] = useState<RangeKey>("month");
  const [ts, setTs] = useState<TimeseriesResponse | null>(null);
  const [insights, setInsights] = useState<InsightsReport | null>(null);
  const [cust, setCust] = useState<CustomersAnalysis | null>(null);
  const [finance, setFinance] = useState<FinanceSnapshot | null>(null);
  const [ops, setOps] = useState<OpsSnapshot | null>(null);
  const [deep, setDeep] = useState<DeepAnalytics | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const isAdmin = user?.role === "admin";

  useEffect(() => {
    if (!hydrated) return;
    if (!isAdmin) return;
    setErr(null);
    const w = windowFor(range);
    const fromIso = w.from.toISOString();
    const toIso = w.to.toISOString();

    // The Money Snapshot uses the period's start/end (P&L window) and "today"
    // (AR/AP/TB are point-in-time snapshots).
    const pnlFrom = w.from.toISOString().slice(0, 10);
    const pnlTo = w.to.toISOString().slice(0, 10);

    Promise.all([
      api<TimeseriesResponse>(
        `/api/reports/timeseries?from=${fromIso}&to=${toIso}&granularity=${w.granularity}`,
      ),
      api<InsightsReport>(`/api/reports/insights?from=${fromIso}&to=${toIso}`),
      api<CustomersAnalysis>(
        `/api/reports/customers-analysis?from=${fromIso}&to=${toIso}`,
      ),
    ])
      .then(([a, b, c]) => {
        setTs(a);
        setInsights(b);
        setCust(c);
      })
      .catch((e) => setErr(e.message ?? String(e)));

    // Each finance card fetched independently so a single 401/500 doesn't
    // wipe the whole snapshot — each card just shows "—".
    const safe = <T,>(p: Promise<T>): Promise<T | null> =>
      p.catch(() => null);
    Promise.all([
      safe(api<ProfitLossResp>(`/api/accounting/profit-loss?from=${pnlFrom}&to=${pnlTo}`)),
      safe(api<TrialBalanceResp>(`/api/accounting/trial-balance`)),
      safe(api<ApAgingResp>(`/api/purchasing/ap-aging`)),
      safe(api<ArAgingResp>(`/api/sales/ar-aging`)),
    ]).then(([pnl, tb, ap, ar]) => {
      setFinance({ pnl, tb, ap, ar });
    });

    // Tier 2 ops snapshot — VAT-mix uses the period window;
    // inventory + match-exceptions are point-in-time.
    Promise.all([
      safe(api<InventorySnapshotResp>(`/api/reports/inventory-snapshot`)),
      safe(api<MatchExceptionsResp>(`/api/reports/match-exceptions`)),
      safe(api<VatMixResp>(`/api/reports/vat-mix?from=${fromIso}&to=${toIso}`)),
    ]).then(([inv, match, vat]) => {
      setOps({ inv, match, vat });
    });

    // Tier 3 deep analytics — profitability + cohorts use the period window;
    // wht-rollup uses last-12-months by default; audit uses last-7-days.
    Promise.all([
      safe(api<ProfitabilityResp>(`/api/reports/profitability?from=${fromIso}&to=${toIso}`)),
      safe(api<CohortsResp>(`/api/reports/cohorts?from=${fromIso}&to=${toIso}`)),
      safe(api<WhtRollupResp>(`/api/reports/wht-rollup`)),
      safe(api<AuditAnomaliesResp>(`/api/reports/audit-anomalies`)),
    ]).then(([profit, coh, wht, audit]) => {
      setDeep({ profit, cohorts: coh, wht, audit });
    });
  }, [range, isAdmin, hydrated]);

  // Block non-admins (defence in depth — sidebar already hides the link)
  if (!hydrated) {
    return null;
  }
  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Lock className="h-10 w-10 text-muted-foreground mb-3" />
        <h2 className="text-xl font-semibold">{t.analysis_admin_required}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t.analysis_subtitle}
        </p>
        <Link
          to="/"
          className="mt-4 text-sm text-primary hover:underline"
        >
          ← {t.nav_dashboard}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t.analysis_title}</h1>
          <p className="text-muted-foreground">{t.analysis_subtitle}</p>
        </div>
        <RangeToggle value={range} onChange={setRange} t={t} />
      </div>

      {err && (
        <div className="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-700">
          <ShieldAlert className="h-4 w-4" />
          {err}
        </div>
      )}

      {/* ───── Period KPI strip ─────────────────────────────────────────── */}
      <PeriodKpiRow ts={ts} insights={insights} currency={currency} t={t} />

      {/* ───── Tier 1: Money Snapshot (admin-only) ──────────────────────── */}
      <FinanceSnapshotSection finance={finance} currency={currency} t={t} />

      {/* ───── Tier 2: Operations Snapshot (admin-only) ─────────────────── */}
      <OpsSnapshotSection ops={ops} currency={currency} t={t} />

      {/* ───── Tier 3: Deep Analytics (admin-only) ──────────────────────── */}
      <DeepAnalyticsSection deep={deep} currency={currency} t={t} />

      {/* ───── Customers + concentration ───────────────────────────────── */}
      {cust && cust.rows.length > 0 && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>{t.analysis_top10_share}</CardTitle>
              <CardDescription>{t.analysis_revenue_share}</CardDescription>
            </CardHeader>
            <CardContent>
              <ConcentrationDial
                share={cust.concentration.top10.share}
                colour="#10b981"
              />
              <div className="mt-2 text-center text-xs text-muted-foreground">
                {formatMoney(cust.concentration.top10.topRevenueCents, currency)}{" "}
                / {formatMoney(cust.totals.revenueCents, currency)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>{t.analysis_top25_share}</CardTitle>
              <CardDescription>{t.analysis_revenue_share}</CardDescription>
            </CardHeader>
            <CardContent>
              <ConcentrationDial
                share={cust.concentration.top25.share}
                colour="#3b82f6"
              />
              <div className="mt-2 text-center text-xs text-muted-foreground">
                {formatMoney(cust.concentration.top25.topRevenueCents, currency)}{" "}
                / {formatMoney(cust.totals.revenueCents, currency)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>{cust.totals.customerCount}</CardTitle>
              <CardDescription>customers / {ts ? ts.totals.orderCount : 0} orders</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-muted-foreground space-y-1">
                <div>Avg orders / customer: <b>
                  {cust.totals.customerCount > 0
                    ? ((ts?.totals.orderCount ?? 0) / cust.totals.customerCount).toFixed(1)
                    : "0.0"}
                </b></div>
                <div>Window: <b>{cust.fromIso.slice(0, 10)}</b> → <b>{cust.toIso.slice(0, 10)}</b></div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ───── Top customers table ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{t.analysis_customers_title}</CardTitle>
          <CardDescription>{t.analysis_customers_sub}</CardDescription>
        </CardHeader>
        <CardContent>
          {!cust || cust.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t.analysis_no_top_customers}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">{t.customers_th_name}</th>
                    <th className="py-2 pr-3">{t.customers_th_tin}</th>
                    <th className="py-2 pr-3 text-right">{t.customers_th_orders}</th>
                    <th className="py-2 pr-3 text-right">{t.customers_th_revenue}</th>
                    <th className="py-2 pr-3 text-right">{t.customers_th_refunds}</th>
                    <th className="py-2 pr-3 text-right">{t.customers_th_net}</th>
                    <th className="py-2 pr-3">{t.customers_th_last}</th>
                  </tr>
                </thead>
                <tbody>
                  {cust.rows.slice(0, 25).map((r, i) => (
                    <tr key={r.key} className="border-b last:border-0">
                      <td className="py-2 pr-3 text-muted-foreground">{i + 1}</td>
                      <td className="py-2 pr-3 font-medium">{r.name}</td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {r.tin ?? <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.orderCount}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatMoney(r.revenueCents, currency)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-rose-600">
                        {r.refundCents !== 0 ? formatMoney(r.refundCents, currency) : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums font-semibold">
                        {formatMoney(r.netCents, currency)}
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {new Date(r.lastSeenIso).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ───── Hourly heatmap ───────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{t.analysis_heatmap_title}</CardTitle>
          <CardDescription>{t.analysis_heatmap_sub}</CardDescription>
        </CardHeader>
        <CardContent>
          {insights && insights.hourlyHeatmap.length > 0 ? (
            <Heatmap data={insights.hourlyHeatmap} />
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">{t.dash_no_data}</p>
          )}
        </CardContent>
      </Card>

      {/* ───── Payment + doc evolution ──────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t.analysis_payment_evo_title}</CardTitle>
            <CardDescription>{t.analysis_payment_evo_sub}</CardDescription>
          </CardHeader>
          <CardContent className="h-[260px]">
            {ts && ts.buckets.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PaymentStack buckets={ts.buckets} />
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">{t.dash_no_data}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t.analysis_doc_evo_title}</CardTitle>
            <CardDescription>{t.dash_doc_mix_subtitle}</CardDescription>
          </CardHeader>
          <CardContent className="h-[260px]">
            {ts && ts.buckets.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ts.buckets}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={30} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="byDocType.TX" stackId="d" name="TX" fill={DOC_PALETTE.TX} />
                  <Bar dataKey="byDocType.ABB" stackId="d" name="ABB" fill={DOC_PALETTE.ABB} />
                  <Bar dataKey="byDocType.RE" stackId="d" name="RE" fill={DOC_PALETTE.RE} />
                  <Bar dataKey="byDocType.CN" stackId="d" name="CN" fill={DOC_PALETTE.CN} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">{t.dash_no_data}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ───── Refund rate + VAT ─────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t.analysis_refund_rate_title}</CardTitle>
            <CardDescription>{t.analysis_refund_rate_sub}</CardDescription>
          </CardHeader>
          <CardContent className="h-[230px]">
            {ts && ts.buckets.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={ts.buckets.map((b) => ({
                    label: b.label,
                    rate:
                      b.orderCount === 0 ? 0 : (b.refundCount / b.orderCount) * 100,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis
                    tickFormatter={(v) => `${v}%`}
                    tick={{ fontSize: 11 }}
                    width={36}
                  />
                  <Tooltip
                    formatter={(v) => `${Number(v ?? 0).toFixed(2)}%`}
                  />
                  <Line
                    type="monotone"
                    dataKey="rate"
                    stroke="#f43f5e"
                    strokeWidth={2}
                    dot={false}
                    name="%"
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">{t.dash_no_data}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t.analysis_vat_title}</CardTitle>
            <CardDescription>{t.dash_kpi_vat}</CardDescription>
          </CardHeader>
          <CardContent className="h-[230px]">
            {ts && ts.buckets.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={ts.buckets}>
                  <defs>
                    <linearGradient id="vat" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis
                    tickFormatter={(v) =>
                      formatMoney(Number(v), currency).replace(/\.\d+/, "")
                    }
                    tick={{ fontSize: 11 }}
                    width={70}
                  />
                  <Tooltip formatter={(v) => formatMoney(Number(v ?? 0), currency)} />
                  <Area
                    type="monotone"
                    dataKey="vatCents"
                    stroke="#8b5cf6"
                    fill="url(#vat)"
                    strokeWidth={2}
                    name={t.dash_kpi_vat}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">{t.dash_no_data}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function RangeToggle({
  value,
  onChange,
  t,
}: {
  value: RangeKey;
  onChange: (r: RangeKey) => void;
  t: ReturnType<typeof useT>;
}) {
  const items: Array<{ key: RangeKey; label: string }> = [
    { key: "7d", label: t.range_7d },
    { key: "month", label: t.range_month },
    { key: "quarter", label: t.range_quarter },
    { key: "year", label: t.range_year },
  ];
  return (
    <div className="inline-flex items-center rounded-md border bg-background p-0.5 shadow-sm">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onChange(it.key)}
          className={
            "px-3 py-1.5 text-sm font-medium rounded transition " +
            (value === it.key
              ? "bg-primary text-primary-foreground shadow"
              : "text-muted-foreground hover:bg-muted")
          }
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function PeriodKpiRow({
  ts,
  insights,
  currency,
  t,
}: {
  ts: TimeseriesResponse | null;
  insights: InsightsReport | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const totals = ts?.totals;
  const delta = insights?.periodCompare.deltaPct ?? null;
  return (
    <div className="grid gap-3 md:grid-cols-4">
      <KpiCard
        label={t.dash_kpi_revenue}
        value={formatMoney(totals?.revenueCents ?? 0, currency)}
        delta={delta}
        sub={t.range_compare_prev}
      />
      <KpiCard
        label={t.dash_kpi_orders}
        value={String(totals?.orderCount ?? 0)}
        sub={`${formatMoney(totals?.aovCents ?? 0, currency)} ${t.dash_kpi_aov.toLowerCase()}`}
      />
      <KpiCard
        label={t.dash_kpi_refund_rate}
        value={
          totals ? `${(totals.refundRate * 100).toFixed(2)}%` : "0.00%"
        }
        sub={
          totals && totals.refundCount > 0
            ? `${totals.refundCount} CN · ${formatMoney(Math.abs(totals.refundCents), currency)}`
            : ""
        }
        severity={
          totals && totals.refundRate > 0.1
            ? "alert"
            : totals && totals.refundRate > 0.05
            ? "warn"
            : "ok"
        }
      />
      <KpiCard
        label={t.dash_kpi_vat}
        value={formatMoney(totals?.vatCents ?? 0, currency)}
        sub={
          totals && totals.revenueCents > 0
            ? `${((totals.vatCents / totals.revenueCents) * 100).toFixed(1)}% of revenue`
            : ""
        }
      />
    </div>
  );
}

function KpiCard({
  label,
  value,
  delta,
  sub,
  severity,
}: {
  label: string;
  value: string;
  delta?: number | null;
  sub?: string;
  severity?: "ok" | "warn" | "alert";
}) {
  const tone =
    severity === "alert"
      ? "border-rose-500/40 bg-rose-500/5"
      : severity === "warn"
      ? "border-amber-500/40 bg-amber-500/5"
      : "";
  return (
    <Card className={tone}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-xs flex items-center gap-2 mt-1">
          {delta != null && (
            <span
              className={
                "inline-flex items-center gap-1 " +
                (delta >= 0 ? "text-emerald-600" : "text-rose-600")
              }
            >
              {delta >= 0 ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {(delta * 100).toFixed(1)}%
            </span>
          )}
          {sub && <span className="text-muted-foreground">{sub}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function ConcentrationDial({ share, colour }: { share: number; colour: string }) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  const data = [
    { name: "share", value: pct, fill: colour },
    { name: "rest", value: 100 - pct, fill: "#e5e7eb" },
  ];
  return (
    <div className="relative h-[140px]">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            startAngle={90}
            endAngle={-270}
            innerRadius={45}
            outerRadius={60}
            stroke="none"
          >
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex items-center justify-center text-xl font-bold">
        {pct.toFixed(0)}%
      </div>
    </div>
  );
}

function PaymentStack({ buckets }: { buckets: TimeseriesBucket[] }) {
  // Pivot byPayment into stacked-bar shape.
  const allMethods = new Set<string>();
  for (const b of buckets) {
    for (const k of Object.keys(b.byPayment)) allMethods.add(k);
  }
  const data = buckets.map((b) => {
    const row: Record<string, number | string> = { label: b.label };
    for (const m of allMethods) {
      row[m] = b.byPayment[m] ?? 0;
    }
    return row;
  });
  const methods = [...allMethods];
  return (
    <BarChart data={data}>
      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
      <YAxis tick={{ fontSize: 11 }} width={30} />
      <Tooltip />
      <Legend wrapperStyle={{ fontSize: 11 }} />
      {methods.map((m) => (
        <Bar
          key={m}
          dataKey={m}
          stackId="p"
          fill={PAY_PALETTE[m] ?? "#94a3b8"}
          name={m}
        />
      ))}
    </BarChart>
  );
}

function Heatmap({
  data,
}: {
  data: Array<{ weekday: number; hour: number; orderCount: number; revenueCents: number }>;
}) {
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const max = Math.max(1, ...data.map((d) => d.orderCount));
  const grid: Record<string, number> = {};
  for (const d of data) grid[`${d.weekday}_${d.hour}`] = d.orderCount;

  return (
    <div className="overflow-x-auto">
      <div className="inline-block">
        <div className="grid grid-cols-[40px_repeat(24,_1.4rem)] gap-[2px]">
          <div />
          {Array.from({ length: 24 }, (_, i) => (
            <div
              key={i}
              className="text-[9px] text-muted-foreground text-center"
              style={{ lineHeight: "1.1rem" }}
            >
              {i % 3 === 0 ? i : ""}
            </div>
          ))}
          {weekdays.map((wd, idx) => (
            <FragmentRow key={wd}>
              <div className="text-[10px] text-muted-foreground self-center pr-1 text-right">
                {wd}
              </div>
              {Array.from({ length: 24 }, (_, h) => {
                const val = grid[`${idx}_${h}`] ?? 0;
                const intensity = val / max;
                const bg =
                  val === 0
                    ? "rgb(243 244 246)"
                    : `rgba(16, 185, 129, ${0.15 + intensity * 0.85})`;
                return (
                  <div
                    key={h}
                    className="h-5 w-5 rounded-sm"
                    style={{ background: bg }}
                    title={`${wd} ${String(h).padStart(2, "0")}:00 — ${val} orders`}
                  />
                );
              })}
            </FragmentRow>
          ))}
        </div>
      </div>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// ─── Tier 1: Money Snapshot ──────────────────────────────────────────────────

function FinanceSnapshotSection({
  finance,
  currency,
  t,
}: {
  finance: FinanceSnapshot | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          {t.analysis_finance_section_title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t.analysis_finance_section_sub}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ProfitLossCard pnl={finance?.pnl ?? null} currency={currency} t={t} />
        <BooksHealthCard tb={finance?.tb ?? null} currency={currency} t={t} />
        <PayablesCard ap={finance?.ap ?? null} currency={currency} t={t} />
        <ReceivablesCard ar={finance?.ar ?? null} currency={currency} t={t} />
      </div>
    </section>
  );
}

// ─── P&L card ───────────────────────────────────────────────────────────────
function ProfitLossCard({
  pnl,
  currency,
  t,
}: {
  pnl: ProfitLossResp | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const revenue = pnl?.revenue.totalCents ?? 0;
  const expense = pnl?.expense.totalCents ?? 0;
  const net = pnl?.netIncomeCents ?? 0;
  const isProfit = net >= 0;
  const profitTone = isProfit
    ? "border-emerald-500/40 bg-emerald-500/5"
    : "border-rose-500/40 bg-rose-500/5";

  return (
    <Card className={profitTone}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              {t.analysis_pnl_title}
            </CardTitle>
            <CardDescription>{t.analysis_pnl_sub}</CardDescription>
          </div>
          <div className="text-right">
            <div
              className={
                "text-3xl font-bold tabular-nums " +
                (isProfit ? "text-emerald-700" : "text-rose-700")
              }
            >
              {formatMoney(net, currency)}
            </div>
            <div className="text-xs text-muted-foreground">
              {isProfit ? t.analysis_pnl_net : t.analysis_pnl_net_loss}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3 text-emerald-600" />
              {t.analysis_pnl_revenue}
            </div>
            <div className="text-lg font-semibold text-emerald-700 tabular-nums">
              {formatMoney(revenue, currency)}
            </div>
          </div>
          <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <TrendingDown className="h-3 w-3 text-rose-600" />
              {t.analysis_pnl_expense}
            </div>
            <div className="text-lg font-semibold text-rose-700 tabular-nums">
              {formatMoney(expense, currency)}
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t.analysis_pnl_explainer}</p>
        {pnl && (
          <p className="text-[10px] text-muted-foreground mt-1 font-mono">
            {pnl.from} → {pnl.to}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Books-balance health card ──────────────────────────────────────────────
function BooksHealthCard({
  tb,
  currency,
  t,
}: {
  tb: TrialBalanceResp | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const dr = tb?.totals.debitCents ?? 0;
  const cr = tb?.totals.creditCents ?? 0;
  const delta = tb?.totals.deltaCents ?? 0;
  const balanced = tb !== null && delta === 0;
  const accounts = tb?.rows.length ?? 0;
  const tone = balanced
    ? "border-emerald-500/40 bg-emerald-500/5"
    : tb
    ? "border-rose-500/40 bg-rose-500/5"
    : "";

  return (
    <Card className={tone}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              {balanced ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-rose-600" />
              )}
              {t.analysis_health_title}
            </CardTitle>
            <CardDescription>{t.analysis_health_sub}</CardDescription>
          </div>
          <div
            className={
              "px-3 py-1 rounded-full text-sm font-semibold " +
              (balanced
                ? "bg-emerald-500/15 text-emerald-700"
                : "bg-rose-500/15 text-rose-700")
            }
          >
            {balanced ? t.analysis_health_balanced : t.analysis_health_unbalanced}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 md:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">
              {t.analysis_health_debits}
            </div>
            <div className="font-semibold tabular-nums">
              {formatMoney(dr, currency)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              {t.analysis_health_credits}
            </div>
            <div className="font-semibold tabular-nums">
              {formatMoney(cr, currency)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              {t.analysis_health_difference}
            </div>
            <div
              className={
                "font-semibold tabular-nums " +
                (delta === 0 ? "text-emerald-700" : "text-rose-700")
              }
            >
              {formatMoney(Math.abs(delta), currency)}
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          {balanced
            ? t.analysis_health_balanced_explainer
            : t.analysis_health_unbalanced_explainer}
        </p>
        <p className="text-[10px] text-muted-foreground mt-1 font-mono">
          {accounts} {t.analysis_health_accounts} · {tb?.asOfDate ?? ""}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── AP aging ───────────────────────────────────────────────────────────────
function PayablesCard({
  ap,
  currency,
  t,
}: {
  ap: ApAgingResp | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const total = ap?.grandTotalCents ?? 0;
  const buckets = ap?.bucketTotals;
  const overdue = buckets
    ? buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90_plus
    : 0;
  const overduePct = total > 0 ? overdue / total : 0;
  const tone =
    overduePct >= 0.4
      ? "border-rose-500/40 bg-rose-500/5"
      : overduePct >= 0.15
      ? "border-amber-500/40 bg-amber-500/5"
      : "";
  const topSuppliers = (ap?.suppliers ?? [])
    .slice()
    .sort((a, b) => b.totalRemainingCents - a.totalRemainingCents)
    .slice(0, 3);

  return (
    <Card className={tone}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <HandCoins className="h-4 w-4" />
              {t.analysis_ap_title}
            </CardTitle>
            <CardDescription>{t.analysis_ap_sub}</CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums">
              {formatMoney(total, currency)}
            </div>
            <div className="text-xs text-muted-foreground">
              {t.analysis_ap_total}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            {t.analysis_ap_no_outstanding}
          </p>
        ) : (
          <>
            <BucketBar buckets={buckets!} total={total} kind="ap" t={t} />
            <BucketLegend
              buckets={buckets!}
              currency={currency}
              kind="ap"
              t={t}
            />
            {topSuppliers.length > 0 && (
              <div className="mt-3 pt-3 border-t">
                <div className="text-xs text-muted-foreground mb-1.5">
                  {t.analysis_ap_top_suppliers}
                </div>
                <ul className="space-y-1">
                  {topSuppliers.map((s) => (
                    <li
                      key={s.supplierId}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="truncate pr-2">{s.supplierName}</span>
                      <span className="tabular-nums font-medium">
                        {formatMoney(s.totalRemainingCents, currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-3">
              {t.analysis_ap_explainer}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── AR aging ───────────────────────────────────────────────────────────────
function ReceivablesCard({
  ar,
  currency,
  t,
}: {
  ar: ArAgingResp | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const total = ar?.grandTotalCents ?? 0;
  const buckets = ar?.bucketTotals;
  const overdue = buckets
    ? buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90_plus
    : 0;
  const overduePct = total > 0 ? overdue / total : 0;
  const tone =
    overduePct >= 0.4
      ? "border-rose-500/40 bg-rose-500/5"
      : overduePct >= 0.15
      ? "border-amber-500/40 bg-amber-500/5"
      : "";
  const topCustomers = (ar?.customers ?? [])
    .slice()
    .sort((a, b) => b.totalRemainingCents - a.totalRemainingCents)
    .slice(0, 3);

  return (
    <Card className={tone}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Receipt className="h-4 w-4" />
              {t.analysis_ar_title}
            </CardTitle>
            <CardDescription>{t.analysis_ar_sub}</CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums">
              {formatMoney(total, currency)}
            </div>
            <div className="text-xs text-muted-foreground">
              {t.analysis_ar_total}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            {t.analysis_ar_no_outstanding}
          </p>
        ) : (
          <>
            <BucketBar buckets={buckets!} total={total} kind="ar" t={t} />
            <BucketLegend
              buckets={buckets!}
              currency={currency}
              kind="ar"
              t={t}
            />
            {topCustomers.length > 0 && (
              <div className="mt-3 pt-3 border-t">
                <div className="text-xs text-muted-foreground mb-1.5">
                  {t.analysis_ar_top_customers}
                </div>
                <ul className="space-y-1">
                  {topCustomers.map((c) => (
                    <li
                      key={c.customerId}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="truncate pr-2">{c.customerName}</span>
                      <span className="tabular-nums font-medium">
                        {formatMoney(c.totalRemainingCents, currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-3">
              {t.analysis_ar_explainer}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Shared aging-bucket components ─────────────────────────────────────────
const BUCKET_COLOURS: Record<AgingBucket, string> = {
  current: "#10b981", // green: not overdue
  d1_30: "#facc15",   // yellow
  d31_60: "#fb923c",  // orange
  d61_90: "#f87171",  // light red
  d90_plus: "#dc2626", // red: critical
};

function bucketLabel(b: AgingBucket, t: ReturnType<typeof useT>): string {
  switch (b) {
    case "current":
      return t.analysis_bucket_current;
    case "d1_30":
      return t.analysis_bucket_1_30;
    case "d31_60":
      return t.analysis_bucket_31_60;
    case "d61_90":
      return t.analysis_bucket_61_90;
    case "d90_plus":
      return t.analysis_bucket_90_plus;
  }
}

const BUCKET_ORDER: AgingBucket[] = [
  "current",
  "d1_30",
  "d31_60",
  "d61_90",
  "d90_plus",
];

function BucketBar({
  buckets,
  total,
  // kind reserved for future per-side legends; both sides currently share scale
  kind: _kind,
  t,
}: {
  buckets: AgingBuckets;
  total: number;
  kind: "ap" | "ar";
  t: ReturnType<typeof useT>;
}) {
  if (total <= 0) return null;
  return (
    <div
      className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`Aging buckets — ${BUCKET_ORDER
        .map((b) => `${bucketLabel(b, t)}: ${((buckets[b] / total) * 100).toFixed(0)}%`)
        .join(", ")}`}
    >
      {BUCKET_ORDER.map((b) => {
        const pct = (buckets[b] / total) * 100;
        if (pct <= 0) return null;
        return (
          <div
            key={b}
            style={{ width: `${pct}%`, background: BUCKET_COLOURS[b] }}
            title={`${bucketLabel(b, t)}: ${pct.toFixed(0)}%`}
          />
        );
      })}
    </div>
  );
}

function BucketLegend({
  buckets,
  currency,
  // both sides use the same colour palette today
  kind: _kind,
  t,
}: {
  buckets: AgingBuckets;
  currency: string;
  kind: "ap" | "ar";
  t: ReturnType<typeof useT>;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3 md:grid-cols-5">
      {BUCKET_ORDER.map((b) => (
        <div key={b} className="space-y-1">
          <div className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: BUCKET_COLOURS[b] }}
            />
            <span className="text-muted-foreground truncate">
              {bucketLabel(b, t)}
            </span>
          </div>
          <div className="font-semibold tabular-nums">
            {buckets[b] > 0 ? formatMoney(buckets[b], currency) : "—"}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Tier 2: Operations Snapshot ────────────────────────────────────────────

function OpsSnapshotSection({
  ops,
  currency,
  t,
}: {
  ops: OpsSnapshot | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          {t.analysis_ops_section_title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t.analysis_ops_section_sub}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <StockValueCard inv={ops?.inv ?? null} currency={currency} t={t} />
        <StockVelocityCard inv={ops?.inv ?? null} t={t} />
        <MatchExceptionsCard match={ops?.match ?? null} currency={currency} t={t} />
        <VatMixCard vat={ops?.vat ?? null} currency={currency} t={t} />
      </div>
    </section>
  );
}

// ─── Stock value card ──────────────────────────────────────────────────────
function StockValueCard({
  inv,
  currency,
  t,
}: {
  inv: InventorySnapshotResp | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const v = inv?.value;
  const lowCount = v?.skusLow ?? 0;
  const zeroCount = v?.skusZero ?? 0;
  // Tone: red if any SKU is OOS, amber if any low, green otherwise
  const tone =
    zeroCount > 0
      ? "border-rose-500/40 bg-rose-500/5"
      : lowCount > 0
      ? "border-amber-500/40 bg-amber-500/5"
      : "";

  return (
    <Card className={tone}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-4 w-4" />
              {t.analysis_inv_value_title}
            </CardTitle>
            <CardDescription>{t.analysis_inv_value_sub}</CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums">
              {formatMoney(v?.totalValueCents ?? 0, currency)}
            </div>
            <div className="text-xs text-muted-foreground">
              {t.analysis_inv_value_total}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 md:grid-cols-3">
          <StatChip
            label={t.analysis_inv_skus_with_stock}
            value={v?.skusWithStock ?? 0}
            tone="ok"
          />
          <StatChip
            label={t.analysis_inv_skus_low}
            value={lowCount}
            tone={lowCount > 0 ? "warn" : "ok"}
            badge={lowCount > 0 ? t.analysis_inv_running_low_alert : undefined}
          />
          <StatChip
            label={t.analysis_inv_skus_zero}
            value={zeroCount}
            tone={zeroCount > 0 ? "alert" : "ok"}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          {t.analysis_inv_value_explainer}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Stock velocity card ───────────────────────────────────────────────────
function StockVelocityCard({
  inv,
  t,
}: {
  inv: InventorySnapshotResp | null;
  t: ReturnType<typeof useT>;
}) {
  const rows = inv?.velocity.rows ?? [];
  // Pull common types out so they always render (even at 0) for a stable view.
  const lookup = new Map(rows.map((r) => [r.moveType, r] as const));
  const stable: Array<{ key: string; label: string; icon: any; tone: string; count: number; qty: number }> = [
    {
      key: "sale",
      label: t.analysis_movetype_sale,
      icon: ArrowUpFromLine,
      tone: "text-emerald-700",
      count: lookup.get("sale")?.moveCount ?? 0,
      qty: lookup.get("sale")?.qtyAbs ?? 0,
    },
    {
      key: "receive",
      label: t.analysis_movetype_receive,
      icon: ArrowDownToLine,
      tone: "text-blue-700",
      count: lookup.get("receive")?.moveCount ?? 0,
      qty: lookup.get("receive")?.qtyAbs ?? 0,
    },
    {
      key: "refund",
      label: t.analysis_movetype_refund,
      icon: ArrowDownToLine,
      tone: "text-rose-700",
      count: lookup.get("refund")?.moveCount ?? 0,
      qty: lookup.get("refund")?.qtyAbs ?? 0,
    },
    {
      key: "adjust",
      label: t.analysis_movetype_adjust,
      icon: PercentSquare,
      tone: "text-amber-700",
      count: lookup.get("adjust")?.moveCount ?? 0,
      qty: lookup.get("adjust")?.qtyAbs ?? 0,
    },
  ];
  const totalMoves = rows.reduce((s, r) => s + r.moveCount, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Package className="h-4 w-4" />
          {t.analysis_inv_velocity_title}
        </CardTitle>
        <CardDescription>{t.analysis_inv_velocity_sub}</CardDescription>
      </CardHeader>
      <CardContent>
        {totalMoves === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            {t.analysis_inv_no_movement}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 mb-3">
              {stable.map(({ key, label, icon: Icon, tone, count, qty }) => (
                <div
                  key={key}
                  className="rounded-md border bg-background px-3 py-2"
                >
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Icon className={`h-3 w-3 ${tone}`} />
                      {label}
                    </span>
                    <span className="tabular-nums">{qty} units</span>
                  </div>
                  <div className={`text-lg font-semibold tabular-nums ${tone}`}>
                    {count}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t.analysis_inv_velocity_explainer}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Three-way-match exceptions ────────────────────────────────────────────
function MatchExceptionsCard({
  match,
  currency,
  t,
}: {
  match: MatchExceptionsResp | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const count = match?.unmatched.count ?? 0;
  const total = match?.unmatched.totalCents ?? 0;
  const tone =
    count >= 10
      ? "border-rose-500/40 bg-rose-500/5"
      : count >= 3
      ? "border-amber-500/40 bg-amber-500/5"
      : "";
  const top = match?.topBills ?? [];

  return (
    <Card className={tone}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4" />
              {t.analysis_match_title}
            </CardTitle>
            <CardDescription>{t.analysis_match_sub}</CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums">
              {count} <span className="text-sm font-normal text-muted-foreground">{t.analysis_match_count}</span>
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {formatMoney(total, currency)} {t.analysis_match_total.toLowerCase()}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {count === 0 ? (
          <p className="text-sm text-emerald-700 py-2 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            {t.analysis_match_clean}
          </p>
        ) : (
          <>
            {top.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground mb-1.5">
                  {t.analysis_match_top_bills}
                </div>
                <ul className="space-y-1">
                  {top.slice(0, 4).map((b) => (
                    <li
                      key={b.billId}
                      className="flex items-center justify-between text-sm"
                    >
                      <div className="min-w-0 pr-2">
                        <div className="truncate font-medium">{b.supplierName}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {b.internalNumber} · {b.billDate}
                        </div>
                      </div>
                      <span className="tabular-nums font-semibold whitespace-nowrap">
                        {formatMoney(b.totalCents, currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-3">
              {t.analysis_match_explainer}
            </p>
            <div className="mt-2">
              <Link
                to="/purchasing"
                className="text-xs text-primary hover:underline"
              >
                {t.analysis_view_more}
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── VAT mix card ──────────────────────────────────────────────────────────
function VatMixCard({
  vat,
  currency,
  t,
}: {
  vat: VatMixResp | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const taxable = vat?.taxableNetCents ?? 0;
  const zero = vat?.zeroRatedNetCents ?? 0;
  const exempt = vat?.exemptNetCents ?? 0;
  const totalNet = vat?.totalNetCents ?? 0;
  const output = vat?.vatCents ?? 0;
  const empty = totalNet === 0 && output === 0;

  const data = [
    { name: t.analysis_vat_mix_taxable, value: taxable, fill: "#10b981" },
    { name: t.analysis_vat_mix_zero, value: zero, fill: "#3b82f6" },
    { name: t.analysis_vat_mix_exempt, value: exempt, fill: "#94a3b8" },
  ].filter((d) => d.value > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <PercentSquare className="h-4 w-4" />
              {t.analysis_vat_mix_title}
            </CardTitle>
            <CardDescription>{t.analysis_vat_mix_sub}</CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums text-emerald-700">
              {formatMoney(output, currency)}
            </div>
            <div className="text-xs text-muted-foreground">
              {t.analysis_vat_mix_output_vat}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="text-sm text-muted-foreground py-2">
            {t.analysis_vat_mix_no_data}
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div className="h-[110px] w-[110px] shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data}
                      dataKey="value"
                      innerRadius={32}
                      outerRadius={50}
                      stroke="none"
                    >
                      {data.map((entry) => (
                        <Cell key={entry.name} fill={entry.fill} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => formatMoney(Number(v ?? 0), currency)} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-1.5 text-sm">
                <VatMixRow
                  colour="#10b981"
                  label={t.analysis_vat_mix_taxable}
                  cents={taxable}
                  totalCents={totalNet}
                  currency={currency}
                />
                <VatMixRow
                  colour="#3b82f6"
                  label={t.analysis_vat_mix_zero}
                  cents={zero}
                  totalCents={totalNet}
                  currency={currency}
                />
                <VatMixRow
                  colour="#94a3b8"
                  label={t.analysis_vat_mix_exempt}
                  cents={exempt}
                  totalCents={totalNet}
                  currency={currency}
                />
              </div>
            </div>
            <div className="mt-3 pt-3 border-t flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {t.analysis_vat_mix_total_net}
              </span>
              <span className="font-semibold tabular-nums">
                {formatMoney(totalNet, currency)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              {t.analysis_vat_mix_explainer}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function VatMixRow({
  colour,
  label,
  cents,
  totalCents,
  currency,
}: {
  colour: string;
  label: string;
  cents: number;
  totalCents: number;
  currency: string;
}) {
  const pct = totalCents > 0 ? (cents / totalCents) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-block h-2 w-2 rounded-sm shrink-0"
        style={{ background: colour }}
      />
      <span className="text-muted-foreground flex-1 truncate">{label}</span>
      <span className="tabular-nums whitespace-nowrap">
        {formatMoney(cents, currency)}
        <span className="text-[10px] text-muted-foreground ml-1">
          {pct.toFixed(0)}%
        </span>
      </span>
    </div>
  );
}

function StatChip({
  label,
  value,
  tone,
  badge,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "alert";
  badge?: string;
}) {
  const colour =
    tone === "alert"
      ? "text-rose-700 bg-rose-500/5 border-rose-500/30"
      : tone === "warn"
      ? "text-amber-700 bg-amber-500/5 border-amber-500/30"
      : "text-emerald-700 bg-emerald-500/5 border-emerald-500/30";
  return (
    <div className={"rounded-md border px-3 py-2 " + colour}>
      <div className="text-xs">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {badge && (
        <div className="text-[9px] uppercase tracking-wider mt-0.5 opacity-70">
          {badge}
        </div>
      )}
    </div>
  );
}

// ─── Tier 3: Deep Analytics ────────────────────────────────────────────────

function DeepAnalyticsSection({
  deep,
  currency,
  t,
}: {
  deep: DeepAnalytics | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          {t.analysis_deep_section_title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t.analysis_deep_section_sub}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ProfitabilityCard profit={deep?.profit ?? null} currency={currency} t={t} />
        <CohortsCard cohorts={deep?.cohorts ?? null} currency={currency} t={t} />
        <WhtRollupCard wht={deep?.wht ?? null} currency={currency} t={t} />
        <AuditAnomaliesCard audit={deep?.audit ?? null} t={t} />
      </div>
    </section>
  );
}

// ─── Profitability card ────────────────────────────────────────────────────
function ProfitabilityCard({
  profit,
  currency,
  t,
}: {
  profit: ProfitabilityResp | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const totals = profit?.totals;
  const empty = !totals || totals.unitsSold === 0;
  const marginPct = totals?.marginPct ?? 0;
  const tone =
    !totals
      ? ""
      : marginPct < 0
      ? "border-rose-500/40 bg-rose-500/5"
      : marginPct < 0.1
      ? "border-amber-500/40 bg-amber-500/5"
      : "";
  const lowCoverage =
    totals && totals.cogsCoveragePct < 0.5 && totals.revenueCents > 0;
  const top = profit?.byProduct.slice(0, 5) ?? [];
  const cats = profit?.byCategory ?? [];

  return (
    <Card className={tone}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Star className="h-4 w-4" />
              {t.analysis_profit_title}
            </CardTitle>
            <CardDescription>{t.analysis_profit_sub}</CardDescription>
          </div>
          <div className="text-right">
            <div
              className={
                "text-2xl font-bold tabular-nums " +
                (totals && totals.marginCents >= 0
                  ? "text-emerald-700"
                  : "text-rose-700")
              }
            >
              {formatMoney(totals?.marginCents ?? 0, currency)}
            </div>
            <div className="text-xs text-muted-foreground">
              {t.analysis_profit_margin} ·{" "}
              <span className="tabular-nums">
                {totals ? `${(marginPct * 100).toFixed(1)}%` : "—"}
              </span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="text-sm text-muted-foreground py-2">
            {t.analysis_profit_no_sales}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 mb-3 text-sm">
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  {t.analysis_profit_revenue}
                </div>
                <div className="font-semibold text-emerald-700 tabular-nums">
                  {formatMoney(totals!.revenueCents, currency)}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {totals!.unitsSold} {t.analysis_profit_units.toLowerCase()} ·{" "}
                  {totals!.skusSold} {t.analysis_profit_skus.toLowerCase()}
                </div>
              </div>
              <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  {t.analysis_profit_cogs}
                </div>
                <div className="font-semibold text-rose-700 tabular-nums">
                  {formatMoney(totals!.cogsCents, currency)}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {(totals!.cogsCoveragePct * 100).toFixed(0)}% coverage
                </div>
              </div>
            </div>

            {top.length > 0 && (
              <div className="mt-3">
                <div className="text-xs text-muted-foreground mb-1">
                  {t.analysis_profit_top_products}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b">
                        <th className="text-left py-1 pr-2">
                          {t.analysis_profit_th_product}
                        </th>
                        <th className="text-right py-1 pr-2 tabular-nums">
                          {t.analysis_profit_th_units}
                        </th>
                        <th className="text-right py-1 pr-2 tabular-nums">
                          {t.analysis_profit_th_revenue}
                        </th>
                        <th className="text-right py-1 tabular-nums">
                          {t.analysis_profit_th_margin}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {top.map((p, i) => (
                        <tr key={`${p.productId ?? "na"}-${i}`} className="border-b last:border-0">
                          <td className="py-1 pr-2 truncate max-w-[150px]">
                            {p.name}
                          </td>
                          <td className="text-right py-1 pr-2 tabular-nums">
                            {p.unitsSold}
                          </td>
                          <td className="text-right py-1 pr-2 tabular-nums">
                            {formatMoney(p.revenueCents, currency)}
                          </td>
                          <td
                            className={
                              "text-right py-1 tabular-nums font-medium " +
                              (p.marginPct < 0
                                ? "text-rose-700"
                                : p.cogsCents === 0
                                ? "text-muted-foreground"
                                : "text-emerald-700")
                            }
                          >
                            {p.cogsCents === 0
                              ? "—"
                              : `${(p.marginPct * 100).toFixed(0)}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {cats.length > 0 && (
              <div className="mt-3 pt-3 border-t">
                <div className="text-xs text-muted-foreground mb-1">
                  {t.analysis_profit_by_category}
                </div>
                <div className="space-y-1">
                  {cats.map((c) => (
                    <div
                      key={c.category}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="truncate pr-2">
                        {c.category === "Uncategorised"
                          ? t.analysis_profit_uncategorised
                          : c.category}
                      </span>
                      <span className="tabular-nums whitespace-nowrap">
                        {formatMoney(c.revenueCents, currency)}
                        <span
                          className={
                            "ml-2 text-[10px] " +
                            (c.marginPct < 0
                              ? "text-rose-700"
                              : "text-muted-foreground")
                          }
                        >
                          {c.cogsCents === 0
                            ? "—"
                            : `${(c.marginPct * 100).toFixed(0)}% margin`}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {lowCoverage && (
              <p className="text-xs text-amber-700 mt-3 flex items-start gap-1.5">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                {t.analysis_profit_coverage_low}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              {t.analysis_profit_explainer}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Cohorts card ──────────────────────────────────────────────────────────
function CohortsCard({
  cohorts,
  currency,
  t,
}: {
  cohorts: CohortsResp | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const w = cohorts?.inWindow;
  const noIdentified = !w || w.identifiedCustomers === 0;
  const newCount = w?.newCustomers ?? 0;
  const retCount = w?.returningCustomers ?? 0;
  const newRev = w?.newRevenueCents ?? 0;
  const retRev = w?.returningRevenueCents ?? 0;
  const totalRev = newRev + retRev;
  const retPct = totalRev > 0 ? (retRev / totalRev) * 100 : 0;
  const newPct = totalRev > 0 ? (newRev / totalRev) * 100 : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          {t.analysis_cohorts_title}
        </CardTitle>
        <CardDescription>{t.analysis_cohorts_sub}</CardDescription>
      </CardHeader>
      <CardContent>
        {noIdentified ? (
          <p className="text-sm text-muted-foreground py-2">
            {t.analysis_cohorts_no_identified}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm mb-3">
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  {t.analysis_cohorts_new}
                </div>
                <div className="text-lg font-semibold tabular-nums">
                  {newCount}
                </div>
                <div className="text-[10px] text-muted-foreground tabular-nums">
                  {formatMoney(newRev, currency)}
                </div>
              </div>
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  {t.analysis_cohorts_returning}
                </div>
                <div className="text-lg font-semibold text-emerald-700 tabular-nums">
                  {retCount}
                </div>
                <div className="text-[10px] text-muted-foreground tabular-nums">
                  {formatMoney(retRev, currency)}
                </div>
              </div>
            </div>

            {totalRev > 0 && (
              <div
                className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`${retPct.toFixed(0)}% returning, ${newPct.toFixed(
                  0,
                )}% new`}
              >
                <div
                  style={{ width: `${retPct}%`, background: "#10b981" }}
                  title={`${t.analysis_cohorts_returning}: ${retPct.toFixed(0)}%`}
                />
                <div
                  style={{ width: `${newPct}%`, background: "#3b82f6" }}
                  title={`${t.analysis_cohorts_new}: ${newPct.toFixed(0)}%`}
                />
              </div>
            )}
          </>
        )}

        {w && w.walkInOrderCount > 0 && (
          <div className="mt-3 pt-3 border-t flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {t.analysis_cohorts_walkins} ({w.walkInOrderCount})
            </span>
            <span className="font-semibold tabular-nums">
              {formatMoney(w.walkInRevenueCents, currency)}
            </span>
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-3">
          {t.analysis_cohorts_explainer}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── WHT roll-up card ──────────────────────────────────────────────────────
function WhtRollupCard({
  wht,
  currency,
  t,
}: {
  wht: WhtRollupResp | null;
  currency: string;
  t: ReturnType<typeof useT>;
}) {
  const totals = wht?.totals;
  const empty =
    !totals || (totals.paidCents === 0 && totals.receivedCents === 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-4 w-4" />
          {t.analysis_wht_title}
        </CardTitle>
        <CardDescription>{t.analysis_wht_sub}</CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="text-sm text-muted-foreground py-2">
            {t.analysis_wht_no_data}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm mb-3">
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  {t.analysis_wht_paid}
                </div>
                <div className="text-lg font-semibold tabular-nums text-amber-700">
                  {formatMoney(totals!.paidCents, currency)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {totals!.paidCount} {t.analysis_wht_certs} ·{" "}
                  {t.analysis_wht_paid_sub}
                </div>
              </div>
              <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2">
                <div className="text-xs text-muted-foreground">
                  {t.analysis_wht_received}
                </div>
                <div className="text-lg font-semibold tabular-nums text-blue-700">
                  {formatMoney(totals!.receivedCents, currency)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {totals!.receivedCount} {t.analysis_wht_receipts} ·{" "}
                  {t.analysis_wht_received_sub}
                </div>
              </div>
            </div>
            {wht!.byMonth.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b">
                      <th className="text-left py-1 pr-2 font-mono">Month</th>
                      <th className="text-right py-1 pr-2 tabular-nums">
                        {t.analysis_wht_paid}
                      </th>
                      <th className="text-right py-1 tabular-nums">
                        {t.analysis_wht_received}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {wht!.byMonth.slice(-6).map((r) => (
                      <tr key={r.month} className="border-b last:border-0">
                        <td className="py-1 pr-2 font-mono">{r.month}</td>
                        <td className="text-right py-1 pr-2 tabular-nums">
                          {r.paidCents > 0
                            ? formatMoney(r.paidCents, currency)
                            : "—"}
                        </td>
                        <td className="text-right py-1 tabular-nums">
                          {r.receivedCents > 0
                            ? formatMoney(r.receivedCents, currency)
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground mt-3">
          {t.analysis_wht_explainer}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Audit anomalies card ──────────────────────────────────────────────────
function AuditAnomaliesCard({
  audit,
  t,
}: {
  audit: AuditAnomaliesResp | null;
  t: ReturnType<typeof useT>;
}) {
  const c = audit?.counts;
  const securitySum = (c?.tokenReuse ?? 0) + (c?.failedLogin ?? 0);
  const tone =
    securitySum >= 10
      ? "border-rose-500/40 bg-rose-500/5"
      : securitySum > 0
      ? "border-amber-500/40 bg-amber-500/5"
      : "";
  const empty =
    !c ||
    (c.tokenReuse === 0 &&
      c.failedLogin === 0 &&
      c.voids === 0 &&
      c.refunds === 0 &&
      c.settingsChanges === 0 &&
      c.manualJournalEntries === 0);

  return (
    <Card className={tone}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          {t.analysis_audit_title}
        </CardTitle>
        <CardDescription>{t.analysis_audit_sub}</CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="text-sm text-emerald-700 py-2 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            {t.analysis_audit_no_events}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <AuditClassRow
                label={t.analysis_audit_security}
                tone={securitySum > 0 ? "alert" : "ok"}
                items={[
                  { label: t.analysis_audit_token_reuse, value: c?.tokenReuse ?? 0 },
                  { label: t.analysis_audit_failed_login, value: c?.failedLogin ?? 0 },
                ]}
              />
              <AuditClassRow
                label={t.analysis_audit_financial}
                tone={(c?.voids ?? 0) > 5 ? "warn" : "ok"}
                items={[
                  { label: t.analysis_audit_voids, value: c?.voids ?? 0 },
                  { label: t.analysis_audit_refunds, value: c?.refunds ?? 0 },
                ]}
              />
              <AuditClassRow
                label={t.analysis_audit_operational}
                tone="ok"
                items={[
                  {
                    label: t.analysis_audit_settings_changes,
                    value: c?.settingsChanges ?? 0,
                  },
                  {
                    label: t.analysis_audit_manual_je,
                    value: c?.manualJournalEntries ?? 0,
                  },
                ]}
              />
            </div>

            {audit!.recent.security.length > 0 && (
              <div className="mt-3 pt-3 border-t">
                <div className="text-xs text-muted-foreground mb-1">
                  {t.analysis_audit_recent} · {t.analysis_audit_security}
                </div>
                <ul className="space-y-1">
                  {audit!.recent.security.slice(0, 3).map((e) => (
                    <li key={e.id} className="text-xs flex items-start gap-2">
                      <AlertTriangle className="h-3 w-3 text-rose-600 mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium truncate">
                          {e.eventType}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {(e.userEmail ?? t.analysis_audit_anonymous) +
                            " · " +
                            (e.ipAddress ?? "—") +
                            " · " +
                            new Date(e.occurredAtIso).toLocaleString()}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        <p className="text-xs text-muted-foreground mt-3">
          {t.analysis_audit_explainer}
        </p>
      </CardContent>
    </Card>
  );
}

function AuditClassRow({
  label,
  tone,
  items,
}: {
  label: string;
  tone: "ok" | "warn" | "alert";
  items: Array<{ label: string; value: number }>;
}) {
  const colour =
    tone === "alert"
      ? "text-rose-700"
      : tone === "warn"
      ? "text-amber-700"
      : "text-muted-foreground";
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={`text-xs uppercase tracking-wider ${colour}`}>
        {label}
      </span>
      <div className="flex items-center gap-3 text-sm">
        {items.map((i) => (
          <span key={i.label} className="flex items-center gap-1">
            <span className="text-muted-foreground text-xs">{i.label}</span>
            <span
              className={
                "tabular-nums font-semibold " +
                (i.value > 0 ? colour : "text-muted-foreground")
              }
            >
              {i.value}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
