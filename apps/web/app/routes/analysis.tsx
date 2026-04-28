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
import { Lock, ShieldAlert, TrendingDown, TrendingUp } from "lucide-react";
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
  const [err, setErr] = useState<string | null>(null);

  const isAdmin = user?.role === "admin";

  useEffect(() => {
    if (!hydrated) return;
    if (!isAdmin) return;
    setErr(null);
    const w = windowFor(range);
    const fromIso = w.from.toISOString();
    const toIso = w.to.toISOString();

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
