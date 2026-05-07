import { type RouteConfig, layout, route, index } from "@react-router/dev/routes";

export default [
  // Public auth routes — no dashboard chrome.
  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),

  // Protected app — dashboard layout enforces auth and redirects to /login if missing.
  layout("components/dashboard-layout.tsx", [
    index("routes/dashboard.tsx"),
    route("pos", "routes/pos.tsx"),
    route("inventory", "routes/inventory.tsx"),
    route("bills", "routes/bills.tsx"),
    route("invoices", "routes/invoices.tsx"),
    route("sales", "routes/sales.tsx"),
    route("accounting", "routes/accounting/route.tsx"),
    route("reports", "routes/placeholder.tsx", { id: "reports" }),
    route("hr", "routes/placeholder.tsx", { id: "hr" }),
    route("crm", "routes/placeholder.tsx", { id: "crm" }),
    route("analysis", "routes/analysis.tsx"),
    route("approvals", "routes/approvals.tsx"),
    route("etax", "routes/etax.tsx"),
    route("settings", "routes/settings.tsx"),
  ]),
] satisfies RouteConfig;
