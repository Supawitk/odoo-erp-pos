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
  Radio,
  ShoppingBag,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { API_BASE, api, formatMoney } from "~/lib/api";
import { io } from "socket.io-client";
import { useT } from "~/hooks/use-t";
import { useOrgSettings } from "~/hooks/use-org-settings";

type OrderRow = {
  id: string;
  sessionId: string;
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

export default function Dashboard() {
  const t = useT();
  const { settings } = useOrgSettings();
  const currency = settings?.currency ?? "USD";

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [sessions, setSessions] = useState<SessionsDashboard | null>(null);
  const [lowStock, setLowStock] = useState<StockRow[]>([]);
  const [sequences, setSequences] = useState<SequenceRow[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);

  const reloadAll = async () => {
    try {
      const [o, s, l, q] = await Promise.all([
        api<OrderRow[]>(`/api/pos/orders?limit=200`),
        api<SessionsDashboard>(`/api/pos/sessions/dashboard`),
        api<StockRow[]>(`/api/inventory/stock?lowOnly=true`).catch(() => []),
        api<SequenceRow[]>(`/api/reports/sequences`).catch(() => []),
      ]);
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
    reloadAll();
    const sock = io(API_BASE, { transports: ["websocket"], reconnection: true });
    sock.on("pos:order:created", () => {
      setLiveCount((n) => n + 1);
      reloadAll();
    });
    return () => {
      sock.disconnect();
    };
  }, []);

  // ─── Derived metrics ─────────────────────────────────────────────────────
  const today = new Date();
  const todayKey = today.toDateString();
  const yesterdayKey = new Date(today.getTime() - 24 * 60 * 60 * 1000).toDateString();

  const todays = orders.filter((o) => new Date(o.createdAt).toDateString() === todayKey);
  const yesterdays = orders.filter(
    (o) => new Date(o.createdAt).toDateString() === yesterdayKey,
  );
  const revenueToday = todays.reduce((s, o) => s + o.totalCents, 0);
  const revenueYday = yesterdays.reduce((s, o) => s + o.totalCents, 0);
  const ordersToday = todays.length;
  const aovToday = ordersToday > 0 ? Math.round(revenueToday / ordersToday) : 0;
  const revenueDeltaPct = revenueYday > 0 ? (revenueToday - revenueYday) / revenueYday : null;

  // 7-day revenue series for sparkline (Mon..Sun, oldest → newest)
  const last7 = useMemo(() => {
    const buckets: { day: string; cents: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toDateString();
      const cents = orders
        .filter((o) => new Date(o.createdAt).toDateString() === key)
        .reduce((s, o) => s + o.totalCents, 0);
      buckets.push({ day: key, cents });
    }
    return buckets;
  }, [orders]);

  // Document mix today
  const docMix = useMemo(() => {
    const mix: Record<string, number> = { TX: 0, ABB: 0, RE: 0, CN: 0 };
    for (const o of todays) {
      const d = (o.documentType ?? "RE") as keyof typeof mix;
      mix[d] = (mix[d] ?? 0) + 1;
    }
    return mix;
  }, [todays]);

  // Top 5 products across all orders
  const topProducts = useMemo(() => {
    const t = new Map<string, { name: string; qty: number; revenueCents: number }>();
    for (const o of orders) {
      for (const line of o.orderLines) {
        const cur = t.get(line.name) ?? { name: line.name, qty: 0, revenueCents: 0 };
        cur.qty += line.qty;
        cur.revenueCents += line.unitPriceCents * line.qty;
        t.set(line.name, cur);
      }
    }
    return [...t.values()].sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 5);
  }, [orders]);

  const taxGapCount = sequences
    .filter((s) => s.scope === "tax")
    .reduce((sum, s) => sum + s.missing.length, 0);
  const outOfStockCount = lowStock.filter((r) => r.qtyOnHand <= 0).length;

  // ─── Severities ──────────────────────────────────────────────────────────
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

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t.dashboard_title}</h1>
          <p className="text-muted-foreground">
            {today.toLocaleDateString(undefined, {
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
      </div>

      {/* ───── Status strip ─────────────────────────────────────────────── */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={<DollarSign className="h-4 w-4" />}
          label="Revenue today"
          value={formatMoney(revenueToday, currency)}
          sub={
            revenueDeltaPct == null ? (
              <span>No data yesterday</span>
            ) : (
              <span
                className={
                  "inline-flex items-center gap-1 " +
                  (revenueDeltaPct >= 0 ? "text-emerald-600" : "text-rose-600")
                }
              >
                {revenueDeltaPct >= 0 ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {(revenueDeltaPct * 100).toFixed(1)}% vs yesterday
              </span>
            )
          }
        />
        <KpiCard
          icon={<ShoppingBag className="h-4 w-4" />}
          label="Orders today"
          value={String(ordersToday)}
          sub={
            <span>
              AOV {ordersToday > 0 ? formatMoney(aovToday, currency) : "—"}
            </span>
          }
        />
        <Link to="/pos" className="contents">
          <KpiCard
            icon={<Users className="h-4 w-4" />}
            label="Open registers"
            value={sessions ? String(sessions.openCount) : "…"}
            sub={
              sessions && sessions.openCount > 0 ? (
                <span className="flex items-center gap-2">
                  <StatusDot severity={sessionSeverity} />
                  <span className={severityText(sessionSeverity)}>
                    {formatMoney(sessions.openCashCents, currency)} cash · {sessions.staleHours}h
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">No open registers</span>
              )
            }
            interactive
          />
        </Link>
        <KpiCard
          icon={<Radio className="h-4 w-4" />}
          label="Live events"
          value={String(liveCount)}
          sub={<span className="text-muted-foreground">since page load</span>}
        />
      </div>

      {/* ───── Action items — only render when severity > ok ──────────── */}
      {(stockSeverity !== "ok" || sequenceSeverity !== "ok" || sessionSeverity !== "ok") && (
        <div className="grid gap-3 md:grid-cols-3">
          {sessionSeverity !== "ok" && sessions && (
            <ActionCard
              severity={sessionSeverity}
              icon={<Users className="h-4 w-4" />}
              title="Stale open register"
              detail={`${sessions.openCount} register${sessions.openCount === 1 ? "" : "s"} open for ${sessions.staleHours}h. ${
                sessionSeverity === "alert"
                  ? "Close them — sweeper will mark them abandoned at 24h."
                  : "Approaching the 24h auto-close."
              }`}
              to="/pos"
            />
          )}
          {stockSeverity !== "ok" && (
            <ActionCard
              severity={stockSeverity}
              icon={<Package className="h-4 w-4" />}
              title={
                outOfStockCount > 0
                  ? `${outOfStockCount} out of stock`
                  : `${lowStock.length} below reorder point`
              }
              detail={
                outOfStockCount > 0
                  ? `${outOfStockCount} item${outOfStockCount === 1 ? "" : "s"} are out — reorder before next sale.`
                  : `${lowStock.length} item${lowStock.length === 1 ? "" : "s"} have qty below their reorder threshold.`
              }
              to="/inventory"
            />
          )}
          {sequenceSeverity !== "ok" && (
            <ActionCard
              severity={sequenceSeverity}
              icon={<AlertCircle className="h-4 w-4" />}
              title={`${taxGapCount} tax-document gap${taxGapCount === 1 ? "" : "s"}`}
              detail={
                "§86 prohibits gaps in RE/ABB/TX/CN sequences. Investigate via Settings → Compliance."
              }
              to="/settings"
            />
          )}
        </div>
      )}

      {/* All-clear banner when nothing needs attention */}
      {stockSeverity === "ok" &&
        sequenceSeverity === "ok" &&
        sessionSeverity === "ok" &&
        sessions && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            <span>All systems healthy. No action items.</span>
          </div>
        )}

      {/* ───── Performance row ─────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Revenue · last 7 days</CardTitle>
            <CardDescription>
              Total{" "}
              <span className="font-medium text-foreground">
                {formatMoney(
                  last7.reduce((s, d) => s + d.cents, 0),
                  currency,
                )}
              </span>{" "}
              · daily average{" "}
              <span className="font-medium text-foreground">
                {formatMoney(
                  Math.round(last7.reduce((s, d) => s + d.cents, 0) / 7),
                  currency,
                )}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Sparkline data={last7} currency={currency} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Document mix · today</CardTitle>
            <CardDescription>
              Compliance signal — TX is full, ABB is abbreviated, RE is non-VAT.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-3">
              <DocPill label="TX" count={docMix.TX} accent="emerald" />
              <DocPill label="ABB" count={docMix.ABB} accent="blue" />
              <DocPill label="RE" count={docMix.RE} accent="amber" />
              <DocPill label="CN" count={docMix.CN} accent="rose" />
            </div>
            <div className="mt-3">
              <Link
                to="/sales"
                className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
              >
                View sales ledger
                <ChevronRight className="h-3 w-3 ml-0.5" />
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ───── Activity row ────────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Top products</CardTitle>
            <CardDescription>Across all orders, ranked by revenue.</CardDescription>
          </CardHeader>
          <CardContent>
            {topProducts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t.no_orders_yet}
              </p>
            ) : (
              <ul className="space-y-2">
                {topProducts.map((p, idx) => (
                  <li
                    key={p.name}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="flex items-center gap-3">
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
              <CardTitle>Recent orders</CardTitle>
              <Link
                to="/sales"
                className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
              >
                All orders
                <ChevronRight className="h-3 w-3 ml-0.5" />
              </Link>
            </div>
            <CardDescription>Last 6 — click through to the sales ledger.</CardDescription>
          </CardHeader>
          <CardContent>
            {orders.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t.no_orders}
              </p>
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

// ─── Subcomponents ─────────────────────────────────────────────────────────

function KpiCard({
  icon,
  label,
  value,
  sub,
  interactive,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: React.ReactNode;
  interactive?: boolean;
}) {
  return (
    <Card
      className={
        "transition-shadow " +
        (interactive ? "hover:shadow-md hover:border-foreground/20 cursor-pointer" : "")
      }
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-xs">{sub}</div>
      </CardContent>
    </Card>
  );
}

function StatusDot({ severity }: { severity: Severity }) {
  const cls =
    severity === "alert"
      ? "bg-rose-500"
      : severity === "warn"
      ? "bg-amber-500"
      : "bg-emerald-500";
  return (
    <span className="relative inline-flex h-2 w-2">
      <span className={"absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping " + cls} />
      <span className={"relative inline-flex h-2 w-2 rounded-full " + cls} />
    </span>
  );
}

function severityText(severity: Severity) {
  return severity === "alert"
    ? "text-rose-600"
    : severity === "warn"
    ? "text-amber-600"
    : "text-emerald-600";
}

function ActionCard({
  severity,
  icon,
  title,
  detail,
  to,
}: {
  severity: Severity;
  icon: React.ReactNode;
  title: string;
  detail: string;
  to: string;
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
        "flex flex-col gap-2 rounded-md border p-4 transition hover:shadow-sm hover:scale-[1.005] " + wrap
      }
    >
      <div className={"flex items-center gap-2 text-sm font-semibold " + text}>
        <Icon className="h-4 w-4" />
        {title}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{detail}</p>
      <span className={"inline-flex items-center text-xs " + text}>
        Investigate
        <ChevronRight className="h-3 w-3 ml-0.5" />
        <span className="sr-only">{icon}</span>
      </span>
    </Link>
  );
}

function DocPill({
  label,
  count,
  accent,
}: {
  label: string;
  count: number;
  accent: "emerald" | "blue" | "amber" | "rose";
}) {
  const dotCls =
    accent === "emerald"
      ? "bg-emerald-500"
      : accent === "blue"
      ? "bg-blue-500"
      : accent === "amber"
      ? "bg-amber-500"
      : "bg-rose-500";
  return (
    <div className="rounded-md border p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-mono uppercase">{label}</span>
        <span className={"inline-block h-1.5 w-1.5 rounded-full " + dotCls} />
      </div>
      <div className="text-2xl font-bold leading-none">{count}</div>
    </div>
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

function Sparkline({
  data,
  currency,
}: {
  data: { day: string; cents: number }[];
  currency: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.cents));
  return (
    <div className="space-y-2">
      <div className="flex h-24 items-end gap-1.5">
        {data.map((d) => {
          const pct = (d.cents / max) * 100;
          const isToday = d.day === new Date().toDateString();
          return (
            <div
              key={d.day}
              className="group relative flex-1"
              title={`${new Date(d.day).toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })} — ${formatMoney(d.cents, currency)}`}
            >
              <div
                className={
                  "absolute bottom-0 left-0 right-0 rounded-t transition-all " +
                  (isToday
                    ? "bg-primary group-hover:opacity-90"
                    : "bg-primary/30 group-hover:bg-primary/60")
                }
                style={{ height: `${Math.max(3, pct)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>
          {new Date(data[0]?.day ?? new Date()).toLocaleDateString(undefined, {
            weekday: "short",
          })}
        </span>
        <span>Today</span>
      </div>
    </div>
  );
}
