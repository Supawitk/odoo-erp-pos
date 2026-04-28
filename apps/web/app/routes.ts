import { type RouteConfig, layout, route, index } from "@react-router/dev/routes";

export default [
  layout("components/dashboard-layout.tsx", [
    index("routes/dashboard.tsx"),
    route("pos", "routes/pos.tsx"),
    route("inventory", "routes/inventory.tsx"),
    route("sales", "routes/sales.tsx"),
    route("accounting", "routes/placeholder.tsx", { id: "accounting" }),
    route("reports", "routes/placeholder.tsx", { id: "reports" }),
    route("hr", "routes/placeholder.tsx", { id: "hr" }),
    route("crm", "routes/placeholder.tsx", { id: "crm" }),
    route("settings", "routes/settings.tsx"),
  ]),
] satisfies RouteConfig;
