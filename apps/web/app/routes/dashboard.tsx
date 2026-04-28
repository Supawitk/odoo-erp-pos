import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { DollarSign, ShoppingBag, Users, Radio } from "lucide-react";
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
  orderLines: Array<{ name: string; qty: number; unitPriceCents: number }>;
  createdAt: string;
};

export default function Dashboard() {
  const t = useT();
  const { settings } = useOrgSettings();
  const currency = settings?.currency ?? "USD";
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);

  useEffect(() => {
    api<OrderRow[]>(`/api/pos/orders?limit=100`)
      .then((d) => {
        setOrders(d);
        setApiHealthy(true);
      })
      .catch(() => setApiHealthy(false));

    const sock = io(API_BASE, { transports: ["websocket"], reconnection: true });
    sock.on("pos:order:created", () => {
      setLiveCount((n) => n + 1);
      api<OrderRow[]>(`/api/pos/orders?limit=100`).then(setOrders).catch(() => {});
    });
    return () => { sock.disconnect(); };
  }, []);

  // Simple "today" = same calendar day local time
  const today = new Date().toDateString();
  const todays = orders.filter((o) => new Date(o.createdAt).toDateString() === today);
  const revenueToday = todays.reduce((s, o) => s + o.totalCents, 0);
  const ordersToday = todays.length;
  const uniqueSessionsToday = new Set(todays.map((o) => o.sessionId)).size;

  const productTally = new Map<string, { name: string; qty: number; revenueCents: number }>();
  for (const o of orders) {
    for (const line of o.orderLines) {
      const cur = productTally.get(line.name) ?? { name: line.name, qty: 0, revenueCents: 0 };
      cur.qty += line.qty;
      cur.revenueCents += line.unitPriceCents * line.qty;
      productTally.set(line.name, cur);
    }
  }
  const topProducts = Array.from(productTally.values())
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, 5);

  const STATS = [
    { label: t.stat_revenue_today, value: formatMoney(revenueToday, currency), icon: DollarSign, sub: t.stat_orders_count(ordersToday) },
    { label: t.stat_orders_today, value: String(ordersToday), icon: ShoppingBag, sub: t.stat_total_orders(orders.length) },
    { label: t.stat_active_sessions, value: String(uniqueSessionsToday), icon: Users, sub: t.stat_today },
    { label: t.stat_live_events, value: String(liveCount), icon: Radio, sub: t.stat_since_load },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t.dashboard_title}</h1>
        <p className="text-muted-foreground">
          {t.dashboard_subtitle}
          {apiHealthy === false && (
            <span className="ml-2 text-sm text-destructive">• {t.api_unreachable}</span>
          )}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {STATS.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.label}</CardTitle>
              <stat.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <p className="text-xs text-muted-foreground">{stat.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t.top_products}</CardTitle>
            <CardDescription>{t.top_products_sub}</CardDescription>
          </CardHeader>
          <CardContent>
            {topProducts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t.no_orders_yet}</p>
            ) : (
              <ul className="space-y-2">
                {topProducts.map((p) => (
                  <li key={p.name} className="flex items-center justify-between text-sm">
                    <span className="truncate">{p.name}</span>
                    <div className="flex items-center gap-3 text-muted-foreground">
                      <span>× {p.qty}</span>
                      <span className="font-medium text-foreground">{formatMoney(p.revenueCents, currency)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.recent_orders}</CardTitle>
            <CardDescription>{t.recent_orders_sub}</CardDescription>
          </CardHeader>
          <CardContent>
            {orders.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t.no_orders}</p>
            ) : (
              <ul className="space-y-2">
                {orders.slice(0, 5).map((o) => (
                  <li key={o.id} className="flex items-center justify-between text-sm">
                    <div>
                      <p className="font-medium">{formatMoney(o.totalCents, o.currency)}</p>
                      <p className="text-xs text-muted-foreground">
                        {o.paymentMethod} • {t.items_count(o.orderLines.length)}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(o.createdAt).toLocaleTimeString()}
                    </span>
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
