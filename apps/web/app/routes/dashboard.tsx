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
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  DollarSign,
  Package,
  Percent,
  Receipt,
  ShoppingBag,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ComposedChart,
} from "recharts";
import { API_BASE, api, formatMoney } from "~/lib/api";
import { io } from "socket.io-client";
import { useT } from "~/hooks/use-t";
import { useOrgSettings } from "~/hooks/use-org-settings";

type RangeKey = "today" | "7d" | "month" | "quarter" | "year";

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

type OrderRow = {
  id: string;
  totalCents: number;
  currency: string;
  paymentMethod: string;
  documentType?: string;
  documentNumber?: string | null;
  status?: string;
  orderLines: Array<{ name: string; qty: number; unitPriceCents: number }>;
  createdAt: string;
};

type SessionsDashboard = {
  openCount: number;
  openCashCents: number;
  oldestOpenAt: string | null;
  staleHours: number;
};

type StockRow = {
  productId: string;
  productName: string;
  qtyOnHand: number;
  reorderPoint: number | null;
  isLow: boolean;
};

type SequenceRow = {
  documentType: string;
  period: string;
  prefix: string;
  allocated: number;
  issued: number;
  missing: number[];
  scope: "tax" | "internal";
};

type Severity = "ok" | "warn" | "alert";

// Map a UI range to (from, to, granularity).
function windowFor(range: RangeKey): {
  from: Date;
  to: Date;
  granularity: Granularity;
  compareLabel: string;
} {
  const now = new Date();
  const to = new Date(now);
  const from = new Date(now);

  if (range === "today") {
    from.setHours(0, 0, 0, 0);
    return { from, to, granularity: "hour", compareLabel: "vs yesterday" };
  }
  if (range === "7d") {
    from.setDate(from.getDate() - 6);
    from.setHours(0, 0, 0, 0);
    return { from, to, granularity: "day", compareLabel: "vs prior 7 days" };
  }
  if (range === "month") {
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
    return { from, to, granularity: "day", compareLabel: "vs last month" };
  }
  if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    from.setMonth(q * 3, 1);
    from.setHours(0, 0, 0, 0);
    return { from, to, granularity: "week", compareLabel: "vs last quarter" };
  }
  // year
  from.setMonth(0, 1);
  from.setHours(0, 0, 0, 0);
  return { from, to, granularity: "month", compareLabel: "vs last year" };
}

// Same-length window immediately preceding the chosen one.
function previousWindowFor(range: RangeKey): { from: Date; to: Date } {
  const cur = windowFor(range);
  const span = cur.to.getTime() - cur.from.getTime();
  return { from: new Date(cur.from.getTime() - span), to: cur.from };
}

const PAY_COLORS: Record<string, string> = {
  cash: "#10b981",
  card: "#3b82f6",
  promptpay: "#8b5cf6",
  qr: "#8b5cf6",
  split: "#f59e0b",
  unknown: "#94a3b8",
};
const DOC_COLORS: Record<string, string> = {
  TX: "#10b981",
  ABB: "#3b82f6",
  RE: "#f59e0b",
  CN: "#f43f5e",
};

export default function Dashboard() {
  const t = useT();
  const { settings } = useOrgSettings();
  const currency = settings?.currency ?? "USD";

  const [range, setRange] = useState<RangeKey>("7d");
  const [tsCurrent, setTsCurrent] = useState<TimeseriesResponse | null>(null);
  const [tsPrev, setTsPrev] = useState<TimeseriesResponse | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [sessions, setSessions] = useState<SessionsDashboard | null>(null);
  const [lowStock, setLowStock] = useState<StockRow[]>([]);
  const [sequences, setSequences] = useState<SequenceRow[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);

  const reloadAll = async (r: RangeKey = range) => {
    const cur = windowFor(r);
    const prev = previousWindowFor(r);
    try {
      const [ts, tsP, o, s, l, q] = await Promise.all([
        api<TimeseriesResponse>(
          `/api/reports/timeseries?from=${cur.from.toISOString()}&to=${cur.to.toISOString()}&granularity=${cur.granularity}`,
        ),
        api<TimeseriesResponse>(
          `/api/reports/timeseries?from=${prev.from.toISOString()}&to=${prev.to.toISOString()}&granularity=${cur.granularity}`,
        ),
        api<OrderRow[]>(`/api/pos/orders?limit=200`),
        api<SessionsDashboard>(`/api/pos/sessions/dashboard`),
        api<StockRow[]>(`/api/inventory/stock?lowOnly=true`).catch(() => []),
        api<SequenceRow[]>(`/api/reports/sequences`).catch(() => []),
      ]);
      setTsCurrent(ts);
      setTsPrev(tsP);
      setOrders(o);
      setSessions(s);
      setLowStock(l);
      setSequences(q);
      setApiHealthy(true);
    } catch {
      setApiHealthy(false);
    }
  };

  useEffect(() => {
    reloadAll(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => {
    const sock = io(API_BASE, { transports: ["websocket"], reconnection: true });
    sock.on("pos:order:created", () => {
      setLiveCount((n) => n + 1);
      reloadAll(range);
    });
    return () => {
      sock.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // ─── KPIs (current vs previous window) ─────────────────────────────────────
  const totals = tsCurrent?.totals;
  const prevTotals = tsPrev?.totals;
  const revenueDelta =
    totals && prevTotals && prevTotals.revenueCents > 0
      ? (totals.revenueCents - prevTotals.revenueCents) / prevTotals.revenueCents
      : null;
  const orderDelta =
    totals && prevTotals && prevTotals.orderCount > 0
      ? (totals.orderCount - prevTotals.orderCount) / prevTotals.orderCount
      : null;

  // ─── Top products in window (from full order list) ─────────────────────────
  const topProducts = useMemo(() => {
    if (!tsCurrent) return [];
    const fromMs = new Date(tsCurrent.fromIso).getTime();
    const toMs = new Date(tsCurrent.toIso).getTime();
    const map = new Map<string, { name: string; qty: number; revenueCents: number }>();
    for (const o of orders) {
      const t = new Date(o.createdAt).getTime();
      if (t < fromMs || t > toMs) continue;
      for (const line of o.orderLines) {
        const cur = map.get(line.name) ?? {
          name: line.name,
          qty: 0,
          revenueCents: 0,
        };
        cur.qty += line.qty;
        cur.revenueCents += line.unitPriceCents * line.qty;
        map.set(line.name, cur);
      }
    }
    return [...map.values()].sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 5);
  }, [tsCurrent, orders]);

  // ─── Document mix in window ────────────────────────────────────────────────
  const docMix = useMemo(() => {
    if (!tsCurrent) return [];
    const totals = { TX: 0, ABB: 0, RE: 0, CN: 0 };
    for (const b of tsCurrent.buckets) {
      totals.TX += b.byDocType.TX;
      totals.ABB += b.byDocType.ABB;
      totals.RE += b.byDocType.RE;
      totals.CN += b.byDocType.CN;
    }
    return (Object.entries(totals) as Array<[keyof typeof totals, number]>)
      .filter(([, n]) => n > 0)
      .map(([type, count]) => ({ name: type, value: count, color: DOC_COLORS[type] }));
  }, [tsCurrent]);

  // ─── Payment mix in window ─────────────────────────────────────────────────
  const paymentMix = useMemo(() => {
    if (!tsCurrent) return [];
    const t = new Map<string, number>();
    for (const b of tsCurrent.buckets) {
      for (const [pay, n] of Object.entries(b.byPayment)) {
        t.set(pay, (t.get(pay) ?? 0) + n);
      }
    }
    return [...t.entries()]
      .map(([name, value]) => ({ name, value, color: PAY_COLORS[name] ?? "#94a3b8" }))
      .sort((a, b) => b.value - a.value);
  }, [tsCurrent]);

  // ─── Action items ──────────────────────────────────────────────────────────
  const taxGapCount = sequences
    .filter((s) => s.scope === "tax")
    .reduce((sum, s) => sum + s.missing.length, 0);
  const outOfStockCount = lowStock.filter((r) => r.qtyOnHand <= 0).length;

  const sessionSeverity: Severity =
    !sessions || sessions.openCount === 0
      ? "ok"
      : sessions.staleHours >= 24
      ? "alert"
      : sessions.staleHours >= 12
      ? "warn"
      : "ok";
  const stockSeverity: Severity =
    outOfStockCount > 0 ? "alert" : lowStock.length > 0 ? "warn" : "ok";
  const sequenceSeverity: Severity = taxGapCount > 0 ? "alert" : "ok";

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t.dashboard_title}</h1>
          <p className="text-muted-foreground">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
            {apiHealthy === false && (
              <span className="ml-2 text-sm text-destructive">• {t.api_unreachable}</span>
            )}
          </p>
        </div>
        <RangeToggle value={range} onChange={setRange} t={t} />
      </div>

      {/* ───── KPI strip ────────────────────────────────────────────────────── */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={<DollarSign className="h-4 w-4" />}
          label={t.dash_kpi_revenue}
          value={formatMoney(totals?.revenueCents ?? 0, currency)}
          delta={revenueDelta}
          sub={windowFor(range).compareLabel}
        />
        <KpiCard
          icon={<ShoppingBag className="h-4 w-4" />}
          label={t.dash_kpi_orders}
          value={String(totals?.orderCount ?? 0)}
          delta={orderDelta}
          sub={windowFor(range).compareLabel}
        />
        <KpiCard
          icon={<Receipt className="h-4 w-4" />}
          label={t.dash_kpi_aov}
          value={
            totals && totals.orderCount > 0
              ? formatMoney(totals.aovCents, currency)
              : "—"
          }
          sub={`${t.stat_live_events}: ${liveCount}`}
        />
        <KpiCard
          icon={<Percent className="h-4 w-4" />}
          label={t.dash_kpi_refund_rate}
          value={
            totals
              ? `${(totals.refundRate * 100).toFixed(1)}%`
              : "0.0%"
          }
          sub={
            totals && totals.refundCount > 0
              ? `${totals.refundCount} CN${totals.refundCount === 1 ? "" : "s"} · ${formatMoney(Math.abs(totals.refundCents), currency)}`
              : t.no_orders
          }
          severity={
            totals && totals.refundRate > 0.1
              ? "alert"
              : totals && totals.refundRate > 0.05
              ? "warn"
              : "ok"
          }
        />
      </div>

      {/* ───── Action items strip ─────────────────────────────────────────── */}
      {(stockSeverity !== "ok" ||
        sequenceSeverity !== "ok" ||
        sessionSeverity !== "ok") && (
        <div className="grid gap-3 md:grid-cols-3">
          {sessionSeverity !== "ok" && sessions && (
            <ActionCard
              severity={sessionSeverity}
              icon={<Users className="h-4 w-4" />}
              title={t.dash_action_stale_register}
              detail={`${sessions.openCount} register${sessions.openCount === 1 ? "" : "s"} open for ${sessions.staleHours}h.`}
              to="/pos"
              t={t}
            />
          )}
          {stockSeverity !== "ok" && (
            <ActionCard
              severity={stockSeverity}
              icon={<Package className="h-4 w-4" />}
              title={
                outOfStockCount > 0
                  ? t.dash_action_out_of_stock(outOfStockCount)
                  : t.dash_action_low_stock(lowStock.length)
              }
              detail={
                outOfStockCount > 0
                  ? `${outOfStockCount} item${outOfStockCount === 1 ? "" : "s"} are out — reorder before next sale.`
                  : `${lowStock.length} item${lowStock.length === 1 ? "" : "s"} below their reorder threshold.`
              }
              to="/inventory"
              t={t}
            />
          )}
          {sequenceSeverity !== "ok" && (
            <ActionCard
              severity={sequenceSeverity}
              icon={<AlertCircle className="h-4 w-4" />}
              title={t.dash_action_seq_gap(taxGapCount)}
              detail="§86 prohibits gaps. Investigate via Settings → Compliance."
              to="/settings"
              t={t}
            />
          )}
        </div>
      )}

      {stockSeverity === "ok" &&
        sequenceSeverity === "ok" &&
        sessionSeverity === "ok" &&
        sessions && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            <span>{t.dash_all_clear}</span>
          </div>
        )}

      {/* ───── Trend (revenue area) ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{t.dash_trend_title}</CardTitle>
          <CardDescription>{t.dash_trend_subtitle}</CardDescription>
        </CardHeader>
        <CardContent className="h-[260px]">
          {tsCurrent && tsCurrent.buckets.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={tsCurrent.buckets}>
                <defs>
                  <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis
                  tickFormatter={(v) => formatMoney(Number(v), currency).replace(/\.\d+/, "")}
                  tick={{ fontSize: 11 }}
                  width={70}
                />
                <Tooltip
                  formatter={(v) => formatMoney(Number(v ?? 0), currency)}
                  labelFormatter={(l) => l as string}
                />
                <Area
                  type="monotone"
                  dataKey="revenueCents"
                  name={t.dash_kpi_revenue}
                  stroke="#10b981"
                  strokeWidth={2}
                  fill="url(#rev)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label={t.dash_no_data} />
          )}
        </CardContent>
      </Card>

      {/* ───── Orders + refunds composed chart ─────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{t.dash_orders_title}</CardTitle>
          <CardDescription>{t.dash_orders_subtitle}</CardDescription>
        </CardHeader>
        <CardContent className="h-[230px]">
          {tsCurrent && tsCurrent.buckets.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={tsCurrent.buckets}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={32} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  dataKey="orderCount"
                  fill="#3b82f6"
                  name={t.dash_kpi_orders}
                  radius={[3, 3, 0, 0]}
                />
                <Line
                  type="monotone"
                  dataKey="refundCount"
                  stroke="#f43f5e"
                  strokeWidth={2}
                  dot={false}
                  name="Refunds"
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label={t.dash_no_data} />
          )}
        </CardContent>
      </Card>

      {/* ───── Doc mix + payment mix side by side ─────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t.dash_doc_mix_title}</CardTitle>
            <CardDescription>{t.dash_doc_mix_subtitle}</CardDescription>
          </CardHeader>
          <CardContent className="h-[240px]">
            {docMix.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={docMix}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {docMix.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart label={t.dash_no_data} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t.dash_payment_title}</CardTitle>
            <CardDescription>{t.dash_payment_subtitle}</CardDescription>
          </CardHeader>
          <CardContent className="h-[240px]">
            {paymentMix.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={paymentMix} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="name" type="category" width={80} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                    {paymentMix.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart label={t.dash_no_data} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ───── Top products + recent orders ───────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t.dash_top_products_title}</CardTitle>
            <CardDescription>{t.dash_top_products_sub}</CardDescription>
          </CardHeader>
          <CardContent>
            {topProducts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t.dash_no_data}</p>
            ) : (
              <ul className="space-y-2">
                {topProducts.map((p, idx) => (
                  <li key={p.name} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-3 min-w-0">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs font-medium">
                        {idx + 1}
                      </span>
                      <span className="font-medium truncate">{p.name}</span>
                    </span>
                    <div className="flex items-center gap-3 text-muted-foreground">
                      <span>× {p.qty}</span>
                      <span className="font-semibold text-foreground">
                        {formatMoney(p.revenueCents, currency)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle>{t.dash_recent_orders_title}</CardTitle>
              <Link
                to="/sales"
                className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
              >
                {t.actions}
                <ChevronRight className="h-3 w-3 ml-0.5" />
              </Link>
            </div>
            <CardDescription>{t.dash_recent_orders_sub}</CardDescription>
          </CardHeader>
          <CardContent>
            {orders.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t.no_orders}</p>
            ) : (
              <ul className="divide-y">
                {orders.slice(0, 6).map((o) => (
                  <li key={o.id}>
                    <Link
                      to="/sales"
                      className="flex items-center justify-between py-2 text-sm hover:bg-muted/50 rounded px-2 -mx-2"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <DocBadge type={o.documentType ?? "RE"} />
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {o.documentNumber ?? o.id.slice(0, 8)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {o.paymentMethod} · {o.orderLines.length} item
                            {o.orderLines.length === 1 ? "" : "s"}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p
                          className={
                            "font-semibold " +
                            (o.status === "refunded" || (o.totalCents ?? 0) < 0
                              ? "text-rose-600"
                              : "")
                          }
                        >
                          {formatMoney(o.totalCents, o.currency)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {new Date(o.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
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
    { key: "today", label: t.range_today },
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

function KpiCard({
  icon,
  label,
  value,
  delta,
  sub,
  severity,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  delta?: number | null;
  sub?: string;
  severity?: Severity;
}) {
  const tone =
    severity === "alert"
      ? "border-rose-500/40 bg-rose-500/5"
      : severity === "warn"
      ? "border-amber-500/40 bg-amber-500/5"
      : "";
  return (
    <Card className={tone}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
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

function ActionCard({
  severity,
  icon,
  title,
  detail,
  to,
  t,
}: {
  severity: Severity;
  icon: React.ReactNode;
  title: string;
  detail: string;
  to: string;
  t: ReturnType<typeof useT>;
}) {
  const wrap =
    severity === "alert"
      ? "border-rose-500/40 bg-rose-500/5"
      : "border-amber-500/40 bg-amber-500/5";
  const text = severity === "alert" ? "text-rose-700" : "text-amber-700";
  const Icon = severity === "alert" ? AlertCircle : AlertTriangle;
  return (
    <Link
      to={to}
      className={
        "flex flex-col gap-2 rounded-md border p-4 transition hover:shadow-sm " + wrap
      }
    >
      <div className={"flex items-center gap-2 text-sm font-semibold " + text}>
        <Icon className="h-4 w-4" />
        {title}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{detail}</p>
      <span className={"inline-flex items-center text-xs " + text}>
        {t.dash_investigate}
        <ChevronRight className="h-3 w-3 ml-0.5" />
        <span className="sr-only">{icon}</span>
      </span>
    </Link>
  );
}

function DocBadge({ type }: { type: string }) {
  const cls =
    type === "TX"
      ? "bg-emerald-500/15 text-emerald-700"
      : type === "ABB"
      ? "bg-blue-500/15 text-blue-700"
      : type === "CN"
      ? "bg-rose-500/15 text-rose-700"
      : "bg-amber-500/15 text-amber-700";
  return (
    <span
      className={
        "inline-flex h-7 w-9 shrink-0 items-center justify-center rounded text-[10px] font-mono font-semibold " +
        cls
      }
    >
      {type}
    </span>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
